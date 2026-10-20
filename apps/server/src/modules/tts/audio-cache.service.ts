import path from 'path';
import { prisma } from '../../core/database';
import { config } from '../../core/config';
import { saveFile, readFile, deleteFile, getFileSize } from '../../core/storage';
import { kokoroService } from './kokoro.service';
import { createCacheHash, TextChunk } from './chunker';
import { beginInteractive, endInteractive } from './generation-activity';
import type { KokoroVoice, TTSSettings } from '@chapter/types';

export interface GenerateAudioOptions {
  text: string;
  voiceId: KokoroVoice;
  settings?: TTSSettings;
  bookId: string;
  chapterId?: string;
  startPosition: number;
  endPosition: number;
}

export interface CachedAudio {
  id: string;
  audioPath: string;
  audioDuration: number;
  audioSize: number;
  wordTimestamps?: any[];
}

export class AudioCacheService {
  private cacheDir: string;
  private maxCacheSize: number;

  // Requests for the same audio that arrive while it is being generated share one generation.
  private inFlight = new Map<string, Promise<CachedAudio>>();

  // Speech generation runs one job at a time. Two jobs at once on a CPU-only machine each take
  // twice as long, so nothing finishes sooner and playback stalls longer.
  private generationQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.cacheDir = config.storage.audioPath;
    this.maxCacheSize = config.storage.audioCacheMaxSize;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.generationQueue.then(task);
    this.generationQueue = run.catch(() => undefined);
    return run;
  }

  async getOrGenerateAudio(options: GenerateAudioOptions): Promise<CachedAudio> {
    const contentHash = createCacheHash(options.text, options.voiceId, options.settings);

    const cached = await this.getCachedAudio(contentHash);
    if (cached) {
      await this.updateAccessTime(cached.id);
      return cached;
    }

    const running = this.inFlight.get(contentHash);
    if (running) {
      return running;
    }

    const generation = this.generateAndCache(options, contentHash).finally(() => {
      this.inFlight.delete(contentHash);
    });
    this.inFlight.set(contentHash, generation);

    return generation;
  }

  private async getCachedAudio(contentHash: string): Promise<CachedAudio | null> {
    const cached = await prisma.tTSCache.findUnique({
      where: { contentHash },
    });

    if (!cached) {
      return null;
    }

    return {
      id: cached.id,
      audioPath: cached.audioPath,
      audioDuration: cached.audioDuration,
      audioSize: cached.audioSize,
      wordTimestamps: cached.wordTimestamps as any,
    };
  }

  private async generateAndCache(
    options: GenerateAudioOptions,
    contentHash: string
  ): Promise<CachedAudio> {
    const ttsResult = await this.runExclusive(() =>
      kokoroService.generateSpeech({
        text: options.text,
        voiceId: options.voiceId,
        settings: options.settings,
      })
    );

    const audioFileName = `${contentHash}.${ttsResult.format}`;
    const audioPath = path.join(this.cacheDir, audioFileName);
    await saveFile(audioPath, ttsResult.audioData);

    const audioSize = ttsResult.audioData.length;

    let cached;
    try {
      cached = await prisma.tTSCache.create({
        data: {
          contentHash,
          bookId: options.bookId,
          chapterId: options.chapterId,
          startPosition: options.startPosition,
          endPosition: options.endPosition,
          textContent: options.text,
          voiceId: options.voiceId,
          settings: options.settings as any,
          audioPath,
          audioFormat: ttsResult.format,
          audioSize,
          audioDuration: ttsResult.duration,
          wordTimestamps: ttsResult.wordTimestamps as any,
          accessCount: 1,
          lastAccessed: new Date(),
        },
      });
    } catch (error: any) {
      // Another request stored the same audio first (unique contentHash). Use that row.
      if (error?.code === 'P2002') {
        const existing = await this.getCachedAudio(contentHash);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }

    await this.evictIfNeeded();

    return {
      id: cached.id,
      audioPath: cached.audioPath,
      audioDuration: cached.audioDuration,
      audioSize: cached.audioSize,
      wordTimestamps: ttsResult.wordTimestamps,
    };
  }

  private async updateAccessTime(cacheId: string): Promise<void> {
    await prisma.tTSCache.update({
      where: { id: cacheId },
      data: {
        accessCount: { increment: 1 },
        lastAccessed: new Date(),
      },
    });
  }

  async getCacheSize(): Promise<number> {
    const result = await prisma.tTSCache.aggregate({
      _sum: {
        audioSize: true,
      },
    });

    return result._sum.audioSize || 0;
  }

  /**
   * Books whose audio must never be evicted: ones the person asked to prepare (queued, running,
   * done) or ticked for the scheduled run. Their audio does not count toward the cache limit.
   */
  async getProtectedBookIds(): Promise<string[]> {
    const rows = await prisma.audioPrep.findMany({
      where: {
        OR: [{ selected: true }, { status: { in: ['queued', 'running', 'done'] } }],
      },
      select: { bookId: true },
    });
    return rows.map((row) => row.bookId);
  }

  private async evictIfNeeded(): Promise<void> {
    const protectedIds = await this.getProtectedBookIds();
    const unprotected = protectedIds.length > 0 ? { bookId: { notIn: protectedIds } } : {};

    const result = await prisma.tTSCache.aggregate({
      where: unprotected,
      _sum: { audioSize: true },
    });
    const currentSize = result._sum.audioSize || 0;

    if (currentSize <= this.maxCacheSize) {
      return;
    }

    const sizeToFree = currentSize - this.maxCacheSize;

    const entriesToEvict = await prisma.tTSCache.findMany({
      where: unprotected,
      orderBy: {
        lastAccessed: 'asc',
      },
      take: 100, // Process in batches
    });

    let freedSize = 0;

    for (const entry of entriesToEvict) {
      if (freedSize >= sizeToFree) {
        break;
      }

      try {
        await deleteFile(entry.audioPath);
        await prisma.tTSCache.delete({
          where: { id: entry.id },
        });

        freedSize += entry.audioSize;
      } catch (error) {
        console.error('Failed to evict cache entry:', error);
      }
    }

    console.log(`Evicted ${freedSize} bytes from TTS cache`);
  }

  /** Delete all stored audio of one book (files and rows). Returns how many chunks were removed. */
  async deleteBookAudio(bookId: string): Promise<number> {
    const entries = await prisma.tTSCache.findMany({
      where: { bookId },
      select: { id: true, audioPath: true },
    });

    for (const entry of entries) {
      try {
        await deleteFile(entry.audioPath);
      } catch (error) {
        console.error('Failed to delete audio file:', error);
      }
    }

    await prisma.tTSCache.deleteMany({ where: { bookId } });
    return entries.length;
  }

  async streamAudio(cacheId: string): Promise<Buffer> {
    const cached = await prisma.tTSCache.findUnique({
      where: { id: cacheId },
    });

    if (!cached) {
      throw new Error('Audio not found in cache');
    }

    await this.updateAccessTime(cacheId);

    return await readFile(cached.audioPath);
  }

  async generateChapterAudio(
    bookId: string,
    chapterId: string,
    chunks: TextChunk[],
    voiceId: KokoroVoice,
    settings?: TTSSettings
  ): Promise<CachedAudio[]> {
    const results: CachedAudio[] = [];

    if (chunks.length === 0) {
      return results;
    }

    // Generate first few chunks upfront to provide a buffer for playback
    const INITIAL_CHUNKS = Math.min(3, chunks.length);

    for (let i = 0; i < INITIAL_CHUNKS; i++) {
      try {
        const audio = await this.getOrGenerateAudio({
          text: chunks[i].text,
          voiceId,
          settings,
          bookId,
          chapterId,
          startPosition: chunks[i].startPosition,
          endPosition: chunks[i].endPosition,
        });
        results.push(audio);
      } catch (error) {
        console.error(`Generation failed for chunk ${i}:`, error);
      }
    }

    // Generate remaining chunks in background
    if (chunks.length > INITIAL_CHUNKS) {
      setImmediate(async () => {
        for (let i = INITIAL_CHUNKS; i < chunks.length; i++) {
          try {
            await this.getOrGenerateAudio({
              text: chunks[i].text,
              voiceId,
              settings,
              bookId,
              chapterId,
              startPosition: chunks[i].startPosition,
              endPosition: chunks[i].endPosition,
            });
          } catch (error) {
            console.error(`Background generation failed for chunk ${i}:`, error);
          }
        }
      });
    }

    return results;
  }

  async generateChunkOnDemand(
    bookId: string,
    chapterId: string,
    chunk: TextChunk,
    voiceId: KokoroVoice,
    settings?: TTSSettings
  ): Promise<CachedAudio> {
    // Someone is listening: the background "prepare audio" job steps aside while this runs
    beginInteractive();
    try {
      return await this.getOrGenerateAudio({
        text: chunk.text,
        voiceId,
        settings,
        bookId,
        chapterId,
        startPosition: chunk.startPosition,
        endPosition: chunk.endPosition,
      });
    } finally {
      endInteractive();
    }
  }

  async getCacheStats() {
    const totalEntries = await prisma.tTSCache.count();
    const totalSize = await this.getCacheSize();

    const recentEntries = await prisma.tTSCache.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      },
    });

    return {
      totalEntries,
      totalSize,
      totalSizeMB: Math.round(totalSize / 1024 / 1024),
      maxSize: this.maxCacheSize,
      maxSizeMB: Math.round(this.maxCacheSize / 1024 / 1024),
      utilizationPercent: Math.round((totalSize / this.maxCacheSize) * 100),
      recentEntries,
    };
  }

  async clearCache(): Promise<void> {
    const entries = await prisma.tTSCache.findMany();

    for (const entry of entries) {
      try {
        await deleteFile(entry.audioPath);
      } catch (error) {
        console.error('Failed to delete audio file:', error);
      }
    }

    await prisma.tTSCache.deleteMany();

    // Nothing is prepared any more
    await prisma.audioPrep.updateMany({
      data: { status: 'idle', doneChunks: 0, totalChunks: 0, error: null },
    });
  }
}

export const audioCacheService = new AudioCacheService();
