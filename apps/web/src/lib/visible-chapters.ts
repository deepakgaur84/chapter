/**
 * Helpers for hiding chapters that have no text (cover pages, image-only pages, section dividers).
 *
 * Nothing is removed from the book: the chapter list keeps its real indexes, so saved progress,
 * audio and the reader keep working. These helpers only decide which chapters are SHOWN in the
 * table of contents, which ones previous/next jump between, and how "Chapter X of Y" is counted.
 */

export interface ChapterLike {
  wordCount?: number | null;
}

/** True for a chapter known to have no words. A chapter with no word count recorded is kept. */
export function isEmptyChapter(chapter: ChapterLike | null | undefined): boolean {
  return !!chapter && typeof chapter.wordCount === 'number' && chapter.wordCount <= 0;
}

/**
 * Real indexes of the chapters to show. If every chapter is empty (for example a book made only
 * of images) all of them are kept, so the reader never ends up with nothing to open.
 */
export function getVisibleChapterIndexes(chapters: ChapterLike[]): number[] {
  const all = chapters.map((_, index) => index);
  const visible = all.filter((index) => !isEmptyChapter(chapters[index]));
  return visible.length > 0 ? visible : all;
}

/**
 * Position (0-based) of a chapter among the visible ones, for "Chapter X of Y".
 * If the chapter itself is hidden, the nearest visible chapter before it is used.
 */
export function getChapterPosition(visible: number[], chapterIndex: number): number {
  const upToHere = visible.filter((index) => index <= chapterIndex).length;
  return Math.max(0, upToHere - 1);
}

/** Real index of the previous visible chapter, or null if there is none. */
export function getPrevVisible(visible: number[], chapterIndex: number): number | null {
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i] < chapterIndex) return visible[i];
  }
  return null;
}

/** Real index of the next visible chapter, or null if there is none. */
export function getNextVisible(visible: number[], chapterIndex: number): number | null {
  for (const index of visible) {
    if (index > chapterIndex) return index;
  }
  return null;
}
