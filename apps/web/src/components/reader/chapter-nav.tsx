'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { getVisibleChapterIndexes } from '@/lib/visible-chapters';

interface ChapterNavProps {
  chapters: any[];
  currentChapter: number;
  onSelectChapter: (index: number) => void;
  onClose: () => void;
}

export function ChapterNav({
  chapters,
  currentChapter,
  onSelectChapter,
  onClose,
}: ChapterNavProps) {
  const [isVisible, setIsVisible] = useState(false);

  // Chapters with no words (cover pages, image-only pages) are left out of the list.
  // `chapterIndex` is the real index, which is what the reader uses; the number shown beside
  // each entry counts only the visible chapters.
  const entries = getVisibleChapterIndexes(chapters).map((chapterIndex) => ({
    chapter: chapters[chapterIndex],
    chapterIndex,
  }));

  useEffect(() => {
    // Trigger animation
    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    setTimeout(onClose, 200);
  };

  const handleSelectChapter = (index: number) => {
    setIsVisible(false);
    setTimeout(() => onSelectChapter(index), 200);
  };

  return (
    <div
      className={`fixed inset-0 z-50 bg-[hsl(var(--reader-bg))]/98 backdrop-blur-lg transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleClose}
    >
      <div
        className={`h-full flex flex-col max-w-2xl mx-auto transition-transform duration-300 ${
          isVisible ? 'translate-y-0' : '-translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-border/50 px-6 h-16 flex items-center justify-between">
          <h2 className="text-lg font-serif font-semibold text-[hsl(var(--reader-text))]">
            Table of Contents
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="hover:bg-accent/50 transition-colors duration-200"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Chapter list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="divide-y divide-border/30">
            {entries.map(({ chapter, chapterIndex }, position) => (
              <button
                key={chapterIndex}
                onClick={() => handleSelectChapter(chapterIndex)}
                className={`w-full text-left px-6 py-5 transition-all duration-200 hover:bg-accent/50 ${
                  chapterIndex === currentChapter
                    ? 'bg-[hsl(var(--reader-accent))]/10 border-l-2 border-[hsl(var(--reader-accent))]'
                    : ''
                }`}
                style={{
                  animationDelay: `${Math.min(position * 30, 300)}ms`,
                }}
              >
                <div className="flex items-start gap-4">
                  <span
                    className={`text-xs font-mono font-medium mt-0.5 transition-colors ${
                      chapterIndex === currentChapter
                        ? 'text-[hsl(var(--reader-accent))]'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {String(position + 1).padStart(2, '0')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm font-serif transition-colors ${
                        chapterIndex === currentChapter
                          ? 'font-semibold text-[hsl(var(--reader-text))]'
                          : 'text-[hsl(var(--reader-text))]/80'
                      }`}
                    >
                      {chapter.title || `Chapter ${position + 1}`}
                    </p>
                    {chapter.wordCount > 0 ? (
                      <p className="text-xs text-muted-foreground mt-1.5 font-medium tracking-wide">
                        {chapter.wordCount.toLocaleString()} words
                      </p>
                    ) : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
