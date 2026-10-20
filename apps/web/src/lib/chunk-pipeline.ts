/**
 * Chunk pipeline: decides which piece of a chapter to turn into audio next.
 *
 * The server splits a chapter into small chunks (about 50 words each) and returns a "plan":
 * how many chunks there are and which ones already have audio. The pipeline then asks the
 * server to generate chunks one at a time:
 *
 *  - While the player is playing it keeps at least `lookahead` chunks, and about `aheadSeconds`
 *    seconds of audio, ready ahead of the playback position.
 *  - When the player is paused it generates nothing new. The one exception is the chunk the
 *    player is parked on (for example after opening the book), so Play starts quickly.
 *  - Only one chunk is ever being generated at a time.
 *
 * This file has no React in it so it can be tested on its own.
 */

export const WORDS_PER_SECOND = 2.6; // typical narration speed at 1.0x
export const DEFAULT_LOOKAHEAD = 2;
// While playing, keep generating until this many seconds of audio are ready beyond the chunk being
// played (or MAX_AHEAD_CHUNKS chunks ahead). The player waits for part of this before it starts,
// and the rest keeps it from running dry during playback.
export const DEFAULT_AHEAD_SECONDS = 120;
export const MAX_AHEAD_CHUNKS = 12;

export interface PlanChunk {
  index: number;
  startPosition: number;
  endPosition: number;
  wordCount: number;
  cached: boolean;
  id: string | null;
  duration: number | null;
  size: number | null;
}

export interface Plan {
  chapterId: string;
  total: number;
  chunks: PlanChunk[];
}

export interface GeneratedChunk {
  id: string;
  duration: number;
  size: number;
}

/** A chunk as the player sees it. `id` is empty until the audio exists. */
export interface PipelineChunk {
  id: string;
  index: number;
  startPosition: number;
  endPosition: number;
  audioDuration: number; // real length once ready, an estimate before that
  audioSize: number;
  voiceId: string;
  ready: boolean;
}

export interface PipelineOptions {
  plan: Plan;
  voiceId: string;
  speed: number;
  generateChunk: (index: number, signal: AbortSignal) => Promise<GeneratedChunk>;
  onChange: () => void;
  onError?: (message: string | null) => void;
  lookahead?: number;
  aheadSeconds?: number; // audio to keep ready ahead while playing (default 120)
  prepareDelayMs?: number; // wait before preparing a parked chunk (absorbs quick seeks)
  maxAttempts?: number;
  retryDelayMs?: number;
}

export function estimateDuration(wordCount: number, speed: number): number {
  const rate = WORDS_PER_SECOND * (speed > 0 ? speed : 1);
  return Math.max(1, wordCount / rate);
}

/** Key used to remember a chunk position before its audio exists. */
export function chunkKey(index: number): string {
  return `idx:${index}`;
}

/** Find a chunk by its audio id, or by an `idx:N` key. Returns -1 when not found. */
export function resolveChunkIndex(
  chunks: { id: string }[],
  chunkId?: string | null
): number {
  if (!chunkId) return -1;
  if (chunkId.startsWith('idx:')) {
    const n = Number(chunkId.slice(4));
    return Number.isInteger(n) && n >= 0 && n < chunks.length ? n : -1;
  }
  return chunks.findIndex((c) => c.id === chunkId);
}

export class ChunkPipeline {
  private plan: Plan;
  private opts: PipelineOptions;
  private generated = new Map<number, GeneratedChunk>();
  private failures = new Map<number, number>();
  private blocked = new Set<number>();
  private inFlight: number | null = null;
  private want = false;
  private prepare = true;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private controller = new AbortController();
  private disposed = false;

  constructor(options: PipelineOptions) {
    this.plan = options.plan;
    this.opts = options;
    for (const chunk of options.plan.chunks) {
      if (chunk.cached && chunk.id) {
        this.generated.set(chunk.index, {
          id: chunk.id,
          duration: chunk.duration ?? estimateDuration(chunk.wordCount, options.speed),
          size: chunk.size ?? 0,
        });
      }
    }
  }

  get total(): number {
    return this.plan.total;
  }

  isReady(index: number): boolean {
    return this.generated.has(index);
  }

  getChunks(): PipelineChunk[] {
    return this.plan.chunks.map((chunk) => {
      const done = this.generated.get(chunk.index);
      return {
        id: done ? done.id : '',
        index: chunk.index,
        startPosition: chunk.startPosition,
        endPosition: chunk.endPosition,
        audioDuration: done ? done.duration : estimateDuration(chunk.wordCount, this.opts.speed),
        audioSize: done ? done.size : 0,
        voiceId: this.opts.voiceId,
        ready: !!done,
      };
    });
  }

  /**
   * Tell the pipeline what the player is doing.
   * `want` is true while the player is playing (or waiting for audio to play).
   * `cursor` is the chunk the player is on.
   */
  setPlayback(want: boolean, cursor: number): void {
    if (this.disposed) return;

    const pressedPlay = want && !this.want;
    this.want = want;
    this.prepare = true;
    this.cursor = Math.max(0, Math.min(cursor, this.plan.total - 1));

    if (pressedPlay) {
      // Pressing play again is a retry after any earlier failure.
      this.blocked.clear();
      this.failures.clear();
      this.opts.onError?.(null);
    }

    this.schedule();
  }

  /** Stop everything: no new generation until setPlayback is called again. */
  stop(): void {
    if (this.disposed) return;
    this.want = false;
    this.prepare = false;
    this.clearTimers();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.controller.abort();
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delay = this.want ? 0 : this.opts.prepareDelayMs ?? 300;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delay);
  }

  private nextTarget(): number | null {
    if (this.plan.total === 0) return null;
    if (!this.want && !this.prepare) return null;

    const lookahead = this.opts.lookahead ?? DEFAULT_LOOKAHEAD;
    const aheadSeconds = this.opts.aheadSeconds ?? DEFAULT_AHEAD_SECONDS;

    if (!this.want) {
      // paused: only the chunk the player is parked on
      const parked = this.cursor;
      return !this.generated.has(parked) && !this.blocked.has(parked) ? parked : null;
    }

    let ahead = 0; // seconds of audio already generated beyond the chunk being played
    for (let i = this.cursor; i < this.plan.total; i++) {
      const offset = i - this.cursor;
      if (offset > lookahead && (ahead >= aheadSeconds || offset > MAX_AHEAD_CHUNKS)) break;

      const done = this.generated.get(i);
      if (done) {
        if (offset > 0) ahead += done.duration;
        continue;
      }
      if (!this.blocked.has(i)) return i;
    }
    return null;
  }

  private pump(): void {
    if (this.disposed || this.inFlight !== null) return;

    const target = this.nextTarget();
    if (target === null) return;

    this.inFlight = target;

    this.opts.generateChunk(target, this.controller.signal).then(
      (result) => {
        if (this.disposed) return;
        this.inFlight = null;
        this.generated.set(target, result);
        this.failures.delete(target);
        this.opts.onError?.(null);
        this.opts.onChange();
        this.pump();
      },
      (error) => {
        if (this.disposed || this.controller.signal.aborted) return;
        this.inFlight = null;

        const attempts = (this.failures.get(target) ?? 0) + 1;
        this.failures.set(target, attempts);

        const maxAttempts = this.opts.maxAttempts ?? 3;
        if (attempts >= maxAttempts) {
          this.blocked.add(target);
          const message = error instanceof Error ? error.message : 'Could not generate audio';
          this.opts.onError?.(message);
          this.opts.onChange();
          return;
        }

        const delay = (this.opts.retryDelayMs ?? 1000) * attempts;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.pump();
        }, delay);
      }
    );
  }
}
