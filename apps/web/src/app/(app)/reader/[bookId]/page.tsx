'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/hooks/use-auth';
import { useBook, useBookStructure, useChapter } from '@/lib/hooks/use-books';
import { useChunkPipeline } from '@/lib/hooks/use-chunk-pipeline';
import { useProgress } from '@/lib/hooks/use-progress';
import { useSettingsStore } from '@/lib/stores/settings-store';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';
import { ChapterNav } from '@/components/reader/chapter-nav';
import { AudioPlayer } from '@/components/reader/AudioPlayer';
import { ReaderMode } from '@/components/reader/ModeToggle';
import { ReadAlongView } from '@/components/reader/ReadAlongView';
import { UnifiedControls } from '@/components/reader/unified-controls';
import { ScannedPdfView } from '@/components/reader/scanned-pdf-view';
import { readingToAudioPosition, audioToReadingPosition } from '@/lib/position-sync';
import { chunkKey, resolveChunkIndex } from '@/lib/chunk-pipeline';
import {
  getVisibleChapterIndexes,
  getChapterPosition,
  getPrevVisible,
  getNextVisible,
} from '@/lib/visible-chapters';

// Saved with the place in a scanned book's page viewer, so that if the book later becomes readable
// text (OCR), the place can be carried over (page position -> chapter and position in chapter)
const SCANNED_MARKER = 'scanned-pdf';

export default function ReaderPage() {
  const params = useParams();
  const router = useRouter();
  const bookId = params.bookId as string;
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { data: book, isLoading: bookLoading } = useBook(bookId);
  const { data: structure } = useBookStructure(bookId);

  const [currentChapter, setCurrentChapter] = useState(0);
  const [showNav, setShowNav] = useState(false);
  const [mode, setMode] = useState<ReaderMode>('reading');
  const [isProgressRestored, setIsProgressRestored] = useState(false);
  const [currentScrollProgress, setCurrentScrollProgress] = useState(0);
  const [currentAudioTime, setCurrentAudioTime] = useState(0);
  const [currentAudioChunk, setCurrentAudioChunk] = useState<string | null>(null);

  const { progress, updateProgress, saveNow } = useProgress(bookId);
  const { data: chapter, isLoading: chapterLoading } = useChapter(bookId, currentChapter);
  const { isOnline } = useOnlineStatus();
  const { tts } = useSettingsStore();

  // Get chapter ID from structure
  const chapterId = structure?.chapters[currentChapter]?.id;

  // Chapters with no words (cover pages, image-only pages) are hidden from the table of contents
  // and skipped by previous/next. `currentChapter` stays the real index; only the counts shown
  // ("Chapter X of Y") and the progress percentage use the visible chapters.
  const visibleIndexes = structure ? getVisibleChapterIndexes(structure.chapters) : [];
  const visibleCount = visibleIndexes.length;
  const chapterPosition = getChapterPosition(visibleIndexes, currentChapter);
  const prevVisibleChapter = getPrevVisible(visibleIndexes, currentChapter);
  const nextVisibleChapter = getNextVisible(visibleIndexes, currentChapter);

  // Plan of the chapter's audio chunks. Audio is generated a few chunks at a time, only while
  // the player is playing (see AudioPlayer), instead of all at once.
  const pipeline = useChunkPipeline({
    bookId,
    chapterId,
    voiceId: tts.voiceId,
    speed: tts.speed,
    temperature: tts.temperature,
    enabled: !!chapterId && isOnline,
  });
  const audioChunks = pipeline.chunks;

  // Handle scroll progress updates (only in reading mode)
  const handleScrollProgress = useCallback(
    (percentage: number) => {
      setCurrentScrollProgress(percentage);
      // Only save scroll progress in reading mode - listening mode uses audio position
      if (mode === 'reading') {
        updateProgress({
          chapterIndex: currentChapter,
          chapterId: chapterId,
          scrollPosition: percentage,
          percentage: ((chapterPosition + percentage / 100) / (visibleCount || 1)) * 100,
        });
      }
    },
    [currentChapter, chapterId, chapterPosition, visibleCount, updateProgress, mode]
  );

  const handlePositionChange = useCallback(
    (position: number, chunkId?: string) => {
      setCurrentAudioTime(position);
      if (chunkId) setCurrentAudioChunk(chunkId);

      updateProgress({
        chapterIndex: currentChapter,
        chapterId: chapterId,
        audioTimestamp: position,
        audioChunkId: chunkId,
      });
    },
    [currentChapter, chapterId, updateProgress]
  );

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  // Restore progress on mount
  useEffect(() => {
    if (progress && !isProgressRestored) {
      setCurrentChapter(progress.chapterIndex);
      setCurrentScrollProgress(progress.scrollPosition || 0);
      const restoredMode = progress.mode === 'audio' ? 'listening' : 'reading';
      setMode(restoredMode);

      // Restore audio position if in listening mode
      if (restoredMode === 'listening' && progress.audioTimestamp !== undefined) {
        setCurrentAudioTime(progress.audioTimestamp);
        if (progress.audioChunkId) {
          setCurrentAudioChunk(progress.audioChunkId);
        }
      }

      setIsProgressRestored(true);
    }
  }, [progress, isProgressRestored]);

  // Save progress on unmount
  useEffect(() => {
    return () => {
      saveNow().catch(console.error);
    };
  }, [saveNow]);

  // Update document title with book name
  useEffect(() => {
    if (book?.title) {
      document.title = `${book.title} - Chapter`;
    }
    return () => {
      document.title = 'Chapter';
    };
  }, [book?.title]);

  // Switch to reading mode if we go offline while listening
  useEffect(() => {
    if (!isOnline && mode === 'listening') {
      setMode('reading');
    }
  }, [isOnline, mode]);

  // Go back to reading mode if the audio plan cannot be loaded, or the chapter has no text
  useEffect(() => {
    if (mode !== 'listening') return;
    if (pipeline.planError) {
      console.error('Audio is not available:', pipeline.planError);
      setMode('reading');
    } else if (pipeline.isPlanReady && pipeline.chunks.length === 0) {
      setMode('reading');
    }
  }, [mode, pipeline.planError, pipeline.isPlanReady, pipeline.chunks.length]);

  // --- scanned PDFs: page viewer first, readable text once OCR has finished -------------------
  const queryClient = useQueryClient();
  const scanPercentRef = useRef(0);
  const wasScannedRef = useRef(false);
  const mappedRef = useRef(false);
  const [mappedScroll, setMappedScroll] = useState<number | null>(null);

  const handleScanPosition = useCallback(
    (percentage: number) => {
      scanPercentRef.current = percentage;
      updateProgress({
        chapterIndex: 0,
        scrollPosition: percentage,
        percentage,
        audioChunkId: SCANNED_MARKER,
        mode: 'reading',
      });
    },
    [updateProgress]
  );

  const handleStartOcr = useCallback(async () => {
    await apiClient.startOcr(bookId);
    await queryClient.invalidateQueries({ queryKey: ['book', bookId] });
  }, [bookId, queryClient]);

  // The book was a scan a moment ago and now has text: load its chapters
  useEffect(() => {
    if (book?.hasText === false) {
      wasScannedRef.current = true;
    } else if (book?.hasText && wasScannedRef.current) {
      wasScannedRef.current = false;
      queryClient.invalidateQueries({ queryKey: ['book-structure', bookId] });
      queryClient.invalidateQueries({ queryKey: ['chapter', bookId] });
    }
  }, [book?.hasText, bookId, queryClient]);

  // Carry the place reached in the page viewer over to the new text: the same share of the way
  // through the book, found by character position
  const hadScanPlace = progress?.audioChunkId === SCANNED_MARKER || scanPercentRef.current > 0;
  useEffect(() => {
    if (mappedRef.current || !book?.hasText || !hadScanPlace || !progress) return;
    const chapters: any[] = structure?.chapters || [];
    if (chapters.length === 0) return;

    mappedRef.current = true;
    const percent = scanPercentRef.current > 0 ? scanPercentRef.current : progress.scrollPosition || 0;
    const total = chapters[chapters.length - 1].endPosition || 0;
    const target = (percent / 100) * total;
    const withText = chapters.filter((c) => (c.charCount ?? 1) > 0);
    const hit =
      withText.find((c) => target >= c.startPosition && target < c.endPosition) ||
      withText[withText.length - 1] ||
      chapters[0];
    const span = hit.endPosition - hit.startPosition;
    const within = span > 0 ? Math.min(100, Math.max(0, ((target - hit.startPosition) / span) * 100)) : 0;

    setCurrentChapter(hit.index);
    setCurrentScrollProgress(within);
    setMappedScroll(within);
    updateProgress({
      chapterIndex: hit.index,
      chapterId: hit.id,
      scrollPosition: within,
      percentage: percent,
      audioChunkId: '',
      mode: 'reading',
    });
  }, [book?.hasText, hadScanPlace, progress, structure, updateProgress]);

  if (authLoading || bookLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated || !book) {
    return null;
  }

  // A scanned PDF has no text (yet): show its pages, with reading mode and listening unavailable
  if (book.hasText === false) {
    return (
      <ScannedPdfView
        book={book}
        isOnline={isOnline}
        onBack={() => router.push('/library')}
        restorePosition={
          isProgressRestored
            ? progress?.audioChunkId === SCANNED_MARKER
              ? progress.scrollPosition || 0
              : 0
            : undefined
        }
        onPositionChange={handleScanPosition}
        onStartOcr={handleStartOcr}
      />
    );
  }

  const goToPrevChapter = () => {
    if (prevVisibleChapter !== null) {
      const newChapter = prevVisibleChapter;
      setCurrentChapter(newChapter);
      setCurrentScrollProgress(0);
      updateProgress({
        chapterIndex: newChapter,
        chapterId: structure?.chapters[newChapter]?.id,
        scrollPosition: 0,
        audioTimestamp: 0,
      });
    }
  };

  const goToNextChapter = () => {
    if (structure && nextVisibleChapter !== null) {
      const newChapter = nextVisibleChapter;
      setCurrentChapter(newChapter);
      setCurrentScrollProgress(0);
      updateProgress({
        chapterIndex: newChapter,
        chapterId: structure?.chapters[newChapter]?.id,
        scrollPosition: 0,
        audioTimestamp: 0,
      });
    }
  };

  const handleModeChange = (newMode: ReaderMode) => {
    const oldMode = mode;
    setMode(newMode);

    const chapterText = chapter?.paragraphs?.map((p: any) => p.text).join('\n\n') || '';

    if (newMode === 'listening' && oldMode === 'reading') {
      if (audioChunks.length > 0 && chapterText) {
        // Chunks are identified by position (idx:N) so this works before their audio exists
        const audioPos = readingToAudioPosition(
          currentScrollProgress,
          chapterText,
          audioChunks.map((chunk) => ({
            id: chunkKey(chunk.index),
            startPosition: chunk.startPosition,
            endPosition: chunk.endPosition,
            audioDuration: chunk.audioDuration,
          }))
        );

        if (audioPos) {
          updateProgress({
            chapterIndex: currentChapter,
            chapterId: chapterId,
            mode: 'audio',
            audioTimestamp: audioPos.timestamp,
            audioChunkId: audioPos.chunkId,
          });
          return;
        }
      }
    } else if (newMode === 'reading' && oldMode === 'listening') {
      if (audioChunks.length > 0 && progress?.audioChunkId) {
        const savedIndex = resolveChunkIndex(audioChunks, progress.audioChunkId);
        const scrollPos = audioToReadingPosition(
          chunkKey(savedIndex),
          progress.audioTimestamp || 0,
          chapterText,
          audioChunks.map((chunk) => ({
            id: chunkKey(chunk.index),
            startPosition: chunk.startPosition,
            endPosition: chunk.endPosition,
            audioDuration: chunk.audioDuration,
          }))
        );

        updateProgress({
          chapterIndex: currentChapter,
          chapterId: chapterId,
          mode: 'reading',
          scrollPosition: scrollPos,
        });
        return;
      }
    }

    updateProgress({
      chapterIndex: currentChapter,
      chapterId: chapterId,
      mode: newMode === 'reading' ? 'reading' : 'audio',
    });
  };

  const currentChapterData = structure?.chapters[currentChapter];

  const estimatedProgress = structure
    ? ((chapterPosition + currentScrollProgress / 100) / (visibleCount || 1)) * 100
    : progress?.percentage || 0;

  return (
    <div className="min-h-screen bg-[hsl(var(--reader-bg))]">
      {showNav && structure && (
        <ChapterNav
          chapters={structure.chapters}
          currentChapter={currentChapter}
          onSelectChapter={(index) => {
            setCurrentChapter(index);
            setCurrentScrollProgress(0);
            setShowNav(false);
          }}
          onClose={() => setShowNav(false)}
        />
      )}

      {/* Unified reading content - same UI for both modes */}
      <div className="pb-24">
        <ReadAlongView
          chapter={chapter}
          isLoading={chapterLoading}
          onScrollProgress={handleScrollProgress}
          initialScrollPosition={
            !isProgressRestored
              ? undefined
              : hadScanPlace && mappedScroll === null
                ? undefined // wait until the place in the page viewer has been turned into a chapter
                : (mappedScroll ?? progress?.scrollPosition)
          }
        />
      </div>

      {/* Short loading overlay while the audio plan for this chapter loads */}
      {mode === 'listening' && pipeline.isPlanLoading && (
        <div className="fixed inset-0 z-40 pointer-events-none">
          {/* Dim backdrop */}
          <div className="absolute inset-0 bg-[hsl(var(--reader-bg))]/60 backdrop-blur-[2px] transition-opacity duration-300" />
          {/* Chiclet */}
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 pointer-events-auto">
            <div className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-[hsl(var(--reader-bg))] backdrop-blur-xl border border-[hsl(var(--reader-text))]/10 shadow-2xl">
              <div className="w-5 h-5 border-2 border-[hsl(var(--reader-accent))]/20 border-t-[hsl(var(--reader-accent))] rounded-full animate-spin" />
              <div className="flex flex-col">
                <p className="text-sm font-semibold text-[hsl(var(--reader-text))]">
                  Preparing audio...
                </p>
                <p className="text-xs text-[hsl(var(--reader-text))]/50">
                  This will only take a moment
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Controls - switch between reading and audio player */}
      {mode === 'reading' ? (
        <UnifiedControls
          book={book}
          currentChapter={chapterPosition}
          totalChapters={visibleCount}
          bookProgress={estimatedProgress}
          onBack={() => router.push('/library')}
          onToggleNav={() => setShowNav(!showNav)}
          onPrevChapter={goToPrevChapter}
          onNextChapter={goToNextChapter}
          hasPrev={prevVisibleChapter !== null}
          hasNext={nextVisibleChapter !== null}
          mode={mode}
          onModeChange={handleModeChange}
          disableListening={!isOnline}
          disableListeningReason="Listen mode requires an internet connection"
        />
      ) : audioChunks.length > 0 ? (
        <AudioPlayer
          bookId={bookId}
          chapterId={chapterId || ''}
          chapterTitle={currentChapterData?.title || `Chapter ${currentChapter + 1}`}
          pipeline={pipeline}
          onPositionChange={handlePositionChange}
          initialChunkId={currentAudioChunk || undefined}
          initialTime={currentAudioTime || undefined}
          book={book}
          currentChapter={chapterPosition}
          totalChapters={visibleCount}
          onBack={() => router.push('/library')}
          onToggleNav={() => setShowNav(!showNav)}
          mode={mode}
          onModeChange={handleModeChange}
        />
      ) : null}
    </div>
  );
}
