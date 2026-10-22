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
    // WORK_PATH is the one folder Chapter writes to (mounted read-write). Inside it:
    //   epubs/   the EPUB of every book (converted from a PDF, or copied from the library)
    //   pdfs/    a working copy of each PDF (the page viewer and text recognition read these)
    //   covers/  cover images
    //   audio/   generated and prepared audio
    //   uploads/ reserved for files added through the web page
    // The books folder (LIBRARY_PATH) is only ever read.
    // Without WORK_PATH the older single-folder layout is used, so existing installs keep working.
    workPath: process.env.WORK_PATH || '',
    // Where earlier versions kept everything. Files found here are moved into the work folder.
    legacyBooksPath: process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
    legacyAudioPath: process.env.AUDIO_CACHE_PATH || path.join(process.cwd(), 'storage', 'audio'),
    booksPath: process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
    epubsPath: process.env.WORK_PATH
      ? path.join(process.env.WORK_PATH, 'epubs')
      : process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
    pdfsPath: process.env.WORK_PATH
      ? path.join(process.env.WORK_PATH, 'pdfs')
      : process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
    coversPath: process.env.WORK_PATH
      ? path.join(process.env.WORK_PATH, 'covers')
      : process.env.BOOK_STORAGE_PATH || path.join(process.cwd(), 'storage', 'books'),
    audioPath: process.env.WORK_PATH
      ? path.join(process.env.WORK_PATH, 'audio')
      : process.env.AUDIO_CACHE_PATH || path.join(process.cwd(), 'storage', 'audio'),
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
    // The folder with your books (.epub and .pdf), mounted read-only. It is scanned in the
    // background when the server starts; nothing in it is ever changed.
    path: process.env.LIBRARY_PATH || '/library',
    scanOnStartup: (process.env.LIBRARY_SCAN_ON_STARTUP || 'true').toLowerCase() !== 'false',
    maxScanDepth: parseInt(process.env.MAX_SCAN_DEPTH || '10', 10),
  },
};
