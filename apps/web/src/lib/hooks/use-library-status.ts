import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export const LIBRARY_STATUS_KEY = ['library-status'];

/**
 * Progress of the server's background scan of the books folder. Polls every 3 seconds while a
 * scan is running, and refreshes the book list whenever more books have been added.
 */
export function useLibraryStatus(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LIBRARY_STATUS_KEY,
    queryFn: () => apiClient.getLibraryStatus(),
    enabled,
    refetchInterval: (q) => (q.state.data?.state === 'scanning' ? 3000 : false),
    staleTime: 10_000,
  });

  const status = query.data;
  const added = (status?.imported ?? 0) + (status?.merged ?? 0);
  const lastAdded = useRef(0);
  const wasScanning = useRef(false);

  useEffect(() => {
    if (!status) return;
    if (added !== lastAdded.current || (wasScanning.current && status.state === 'idle')) {
      lastAdded.current = added;
      queryClient.invalidateQueries({ queryKey: ['books'] });
    }
    wasScanning.current = status.state === 'scanning';
  }, [added, status, queryClient]);

  return { status, isLoading: query.isLoading, refresh: () => queryClient.invalidateQueries({ queryKey: LIBRARY_STATUS_KEY }) };
}
