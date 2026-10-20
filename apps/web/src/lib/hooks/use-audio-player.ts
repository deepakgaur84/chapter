import { useState, useRef, useEffect, useCallback } from 'react';
import { resolveChunkIndex } from '../chunk-pipeline';
import { audioLog } from '../audio-debug';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

// How often the time display and word highlighting are refreshed. Redrawing on every animation
// frame (about 60 times a second) is far more than needed and can make a phone fall behind.
const UI_UPDATE_INTERVAL_MS = 150;

// Decoded audio is large (a 50-word chunk is several MB once decoded). Chunks further behind the
// playhead than this are released, so memory does not grow for the whole length of a chapter.
const KEEP_DECODED_BEHIND = 1;

// If the audio engine stays paused by the system (a call, Siri, switching apps on iOS) for this
// long while the player says "playing", the player pauses itself so the Play button is honest.
const INTERRUPTION_GRACE_MS = 2500;

// Playback starts (and restarts after running dry) only once this many seconds of audio are ready
// ahead of the listening position, unless the rest of the chapter is already ready. Starting on
// the first piece and then stopping for every next piece is far more irritating than one wait.
export const DEFAULT_BUFFER_SECONDS = 45;

export interface AudioChunk {
  id: string; // empty until the audio for this chunk has been generated
  index: number;
  startPosition: number;
  endPosition: number;
  audioDuration: number; // an estimate until the chunk is ready
  audioSize: number;
  voiceId: string;
  ready?: boolean;
}

// A chunk can be played once its audio exists. Chunks without audio yet are waited for.
function isChunkReady(chunk?: AudioChunk): boolean {
  return !!chunk && !!chunk.id && chunk.ready !== false;
}

/**
 * How much audio is ready from a position onwards: real seconds at the current speed, and
 * whether everything up to the end of the chapter is ready.
 */
export function bufferedAhead(
  chunks: AudioChunk[],
  index: number,
  offset: number,
  speed: number
): { seconds: number; allReady: boolean } {
  let audioSeconds = 0;
  let i = index;
  for (; i < chunks.length && isChunkReady(chunks[i]); i++) {
    audioSeconds += Math.max(0, chunks[i].audioDuration - (i === index ? offset : 0));
  }
  return { seconds: audioSeconds / (speed > 0 ? speed : 1), allReady: i >= chunks.length };
}

export interface AudioPlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  isLoading: boolean;
  isBuffering: boolean; // waiting for audio to be generated
  bufferProgress: number; // 0..1 while buffering: how much of the wanted head start is ready
  speed: number;
  volume: number;
  currentChunkIndex: number;
  error: string | null;
  // Chapter-level progress
  chapterCurrentTime: number;
  chapterDuration: number;
}

export interface UseAudioPlayerOptions {
  bookId: string;
  chapterId: string;
  chunks: AudioChunk[];
  onPositionChange?: (position: number, chunkId?: string) => void;
  onChunkChange?: (chunkIndex: number) => void;
  onChunkNeeded?: (chunkIndex: number) => Promise<void>;
  initialChunkId?: string;
  initialTime?: number;
  /** Seconds of audio to have ready before playing (default 45). 0 plays as soon as one piece is ready. */
  bufferSeconds?: number;
}

interface DecodedChunk {
  index: number;
  buffer: AudioBuffer;
}

export function useAudioPlayer({
  bookId,
  chapterId,
  chunks,
  onPositionChange,
  onChunkChange,
  onChunkNeeded,
  initialChunkId,
  initialTime,
  bufferSeconds = DEFAULT_BUFFER_SECONDS,
}: UseAudioPlayerOptions) {
  // Web Audio API refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const nextSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Decoded audio buffer cache
  const decodedBuffersRef = useRef<Map<number, AudioBuffer>>(new Map());
  const pendingDecodes = useRef<Set<number>>(new Set());

  // Playback tracking
  const playbackStartTimeRef = useRef<number>(0); // AudioContext time when playback started
  const chunkStartOffsetRef = useRef<number>(0); // Offset within current chunk when started
  const isPlayingRef = useRef<boolean>(false);
  const currentChunkIndexRef = useRef<number>(0);
  const pendingChunkRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const hasInitializedRef = useRef<boolean>(false);
  const chunksRef = useRef<AudioChunk[]>(chunks);
  const waitingRef = useRef<{ index: number; offset: number } | null>(null);
  const speedRef = useRef<number>(1.0);
  const lastUiUpdateRef = useRef<number>(0);
  const notRunningSinceRef = useRef<number | null>(null);
  const bufferSecondsRef = useRef<number>(bufferSeconds);
  bufferSecondsRef.current = bufferSeconds;

  const [state, setState] = useState<AudioPlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    isLoading: false,
    isBuffering: false,
    bufferProgress: 0,
    speed: 1.0,
    volume: 1.0,
    currentChunkIndex: 0,
    error: null,
    chapterCurrentTime: 0,
    chapterDuration: 0,
  });

  // Keep chunks ref updated so closures always have latest
  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);

  // Calculate total chapter duration from all chunks
  const chapterDuration = chunks.reduce((total, chunk) => total + chunk.audioDuration, 0);

  // Calculate time elapsed before a chunk
  const getTimeBeforeChunk = useCallback(
    (chunkIndex: number) => {
      return chunks.slice(0, chunkIndex).reduce((total, chunk) => total + chunk.audioDuration, 0);
    },
    [chunks]
  );

  // Initialize AudioContext (must be done after user gesture)
  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.connect(audioContextRef.current.destination);
      audioLog(
        `audio engine created: ${audioContextRef.current.state}, ${audioContextRef.current.sampleRate ?? '?'} Hz`
      );
    }
    // Resume if suspended (browser autoplay policy)
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  // Free decoded audio for chunks well behind the one now playing
  const releaseDecodedBefore = useCallback((playingIndex: number) => {
    const limit = playingIndex - KEEP_DECODED_BEHIND;
    const released: number[] = [];
    decodedBuffersRef.current.forEach((_buffer, index) => {
      if (index < limit) released.push(index);
    });
    for (const index of released) {
      decodedBuffersRef.current.delete(index);
    }
    if (released.length > 0) {
      audioLog(`released decoded audio of chunk ${released.join(', ')}`);
    }
  }, []);

  // Fetch and decode a chunk
  const fetchAndDecodeChunk = useCallback(
    async (chunkIndex: number): Promise<AudioBuffer | null> => {
      // Return cached if available
      if (decodedBuffersRef.current.has(chunkIndex)) {
        return decodedBuffersRef.current.get(chunkIndex)!;
      }

      // Skip if already being decoded
      if (pendingDecodes.current.has(chunkIndex)) {
        // Wait for it to complete
        return new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (decodedBuffersRef.current.has(chunkIndex)) {
              clearInterval(checkInterval);
              resolve(decodedBuffersRef.current.get(chunkIndex)!);
            } else if (!pendingDecodes.current.has(chunkIndex)) {
              // The decode finished without producing audio (it failed)
              clearInterval(checkInterval);
              resolve(null);
            }
          }, 50);
        });
      }

      // Read from the ref so a callback created earlier still sees chunks that became ready since
      const chunk = chunksRef.current[chunkIndex];
      if (!isChunkReady(chunk)) return null;

      const ctx = ensureAudioContext();
      pendingDecodes.current.add(chunkIndex);
      const startedAt = Date.now();

      try {
        const response = await fetch(`${API_URL}/tts/audio/${chunk.id}`);
        if (!response.ok) throw new Error(`Failed to fetch audio (${response.status})`);

        const arrayBuffer = await response.arrayBuffer();
        const downloadedAt = Date.now();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        decodedBuffersRef.current.set(chunkIndex, audioBuffer);
        pendingDecodes.current.delete(chunkIndex);
        audioLog(
          `chunk ${chunkIndex} ready to play: download ${downloadedAt - startedAt} ms, ` +
            `decode ${Date.now() - downloadedAt} ms`
        );
        return audioBuffer;
      } catch (error) {
        pendingDecodes.current.delete(chunkIndex);
        audioLog(`chunk ${chunkIndex} FAILED to load: ${(error as Error)?.message ?? error}`);
        console.error(`[AudioPlayer] Failed to decode chunk ${chunkIndex}:`, error);
        return null;
      }
    },
    [ensureAudioContext]
  );

  // Preload upcoming chunks
  const preloadChunks = useCallback(
    (fromIndex: number, count: number = 2) => {
      for (let i = fromIndex; i < Math.min(fromIndex + count, chunks.length); i++) {
        if (
          !decodedBuffersRef.current.has(i) &&
          !pendingDecodes.current.has(i) &&
          isChunkReady(chunksRef.current[i])
        ) {
          fetchAndDecodeChunk(i);
        }
      }
    },
    [chunks.length, fetchAndDecodeChunk]
  );

  // When more chunks become ready during playback, start decoding the next ones
  useEffect(() => {
    if (isPlayingRef.current || waitingRef.current) {
      // While waiting, the chunk we will start on is decoded too, so playback starts at once
      const from = waitingRef.current ? currentChunkIndexRef.current : currentChunkIndexRef.current + 1;
      preloadChunks(from, 3);
    }
  }, [chunks, preloadChunks]);

  // Schedule a chunk for playback
  const scheduleChunk = useCallback(
    (chunkIndex: number, buffer: AudioBuffer, startOffset: number = 0, when: number = 0) => {
      const ctx = audioContextRef.current;
      const gainNode = gainNodeRef.current;
      if (!ctx || !gainNode) return null;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speedRef.current;
      source.connect(gainNode);

      // Calculate actual start time
      const startTime = when || ctx.currentTime;

      source.start(startTime, startOffset);

      return { source, startTime, startOffset };
    },
    []
  );

  // Play from a specific chunk and offset
  const playFromChunk = useCallback(
    async (chunkIndex: number, offsetWithinChunk: number = 0) => {
      const ctx = ensureAudioContext();
      audioLog(`play chunk ${chunkIndex} from ${offsetWithinChunk.toFixed(1)}s (engine ${ctx.state})`);

      // Wait until the audio engine is really running (it starts paused on iOS until a tap)
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        try {
          await ctx.resume();
        } catch (error) {
          audioLog(`audio engine would not start: ${(error as Error)?.message ?? error}`);
        }
      }

      // Stop current playback
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch (e) {
          // Ignore - might already be stopped
        }
        currentSourceRef.current = null;
      }
      if (nextSourceRef.current) {
        try {
          nextSourceRef.current.stop();
        } catch (e) {}
        nextSourceRef.current = null;
      }

      waitingRef.current = null;

      // Not enough audio is ready yet: wait (showing how far along it is) instead of starting and
      // then stopping again after every piece. A chunk that is not generated yet also waits here.
      const ahead = bufferedAhead(chunksRef.current, chunkIndex, offsetWithinChunk, speedRef.current);
      const wanted = bufferSecondsRef.current;
      const chunkReady = isChunkReady(chunksRef.current[chunkIndex]);
      if (!chunkReady || (!ahead.allReady && ahead.seconds < wanted)) {
        audioLog(
          chunkReady
            ? `buffering: ${ahead.seconds.toFixed(0)}s of ${wanted}s ready from chunk ${chunkIndex}`
            : `waiting for chunk ${chunkIndex} to be generated`
        );
        waitingRef.current = { index: chunkIndex, offset: offsetWithinChunk };
        currentChunkIndexRef.current = chunkIndex;
        chunkStartOffsetRef.current = offsetWithinChunk;
        isPlayingRef.current = false;
        setState((prev) => ({
          ...prev,
          isPlaying: true,
          isBuffering: true,
          bufferProgress: wanted > 0 ? Math.min(1, ahead.seconds / wanted) : 0,
          isLoading: false,
          currentChunkIndex: chunkIndex,
          currentTime: offsetWithinChunk,
        }));
        onChunkChange?.(chunkIndex);
        return;
      }

      setState((prev) => ({ ...prev, isLoading: true }));

      // Fetch and decode current chunk
      const buffer = await fetchAndDecodeChunk(chunkIndex);
      if (!buffer) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isBuffering: false,
          error: 'Failed to load audio',
        }));
        return;
      }

      // Schedule playback
      const scheduled = scheduleChunk(chunkIndex, buffer, offsetWithinChunk);
      if (!scheduled) return;

      currentSourceRef.current = scheduled.source;
      playbackStartTimeRef.current = scheduled.startTime;
      chunkStartOffsetRef.current = offsetWithinChunk;
      currentChunkIndexRef.current = chunkIndex;
      isPlayingRef.current = true;

      // Monitor AudioContext state changes - auto-resume if suspended
      // iOS also reports "interrupted" (a call, Siri, another app took the audio)
      if (ctx.onstatechange === null) {
        ctx.onstatechange = () => {
          audioLog(`audio engine is now ${ctx.state}`);
          if (ctx.state !== 'running' && ctx.state !== 'closed') {
            ctx.resume().catch(() => {});
          }
        };
      }
      releaseDecodedBefore(chunkIndex);

      // Handle chunk end - schedule next chunk
      scheduled.source.onended = () => {
        // Use ref to get latest chunks (not stale closure)
        const currentChunks = chunksRef.current;

        if (!isPlayingRef.current) {
          return;
        }

        const nextIndex = currentChunkIndexRef.current + 1;

        if (nextIndex < currentChunks.length) {
          // Move to next chunk
          currentChunkIndexRef.current = nextIndex;
          chunkStartOffsetRef.current = 0;
          playbackStartTimeRef.current = ctx.currentTime;

          // Play next chunk if we have it buffered
          const nextBuffer = decodedBuffersRef.current.get(nextIndex);
          audioLog(
            `chunk ${nextIndex - 1} ended; next chunk ${nextIndex} is ` +
              (nextBuffer ? 'ready' : isChunkReady(currentChunks[nextIndex]) ? 'generated, still loading' : 'NOT generated yet')
          );
          releaseDecodedBefore(nextIndex);

          if (nextBuffer) {
            const nextScheduled = scheduleChunk(nextIndex, nextBuffer, 0, ctx.currentTime);
            if (nextScheduled) {
              currentSourceRef.current = nextScheduled.source;
              nextScheduled.source.onended = scheduled.source.onended;
            }
          } else {
            // Need to load it - this will cause a gap
            playFromChunk(nextIndex, 0);
          }

          setState((prev) => ({
            ...prev,
            currentChunkIndex: nextIndex,
            currentTime: 0,
          }));
          onChunkChange?.(nextIndex);

          // Notify position change with new chunk ID
          const nextChunk = currentChunks[nextIndex];
          if (nextChunk && onPositionChange) {
            onPositionChange(0, nextChunk.id);
          }

          // Preload more chunks
          preloadChunks(nextIndex + 1, 3);
        } else {
          // End of available chunks
          isPlayingRef.current = false;
          setState((prev) => ({ ...prev, isPlaying: false }));
        }
      };

      setState((prev) => ({
        ...prev,
        isPlaying: true,
        isLoading: false,
        isBuffering: false,
        bufferProgress: 0,
        error: null,
        currentChunkIndex: chunkIndex,
        currentTime: offsetWithinChunk,
        duration: buffer.duration,
        chapterDuration,
      }));

      onChunkChange?.(chunkIndex);

      // Notify position change with chunk ID for word highlighting
      const currentChunk = chunksRef.current[chunkIndex];
      if (currentChunk && onPositionChange) {
        onPositionChange(offsetWithinChunk, currentChunk.id);
      }

      // Preload next chunks
      preloadChunks(chunkIndex + 1, 3);
    },
    [
      ensureAudioContext,
      fetchAndDecodeChunk,
      scheduleChunk,
      chunks,
      chapterDuration,
      onChunkChange,
      onPositionChange,
      preloadChunks,
      releaseDecodedBefore,
    ]
  );

  // Update time display using requestAnimationFrame
  useEffect(() => {
    const updateTime = () => {
      if (!isPlayingRef.current || !audioContextRef.current) {
        animationFrameRef.current = requestAnimationFrame(updateTime);
        return;
      }

      // Refresh the display a few times a second, not on every animation frame
      const nowMs = Date.now();
      if (nowMs - lastUiUpdateRef.current < UI_UPDATE_INTERVAL_MS) {
        animationFrameRef.current = requestAnimationFrame(updateTime);
        return;
      }

      const ctx = audioContextRef.current;
      const chunkIndex = currentChunkIndexRef.current;
      const chunk = chunks[chunkIndex];

      if (!chunk || playbackStartTimeRef.current === 0) {
        animationFrameRef.current = requestAnimationFrame(updateTime);
        return;
      }
      lastUiUpdateRef.current = nowMs;

      // Calculate elapsed time - playbackRate handles speed, so we multiply by speed
      const elapsedReal = ctx.currentTime - playbackStartTimeRef.current;
      const elapsedAudio = elapsedReal * state.speed;

      // Clamp to valid range for this chunk
      const currentTime = Math.min(
        Math.max(0, chunkStartOffsetRef.current + elapsedAudio),
        chunk.audioDuration
      );

      const timeBeforeChunk = getTimeBeforeChunk(chunkIndex);
      const chapterCurrentTime = timeBeforeChunk + currentTime;

      setState((prev) => ({
        ...prev,
        currentTime,
        chapterCurrentTime,
        chapterDuration,
      }));

      if (onPositionChange) {
        onPositionChange(currentTime, chunk.id);
      }

      animationFrameRef.current = requestAnimationFrame(updateTime);
    };

    animationFrameRef.current = requestAnimationFrame(updateTime);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [state.speed, chunks, chapterDuration, getTimeBeforeChunk, onPositionChange]);

  // Toggle play/pause
  const togglePlay = useCallback(async () => {
    if (state.isPlaying) {
      // Pause
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch (e) {}
        currentSourceRef.current = null;
      }
      waitingRef.current = null;
      isPlayingRef.current = false;
      setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
    } else {
      // Resume from current position
      await playFromChunk(currentChunkIndexRef.current, state.currentTime);
    }
  }, [state.isPlaying, state.currentTime, playFromChunk]);

  // Pause without toggling (used when audio could not be generated)
  const pause = useCallback(() => {
    waitingRef.current = null;
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch (e) {}
      currentSourceRef.current = null;
    }
    isPlayingRef.current = false;
    setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
  }, []);

  // Start playing once enough audio is ready (or the rest of the chapter is), and show progress
  useEffect(() => {
    const waiting = waitingRef.current;
    if (!waiting) return;
    const ahead = bufferedAhead(chunks, waiting.index, waiting.offset, speedRef.current);
    const wanted = bufferSecondsRef.current;
    const ready = isChunkReady(chunks[waiting.index]);
    if (ready && (ahead.allReady || ahead.seconds >= wanted)) {
      waitingRef.current = null;
      playFromChunk(waiting.index, waiting.offset);
    } else {
      const progress = wanted > 0 ? Math.min(1, ahead.seconds / wanted) : 0;
      setState((prev) => (prev.bufferProgress === progress ? prev : { ...prev, bufferProgress: progress }));
    }
  }, [chunks, playFromChunk]);

  // The system can pause the audio engine while the player thinks it is playing: a call, Siri,
  // switching apps or locking the screen on iOS. Try to resume it when the app comes back. If it
  // stays paused, pause the player so the Play button matches reality and a tap restarts playback,
  // instead of showing "Pause" over silence.
  useEffect(() => {
    const tryResume = (reason: string) => {
      const ctx = audioContextRef.current;
      if (!ctx || !isPlayingRef.current) return;
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        audioLog(`${reason}: audio engine is ${ctx.state}, trying to resume`);
        ctx.resume().catch(() => {});
      }
    };

    const onVisibilityChange = () => {
      audioLog(`app is now ${document.visibilityState}`);
      if (document.visibilityState === 'visible') tryResume('app visible again');
    };
    const onPageShow = () => tryResume('page shown');

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);

    const watchdog = setInterval(() => {
      const ctx = audioContextRef.current;
      if (!ctx || !isPlayingRef.current || ctx.state === 'running' || ctx.state === 'closed') {
        notRunningSinceRef.current = null;
        return;
      }

      const now = Date.now();
      if (notRunningSinceRef.current === null) {
        notRunningSinceRef.current = now;
        return;
      }
      if (now - notRunningSinceRef.current < INTERRUPTION_GRACE_MS) return;

      notRunningSinceRef.current = null;
      audioLog(`audio engine stuck ${ctx.state}: pausing the player (tap Play to continue)`);
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch (e) {}
        currentSourceRef.current = null;
      }
      waitingRef.current = null;
      isPlayingRef.current = false;
      setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false, error: 'interrupted' }));
    }, 500);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      clearInterval(watchdog);
    };
  }, []);

  // Seek within current chunk
  const seek = useCallback(
    (time: number) => {
      if (state.isPlaying) {
        playFromChunk(currentChunkIndexRef.current, time);
      } else {
        chunkStartOffsetRef.current = time;
        setState((prev) => ({ ...prev, currentTime: time }));
      }
    },
    [state.isPlaying, playFromChunk]
  );

  // Seek within entire chapter
  const seekChapter = useCallback(
    async (chapterTime: number) => {
      let accumulatedTime = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (accumulatedTime + chunks[i].audioDuration > chapterTime) {
          const timeWithinChunk = chapterTime - accumulatedTime;
          if (state.isPlaying) {
            await playFromChunk(i, timeWithinChunk);
          } else {
            currentChunkIndexRef.current = i;
            chunkStartOffsetRef.current = timeWithinChunk;
            setState((prev) => ({
              ...prev,
              currentChunkIndex: i,
              currentTime: timeWithinChunk,
              chapterCurrentTime: chapterTime,
            }));
          }
          return;
        }
        accumulatedTime += chunks[i].audioDuration;
      }
    },
    [chunks, state.isPlaying, playFromChunk]
  );

  // Set playback speed
  const setSpeed = useCallback((speed: number) => {
    speedRef.current = speed;
    setState((prev) => ({ ...prev, speed }));
    if (currentSourceRef.current) {
      currentSourceRef.current.playbackRate.value = speed;
    }
  }, []);

  // Set volume
  const setVolume = useCallback((volume: number) => {
    setState((prev) => ({ ...prev, volume }));
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume;
    }
  }, []);

  // Navigation
  const nextChunk = useCallback(() => {
    if (currentChunkIndexRef.current < chunks.length - 1) {
      const nextIndex = currentChunkIndexRef.current + 1;
      if (state.isPlaying) {
        playFromChunk(nextIndex, 0);
      } else {
        currentChunkIndexRef.current = nextIndex;
        chunkStartOffsetRef.current = 0;
        setState((prev) => ({
          ...prev,
          currentChunkIndex: nextIndex,
          currentTime: 0,
        }));
      }
    }
  }, [chunks.length, state.isPlaying, playFromChunk]);

  const previousChunk = useCallback(() => {
    if (currentChunkIndexRef.current > 0) {
      const prevIndex = currentChunkIndexRef.current - 1;
      if (state.isPlaying) {
        playFromChunk(prevIndex, 0);
      } else {
        currentChunkIndexRef.current = prevIndex;
        chunkStartOffsetRef.current = 0;
        setState((prev) => ({
          ...prev,
          currentChunkIndex: prevIndex,
          currentTime: 0,
        }));
      }
    }
  }, [state.isPlaying, playFromChunk]);

  const loadChunk = useCallback(
    async (chunkIndex: number, autoPlay: boolean = false) => {
      if (!chunks[chunkIndex]) {
        if (onChunkNeeded) {
          setState((prev) => ({ ...prev, isLoading: true }));
          pendingChunkRef.current = chunkIndex;
          try {
            await onChunkNeeded(chunkIndex);
            return;
          } catch (error) {
            pendingChunkRef.current = null;
            setState((prev) => ({ ...prev, isLoading: false, error: 'Failed to load chunk' }));
            return;
          }
        }
        return;
      }

      if (autoPlay) {
        await playFromChunk(chunkIndex, 0);
      } else {
        currentChunkIndexRef.current = chunkIndex;
        chunkStartOffsetRef.current = 0;
        setState((prev) => ({
          ...prev,
          currentChunkIndex: chunkIndex,
          currentTime: 0,
        }));
        // Preload this chunk
        fetchAndDecodeChunk(chunkIndex);
      }
    },
    [chunks, onChunkNeeded, playFromChunk, fetchAndDecodeChunk]
  );

  // Handle pending chunk loads
  useEffect(() => {
    const pendingIndex = pendingChunkRef.current;
    if (pendingIndex !== null && chunks[pendingIndex]) {
      pendingChunkRef.current = null;
      loadChunk(pendingIndex);
    }
  }, [chunks, loadChunk]);

  // Reset when chapter changes
  const lastChapterIdRef = useRef<string>(chapterId);
  useEffect(() => {
    if (chapterId !== lastChapterIdRef.current) {
      lastChapterIdRef.current = chapterId;
      hasInitializedRef.current = false;

      // Stop current playback
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch (e) {}
        currentSourceRef.current = null;
      }
      isPlayingRef.current = false;
      waitingRef.current = null;
      currentChunkIndexRef.current = 0;
      chunkStartOffsetRef.current = 0;

      // Clear decoded buffers for old chapter
      decodedBuffersRef.current.clear();
      pendingDecodes.current.clear();

      setState((prev) => ({
        ...prev,
        isPlaying: false,
        isBuffering: false,
        currentChunkIndex: 0,
        currentTime: 0,
        chapterCurrentTime: 0,
      }));
    }
  }, [chapterId]);

  // Initial load - only run once when chunks first become available
  useEffect(() => {
    if (chunks.length > 0 && !hasInitializedRef.current) {
      hasInitializedRef.current = true;

      let chunkIndex = 0;
      let startTime = initialTime || 0;
      if (initialChunkId) {
        const foundIndex = resolveChunkIndex(chunks, initialChunkId);
        if (foundIndex !== -1) {
          chunkIndex = foundIndex;
        } else {
          // The saved chunk no longer exists (for example the voice changed): start from the top
          startTime = 0;
        }
      }

      currentChunkIndexRef.current = chunkIndex;
      chunkStartOffsetRef.current = startTime;

      setState((prev) => ({
        ...prev,
        currentChunkIndex: chunkIndex,
        currentTime: startTime,
        chapterDuration,
      }));

      // Preload first few chunks
      preloadChunks(chunkIndex, 3);
    }
  }, [chunks, initialChunkId, initialTime, chapterDuration, preloadChunks]);

  // Update chapter duration when new chunks arrive
  useEffect(() => {
    if (chunks.length > 0) {
      setState((prev) => ({ ...prev, chapterDuration }));
    }
  }, [chunks.length, chapterDuration]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch (e) {}
        currentSourceRef.current = null;
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, []);

  // Apply volume on mount
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = state.volume;
    }
  }, [state.volume]);

  return {
    state,
    controls: {
      togglePlay,
      seek,
      seekChapter,
      setSpeed,
      setVolume,
      nextChunk,
      previousChunk,
      loadChunk,
      pause,
    },
  };
}
