import { config as dotenvConfig } from 'dotenv';
import path from 'path';

dotenvConfig();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://chapter:password@localhost:5432/chapter',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  storage: {
    booksPath: process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
    audioPath: process.env.AUDIO_CACHE_PATH || path.join(process.cwd(), 'storage', 'audio'),
    audioCacheMaxSize: parseInt(process.env.AUDIO_CACHE_MAX_SIZE || '10737418240', 10),
  },

  tts: {
    kokoroServiceUrl: process.env.KOKORO_SERVICE_URL || 'http://kokoro:5000',
    defaultVoice: process.env.TTS_DEFAULT_VOICE || 'af_bella',
    // Generated speech is stored as MP3 (about 6 times smaller than WAV). Set AUDIO_FORMAT=wav to
    // keep WAV. MP3 needs ffmpeg in the server image; without it the server falls back to WAV.
    audioFormat: (process.env.AUDIO_FORMAT || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3',
    mp3Bitrate: process.env.AUDIO_MP3_BITRATE || '64k',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  upload: {
    maxFileSizeBytes: parseInt(process.env.MAX_UPLOAD_MB || '500', 10) * 1024 * 1024,
  },

  pdf: {
    converterUrl: process.env.PDF_CONVERTER_URL || 'http://pdf2epub:5000',
    // Converting a big PDF can take a while on a NAS
    converterTimeoutMs: parseInt(process.env.PDF_CONVERTER_TIMEOUT || '600000', 10),
    // Scanned PDFs are text-recognised (OCR) in the background. Set OCR_ENABLED=false to turn off.
    ocrEnabled: (process.env.OCR_ENABLED || 'true').toLowerCase() !== 'false',
    // How often the server asks the converter how far OCR has got
    ocrPollMs: parseInt(process.env.OCR_POLL_MS || '5000', 10),
  },

  library: {
    maxWatchedFolders: parseInt(process.env.MAX_WATCHED_FOLDERS || '20', 10),
    scanTimeout: parseInt(process.env.SCAN_TIMEOUT || '300000', 10),
    maxScanDepth: parseInt(process.env.MAX_SCAN_DEPTH || '10', 10),
    defaultLibraryPath:
      process.env.DEFAULT_LIBRARY_PATH ||
      path.join(
        process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
        'library'
      ),
  },
};
