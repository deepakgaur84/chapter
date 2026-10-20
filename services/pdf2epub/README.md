# pdf2epub

Sidecar service that lets Chapter read PDFs.

- Text PDFs are converted to a reflowable EPUB (`POST /convert`), so reading and listening work
  as for any EPUB.
- Scanned PDFs (no text) are reported as such. Chapter shows their pages as images
  (`GET /pages/<hash>/<n>?w=<px>`) and the sidecar recognises the text in the background with
  Tesseract OCR (`POST/GET/DELETE /ocr/<hash>`, `GET /ocr/<hash>/result`). When it works, the
  book becomes a normal readable, listenable book. If not, the page viewer stays.
- `GET /info/<hash>` gives page count and shape. `GET /health` returns `{"status","ocr"}`.

PDFs are read from the shared books folder (`BOOKS_DIR`, default `/data/books`), so mount the
Chapter data volume into this container read-only (see the stack additions).

Settings (environment): `OCR_LANG` (default `eng`), `OCR_DPI` (default 200), `BOOKS_DIR`,
`JOBS_DIR`. Other languages need the matching `tesseract-ocr-<lang>` package added in the
Dockerfile, then `OCR_LANG=eng+<lang>`.

Text cleanup: removes page numbers and running headers/footers, joins wrapped lines, repairs
hyphenated words, joins paragraphs cut by page breaks, and finds chapters from the PDF outline,
else large headings, else groups of 15 pages. A PDF counts as scanned when it averages under 30
characters per page or fewer than 25% of its pages have text. OCR output that looks like noise
is rejected.

OCR runs one book at a time at low priority and is slow on a NAS (seconds per page); it competes
with TTS for CPU. PyMuPDF is AGPL licensed, fine for a private install.
