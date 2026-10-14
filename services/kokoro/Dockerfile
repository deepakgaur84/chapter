FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Download Kokoro model files (full-precision model, int8 quantized model, and voices)
RUN mkdir -p /root/.cache/kokoro /app/models && \
    cd /root/.cache/kokoro && \
    wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && \
    wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin && \
    mv voices-v1.0.bin voices.bin && \
    wget -O /app/models/kokoro-v1.0.int8.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx

# Use the faster int8 model by default. Set KOKORO_MODEL_PATH to
# /root/.cache/kokoro/kokoro-v1.0.onnx to use the full-precision model instead.
ENV KOKORO_MODEL_PATH=/app/models/kokoro-v1.0.int8.onnx

# Copy server code
COPY server.py .

# Expose port
EXPOSE 5000

# Run server
CMD ["python", "server.py"]
