FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY converter.py server.py ./

EXPOSE 5000

# One worker, several threads: conversions are serialised by a lock, but /health stays responsive.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "900", "server:app"]
