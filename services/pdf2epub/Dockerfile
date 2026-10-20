FROM python:3.11-slim

WORKDIR /app

# Tesseract does the OCR. To read books in other languages, add their packages here
# (for example tesseract-ocr-fra tesseract-ocr-deu) and set OCR_LANG=eng+fra on the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY converter.py ocr_worker.py server.py ./

# Chapter's books folder is mounted here, read-only (see chapter-stack-additions.yaml)
ENV BOOKS_DIR=/data/books

EXPOSE 5000

# One worker (job state lives in memory), several threads so /health and page images stay responsive
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "900", "server:app"]
