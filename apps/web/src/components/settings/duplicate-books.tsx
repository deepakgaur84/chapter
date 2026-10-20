'use client';

import { useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient, type DuplicateGroup } from '@/lib/api-client';

/** Find books that look like copies of each other and merge them, keeping one per group. */
export function DuplicateBooks() {
  const queryClient = useQueryClient();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiClient.getDuplicateGroups();
      setGroups(result.groups);
      setKeep(Object.fromEntries(result.groups.map((g, i) => [i, g.keepId])));
      if (result.groups.length === 0) setMessage('No duplicate books found.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not look for duplicates');
    } finally {
      setBusy(false);
    }
  };

  const merge = async (indexes: number[]) => {
    if (!groups) return;
    const merges = indexes.map((i) => ({
      keepId: keep[i] ?? groups[i].keepId,
      removeIds: groups[i].books.map((b) => b.id).filter((id) => id !== (keep[i] ?? groups[i].keepId)),
    }));
    const count = merges.reduce((n, m) => n + m.removeIds.length, 0);
    if (
      !window.confirm(
        `Remove ${count} duplicate ${count === 1 ? 'copy' : 'copies'}?\n\n` +
          'The copy you picked is kept. The others are removed from your library together with their generated audio. Files in your watched folders are not touched.'
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiClient.mergeDuplicates(merges);
      await queryClient.invalidateQueries({ queryKey: ['books'] });
      await queryClient.invalidateQueries({ queryKey: ['audio-prep'] });
      setMessage(`Removed ${result.removed} duplicate ${result.removed === 1 ? 'copy' : 'copies'}.`);
      setGroups((prev) => (prev ? prev.filter((_, i) => !indexes.includes(i)) : prev));
      setKeep({});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white/5 rounded-xl p-4 border border-white/10" data-testid="duplicate-books">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Copy className="w-4 h-4 text-white/70" />
            <p className="text-sm font-medium text-white/90">Duplicate Books</p>
          </div>
          <p className="text-xs text-white/50">
            Finds books with the same title and author, or the same ISBN, and lets you keep one.
          </p>
        </div>
        <button
          type="button"
          onClick={find}
          disabled={busy}
          className="shrink-0 h-9 px-4 rounded-lg border border-white/20 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white/90 transition-colors text-sm font-medium flex items-center gap-2 disabled:opacity-50"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Find duplicates
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {message && <p className="mt-3 text-sm text-white/70">{message}</p>}

      {groups && groups.length > 0 && (
        <div className="mt-4 space-y-4">
          {groups.map((group, i) => (
            <fieldset key={group.books.map((b) => b.id).join('-')} className="rounded-lg border border-white/10 p-3">
              <legend className="px-1 text-xs text-white/50">
                {group.confidence === 'sure'
                  ? 'Same book'
                  : 'Probably the same book - please check'}
              </legend>
              {group.books.map((b) => (
                <label key={b.id} className="flex items-start gap-3 py-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name={`keep-${i}`}
                    aria-label={`Keep ${b.title}`}
                    checked={(keep[i] ?? group.keepId) === b.id}
                    onChange={() => setKeep((prev) => ({ ...prev, [i]: b.id }))}
                    className="mt-1 h-4 w-4 shrink-0 accent-sky-500"
                  />
                  <span className="min-w-0 text-sm">
                    <span className="block text-white/90 truncate">{b.title}</span>
                    <span className="block text-xs text-white/40">
                      {[
                        b.author,
                        b.sourceFormat ? String(b.sourceFormat).toUpperCase() : null,
                        b.progress ? `${Math.round(b.progress)}% read` : null,
                        b.audioChunks ? `${b.audioChunks} audio pieces` : null,
                        (keep[i] ?? group.keepId) === b.id ? 'keep' : 'remove',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </label>
              ))}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => merge([i])}
                  disabled={busy}
                  className="h-8 px-3 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white/90 disabled:opacity-50"
                >
                  Merge
                </button>
              </div>
            </fieldset>
          ))}
          {groups.length > 1 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => merge(groups.map((_, i) => i))}
                disabled={busy}
                className="h-9 px-4 rounded-lg bg-white/10 hover:bg-white/15 text-sm text-white/90 disabled:opacity-50"
              >
                Merge all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
