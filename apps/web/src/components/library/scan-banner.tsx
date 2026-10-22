'use client';

import { Loader2 } from 'lucide-react';
import { useLibraryStatus } from '@/lib/hooks/use-library-status';

/** A slim notice while the server is adding books from the books folder in the background */
export function ScanBanner() {
  const { status } = useLibraryStatus();
  if (!status || status.state !== 'scanning' || status.total === 0) return null;
  const added = status.imported + status.merged;

  return (
    <div
      role="status"
      data-testid="scan-banner"
      className="fixed left-1/2 -translate-x-1/2 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 max-w-[92vw] flex items-center gap-3 rounded-full bg-black/80 backdrop-blur-md px-4 py-2 text-xs text-white/90 shadow-xl"
    >
      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
      <span className="truncate">
        Adding books from your library folder: {status.done} of {status.total}
        {added > 0 ? ` · ${added} added` : ''}
      </span>
    </div>
  );
}
