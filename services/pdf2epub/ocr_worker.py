"""Runs OCR for one book in its own process.

Tesseract is slow and heavy. Running it in a separate, low-priority process means a long OCR job
cannot freeze the web service or the page viewer, and a crash only fails that one job.

Usage: python ocr_worker.py <pdf path> <output dir> <file name>
Writes <output dir>/status.json while it works and <output dir>/book.epub when done.
"""

import json
import os
import sys
import traceback

from converter import ConversionError, convert_pdf_path


def write_status(out_dir, **data):
    path = os.path.join(out_dir, "status.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)  # readers never see a half-written file


def main():
    pdf_path, out_dir, filename = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        os.nice(10)  # leave the CPU to audio generation and the web UI
    except OSError:
        pass

    write_status(out_dir, state="running", page=0, pages=0)
    try:
        result = convert_pdf_path(
            pdf_path,
            filename,
            ocr=True,
            progress=lambda page, pages: write_status(out_dir, state="running", page=page, pages=pages),
        )
        if result.has_text:
            with open(os.path.join(out_dir, "book.epub"), "wb") as fh:
                fh.write(result.epub)
        write_status(
            out_dir,
            state="done",
            page=result.pages,
            pages=result.pages,
            hasText=result.has_text,
            reason=result.reason,
            chars=result.chars,
            chapters=result.chapters,
        )
    except ConversionError as exc:
        write_status(out_dir, state="failed", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        write_status(out_dir, state="failed", error=f"OCR failed: {exc}")


if __name__ == "__main__":
    main()
