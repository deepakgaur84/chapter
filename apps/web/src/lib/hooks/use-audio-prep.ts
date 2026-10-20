import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type AudioPrepBook, type AudioPrepOverview } from '../api-client';
import { useSettingsStore } from '../stores/settings-store';

export const AUDIO_PREP_KEY = ['audio-prep'];

/** True while any book is waiting for, or having, its audio generated. */
export function isPrepBusy(overview?: AudioPrepOverview): boolean {
  return !!overview?.books.some((b) => b.status === 'queued' || b.status === 'running');
}

/**
 * Prepared-audio status for the whole library. Polls every 3 seconds while anything is queued or
 * running, and otherwise refreshes only when asked.
 */
export function useAudioPrep(enabled = true) {
  const queryClient = useQueryClient();
  const tts = useSettingsStore((s) => s.tts);

  const query = useQuery({
    queryKey: AUDIO_PREP_KEY,
    queryFn: () => apiClient.getAudioPrep(),
    enabled,
    refetchInterval: (q) => (isPrepBusy(q.state.data) ? 3000 : false),
    staleTime: 10_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: AUDIO_PREP_KEY });

  const prepare = useMutation({
    mutationFn: (bookId: string) =>
      apiClient.prepareBookAudio(bookId, {
        voiceId: tts.voiceId,
        speed: tts.speed,
        temperature: tts.temperature,
      }),
    onSettled: refresh,
  });

  const cancel = useMutation({
    mutationFn: (bookId: string) => apiClient.cancelBookAudio(bookId),
    onSettled: refresh,
  });

  const deleteAudio = useMutation({
    mutationFn: (bookId: string) => apiClient.deleteBookAudio(bookId),
    onSettled: refresh,
  });

  const select = useMutation({
    mutationFn: ({ bookIds, selected }: { bookIds: string[]; selected: boolean }) =>
      apiClient.setAudioPrepSelection(bookIds, selected, {
        voiceId: tts.voiceId,
        speed: tts.speed,
        temperature: tts.temperature,
      }),
    onSettled: refresh,
  });

  const byId = new Map<string, AudioPrepBook>((query.data?.books ?? []).map((b) => [b.id, b]));

  return {
    overview: query.data,
    isLoading: query.isLoading,
    error: query.error,
    getBook: (id: string) => byId.get(id),
    prepare: (id: string) => prepare.mutateAsync(id),
    cancel: (id: string) => cancel.mutateAsync(id),
    deleteAudio: (id: string) => deleteAudio.mutateAsync(id),
    select: (bookIds: string[], selected: boolean) => select.mutateAsync({ bookIds, selected }),
    refresh,
  };
}
