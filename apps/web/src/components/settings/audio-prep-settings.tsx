'use client';

import { useEffect, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useAudioPrep } from '@/lib/hooks/use-audio-prep';
import { useSettingsStore } from '@/lib/stores/settings-store';

function formatMB(bytes: number): string {
  if (bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/**
 * Nightly audio preparation: a schedule, plus a list of books to prepare. The job generates only
 * what is missing, one piece at a time, and skips books that are already complete.
 */
export function AudioPrepSettings() {
  const { overview, isLoading, error, select, refresh } = useAudioPrep();
  const tts = useSettingsStore((s) => s.tts);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('02:00');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const settings = overview?.settings;
  useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled);
      setTime(settings.time);
    }
  }, [settings?.enabled, settings?.time]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <p className="text-sm text-white/50">Loading...</p>;
  if (error || !overview) {
    return <p className="text-sm text-red-400">Could not load the audio preparation settings.</p>;
  }

  const books = overview.books.filter((b) => b.hasText !== false);
  const selectedCount = books.filter((b) => b.selected).length;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const save = async (next: { enabled?: boolean; time?: string }) => {
    setSaving(true);
    setSaveError(null);
    try {
      await apiClient.updateAudioPrepSettings({
        enabled: next.enabled ?? enabled,
        time: next.time ?? time,
        timezone,
        voiceId: tts.voiceId,
        speed: tts.speed,
        temperature: tts.temperature,
      });
      await refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setSaveError(null);
    try {
      await apiClient.runAudioPrepNow();
      await refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not start');
    } finally {
      setRunning(false);
    }
  };

  const statusText = (b: (typeof books)[number]) => {
    if (b.status === 'running') {
      const pct = b.totalChunks ? Math.floor((b.doneChunks / b.totalChunks) * 100) : 0;
      return `Preparing ${pct}%`;
    }
    if (b.status === 'queued') return 'Waiting';
    if (b.status === 'failed') return 'Failed';
    if (b.status === 'done') return `Ready${b.audioBytes ? ` · ${formatMB(b.audioBytes)}` : ''}`;
    if (b.audioChunks > 0) return `Partly generated${b.audioBytes ? ` · ${formatMB(b.audioBytes)}` : ''}`;
    return 'No audio yet';
  };

  return (
    <div className="space-y-4" data-testid="audio-prep-settings">
      <p className="text-xs text-white/50 leading-relaxed">
        Prepare audio ahead of time so listening is smooth. Each night the server generates the
        missing audio for the books you tick below, one piece at a time, and skips books that are
        already complete. It steps aside while you are listening.
      </p>

      <div className="bg-white/5 rounded-xl p-4 border border-white/10 space-y-4">
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <span className="text-sm font-medium text-white/90">Run every day</span>
          <input
            type="checkbox"
            aria-label="Run every day"
            checked={enabled}
            disabled={saving}
            onChange={(e) => {
              setEnabled(e.target.checked);
              save({ enabled: e.target.checked });
            }}
            className="h-4 w-4 accent-sky-500"
          />
        </label>

        <div className="flex items-center justify-between gap-4">
          <label htmlFor="audio-prep-time" className="text-sm text-white/80">
            Start at
            <span className="block text-xs text-white/40">Time zone: {timezone}</span>
          </label>
          <input
            id="audio-prep-time"
            type="time"
            value={time}
            disabled={saving}
            onChange={(e) => setTime(e.target.value)}
            onBlur={() => {
              if (/^\d{2}:\d{2}$/.test(time) && time !== settings?.time) save({ time });
            }}
            className="h-9 px-3 rounded-lg bg-white/10 border border-white/20 text-white/90 text-sm"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="text-xs text-white/50 min-w-0">
            {settings?.lastRunAt ? (
              <>
                Last run: {formatWhen(settings.lastRunAt)}
                {settings.lastRunNote ? ` · ${settings.lastRunNote}` : ''}
              </>
            ) : (
              'Has not run yet'
            )}
          </div>
          <button
            type="button"
            onClick={runNow}
            disabled={running || selectedCount === 0}
            className="shrink-0 h-9 px-4 rounded-lg border border-white/20 bg-white/5 text-white/80 hover:bg-white/10 transition-colors text-sm font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Run now
          </button>
        </div>
        {saveError && (
          <p className="text-sm text-red-400" role="alert">
            {saveError}
          </p>
        )}
        <p className="text-xs text-white/40">
          Voice used: {tts.voiceId} (the voice chosen above). Changing the voice later means books
          need preparing again for the new voice.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-white/90">
            Books to prepare{' '}
            <span className="text-white/40 font-normal">
              ({selectedCount} of {books.length})
            </span>
          </p>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              className="text-white/60 hover:text-white underline-offset-2 hover:underline"
              onClick={() => select(books.map((b) => b.id), true)}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-white/60 hover:text-white underline-offset-2 hover:underline"
              onClick={() => select(books.map((b) => b.id), false)}
            >
              Select none
            </button>
          </div>
        </div>
        {books.length === 0 ? (
          <p className="text-sm text-white/50">No books with readable text yet.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto rounded-xl border border-white/10 divide-y divide-white/10">
            {books.map((b) => (
              <li key={b.id}>
                <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/5">
                  <input
                    type="checkbox"
                    aria-label={`Prepare audio for ${b.title}`}
                    checked={b.selected}
                    onChange={(e) => select([b.id], e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-sky-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white/90 truncate">{b.title}</span>
                    {b.author && <span className="block text-xs text-white/40 truncate">{b.author}</span>}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${b.status === 'failed' ? 'text-red-400' : 'text-white/50'}`}
                    title={b.error || undefined}
                  >
                    {statusText(b)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
