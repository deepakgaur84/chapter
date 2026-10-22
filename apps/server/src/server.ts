import { buildApp } from './app';
import { config } from './core/config';
import { connectDatabase, disconnectDatabase } from './core/database';
import { disconnectRedis } from './core/redis';
import { ensureStorageDirectories } from './core/storage';
import { ocrService } from './modules/books/ocr.service';
import { audioPrepService } from './modules/tts/audio-prep.service';
import { libraryService } from './modules/library/library.service';
import { migrateToWorkFolder } from './core/storage-migration';

async function start() {
  try {
    // Initialize storage
    await ensureStorageDirectories();

    // Connect to database (continue even if it fails)
    try {
      await connectDatabase();
    } catch (dbError) {
      console.warn('⚠️  Database connection failed, server will start anyway');
      console.warn('   Some features may not work until database is fixed');
    }

    // Build and start app
    const app = await buildApp();

    await app.listen({
      port: config.port,
      host: '0.0.0.0',
    });

    console.log(`🚀 Server running on port ${config.port}`);
    console.log(`📚 Environment: ${config.nodeEnv}`);

    // Move files kept by an earlier version into the work folder (if one is set), then scan the
    // read-only books folder in the background. Books appear in the library as they are added.
    (async () => {
      try {
        await migrateToWorkFolder();
      } catch (error) {
        console.error('Moving files to the work folder failed:', error);
      }
      if (config.library.scanOnStartup) await libraryService.startScan();
    })();

    // Pick up scanned PDFs whose text recognition was interrupted by a restart
    ocrService.resumePending().catch((error) => {
      console.error('Could not resume text recognition:', error);
    });

    // Start the "prepare audio" schedule, and continue any preparation a restart interrupted
    audioPrepService.start().catch((error) => {
      console.error('Could not start the audio preparation schedule:', error);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await disconnectDatabase();
  await disconnectRedis();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await disconnectDatabase();
  await disconnectRedis();
  process.exit(0);
});

start();
