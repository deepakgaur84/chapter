import { prisma } from '../../core/database';
import { ttsChunker, createCacheHash, type TextChunk } from './chunker';
import { audioCacheService } from './audio-cache.service';
import { isListenerActive } from './generation-activity';
import type { KokoroVoice } from '@chapter/types';

/**
 * "Prepare audio": generates every audio chunk of a book ahead of time and keeps it, so listening
 * is seamless instead of waiting for each piece to be made.
 *
 *  - One chunk at a time, books one after another, and the job steps aside while someone is
 *    listening to something that is not prepared yet.
 *  - Chunks that already exist are skipped, so running it again only does what is missing, and a
 *    book that is complete costs almost nothing.
 *  - A schedule (time of day + time zone, set in Settings) runs it for the ticked books.
 */

export type PrepStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export interface PrepVoice {
  voiceId: string;
  speed: number;
  temperature: number;
}

export interface PrepSettings extends PrepVoice {
  enabled: boolean;
  time: string; // HH:MM
  timezone: string;
  lastRunAt: string | null;
  lastRunNote: string | null;
}

const MAX_ATTEMPTS = 3;
const SCHEDULE_CHECK_MS = 60_000;
const SCHEDULE_WINDOW_MINUTES = 180; // a missed start is caught up for this long, then skipped
const HASH_BATCH = 400;
const PROGRESS_SAVE_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Date (YYYY-MM-DD) and minutes since midnight, in a time zone */
export function zonedNow(timezone: string, at: Date = new Date()): { date: string; minutes: number } {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
  };
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

/** Whether the scheduled run is due: today's time has passed (within the window) and has not run today */
export function isScheduleDue(
  settings: { enabled: boolean; time: string; timezone: string; lastRunDate: string | null },
  at: Date = new Date()
): boolean {
  if (!settings.enabled) return false;
  const now = zonedNow(settings.timezone, at);
  if (settings.lastRunDate === now.date) return false;
  const since = now.minutes - toMinutes(settings.time);
  return since >= 0 && since < SCHEDULE_WINDOW_MINUTES;
}

interface PlannedChunk {
  chapterId: string;
  chunk: TextChunk;
  hash: string;
}

export class AudioPrepService {
  private queue: string[] = [];
  private current: string | null = null;
  private cancelled = new Set<string>();
  private draining = false;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private run = { books: 0, chunks: 0, failed: 0, scheduled: false };
  /** Pause before a failed chunk is tried again (multiplied by the attempt number) */
  retryDelayMs = 2000;

  // ---- settings ----------------------------------------------------------------------------

  private async loadSettingsRow() {
    return prisma.audioPrepSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global' },
      update: {},
    });
  }

  async getSettings(): Promise<PrepSettings> {
    const row = await this.loadSettingsRow();
    return {
      enabled: row.enabled,
      time: row.time,
      timezone: row.timezone,
      voiceId: row.voiceId,
      speed: row.speed,
      temperature: row.temperature,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastRunNote: row.lastRunNote,
    };
  }

  async updateSettings(
    patch: Partial<Pick<PrepSettings, 'enabled' | 'time' | 'timezone' | 'voiceId' | 'speed' | 'temperature'>>
  ): Promise<PrepSettings> {
    if (patch.time !== undefined && !isValidTime(patch.time)) throw new Error('Time must be HH:MM');
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
      throw new Error('Unknown time zone');
    }
    await this.loadSettingsRow();
    await prisma.audioPrepSettings.update({ where: { id: 'global' }, data: patch });
    return this.getSettings();
  }

  // ---- status for the web app -----------------------------------------------------------------

  async listForUser(userId: string) {
    const links = await prisma.userBook.findMany({
      where: { userId },
      select: { book: { select: { id: true, title: true, author: true, hasText: true } } },
    });
    const books = links.map((link) => link.book);
    const ids = books.map((book) => book.id);

    const [preps, stats] = await Promise.all([
      prisma.audioPrep.findMany({ where: { bookId: { in: ids } } }),
      prisma.tTSCache.groupBy({
        by: ['bookId'],
        where: { bookId: { in: ids } },
        _count: { _all: true },
        _sum: { audioSize: true },
      }),
    ]);
    const prepByBook = new Map(preps.map((row) => [row.bookId, row]));
    const statByBook = new Map(stats.map((row) => [row.bookId, row]));

    return {
      settings: await this.getSettings(),
      running: this.current,
      books: books
        .map((book) => {
          const prep = prepByBook.get(book.id);
          const stat = statByBook.get(book.id);
          return {
            id: book.id,
            title: book.title,
            author: book.author,
            hasText: book.hasText,
            selected: prep?.selected ?? false,
            status: (prep?.status ?? 'idle') as PrepStatus,
            doneChunks: prep?.doneChunks ?? 0,
            totalChunks: prep?.totalChunks ?? 0,
            voiceId: prep?.voiceId ?? null,
            error: prep?.error ?? null,
            audioChunks: stat?._count._all ?? 0,
            audioBytes: stat?._sum.audioSize ?? 0,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  }

  private async assertAccess(userId: string, bookId: string) {
    const link = await prisma.userBook.findUnique({
      where: { userId_bookId: { userId, bookId } },
      include: { book: { select: { hasText: true } } },
    });
    if (!link) throw new AudioPrepError('Book not found', 404);
    return link.book;
  }

  // ---- actions --------------------------------------------------------------------------------

  /** Prepare one book now, using the voice the person has selected */
  async prepareBook(userId: string, bookId: string, voice: PrepVoice): Promise<void> {
    const book = await this.assertAccess(userId, bookId);
    if (!book.hasText) {
      throw new AudioPrepError('This book has no readable text yet, so there is nothing to read aloud', 400);
    }
    await this.updateSettings(voice);
    await this.enqueue(bookId);
  }

  /** Tick or untick books for the scheduled run */
  async setSelected(userId: string, bookIds: string[], selected: boolean, voice?: PrepVoice) {
    const links = await prisma.userBook.findMany({
      where: { userId, bookId: { in: bookIds } },
      select: { bookId: true, book: { select: { hasText: true } } },
    });
    const allowed = links.filter((link) => link.book.hasText).map((link) => link.bookId);
    if (voice) await this.updateSettings(voice);
    for (const bookId of allowed) {
      await prisma.audioPrep.upsert({
        where: { bookId },
        create: { bookId, selected },
        update: { selected },
      });
    }
    return allowed.length;
  }

  /** Delete a book's prepared/generated audio. The book is also unticked so it is not made again. */
  async deleteAudio(userId: string, bookId: string): Promise<number> {
    await this.assertAccess(userId, bookId);
    await this.cancel(bookId);
    // If a chunk is being written right now, wait for it so it cannot reappear after the delete
    for (let i = 0; i < 100 && this.current === bookId; i++) await sleep(100);
    const removed = await audioCacheService.deleteBookAudio(bookId);
    await prisma.audioPrep.upsert({
      where: { bookId },
      create: { bookId, status: 'idle', selected: false },
      update: { status: 'idle', selected: false, doneChunks: 0, totalChunks: 0, error: null, voiceId: null },
    });
    return removed;
  }

  async cancelBook(userId: string, bookId: string): Promise<void> {
    await this.assertAccess(userId, bookId);
    await this.cancel(bookId);
  }

  /** Stop a queued or running job (also used when a book is deleted) */
  async cancel(bookId: string): Promise<void> {
    this.queue = this.queue.filter((id) => id !== bookId);
    if (this.current === bookId) this.cancelled.add(bookId);
    await prisma.audioPrep
      .updateMany({
        where: { bookId, status: { in: ['queued', 'running'] } },
        data: { status: 'idle', error: null },
      })
      .catch(() => undefined);
  }

  /** Run the ticked books now (the same thing the schedule does) */
  async runSelectedNow(): Promise<number> {
    return this.enqueueSelected(false);
  }

  private async enqueueSelected(scheduled: boolean): Promise<number> {
    const rows = await prisma.audioPrep.findMany({
      where: { selected: true },
      select: { bookId: true },
    });
    if (!this.draining) this.run = { books: 0, chunks: 0, failed: 0, scheduled };
    for (const row of rows) await this.enqueue(row.bookId);
    return rows.length;
  }

  private async enqueue(bookId: string): Promise<void> {
    if (this.current === bookId || this.queue.includes(bookId)) return;
    this.cancelled.delete(bookId);
    await prisma.audioPrep.upsert({
      where: { bookId },
      create: { bookId, status: 'queued' },
      update: { status: 'queued', error: null },
    });
    this.queue.push(bookId);
    void this.drain();
  }

  // ---- worker ---------------------------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const bookId = this.queue.shift()!;
        this.current = bookId;
        try {
          await this.runBook(bookId);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Audio generation failed';
          console.error(`Prepare audio failed for ${bookId}:`, error);
          this.run.failed += 1;
          await prisma.audioPrep
            .updateMany({ where: { bookId }, data: { status: 'failed', error: message } })
            .catch(() => undefined);
        } finally {
          this.cancelled.delete(bookId);
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
      await this.finishRun();
    }
  }

  private async finishRun(): Promise<void> {
    if (!this.run.scheduled) return;
    const { books, chunks, failed } = this.run;
    const note =
      chunks === 0 && failed === 0
        ? 'Nothing to generate, skipped'
        : `Generated ${chunks} piece${chunks === 1 ? '' : 's'} of audio in ${books} book${books === 1 ? '' : 's'}` +
          (failed > 0 ? `, ${failed} failed` : '');
    this.run = { books: 0, chunks: 0, failed: 0, scheduled: false };
    await prisma.audioPrepSettings
      .update({ where: { id: 'global' }, data: { lastRunAt: new Date(), lastRunNote: note } })
      .catch(() => undefined);
  }

  /** Every chunk of the book, in reading order, exactly as the player splits it */
  private async planBook(bookId: string, voice: PrepVoice): Promise<PlannedChunk[]> {
    const chapters = await prisma.chapter.findMany({
      where: { bookId },
      orderBy: { index: 'asc' },
      select: { id: true, textContent: true, startPosition: true },
    });
    const settings = { speed: voice.speed, temperature: voice.temperature };
    const planned: PlannedChunk[] = [];
    for (const chapter of chapters) {
      for (const chunk of ttsChunker.chunk(chapter.textContent, chapter.startPosition)) {
        planned.push({
          chapterId: chapter.id,
          chunk,
          hash: createCacheHash(chunk.text, voice.voiceId, settings),
        });
      }
    }
    return planned;
  }

  private async findCachedHashes(hashes: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < hashes.length; i += HASH_BATCH) {
      const rows = await prisma.tTSCache.findMany({
        where: { contentHash: { in: hashes.slice(i, i + HASH_BATCH) } },
        select: { contentHash: true },
      });
      rows.forEach((row) => found.add(row.contentHash));
    }
    return found;
  }

  /** Wait while someone is listening to audio that is being made for them */
  private async stepAsideForListener(bookId: string): Promise<void> {
    while (isListenerActive() && !this.cancelled.has(bookId)) {
      await sleep(1500);
    }
  }

  private async runBook(bookId: string): Promise<void> {
    const book = await prisma.book.findUnique({ where: { id: bookId }, select: { id: true, hasText: true } });
    if (!book) return;
    if (!book.hasText) throw new Error('This book has no readable text');

    const voice = await this.getSettings();
    await prisma.audioPrep.updateMany({
      where: { bookId },
      data: { status: 'running', error: null, voiceId: voice.voiceId },
    });

    const planned = await this.planBook(bookId, voice);
    const cached = await this.findCachedHashes(planned.map((item) => item.hash));

    let done = planned.filter((item) => cached.has(item.hash)).length;
    const total = planned.length;
    let savedAt = 0;
    const saveProgress = async (force = false) => {
      if (!force && Date.now() - savedAt < PROGRESS_SAVE_MS) return;
      savedAt = Date.now();
      await prisma.audioPrep
        .updateMany({ where: { bookId }, data: { doneChunks: done, totalChunks: total } })
        .catch(() => undefined);
    };
    await saveProgress(true);

    const settings = { speed: voice.speed, temperature: voice.temperature };
    let generated = 0;

    for (const item of planned) {
      if (this.cancelled.has(bookId)) return;
      if (cached.has(item.hash)) continue;

      await this.stepAsideForListener(bookId);
      if (this.cancelled.has(bookId)) return;

      let attempt = 0;
      for (;;) {
        try {
          await audioCacheService.getOrGenerateAudio({
            text: item.chunk.text,
            voiceId: voice.voiceId as KokoroVoice,
            settings,
            bookId,
            chapterId: item.chapterId,
            startPosition: item.chunk.startPosition,
            endPosition: item.chunk.endPosition,
          });
          break;
        } catch (error) {
          attempt += 1;
          if (this.cancelled.has(bookId)) return;
          if (attempt >= MAX_ATTEMPTS) throw error;
          await sleep(this.retryDelayMs * attempt);
        }
      }

      generated += 1;
      done += 1;
      this.run.chunks += 1;
      await saveProgress();
    }

    if (this.cancelled.has(bookId)) return;
    if (generated > 0) this.run.books += 1;
    await prisma.audioPrep.updateMany({
      where: { bookId },
      data: { status: 'done', doneChunks: total, totalChunks: total, error: null, voiceId: voice.voiceId },
    });
  }

  // ---- schedule and restart -------------------------------------------------------------------

  /** Start the clock that triggers the scheduled run, and pick up work interrupted by a restart */
  async start(): Promise<void> {
    if (this.scheduleTimer) return;

    const interrupted = await prisma.audioPrep.findMany({
      where: { status: { in: ['queued', 'running'] } },
      select: { bookId: true },
    });
    for (const row of interrupted) await this.enqueue(row.bookId);

    this.scheduleTimer = setInterval(() => {
      this.checkSchedule().catch((error) => console.error('Audio schedule check failed:', error));
    }, SCHEDULE_CHECK_MS);
    this.scheduleTimer.unref?.();
  }

  async checkSchedule(at: Date = new Date()): Promise<boolean> {
    const row = await this.loadSettingsRow();
    if (!isScheduleDue(row, at)) return false;

    const { date } = zonedNow(row.timezone, at);
    await prisma.audioPrepSettings.update({ where: { id: 'global' }, data: { lastRunDate: date } });
    const count = await this.enqueueSelected(true);
    if (count === 0) {
      await prisma.audioPrepSettings.update({
        where: { id: 'global' },
        data: { lastRunAt: at, lastRunNote: 'No books ticked, skipped' },
      });
    }
    return true;
  }
}

export class AudioPrepError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
  }
}

export const audioPrepService = new AudioPrepService();
