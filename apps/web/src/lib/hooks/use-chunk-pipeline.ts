import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChunkPipeline,
  type GeneratedChunk,
  type PipelineChunk,
  type Plan,
} from '../chunk-pipeline';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

function authHeaders(): Record<string, string> {
  let token: string | null = null;
  try {
    token = localStorage.getItem('chapter_token');
  } catch {
    token = null;
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // ignore: response had no JSON body
  }
  return `${fallback} (${response.status})`;
}

export interface UseChunkPipelineOptions {
  bookId: string;
  chapterId?: string;
  voiceId: string;
  speed: number;
  temperature: number;
  enabled: boolean;
}

export interface UseChunkPipelineResult {
  /** Every chunk of the chapter, in order. Chunks without audio yet have `ready: false`. */
  chunks: PipelineChunk[];
  isPlanLoading: boolean;
  isPlanReady: boolean;
  planError: string | null;
  /** Set when generating a chunk failed after several attempts. */
  error: string | null;
  /** Tell the pipeline whether the player is playing and which chunk it is on. */
  setPlayback: (isPlaying: boolean, chunkIndex: number) => void;
  /** Stop all generation (for example when the player is closed). */
  stop: () => void;
}

export function useChunkPipeline({
  bookId,
  chapterId,
  voiceId,
  speed,
  temperature,
  enabled,
}: UseChunkPipelineOptions): UseChunkPipelineResult {
  const [pipeline, setPipeline] = useState<ChunkPipeline | null>(null);
  const [version, setVersion] = useState(0);
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPipeline(null);
    setError(null);
    setPlanError(null);

    if (!enabled || !chapterId) {
      setIsPlanLoading(false);
      return;
    }

    let cancelled = false;
    let created: ChunkPipeline | null = null;
    const controller = new AbortController();
    setIsPlanLoading(true);

    const settings = { speed, temperature };

    const load = async () => {
      const query = new URLSearchParams({
        voiceId,
        speed: String(speed),
        temperature: String(temperature),
      });
      const response = await fetch(
        `${API_URL}/tts/chapters/${bookId}/${chapterId}/plan?${query.toString()}`,
        { headers: authHeaders(), signal: controller.signal }
      );
      if (!response.ok) {
        throw new Error(await readError(response, 'Failed to load audio plan'));
      }
      const plan = (await response.json()) as Plan;
      if (cancelled) return;

      created = new ChunkPipeline({
        plan,
        voiceId,
        speed,
        lookahead: 2,
        onChange: () => setVersion((v) => v + 1),
        onError: (message) => setError(message),
        generateChunk: async (index, signal): Promise<GeneratedChunk> => {
          const result = await fetch(
            `${API_URL}/tts/chapters/${bookId}/${chapterId}/chunk/${index}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify({ voiceId, settings }),
              signal,
            }
          );
          if (!result.ok) {
            throw new Error(await readError(result, 'Failed to generate audio'));
          }
          const body = await result.json();
          return { id: body.id, duration: body.duration, size: body.size };
        },
      });

      setPipeline(created);
      setIsPlanLoading(false);
    };

    load().catch((err) => {
      if (cancelled || controller.signal.aborted) return;
      console.error('Failed to load audio plan:', err);
      setPlanError(err instanceof Error ? err.message : 'Failed to load audio plan');
      setIsPlanLoading(false);
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (created) {
        created.dispose();
      }
    };
  }, [bookId, chapterId, voiceId, speed, temperature, enabled]);

  const chunks = useMemo(
    () => (pipeline ? pipeline.getChunks() : []),
    // `version` changes whenever a chunk finishes generating
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pipeline, version]
  );

  const setPlayback = useCallback(
    (isPlaying: boolean, chunkIndex: number) => {
      pipeline?.setPlayback(isPlaying, chunkIndex);
    },
    [pipeline]
  );

  const stop = useCallback(() => {
    pipeline?.stop();
  }, [pipeline]);

  return {
    chunks,
    isPlanLoading,
    isPlanReady: !!pipeline,
    planError,
    error,
    setPlayback,
    stop,
  };
}
