/**
 * Tracks audio requests made by someone who is listening right now, so the background
 * "prepare audio" job can step aside while they are being served.
 */

let inFlight = 0;
let lastEndedAt = 0;

export function beginInteractive(): void {
  inFlight += 1;
}

export function endInteractive(): void {
  inFlight = Math.max(0, inFlight - 1);
  lastEndedAt = Date.now();
}

/**
 * True while a listener's request is running, or finished less than `quietMs` ago (a listener
 * asks for the next chunk every few seconds, so a short pause between requests is not "idle").
 */
export function isListenerActive(quietMs = 15000): boolean {
  return inFlight > 0 || Date.now() - lastEndedAt < quietMs;
}
