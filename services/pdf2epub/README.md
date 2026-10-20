# pdf2epub

Small service that turns a text PDF into a reflowable EPUB for Chapter, and tells Chapter when a
PDF is a scan with no readable text.

- `POST /convert` (multipart: `file`, optional `filename`) returns JSON with `hasText`, `pages`,
  `title`, `author`, a base64 `cover` (JPEG of page 1) and, when there is text, a base64 `epub`.
- `GET /health`

What it does to the text: removes page numbers and running headers/footers, joins wrapped lines
and repairs words split with a hyphen at a line end, joins paragraphs cut by a page or column
break, and finds chapters from the PDF outline (bookmarks), else from large headings, else in
groups of 15 pages.

A PDF counts as scanned when it averages under 30 characters of text per page, or fewer than 25%
of its pages have any text.

Limits: tables, footnotes and unusual layouts come out rougher. There is no OCR. PyMuPDF is AGPL
licensed, which is fine for a private install.
