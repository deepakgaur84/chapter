'use client';

import { useState } from 'react';
import { FolderOpen, Loader2, RotateCcw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { useLibraryStatus } from '@/lib/hooks/use-library-status';

/** The read-only books folder: what the last scan did, and books that were removed */
export function LibrarySettings() {
  const queryClient = useQueryClient();
  const { status, refresh } = useLibraryStatus();
  const hidden = useQuery({
    queryKey: ['library-hidden'],
    queryFn: () => apiClient.getHiddenBooks(),
    staleTime: 10_000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const files = hidden.data?.files ?? [];

  const restore = async (ids?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.restoreHiddenBooks(ids);
      await queryClient.invalidateQueries({ queryKey: ['library-hidden'] });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not bring the books back');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="library-settings">
      <div className="bg-white/5 rounded-xl p-4 border border-white/10">
        <div className="flex items-center gap-2 mb-1">
          <FolderOpen className="w-4 h-4 text-white/70" />
          <p className="text-sm font-medium text-white/90">Books folder</p>
        </div>
        <p className="text-xs text-white/50 leading-relaxed">
          Books are added from your read-only books folder automatically, in the background, every
          time the server starts. A PDF and an EPUB of the same book appear once, and you choose
          how to read each. Files in that folder are never changed.
        </p>
        {status && (
          <p className="mt-2 text-xs text-white/70" data-testid="library-status-line">
            {status.state === 'scanning'
              ? `Adding books: ${status.done} of ${status.total}${status.current ? ` (${status.current})` : ''}`
              : status.finishedAt
                ? `Last scan: ${status.total} file${status.total === 1 ? '' : 's'} checked, ${status.imported + status.merged} added${status.failed ? `, ${status.failed} could not be read` : ''}`
                : 'Waiting for the first scan'}
          </p>
        )}
        {status && status.errors.length > 0 && (
          <ul className="mt-2 text-xs text-red-400 space-y-0.5">
            {status.errors.slice(0, 5).map((message) => (
              <li key={message} className="truncate">
                {message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {files.length > 0 && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
          <div className="flex items-center justify-between gap-4 mb-2">
            <p className="text-sm font-medium text-white/90">
              Removed books <span className="text-white/40 font-normal">({files.length})</span>
            </p>
            <button
              type="button"
              onClick={() => restore()}
              disabled={busy}
              className="h-8 px-3 rounded-lg border border-white/20 bg-white/5 text-white/80 hover:bg-white/10 text-xs font-medium flex items-center gap-2 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              Bring all back
            </button>
          </div>
          <ul className="max-h-48 overflow-y-auto divide-y divide-white/10">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm text-white/80">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Bring back ${file.name}`}
                  onClick={() => restore([file.id])}
                  disabled={busy}
                  className="text-xs text-white/60 hover:text-white underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Bring back
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
