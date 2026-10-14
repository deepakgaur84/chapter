#!/usr/bin/env python3
"""
Kokoro TTS HTTP Service
Wraps the Kokoro TTS model in a simple HTTP API.

Long text is split into sentence-sized chunks before synthesis, and any
chunk that still hits Kokoro's 510-phoneme limit is split in half and retried.
Without this, a long paragraph is truncated or crashes with
"IndexError: index 510 is out of bounds for axis 0 with size 510".
"""

import io
import os
import wave
import re
import numpy as np
from flask import Flask, request, jsonify, send_file
from kokoro_onnx import Kokoro

app = Flask(__name__)

# Initialize Kokoro TTS (loaded once at startup)
print("Loading Kokoro TTS model...")
# KOKORO_MODEL_PATH selects the model file (the Docker image sets it to the int8 quantized model).
# If it is not set, the full-precision model in the cache folder is used.
model_path = os.environ.get("KOKORO_MODEL_PATH") or os.path.expanduser("~/.cache/kokoro/kokoro-v1.0.onnx")
voices_path = os.path.expanduser("~/.cache/kokoro/voices.bin")
print(f"Using model file: {model_path}")

# KOKORO_THREADS limits how many CPU threads speech generation may use, which caps CPU load.
# Docker's "cpus" limit does not work on every kernel (Synology DSM refuses it), so the limit is
# applied here instead. If it is not set, ONNX Runtime uses every core (the default).
try:
    kokoro_threads = int(os.environ.get("KOKORO_THREADS", "0") or 0)
except ValueError:
    kokoro_threads = 0

if kokoro_threads > 0:
    import onnxruntime as ort

    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = kokoro_threads
    session_options.inter_op_num_threads = 1
    print(f"Limiting speech generation to {kokoro_threads} CPU thread(s)")
    session = ort.InferenceSession(
        model_path, sess_options=session_options, providers=["CPUExecutionProvider"]
    )
    kokoro = Kokoro.from_session(session, voices_path)
else:
    kokoro = Kokoro(model_path, voices_path)

print("Kokoro TTS model loaded successfully!")

# Default settings
DEFAULT_SPEED = 1.0
DEFAULT_VOICE = 'af_bella'

# Safe maximum characters per synthesis chunk (limit is 510 phonemes)
MAX_CHARS = 300

# Voice mapping (kokoro-onnx uses these voice codes)
VOICE_MAP = {
    'af_bella': 'af_bella',
    'af_nicole': 'af_nicole',
    'af_sarah': 'af_sarah',
    'af_sky': 'af_sky',
    'am_adam': 'am_adam',
    'am_michael': 'am_michael',
    'bf_emma': 'bf_emma',
    'bf_isabella': 'bf_isabella',
    'bm': 'bm',
}


def split_long_piece(piece, limit):
    """Split one over-long sentence on spaces (hard cut if there are no spaces)."""
    out = []
    current = ''
    for word in piece.split(' '):
        if len(word) > limit:
            if current:
                out.append(current)
                current = ''
            out.extend(word[i:i + limit] for i in range(0, len(word), limit))
        elif current and len(current) + 1 + len(word) > limit:
            out.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        out.append(current)
    return out


def split_text(text, limit=MAX_CHARS):
    """Split text into chunks of at most `limit` characters, preferring sentence ends."""
    text = text.strip()
    if len(text) <= limit:
        return [text] if text else []
    pieces = re.split(r'(?<=[.!?;:])\s+', text)
    chunks = []
    current = ''
    for piece in pieces:
        if len(piece) > limit:
            if current:
                chunks.append(current)
                current = ''
            chunks.extend(split_long_piece(piece, limit))
        elif current and len(current) + 1 + len(piece) > limit:
            chunks.append(current)
            current = piece
        else:
            current = f"{current} {piece}".strip()
    if current:
        chunks.append(current)
    return chunks


def synthesize_chunk(text, voice, speed):
    """Synthesize one chunk. If it overflows the 510-entry limit, split it and retry."""
    try:
        return kokoro.create(text, voice=voice, speed=speed)
    except IndexError as error:
        if '510' not in str(error) or len(text) < 2:
            raise
        mid = len(text) // 2
        candidates = [i for i in (text.rfind(' ', 0, mid), text.find(' ', mid)) if i > 0]
        split_at = min(candidates, key=lambda i: abs(i - mid)) if candidates else mid
        left = text[:split_at].strip()
        right = text[split_at:].strip()
        if not left or not right:
            left, right = text[:mid], text[mid:]
        left_audio, left_rate = synthesize_chunk(left, voice, speed)
        right_audio, right_rate = synthesize_chunk(right, voice, speed)
        if left_rate != right_rate:
            raise RuntimeError("Kokoro returned inconsistent sample rates across text chunks")
        return np.concatenate([left_audio, right_audio]), left_rate


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'service': 'kokoro-tts'})


@app.route('/synthesize', methods=['POST'])
def synthesize():
    """
    Synthesize speech from text

    Request JSON:
    {
        "text": "Hello world",
        "voice": "af_bella",
        "speed": 1.0,
        "temperature": 0.7
    }
    """
    try:
        data = request.get_json()

        if not data or 'text' not in data:
            return jsonify({'error': 'Missing required field: text'}), 400

        text = data['text']
        voice = data.get('voice', DEFAULT_VOICE)
        speed = float(data.get('speed', DEFAULT_SPEED))

        # Validate voice
        if voice not in VOICE_MAP:
            return jsonify({'error': f'Invalid voice: {voice}'}), 400

        chunks = [c for c in split_text(text) if c.strip()]
        if not chunks:
            return jsonify({'error': 'Text is empty'}), 400

        # Generate speech chunk by chunk using Kokoro-ONNX
        parts = []
        sample_rate = None
        for chunk in chunks:
            audio_part, rate = synthesize_chunk(chunk, VOICE_MAP[voice], speed)
            if sample_rate is None:
                sample_rate = rate
            elif rate != sample_rate:
                raise RuntimeError("Kokoro returned inconsistent sample rates across text chunks")
            parts.append(audio_part)
        audio = np.concatenate(parts)

        # Convert float32 audio to int16
        audio_int16 = (audio * 32767).astype(np.int16)

        # Convert to WAV format
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_int16.tobytes())

        wav_buffer.seek(0)

        # Calculate duration
        duration = len(audio) / sample_rate

        # Return WAV file with duration header
        response = send_file(
            wav_buffer,
            mimetype='audio/wav',
            as_attachment=False,
            download_name='speech.wav'
        )
        response.headers['X-Audio-Duration'] = str(duration)
        response.headers['X-Sample-Rate'] = str(sample_rate)

        return response

    except Exception as e:
        print(f"Error generating speech: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/voices', methods=['GET'])
def voices():
    """List available voices"""
    return jsonify({
        'voices': list(VOICE_MAP.keys()),
        'default': DEFAULT_VOICE
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"Starting Kokoro TTS server on port {port}...")
    app.run(host='0.0.0.0', port=port, debug=False)
