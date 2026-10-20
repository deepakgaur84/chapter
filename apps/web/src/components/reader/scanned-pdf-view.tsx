'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

interface ScannedBook {
  id: string;
  title: string;
  author?: string | null;
  pageCount?: number | null;
  pageAspect?: number | null;
  epubMetadata?: { pages?: number } | null;
  ocrStatus?: string | null;
  ocrProgress?: number | null;
  ocrError?: string | null;
}

interface ScannedPdfViewProps {
  book: ScannedBook;
  isOnline: boolean;
  onBack: () => void;
  /** Where to start, as a percentage (0-100) of the way through the book. Applied once. */
  restorePosition?: number;
  /** Called (at most about once a second) with the percentage (0-100) the reader has reached */
  onPositionChange?: (percentage: number) => void;
  /** Ask the server to (re)start text recognition. The parent refreshes the book afterwards. */
  onStartOcr?: () => Promise<void>;
}

const DEFAULT_ASPECT = 1.414; // A4, until the real page shape is known
const PAGE_GAP_PX = 12;
const NEAR_VIEWPORT_MARGIN = '1500px 0px'; // pages this close to the screen have their image loaded

/** Image width to ask for: the screen width times the pixel ratio, rounded so URLs repeat */
function pickImageWidth(containerWidth: number): number {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;
  const wanted = Math.max(containerWidth, 320) * dpr;
  return Math.min(2000, Math.ceil(wanted / 200) * 200);
}

interface PageProps {
  bookId: string;
  page: number;
  width: number;
  aspect: number;
}

/** One page: an empty box of the right shape, with its image loaded only while it is near the screen */
function PageImage({ bookId, page, width, aspect }: PageProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(page <= 2);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      rootMargin: NEAR_VIEWPORT_MARGIN,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={boxRef}
      data-page={page}
      className="relative w-full overflow-hidden rounded-sm bg-white/5"
      style={{ aspectRatio: `1 / ${aspect}`, marginBottom: PAGE_GAP_PX }}
    >
      {near && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={apiClient.getPageUrl(bookId, page, width)}
          alt={`Page ${page}`}
          className="absolute inset-0 w-full h-full object-contain bg-white"
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <button
          type="button"
          onClick={() => setFailed(false)}
          className="absolute inset-0 flex items-center justify-center text-xs text-[hsl(var(--reader-text))]/60"
        >
          Page {page} did not load. Tap to try again.
        </button>
      )}
    </div>
  );
}

/**
 * Shown instead of the reader for a book with no readable text yet (a scanned PDF).
 *
 * The pages are shown as images, and the place the reader has reached is saved. Meanwhile the
 * server recognises the text (OCR) in the background; when that works, the book turns into a
 * normal readable, listenable book. If it does not work, this page viewer stays.
 */
export function ScannedPdfView({
  book,
  isOnline,
  onBack,
  restorePosition,
  onPositionChange,
  onStartOcr,
}: ScannedPdfViewProps) {
  const pageCount = book.pageCount || book.epubMetadata?.pages || 0;
  const aspect = book.pageAspect || DEFAULT_ASPECT;
  const pdfUrl = useMemo(() => apiClient.getPdfUrl(book.id), [book.id]);

  const pagesRef = useRef<HTMLDivElement>(null);
  const [imageWidth, setImageWidth] = useState(1000);
  const [currentPage, setCurrentPage] = useState(1);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReported = useRef<number | null>(null);

  // Pick the image width once the box is on screen
  useEffect(() => {
    if (pagesRef.current) setImageWidth(pickImageWidth(pagesRef.current.clientWidth));
  }, []);

  // How far through the pages the top of the screen is, 0..1 (1 when the end is reached)
  const readFraction = useCallback((): number => {
    const box = pagesRef.current;
    if (!box) return 0;
    const top = box.getBoundingClientRect().top + window.scrollY;
    const track = box.offsetHeight - window.innerHeight;
    if (track <= 0) return 0;
    return Math.min(1, Math.max(0, (window.scrollY - top) / track));
  }, []);

  // Restore the saved place once, as soon as the parent says what it is
  useEffect(() => {
    if (restoredRef.current || restorePosition === undefined || pageCount === 0) return;
    restoredRef.current = true;
    if (restorePosition <= 0) return;
    const scrollToPlace = () => {
      const box = pagesRef.current;
      if (!box) return;
      const top = box.getBoundingClientRect().top + window.scrollY;
      const track = box.offsetHeight - window.innerHeight;
      if (track > 0) {
        window.scrollTo({ top: top + (restorePosition / 100) * track, behavior: 'instant' as ScrollBehavior });
      }
    };
    const timers = [setTimeout(scrollToPlace, 50), setTimeout(scrollToPlace, 400)];
    return () => timers.forEach(clearTimeout);
  }, [restorePosition, pageCount]);

  // Follow scrolling: show the page number and report the place (not before the restore ran)
  useEffect(() => {
    if (pageCount === 0) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const fraction = readFraction();
        setCurrentPage(Math.min(pageCount, Math.max(1, Math.round(fraction * (pageCount - 1)) + 1)));
        if (!restoredRef.current || !onPositionChange) return;
        if (reportTimer.current) return;
        reportTimer.current = setTimeout(() => {
          reportTimer.current = null;
          const percentage = readFraction() * 100;
          if (lastReported.current === null || Math.abs(percentage - lastReported.current) >= 0.05) {
            lastReported.current = percentage;
            onPositionChange(percentage);
          }
        }, 1000);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (reportTimer.current) {
        clearTimeout(reportTimer.current);
        reportTimer.current = null;
      }
    };
  }, [pageCount, onPositionChange, readFraction]);

  const startOcr = async () => {
    if (!onStartOcr || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await onStartOcr();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not start text recognition');
    } finally {
      setStarting(false);
    }
  };

  const working = book.ocrStatus === 'pending' || book.ocrStatus === 'running';
  const done = Math.min(book.ocrProgress ?? 0, pageCount);
  const percent = pageCount > 0 ? Math.round((done / pageCount) * 100) : 0;

  return (
    <div className="min-h-screen flex flex-col bg-[hsl(var(--reader-bg))] text-[hsl(var(--reader-text))]">
      <header className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 border-b border-[hsl(var(--reader-text))]/10 bg-[hsl(var(--reader-bg))]/95 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to library"
          className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-[hsl(var(--reader-text))]/10 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="font-medium truncate">{book.title}</h1>
          {book.author && (
            <p className="text-xs text-[hsl(var(--reader-text))]/60 truncate">{book.author}</p>
          )}
        </div>
        {isOnline && (
          <button
            type="button"
            onClick={() => window.open(pdfUrl, '_blank', 'noopener')}
            aria-label="Open the PDF in a new tab"
            title="Open the PDF in a new tab"
            className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-[hsl(var(--reader-text))]/10 transition-colors"
          >
            <ExternalLink className="w-5 h-5" />
          </button>
        )}
      </header>

      <div role="status" className="mt-4 mx-auto w-full max-w-3xl px-4 box-border">
        <div className="flex items-start gap-3 rounded-2xl border border-[hsl(var(--reader-text))]/10 bg-[hsl(var(--reader-text))]/5 p-4">
          {working ? (
            <Loader2 className="w-5 h-5 mt-0.5 shrink-0 animate-spin" />
          ) : (
            <FileText className="w-5 h-5 mt-0.5 shrink-0" />
          )}
          <div className="text-sm min-w-0 flex-1">
            {working ? (
              <>
                <p className="font-medium">Making this book readable…</p>
                <p className="mt-1 text-[hsl(var(--reader-text))]/60">
                  The text is being recognised in the background
                  {pageCount > 0 ? ` (page ${done} of ${pageCount})` : ''}. You can read the pages
                  below meanwhile. When it finishes, this book switches to the normal reader and
                  listening.
                </p>
                {pageCount > 0 && (
                  <div
                    className="mt-3 h-1.5 rounded-full bg-[hsl(var(--reader-text))]/10 overflow-hidden"
                    role="progressbar"
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full bg-[hsl(var(--reader-accent))] transition-all duration-500"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
              </>
            ) : book.ocrStatus === 'failed' ? (
              <>
                <p className="font-medium">Text recognition did not work</p>
                <p className="mt-1 text-[hsl(var(--reader-text))]/60">
                  {book.ocrError || 'The text could not be recognised.'} You can still read the
                  pages below. Listening is not available for this book.
                </p>
                {onStartOcr && (
                  <div className="mt-3">
                    <Button onClick={startOcr} disabled={starting}>
                      {starting ? 'Starting…' : 'Try again'}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="font-medium">This PDF is a scan with no readable text</p>
                <p className="mt-1 text-[hsl(var(--reader-text))]/60">
                  You can read the pages below. To read it as text and listen to it, the text has
                  to be recognised first.
                </p>
                {onStartOcr && (
                  <div className="mt-3">
                    <Button onClick={startOcr} disabled={starting}>
                      {starting ? 'Starting…' : 'Make readable'}
                    </Button>
                  </div>
                )}
              </>
            )}
            {startError && <p className="mt-2 text-red-500">{startError}</p>}
          </div>
        </div>
      </div>

      {!isOnline ? (
        <p className="mx-auto w-full max-w-3xl px-4 mt-4 text-sm text-[hsl(var(--reader-text))]/60">
          You are offline. The pages need an internet connection.
        </p>
      ) : pageCount > 0 ? (
        <div ref={pagesRef} className="mx-auto w-full max-w-3xl px-2 mt-4 pb-24">
          {Array.from({ length: pageCount }, (_, i) => (
            <PageImage
              key={i + 1}
              bookId={book.id}
              page={i + 1}
              width={imageWidth}
              aspect={aspect}
            />
          ))}
        </div>
      ) : (
        <p className="mx-auto w-full max-w-3xl px-4 mt-4 text-sm text-[hsl(var(--reader-text))]/60">
          The pages are not available yet. Use the button at the top to open the PDF.
        </p>
      )}

      {isOnline && pageCount > 0 && (
        <div
          aria-live="off"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 rounded-full bg-black/70 px-3 py-1 text-xs text-white shadow-lg pointer-events-none"
        >
          Page {currentPage} of {pageCount}
        </div>
      )}
    </div>
  );
}
