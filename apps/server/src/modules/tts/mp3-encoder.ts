import { spawn } from 'child_process';
import { config } from '../../core/config';

/** Content-Type for a stored audio format ("mp3" is served as audio/mpeg) */
export function audioMimeType(format: string): string {
  return format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;
}

const ENCODE_TIMEOUT_MS = 60_000;
let unavailable = false;

/**
 * Convert WAV audio to mono MP3 with ffmpeg. Returns null (and the caller keeps the WAV) if
 * ffmpeg is missing or the conversion fails, so a problem here never loses audio.
 */
export function encodeMp3(wav: Buffer): Promise<Buffer | null> {
  if (unavailable) return Promise.resolve(null);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(
      config.tts.ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'wav', '-i', 'pipe:0',
        '-vn', '-ac', '1',
        '-codec:a', 'libmp3lame', '-b:a', config.tts.mp3Bitrate,
        '-f', 'mp3', 'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const timer = setTimeout(() => {
      console.error('MP3 encoding timed out; keeping WAV');
      child.kill('SIGKILL');
      finish(null);
    }, ENCODE_TIMEOUT_MS);

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        unavailable = true;
        console.error('ffmpeg was not found, so audio is stored as WAV. Install ffmpeg for smaller MP3 files.');
      } else {
        console.error('MP3 encoding failed; keeping WAV:', error.message);
      }
      finish(null);
    });
    child.stdin.on('error', () => {
      // ffmpeg closed its input early; the exit handler reports the failure
    });
    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      const mp3 = Buffer.concat(chunks);
      if (code === 0 && mp3.length > 0) {
        finish(mp3);
      } else {
        console.error(`MP3 encoding failed (ffmpeg exit ${code}); keeping WAV`);
        finish(null);
      }
    });

    child.stdin.end(wav);
  });
}

/** Test helper: forget that ffmpeg was missing */
export function resetMp3EncoderForTests(): void {
  unavailable = false;
}
