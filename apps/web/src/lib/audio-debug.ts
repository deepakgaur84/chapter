/**
 * A small in-memory log of what the audio player is doing (context state changes, how long each
 * chunk took to download and decode, when playback waits for audio, going offline, and so on).
 *
 * It exists so that problems on a phone, where there is no developer console, can be diagnosed:
 * tap the time display in the player five times to show the log on screen.
 * Logging is cheap (a short string in a ring buffer) and nothing is sent anywhere.
 */

export interface AudioLogEntry {
  /** Milliseconds since the page was loaded */
  at: number;
  message: string;
}

const MAX_ENTRIES = 120;
const entries: AudioLogEntry[] = [];
const listeners = new Set<() => void>();
const startedAt = Date.now();

export function audioLog(message: string): void {
  entries.push({ at: Date.now() - startedAt, message });
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
  listeners.forEach((listener) => listener());
}

export function getAudioLog(): AudioLogEntry[] {
  return entries.slice();
}

export function clearAudioLog(): void {
  entries.length = 0;
  listeners.forEach((listener) => listener());
}

export function subscribeAudioLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatLogTime(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
