"""HTTP wrapper around converter.py. One conversion at a time (PyMuPDF + small NAS)."""

import base64
import logging
import threading

from flask import Flask, jsonify, request

from converter import ConversionError, convert_pdf

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
_lock = threading.Lock()


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


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
        with _lock:
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
            "pages": result.pages,
            "chars": result.chars,
            "chapters": result.chapters,
            "title": result.title,
            "author": result.author,
            "language": result.language,
            "cover": base64.b64encode(result.cover_jpeg).decode("ascii"),
            "epub": base64.b64encode(result.epub).decode("ascii") if result.epub else "",
        }
    )
