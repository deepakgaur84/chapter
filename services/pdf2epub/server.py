"""HTTP service for Chapter's PDF handling.

- POST /convert              PDF upload -> EPUB (text PDFs) or "no text" (scans)
- POST /ocr/<hash>           start OCR of <BOOKS_DIR>/<hash>.pdf in the background
- GET  /ocr/<hash>           progress: none | queued | running | done | failed
- GET  /ocr/<hash>/result    the EPUB made by a finished OCR job
- DELETE /ocr/<hash>         cancel / forget a job
- GET  /info/<hash>          page count and page shape
- GET  /pages/<hash>/<n>     one page as a JPEG (the page viewer)

The books folder of Chapter's server is mounted read-only at BOOKS_DIR, so scanned PDFs never
have to be uploaded again.
"""

import base64
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque

from flask import Flask, Response, jsonify, request

from converter import ConversionError, convert_pdf, pdf_info, render_page

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

BOOKS_DIR = os.environ.get("BOOKS_DIR", "/data/books")
JOBS_DIR = os.environ.get("JOBS_DIR", "/tmp/pdf2epub-jobs")
JOB_KEEP_SECONDS = 24 * 3600
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
HERE = os.path.dirname(os.path.abspath(__file__))

# PyMuPDF is not thread-safe: everything that uses it in this process takes this lock.
# (OCR runs in a separate process, so it never holds it.)
_fitz_lock = threading.Lock()


def ocr_available():
    tessdata = os.environ.get("TESSDATA_PREFIX", "")
    return bool(tessdata) and os.path.isdir(tessdata)


def book_pdf(file_hash):
    """Path of the stored PDF for a book hash, or None."""
    if not HASH_RE.match(file_hash or ""):
        return None
    path = os.path.join(BOOKS_DIR, f"{file_hash}.pdf")
    return path if os.path.isfile(path) else None


# --- OCR jobs ---------------------------------------------------------------------------------
class OcrJobs:
    """One OCR process at a time; further requests wait in a queue."""

    def __init__(self):
        self.lock = threading.Lock()
        self.procs = {}
        self.queue = deque()

    def _dir(self, file_hash):
        return os.path.join(JOBS_DIR, file_hash)

    def _read(self, file_hash):
        import json

        try:
            with open(os.path.join(self._dir(file_hash), "status.json")) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _reap(self):
        for file_hash, proc in list(self.procs.items()):
            code = proc.poll()
            if code is None:
                continue
            del self.procs[file_hash]
            status = self._read(file_hash)
            if not status or status.get("state") not in ("done", "failed"):
                import json

                os.makedirs(self._dir(file_hash), exist_ok=True)
                with open(os.path.join(self._dir(file_hash), "status.json"), "w") as fh:
                    json.dump(
                        {"state": "failed", "error": f"OCR stopped unexpectedly (exit code {code})"}, fh
                    )

    def _pump(self):
        self._reap()
        while self.queue and not self.procs:
            file_hash = self.queue.popleft()
            path = book_pdf(file_hash)
            if not path:
                continue
            out_dir = self._dir(file_hash)
            shutil.rmtree(out_dir, ignore_errors=True)
            os.makedirs(out_dir, exist_ok=True)
            app.logger.info("starting OCR for %s", file_hash)
            self.procs[file_hash] = subprocess.Popen(
                [sys.executable, os.path.join(HERE, "ocr_worker.py"), path, out_dir, file_hash + ".pdf"]
            )

    def _cleanup_old(self):
        try:
            for name in os.listdir(JOBS_DIR):
                path = os.path.join(JOBS_DIR, name)
                if name not in self.procs and time.time() - os.path.getmtime(path) > JOB_KEEP_SECONDS:
                    shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass

    def start(self, file_hash, force=False):
        with self.lock:
            self._pump()
            if file_hash in self.procs or file_hash in self.queue:
                return self._status(file_hash)
            existing = self._read(file_hash)
            if existing and existing.get("state") == "done" and not force:
                return existing
            self._cleanup_old()
            shutil.rmtree(self._dir(file_hash), ignore_errors=True)
            self.queue.append(file_hash)
            self._pump()
            return self._status(file_hash)

    def _status(self, file_hash):
        if file_hash in self.queue:
            return {"state": "queued", "position": list(self.queue).index(file_hash) + 1}
        status = self._read(file_hash)
        if file_hash in self.procs:
            return status or {"state": "running", "page": 0, "pages": 0}
        if status and status.get("state") in ("done", "failed"):
            return status
        # A "running" file with no process is left over from a restart: let the caller start again
        return {"state": "none"}

    def status(self, file_hash):
        with self.lock:
            self._pump()
            return self._status(file_hash)

    def result_path(self, file_hash):
        with self.lock:
            status = self._status(file_hash)
        if status.get("state") != "done":
            return None, status
        path = os.path.join(self._dir(file_hash), "book.epub")
        return (path if os.path.isfile(path) else None), status

    def cancel(self, file_hash):
        with self.lock:
            if file_hash in self.queue:
                self.queue.remove(file_hash)
            proc = self.procs.pop(file_hash, None)
            if proc and proc.poll() is None:
                proc.terminate()
            shutil.rmtree(self._dir(file_hash), ignore_errors=True)
            self._pump()


jobs = OcrJobs()


# --- routes -----------------------------------------------------------------------------------
@app.get("/health")
def health():
    return jsonify({"status": "ok", "ocr": ocr_available()})


@app.post("/convert")
def convert():
    upload = request.files.get("file")
    if upload is None:
        return jsonify({"error": "No file provided"}), 400
    data = upload.read()
    if not data.startswith(b"%PDF-"):
        return jsonify({"error": "The file is not a PDF"}), 400
    filename = request.form.get("filename", "") or upload.filename or ""
    try:
        with _fitz_lock:
            result = convert_pdf(data, filename)
    except ConversionError as exc:
        return jsonify({"error": str(exc)}), 422
    except Exception as exc:  # pragma: no cover
        app.logger.exception("conversion failed")
        return jsonify({"error": f"Conversion failed: {exc}"}), 500

    app.logger.info(
        "converted %s: pages=%d chars=%d hasText=%s chapters=%d",
        filename, result.pages, result.chars, result.has_text, result.chapters,
    )
    return jsonify(
        {
            "hasText": result.has_text,
            "reason": result.reason,
            "pages": result.pages,
            "aspect": result.aspect,
            "chars": result.chars,
            "chapters": result.chapters,
            "title": result.title,
            "author": result.author,
            "language": result.language,
            "cover": base64.b64encode(result.cover_jpeg).decode("ascii"),
            "epub": base64.b64encode(result.epub).decode("ascii") if result.epub else "",
        }
    )


@app.post("/ocr/<file_hash>")
def ocr_start(file_hash):
    if not book_pdf(file_hash):
        return jsonify({"error": "PDF not found. Is the books folder mounted in this container?"}), 404
    if not ocr_available():
        return jsonify({"error": "OCR is not available in this container"}), 503
    force = request.args.get("force") == "1"
    return jsonify(jobs.start(file_hash, force=force)), 202


@app.get("/ocr/<file_hash>")
def ocr_status(file_hash):
    if not HASH_RE.match(file_hash):
        return jsonify({"error": "Bad id"}), 400
    return jsonify(jobs.status(file_hash))


@app.get("/ocr/<file_hash>/result")
def ocr_result(file_hash):
    if not HASH_RE.match(file_hash):
        return jsonify({"error": "Bad id"}), 400
    path, status = jobs.result_path(file_hash)
    if status.get("state") != "done":
        return jsonify({"error": "OCR is not finished", "status": status}), 409
    body = {
        "hasText": bool(status.get("hasText")),
        "reason": status.get("reason", ""),
        "chars": status.get("chars", 0),
        "chapters": status.get("chapters", 0),
        "epub": "",
    }
    if body["hasText"]:
        if not path:
            return jsonify({"error": "OCR result is missing"}), 410
        with open(path, "rb") as fh:
            body["epub"] = base64.b64encode(fh.read()).decode("ascii")
    return jsonify(body)


@app.delete("/ocr/<file_hash>")
def ocr_cancel(file_hash):
    if not HASH_RE.match(file_hash):
        return jsonify({"error": "Bad id"}), 400
    jobs.cancel(file_hash)
    return "", 204


@app.get("/info/<file_hash>")
def info(file_hash):
    path = book_pdf(file_hash)
    if not path:
        return jsonify({"error": "PDF not found"}), 404
    try:
        with _fitz_lock:
            return jsonify(pdf_info(path))
    except ConversionError as exc:
        return jsonify({"error": str(exc)}), 422


@app.get("/pages/<file_hash>/<int:number>")
def page_image(file_hash, number):
    path = book_pdf(file_hash)
    if not path:
        return jsonify({"error": "PDF not found"}), 404
    try:
        width = max(300, min(int(request.args.get("w", "1000")), 2400))
    except ValueError:
        width = 1000
    try:
        with _fitz_lock:
            jpeg = render_page(path, number, width)
    except ConversionError as exc:
        return jsonify({"error": str(exc)}), 404
    return Response(jpeg, mimetype="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
