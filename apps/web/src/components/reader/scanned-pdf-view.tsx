'use client';

import { useMemo } from 'react';
import { ArrowLeft, ExternalLink, FileText } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

interface ScannedPdfViewProps {
  book: { id: string; title: string; author?: string | null };
  isOnline: boolean;
  onBack: () => void;
}

/** iPhone / iPad: Safari shows only the first page of a PDF embedded in a page, so link out instead */
function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Shown instead of the reader for a scanned PDF. There is no text to display or to turn into
 * audio, so the only thing to offer is the PDF itself.
 */
export function ScannedPdfView({ book, isOnline, onBack }: ScannedPdfViewProps) {
  const pdfUrl = useMemo(() => apiClient.getPdfUrl(book.id), [book.id]);
  const canEmbed = useMemo(() => !isAppleTouchDevice(), []);

  return (
    <div className="min-h-screen flex flex-col bg-[hsl(var(--reader-bg))] text-[hsl(var(--reader-text))]">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[hsl(var(--reader-text))]/10">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to library"
          className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-[hsl(var(--reader-text))]/10 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <h1 className="font-medium truncate">{book.title}</h1>
          {book.author && (
            <p className="text-xs text-[hsl(var(--reader-text))]/60 truncate">{book.author}</p>
          )}
        </div>
      </header>

      <div
        role="status"
        className="mx-4 mt-4 flex items-start gap-3 rounded-2xl border border-[hsl(var(--reader-text))]/10 bg-[hsl(var(--reader-text))]/5 p-4"
      >
        <FileText className="w-5 h-5 mt-0.5 shrink-0" />
        <div className="text-sm">
          <p className="font-medium">This PDF is a scan with no readable text</p>
          <p className="mt-1 text-[hsl(var(--reader-text))]/60">
            The reader and listening need text, so they are not available for this book. You can
            still open the PDF.
          </p>
        </div>
      </div>

      {!isOnline ? (
        <p className="mx-4 mt-4 text-sm text-[hsl(var(--reader-text))]/60">
          You are offline. Connect to the internet to open this PDF.
        </p>
      ) : (
        <>
          <div className="mx-4 mt-4">
            <Button onClick={() => window.open(pdfUrl, '_blank', 'noopener')}>
              <ExternalLink className="w-4 h-4 mr-2" />
              Open PDF
            </Button>
          </div>

          {canEmbed && (
            <iframe
              src={pdfUrl}
              title={`${book.title} (PDF)`}
              className="flex-1 w-full min-h-[70vh] mt-4 border-0 bg-white"
            />
          )}
        </>
      )}
    </div>
  );
}
