'use client';

import { useState, useEffect, useCallback, memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Menu } from '@base-ui/react/menu';
import { Tooltip } from '@base-ui/react/tooltip';
import { apiClient } from '@/lib/api-client';
import { offlineStorage } from '@/lib/offline-storage';
import {
  Download,
  Check,
  Loader2,
  MoreHorizontal,
  ImageIcon,
  BookOpen,
  Edit,
  Star,
  Trash2,
} from 'lucide-react';

// Global cover URL cache to persist across component mounts/unmounts
// This prevents cover flashing when books are re-arranged during scaling
const coverCache = new Map<string, string>();

function getCachedCover(bookId: string): string | null {
  return coverCache.get(bookId) || null;
}

function setCachedCover(bookId: string, url: string): void {
  // Revoke old URL if exists
  const oldUrl = coverCache.get(bookId);
  if (oldUrl && oldUrl !== url) {
    URL.revokeObjectURL(oldUrl);
  }
  coverCache.set(bookId, url);
}

function clearCachedCover(bookId: string): void {
  const url = coverCache.get(bookId);
  if (url) {
    URL.revokeObjectURL(url);
    coverCache.delete(bookId);
  }
}

// Tailwind safelist: These classes must be statically present for JIT to include them
// prettier-ignore
const BOOK_COLORS = [
  'from-rose-800 to-rose-950',     // bg-gradient-to-br from-rose-800 to-rose-950
  'from-amber-800 to-amber-950',   // bg-gradient-to-br from-amber-800 to-amber-950
  'from-emerald-800 to-emerald-950', // bg-gradient-to-br from-emerald-800 to-emerald-950
  'from-blue-800 to-blue-950',     // bg-gradient-to-br from-blue-800 to-blue-950
  'from-violet-800 to-violet-950', // bg-gradient-to-br from-violet-800 to-violet-950
  'from-slate-700 to-slate-900',   // bg-gradient-to-br from-slate-700 to-slate-900
  'from-orange-800 to-orange-950', // bg-gradient-to-br from-orange-800 to-orange-950
  'from-teal-800 to-teal-950',     // bg-gradient-to-br from-teal-800 to-teal-950
  'from-indigo-800 to-indigo-950', // bg-gradient-to-br from-indigo-800 to-indigo-950
  'from-stone-700 to-stone-900',   // bg-gradient-to-br from-stone-700 to-stone-900
] as const;

// Generate a consistent color based on the book title
function getBookColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash << 5) - hash + title.charCodeAt(i);
    hash = hash & hash;
  }

  return BOOK_COLORS[Math.abs(hash) % BOOK_COLORS.length];
}
import { useDownload } from '@/lib/hooks/use-download';
import { useBooks } from '@/lib/hooks/use-books';
import { CoverPickerDialog } from './cover-picker-dialog';
import { MetadataEditorModal } from '../books/metadata-editor-modal';
import { useQueryClient } from '@tanstack/react-query';

interface BookCardProps {
  book: any;
}

// Generate consistent random offset based on book ID
function getTextureOffset(bookId: string): { x: number; y: number } {
  let hash = 0;
  for (let i = 0; i < bookId.length; i++) {
    hash = (hash << 5) - hash + bookId.charCodeAt(i);
    hash = hash & hash;
  }
  // Generate offsets between 0-200px for variety
  const x = Math.abs(hash % 200);
  const y = Math.abs((hash >> 8) % 200);
  return { x, y };
}

export const BookCard = memo(function BookCard({ book }: BookCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toggleFavorite, deleteBook } = useBooks();
  // Initialize from cache to prevent flash on remount
  const [coverUrl, setCoverUrl] = useState<string | null>(() => getCachedCover(book.id));
  const textureOffset = useMemo(() => getTextureOffset(book.id), [book.id]);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [showCoverPicker, setShowCoverPicker] = useState(false);
  const [showMetadataEditor, setShowMetadataEditor] = useState(false);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [alsoDeleteFile, setAlsoDeleteFile] = useState(false);
  const { downloadBook, isDownloading, progress } = useDownload();

  const loadCover = useCallback(
    async (forceReload = false) => {
      const bookId = book.id;
      const coverPath = book.coverPath;

      // Check cache first (unless force reloading)
      if (!forceReload) {
        const cached = getCachedCover(bookId);
        if (cached) {
          setCoverUrl(cached);
          return;
        }
      }

      try {
        const offlineCover = await offlineStorage.getCover(bookId);
        if (offlineCover) {
          const url = URL.createObjectURL(offlineCover);
          setCachedCover(bookId, url);
          setCoverUrl(url);
          return;
        }

        if (coverPath) {
          const blob = await apiClient.getCover(bookId);
          const url = URL.createObjectURL(blob);
          setCachedCover(bookId, url);
          setCoverUrl(url);
        } else if (forceReload) {
          clearCachedCover(bookId);
          setCoverUrl(null);
        }
      } catch (error) {
        console.error('Failed to load cover for book:', bookId, error);
      }
    },
    [book.id, book.coverPath]
  );

  const checkDownloaded = useCallback(async () => {
    const downloaded = await offlineStorage.isBookDownloaded(book.id);
    setIsDownloaded(downloaded);
  }, [book.id]);

  // Initial load - only if not already cached
  useEffect(() => {
    if (!getCachedCover(book.id)) {
      loadCover(false);
    }
    checkDownloaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]); // Only reload when book.id changes

  // No cleanup on unmount - cover URLs are cached globally

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isDownloaded && !isDownloading) {
      try {
        await downloadBook(book.id);
        setIsDownloaded(true);
      } catch (error) {
        console.error('Download failed:', error);
      }
    }
  };

  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTogglingFavorite) return;

    setIsTogglingFavorite(true);
    try {
      await toggleFavorite(book.id, !book.isFavorite);
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    } finally {
      setIsTogglingFavorite(false);
    }
  };

  const closeDeleteConfirm = useCallback(() => {
    if (isDeleting) return;
    setShowDeleteConfirm(false);
    setDeleteError(null);
    setAlsoDeleteFile(false);
  }, [isDeleting]);

  // Close the delete confirmation with Escape
  useEffect(() => {
    if (!showDeleteConfirm) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDeleteConfirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showDeleteConfirm, closeDeleteConfirm]);

  // Remove the book from the library. By default only Chapter's own copy is deleted and the
  // original .epub in any watched folder is left alone. With the checkbox ticked, the original
  // file(s) in the watched folders are deleted too, so a rescan cannot bring the book back.
  const handleConfirmDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteBook(book.id, alsoDeleteFile);
      if (result && result.failed.length > 0) {
        // The book is already gone from the library; tell the user the file is still there
        window.alert(
          `The book was removed from the library, but ${result.failed.length} file(s) could not ` +
            `be deleted from the folder, so it may be added again on the next scan:\n\n` +
            result.failed.map((f) => `${f.path}: ${f.error}`).join('\n')
        );
      }
    } catch (error) {
      console.error('Failed to delete book:', error);
      setDeleteError(error instanceof Error ? error.message : 'Could not delete the book');
      setIsDeleting(false);
      return;
    }

    // The book is gone from the server: also drop the offline copy and cached cover on this device
    try {
      await offlineStorage.deleteBook(book.id);
    } catch (error) {
      console.error('Failed to remove offline copy:', error);
    }
    clearCachedCover(book.id);
    // The card disappears when the books list refreshes, so there is nothing more to reset
  };

  const handleSaveMetadata = useCallback(
    async (metadata: any) => {
      const bookId = book.id;
      console.log('Saving metadata for book:', bookId, metadata);
      await apiClient.updateBookMetadata(bookId, metadata);
      // Wait for the books query to refetch so we have fresh data
      await queryClient.refetchQueries({ queryKey: ['books'] });
      // Force reload cover since it may have been updated
      loadCover(true);
    },
    [book.id, queryClient, loadCover]
  );

  return (
    <div className="group w-full">
      <div
        className="cursor-pointer relative w-full"
        onClick={() => router.push(`/reader/${book.id}`)}
      >
        {/* Book Cover */}
        <div className="w-full aspect-[2/3] bg-stone-800 overflow-hidden relative book-cover">
          {/* Spine shadow overlay */}
          <div className="absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-black/40 via-black/20 to-transparent z-10 pointer-events-none" />

          {coverUrl ? (
            <img
              src={coverUrl}
              alt={book.title}
              className="w-full h-full object-cover"
              onError={() => setCoverUrl(null)}
            />
          ) : (
            <div
              className={`w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-br ${getBookColor(book.title)}`}
            >
              {/* Decorative top border */}
              <div className="absolute top-3 left-4 right-4 h-px bg-white/20" />
              <div className="absolute top-4 left-4 right-4 h-px bg-white/10" />

              {/* Book icon */}
              <BookOpen className="w-6 h-6 text-white/30 mb-3" />

              {/* Title */}
              <h3 className="text-white font-serif text-sm font-semibold text-center leading-tight line-clamp-4 px-1">
                {book.title}
              </h3>

              {/* Author */}
              {book.author && (
                <p className="text-white/60 text-xs text-center mt-2 line-clamp-2">{book.author}</p>
              )}

              {/* Decorative bottom border */}
              <div className="absolute bottom-4 left-4 right-4 h-px bg-white/10" />
              <div className="absolute bottom-3 left-4 right-4 h-px bg-white/20" />
            </div>
          )}

          {/* Leather texture overlay - randomized offset per book */}
          <div
            className="absolute inset-0 pointer-events-none z-[5] opacity-50"
            style={{
              backgroundImage: 'url(/leather.png)',
              backgroundPosition: `${textureOffset.x}px ${textureOffset.y}px`,
            }}
          />

          {/* Progress bar - always visible when there's progress */}
          {book.progress > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/40 z-30">
              <div
                className="h-full bg-[hsl(var(--reader-accent))] transition-all duration-500"
                style={{ width: `${book.progress}%` }}
              />
            </div>
          )}

          {/* Persistent badges - always visible when active */}
          <div className="absolute top-2 left-2 flex flex-col gap-1.5 z-20">
            {/* Favorite badge - always visible when favorited */}
            {book.isFavorite && (
              <div className="w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center shadow-md">
                <Star className="w-3 h-3 text-white fill-current" />
              </div>
            )}
            {/* Downloaded badge - always visible when downloaded */}
            {isDownloaded && (
              <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shadow-md">
                <Check className="w-3 h-3 text-white" strokeWidth={2.5} />
              </div>
            )}
          </div>

          {/* Hover overlay - subtle gradient at bottom only */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-all duration-300 pointer-events-none" />

          {/* Book info on hover - bottom */}
          <div className="absolute bottom-0 left-0 right-0 p-3 pb-4 translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300 ease-out">
            <h3 className="font-medium text-sm text-white line-clamp-2 leading-snug drop-shadow-lg">
              {book.title}
            </h3>
            {book.author && (
              <p className="text-xs text-white/70 line-clamp-1 mt-1">{book.author}</p>
            )}
            {book.progress > 0 && (
              <p className="text-xs text-white/50 mt-1">{Math.round(book.progress)}%</p>
            )}
          </div>

          {/* Action strip - slides in from right edge on hover */}
          <div className="absolute top-0 bottom-0 right-0 flex items-center">
            <div className="flex flex-col gap-0 bg-black/80 backdrop-blur-md rounded-l-xl py-2 translate-x-full group-hover:translate-x-0 transition-transform duration-300 ease-out shadow-xl">
              {/* Favorite toggle */}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger
                    className={`flex items-center justify-center w-10 h-10 transition-colors duration-150 ${
                      book.isFavorite
                        ? 'text-amber-400 hover:text-amber-300'
                        : 'text-white/60 hover:text-white'
                    }`}
                    onClick={handleToggleFavorite}
                    disabled={isTogglingFavorite}
                  >
                    <Star className={`w-4 h-4 ${book.isFavorite ? 'fill-current' : ''}`} />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Positioner side="left" sideOffset={8}>
                      <Tooltip.Popup className="rounded-lg bg-black/90 px-3 py-1.5 text-xs text-white shadow-xl backdrop-blur-sm">
                        {book.isFavorite ? 'Unfavorite' : 'Favorite'}
                      </Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>

              {/* Divider */}
              <div className="w-5 h-px bg-white/10 mx-auto" />

              {/* Edit */}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger
                    className="flex items-center justify-center w-10 h-10 text-white/60 hover:text-white transition-colors duration-150"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMetadataEditor(true);
                    }}
                  >
                    <Edit className="w-4 h-4" />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Positioner side="left" sideOffset={8}>
                      <Tooltip.Popup className="rounded-lg bg-black/90 px-3 py-1.5 text-xs text-white shadow-xl backdrop-blur-sm">
                        Edit
                      </Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>

              {/* Download - only show if not downloaded */}
              {!isDownloaded && (
                <>
                  <div className="w-5 h-px bg-white/10 mx-auto" />
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        className="flex items-center justify-center w-10 h-10 text-white/60 hover:text-white transition-colors duration-150"
                        onClick={handleDownload}
                        disabled={isDownloading}
                      >
                        {isDownloading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Positioner side="left" sideOffset={8}>
                          <Tooltip.Popup className="rounded-lg bg-black/90 px-3 py-1.5 text-xs text-white shadow-xl backdrop-blur-sm">
                            {isDownloading ? 'Downloading...' : 'Download'}
                          </Tooltip.Popup>
                        </Tooltip.Positioner>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                </>
              )}
              {/* Divider */}
              <div className="w-5 h-px bg-white/10 mx-auto" />

              {/* Delete from library */}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger
                    className="flex items-center justify-center w-10 h-10 text-white/60 hover:text-red-400 transition-colors duration-150"
                    aria-label="Delete from library"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(true);
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Positioner side="left" sideOffset={8}>
                      <Tooltip.Popup className="rounded-lg bg-black/90 px-3 py-1.5 text-xs text-white shadow-xl backdrop-blur-sm">
                        Delete from library
                      </Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>
            </div>
          </div>

          {/* Download progress bar */}
          {isDownloading && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/30 backdrop-blur-sm">
              <div
                className="h-full bg-white rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
            onClick={(e) => {
              e.stopPropagation();
              closeDeleteConfirm();
            }}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={`delete-title-${book.id}`}
              className="w-full max-w-md rounded-2xl bg-stone-900 border border-white/10 shadow-2xl p-6 text-white"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id={`delete-title-${book.id}`} className="text-lg font-semibold">
                Delete from library?
              </h2>
              <p className="mt-2 text-sm text-white/80 font-medium line-clamp-2">{book.title}</p>
              <p className="mt-3 text-sm text-white/60 leading-relaxed">
                This removes the book, your reading progress and its generated audio from Chapter.
                {alsoDeleteFile
                  ? ' The original .epub file in your watched folder will also be permanently deleted.'
                  : ' The original .epub file in your folder is not touched. If the book is in a watched folder, it will be added again the next time that folder is scanned.'}
              </p>
              <label className="mt-4 flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={alsoDeleteFile}
                  onChange={(e) => setAlsoDeleteFile(e.target.checked)}
                  disabled={isDeleting}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
                />
                <span className="text-sm text-white/80 leading-snug">
                  Also delete the file from the folder
                  <span className="block text-xs text-white/50 mt-0.5">
                    Permanently deletes the original .epub from your watched folders so a rescan
                    cannot add it back. This cannot be undone. Only files that exactly match this
                    book are deleted.
                  </span>
                </span>
              </label>
              {deleteError && (
                <p className="mt-3 text-sm text-red-400" role="alert">
                  {deleteError}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeDeleteConfirm}
                  disabled={isDeleting}
                  className="px-4 py-2 rounded-lg text-sm bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={isDeleting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-60 transition-colors"
                >
                  {isDeleting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Cover Picker Dialog */}
      <CoverPickerDialog
        book={book}
        isOpen={showCoverPicker}
        onClose={() => {
          setShowCoverPicker(false);
          clearCachedCover(book.id);
          loadCover(true);
        }}
      />

      {/* Metadata Editor Modal */}
      <MetadataEditorModal
        book={book}
        isOpen={showMetadataEditor}
        onClose={() => setShowMetadataEditor(false)}
        onSave={handleSaveMetadata}
      />
    </div>
  );
});
