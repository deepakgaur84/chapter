"""PDF -> reflowable EPUB conversion for Chapter.

Text PDFs are turned into an EPUB 2 (cleaned paragraphs, chapters from the PDF outline or
headings). PDFs with no usable text layer (scanned books) are detected and reported, so the
caller can import them with listening disabled instead.
"""

import io
import re
import uuid
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

try:  # newer PyMuPDF name first
    import pymupdf as fitz
except ImportError:  # pragma: no cover
    import fitz


class ConversionError(Exception):
    """The PDF cannot be converted (corrupt, password protected...)."""


# --- tuning -----------------------------------------------------------------------------------
MARGIN_FRACTION = 0.09          # top/bottom band of the page where headers/footers live
REPEAT_FRACTION = 0.25          # a margin line on >= 25% of pages is a running header/footer
CHAPTER_HEADING_RATIO = 1.5     # heading size relative to body text that starts a chapter
SUB_HEADING_RATIO = 1.2         # smaller headings stay inside the chapter
MAX_HEADING_CHARS = 150
FALLBACK_PAGES_PER_SECTION = 15
MIN_CHARS_PER_PAGE = 30         # below this average the PDF is treated as scanned
MIN_TEXT_PAGE_SHARE = 0.25      # share of pages that must carry text
COVER_WIDTH_PX = 600

LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl"}
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f  ]")
_PAGE_NUMBER = re.compile(
    r"^\s*[-–— ]*(page\s+)?(\d{1,5}|[ivxlcdm]{1,8})([-–— ]*|\s+of\s+\d+\s*)$",
    re.IGNORECASE,
)
_TERMINAL = re.compile(r"[.!?…\"”’»)\]:]\s*$")


@dataclass
class Item:
    kind: str            # "p" | "h1" | "h2"
    text: str
    page: int            # 0-based
    size: float = 0.0


@dataclass
class Chapter:
    title: str
    items: list = field(default_factory=list)


@dataclass
class ConversionResult:
    has_text: bool
    pages: int
    chars: int
    title: str
    author: str
    language: str
    cover_jpeg: bytes
    epub: bytes
    chapters: int


# --- text helpers -----------------------------------------------------------------------------
def clean_text(text):
    for lig, plain in LIGATURES.items():
        text = text.replace(lig, plain)
    text = _CONTROL.sub("", text)
    text = text.replace(" ", " ")
    return re.sub(r"[ \t]+", " ", text).strip()


def join_lines(lines):
    """Join wrapped lines of one block, repairing words split with a hyphen at the line end."""
    out = ""
    for raw in lines:
        line = clean_text(raw)
        if not line:
            continue
        if not out:
            out = line
        elif out.endswith("­"):
            out = out[:-1] + line
        elif re.search(r"[A-Za-z]-$", out) and line[:1].islower():
            out = out[:-1] + line
        else:
            out += " " + line
    return out


def _norm(text):
    return re.sub(r"\W+", " ", text.lower()).strip()


# --- extraction -------------------------------------------------------------------------------
@dataclass
class RawBlock:
    page: int
    text: str
    size: float
    lines: int
    margin: bool


def _extract_blocks(doc):
    blocks = []
    for pno in range(doc.page_count):
        page = doc[pno]
        height = page.rect.height or 1.0
        try:
            data = page.get_text("dict")
        except Exception:
            continue
        for b in data.get("blocks", []):
            if b.get("type") != 0:
                continue
            lines, sizes = [], Counter()
            for ln in b.get("lines", []):
                spans = ln.get("spans", [])
                txt = "".join(s.get("text", "") for s in spans)
                if not txt.strip():
                    continue
                lines.append(txt)
                for s in spans:
                    sizes[round(s.get("size", 0.0), 1)] += len(s.get("text", "").strip())
            text = join_lines(lines)
            if not text:
                continue
            size = sizes.most_common(1)[0][0] if sizes else 0.0
            y0, y1 = b["bbox"][1], b["bbox"][3]
            margin = y1 <= height * MARGIN_FRACTION or y0 >= height * (1 - MARGIN_FRACTION)
            blocks.append(RawBlock(pno, text, size, len(lines), margin))
    return blocks


def _drop_running_text(blocks, page_count):
    """Remove page numbers and headers/footers that repeat across the book."""
    seen = {}
    for b in blocks:
        if b.margin:
            key = re.sub(r"\d+", "#", b.text.lower()).strip()
            seen.setdefault(key, set()).add(b.page)
    threshold = max(3, int(page_count * REPEAT_FRACTION))
    repeated = {k for k, pages in seen.items() if len(pages) >= threshold}
    kept = []
    for b in blocks:
        if b.margin:
            if _PAGE_NUMBER.match(b.text):
                continue
            if re.sub(r"\d+", "#", b.text.lower()).strip() in repeated:
                continue
        kept.append(b)
    return kept


def _body_size(blocks):
    weight = Counter()
    for b in blocks:
        if not b.margin and b.size:
            weight[b.size] += len(b.text)
    return weight.most_common(1)[0][0] if weight else 0.0


def _to_items(blocks, body):
    items = []
    for b in blocks:
        is_heading = (
            body > 0
            and b.size >= body * SUB_HEADING_RATIO
            and len(b.text) <= MAX_HEADING_CHARS
            and b.lines <= 3
        )
        if is_heading:
            kind = "h1" if b.size >= body * CHAPTER_HEADING_RATIO else "h2"
            items.append(Item(kind, b.text, b.page, b.size))
        else:
            items.append(Item("p", b.text, b.page, b.size))
    return items


def _merge_paragraphs(items):
    """Join paragraphs that were cut by a column or page break."""
    merged = []
    for it in items:
        prev = merged[-1] if merged else None
        if (
            prev is not None
            and it.kind == "p"
            and prev.kind == "p"
            and not _TERMINAL.search(prev.text)
            and it.text[:1].islower()
        ):
            prev.text = prev.text + " " + it.text
        else:
            merged.append(Item(it.kind, it.text, it.page, it.size))
    return merged


# --- chapters ---------------------------------------------------------------------------------
def _toc_entries(doc):
    try:
        toc = [t for t in doc.get_toc(simple=True) if t[2] >= 1 and clean_text(str(t[1]))]
    except Exception:
        return []
    if not toc:
        return []
    pages = max(doc.page_count, 1)
    levels = sorted({t[0] for t in toc})
    chosen = None
    for lvl in levels:
        entries = [t for t in toc if t[0] == lvl]
        if len(entries) >= 3 and pages / len(entries) <= 40:
            chosen = entries
            break
    if chosen is None:
        for lvl in reversed(levels):
            entries = [t for t in toc if t[0] == lvl]
            if len(entries) >= 3:
                chosen = entries
                break
    if chosen is None:
        for lvl in levels:
            entries = [t for t in toc if t[0] == lvl]
            if len(entries) >= 2:
                chosen = entries
                break
    if chosen is None:
        return []
    result, last_page = [], -1
    for _, title, page in chosen:
        pno = min(max(page - 1, 0), doc.page_count - 1)
        if pno == last_page:
            continue  # two entries on one page: the page cannot be split, keep the first
        result.append((clean_text(str(title)), pno))
        last_page = pno
    return result if len(result) >= 2 else []


def _strip_duplicate_title(items, title):
    if items and items[0].kind in ("h1", "h2"):
        a, b = _norm(items[0].text), _norm(title)
        if a and b and (a in b or b in a):
            return items[1:]
    return items


def _chapters_from_toc(entries, items, first_page):
    chapters = []
    starts = [p for _, p in entries]
    if first_page < starts[0]:
        pre = [i for i in items if i.page < starts[0]]
        if sum(len(i.text) for i in pre) > 0:
            chapters.append(Chapter("Front matter", pre))
    for n, (title, start) in enumerate(entries):
        end = starts[n + 1] if n + 1 < len(entries) else 10**9
        body = [i for i in items if start <= i.page < end]
        chapters.append(Chapter(title, _strip_duplicate_title(body, title)))
    return chapters


def _chapters_from_headings(items, page_count):
    h1_positions = [n for n, i in enumerate(items) if i.kind == "h1"]
    if len(h1_positions) < 3 or len(h1_positions) > max(3, page_count * 0.6):
        return []
    chapters, current = [], None
    subtitle_open = False  # a smaller heading right after a chapter heading is its subtitle
    for it in items:
        if it.kind == "h1":
            if current is not None and not current.items:
                current.title = (current.title + ": " + it.text)[:MAX_HEADING_CHARS]
            else:
                current = Chapter(it.text)
                chapters.append(current)
            subtitle_open = True
        elif it.kind == "h2" and current is not None and not current.items and subtitle_open:
            current.title = (current.title + ": " + it.text)[:MAX_HEADING_CHARS]
            subtitle_open = False
        elif current is None:
            current = Chapter("Front matter")
            chapters.append(current)
            current.items.append(it)
        else:
            current.items.append(it)
    return [c for c in chapters if c.items or c.title != "Front matter"]


def _chapters_by_pages(items, page_count):
    chapters = []
    for start in range(0, page_count, FALLBACK_PAGES_PER_SECTION):
        end = min(start + FALLBACK_PAGES_PER_SECTION, page_count)
        body = [i for i in items if start <= i.page < end]
        if body:
            label = f"Pages {start + 1}–{end}" if end > start + 1 else f"Page {start + 1}"
            chapters.append(Chapter(label, body))
    return chapters


def build_chapters(doc, items):
    entries = _toc_entries(doc)
    if entries:
        return _chapters_from_toc(entries, items, 0)
    chapters = _chapters_from_headings(items, doc.page_count)
    if chapters:
        return chapters
    return _chapters_by_pages(items, doc.page_count)


# --- EPUB writer ------------------------------------------------------------------------------
def _xml(text):
    return escape(_CONTROL.sub("", text))


def _chapter_xhtml(chapter):
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" '
        '"http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">',
        '<html xmlns="http://www.w3.org/1999/xhtml"><head>',
        f"<title>{_xml(chapter.title)}</title>",
        '<link rel="stylesheet" type="text/css" href="styles.css"/></head><body>',
        f"<h1>{_xml(chapter.title)}</h1>",
    ]
    for it in chapter.items:
        tag = "h2" if it.kind in ("h1", "h2") else "p"
        parts.append(f"<{tag}>{_xml(it.text)}</{tag}>")
    parts.append("</body></html>")
    return "\n".join(parts)


def build_epub(title, author, language, chapters, cover_jpeg):
    book_id = "urn:uuid:" + str(uuid.uuid4())
    manifest, spine, navpoints = [], [], []
    files = {}
    for n, ch in enumerate(chapters, start=1):
        name = f"ch{n:04d}.xhtml"
        files[f"OEBPS/{name}"] = _chapter_xhtml(ch).encode("utf-8")
        manifest.append(f'<item id="ch{n}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="ch{n}"/>')
        navpoints.append(
            f'<navPoint id="np{n}" playOrder="{n}"><navLabel><text>{_xml(ch.title)}</text>'
            f'</navLabel><content src="{name}"/></navPoint>'
        )
    if cover_jpeg:
        files["OEBPS/cover.jpg"] = cover_jpeg
        manifest.append('<item id="cover-image" href="cover.jpg" media-type="image/jpeg"/>')
    creator = f"<dc:creator>{_xml(author)}</dc:creator>" if author else ""
    cover_meta = '<meta name="cover" content="cover-image"/>' if cover_jpeg else ""
    opf = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f"<dc:title>{_xml(title)}</dc:title>{creator}"
        f"<dc:language>{_xml(language)}</dc:language>"
        f'<dc:identifier id="bookid">{book_id}</dc:identifier>{cover_meta}</metadata>'
        '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        '<item id="css" href="styles.css" media-type="text/css"/>'
        + "".join(manifest)
        + '</manifest><spine toc="ncx">'
        + "".join(spine)
        + "</spine></package>"
    )
    ncx = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
        f'<head><meta name="dtb:uid" content="{book_id}"/></head>'
        f"<docTitle><text>{_xml(title)}</text></docTitle><navMap>"
        + "".join(navpoints)
        + "</navMap></ncx>"
    )
    container = (
        '<?xml version="1.0"?><container version="1.0" '
        'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
        "</rootfiles></container>"
    )
    css = "body{line-height:1.5}h1{font-size:1.5em}h2{font-size:1.2em}p{margin:0 0 1em}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/toc.ncx", ncx, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/styles.css", css, zipfile.ZIP_DEFLATED)
        for path, data in files.items():
            z.writestr(path, data, zipfile.ZIP_DEFLATED)
    return buf.getvalue()


# --- entry point ------------------------------------------------------------------------------
def render_cover(doc):
    try:
        page = doc[0]
        zoom = COVER_WIDTH_PX / (page.rect.width or COVER_WIDTH_PX)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("jpeg", jpg_quality=82)
    except Exception:
        return b""


def _title_from(doc, filename):
    meta = doc.metadata or {}
    title = clean_text(meta.get("title") or "")
    if not title or title.lower() in ("untitled", "microsoft word - document1"):
        stem = re.sub(r"\.pdf$", "", filename or "", flags=re.IGNORECASE)
        title = clean_text(re.sub(r"[_]+", " ", stem)) or "Untitled"
    return title, clean_text(meta.get("author") or "")


def convert_pdf(data, filename=""):
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ConversionError(f"Could not open the PDF: {exc}") from exc
    try:
        if doc.needs_pass:
            raise ConversionError("This PDF is password protected")
        if doc.page_count == 0:
            raise ConversionError("This PDF has no pages")

        title, author = _title_from(doc, filename)
        cover = render_cover(doc)

        blocks = _drop_running_text(_extract_blocks(doc), doc.page_count)
        chars = sum(len(b.text) for b in blocks)
        text_pages = len({b.page for b in blocks if len(b.text) >= MIN_CHARS_PER_PAGE})
        has_text = (
            chars / doc.page_count >= MIN_CHARS_PER_PAGE
            and text_pages / doc.page_count >= MIN_TEXT_PAGE_SHARE
        )
        if not has_text:
            return ConversionResult(False, doc.page_count, chars, title, author, "en", cover, b"", 0)

        items = _merge_paragraphs(_to_items(blocks, _body_size(blocks)))
        chapters = [c for c in build_chapters(doc, items) if c.items or c.title]
        epub = build_epub(title, author, "en", chapters, cover)
        return ConversionResult(
            True, doc.page_count, chars, title, author, "en", cover, epub, len(chapters)
        )
    finally:
        doc.close()
