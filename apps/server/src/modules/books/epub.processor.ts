import crypto from 'crypto';
import path from 'path';
import { parseEPUB } from '@chapter/epub-parser';
import { tokenize, countWords } from '@chapter/utils';
import { prisma } from '../../core/database';
import { config } from '../../core/config';
import { saveFile, deleteFile } from '../../core/storage';
import { compareBooks } from './duplicates';

/** Set when the EPUB was converted from a PDF: the book is identified by the PDF, not the EPUB */
export interface PdfSource {
  fileHash: string;
  fileSize: number;
  pdfPath: string;
}

// ISBN-10 / ISBN-13, so the random identifier of a converted PDF is not stored as an ISBN
const looksLikeIsbn = (value?: string): boolean =>
  !!value && /^(97[89])?\d{9}[\dX]$/i.test(value.replace(/[-\s]/g, ''));

export interface ImportResult {
  bookId: string;
  /** False when nothing new was added: the same file, or a copy of a book already in the library */
  created: boolean;
  /** Set when the file looks like a different copy (another format or edition) of this book */
  duplicateOf?: { id: string; title: string };
}

// Imports run one at a time. Two imports of the same book at once (an upload during a folder
// scan, or two scans) would otherwise both find nothing and both add it.
let importQueue: Promise<unknown> = Promise.resolve();
function inImportQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = importQueue.then(task, task);
  importQueue = run.catch(() => undefined);
  return run;
}

export class EPUBProcessor {
  async processEPUB(
    userId: string,
    epubBuffer: Buffer,
    filename: string,
    source?: PdfSource
  ): Promise<string> {
    return (await this.importEPUB(userId, epubBuffer, filename, source)).bookId;
  }

  /** Like processEPUB, but says whether a book was added or the file was a duplicate */
  importEPUB(
    userId: string,
    epubBuffer: Buffer,
    filename: string,
    source?: PdfSource
  ): Promise<ImportResult> {
    return inImportQueue(() => this.importEPUBNow(userId, epubBuffer, filename, source));
  }

  /**
   * A book already in this person's library that is clearly the same as the one being imported:
   * the same ISBN, or the same title with an author in common. A same title with an author
   * missing on one side is NOT treated as a duplicate here (it may be a different book); those
   * are listed for review in Settings instead.
   */
  private async findCopyInLibrary(
    userId: string,
    candidate: { title: string; author?: string; isbn?: string }
  ): Promise<{ id: string; title: string } | null> {
    const links = await prisma.userBook.findMany({
      where: { userId },
      select: { book: { select: { id: true, title: true, author: true, isbn: true } } },
    });
    for (const link of links) {
      const book = link.book;
      if (compareBooks({ id: 'new', ...candidate }, book) === 'sure') {
        return { id: book.id, title: book.title };
      }
    }
    return null;
  }

  private async importEPUBNow(
    userId: string,
    epubBuffer: Buffer,
    filename: string,
    source?: PdfSource
  ): Promise<ImportResult> {
    const fileHash = source
      ? source.fileHash
      : crypto.createHash('sha256').update(epubBuffer).digest('hex');

    let book = await prisma.book.findUnique({
      where: { fileHash },
    });

    if (book) {
      await this.linkBookToUser(userId, book.id);
      return { bookId: book.id, created: false };
    }

    const structure = await parseEPUB(epubBuffer);

    const normalize = (field: any): string | undefined => {
      if (!field) return undefined;
      if (typeof field === 'string') return field;
      if (typeof field === 'object' && field._) return field._;
      return undefined;
    };
    const copy = await this.findCopyInLibrary(userId, {
      title: normalize(structure.metadata.title) || '',
      author: normalize(structure.metadata.author),
      // The identifier of a converted PDF is random, not an ISBN
      isbn: source ? undefined : normalize(structure.metadata.isbn),
    });
    if (copy) {
      return { bookId: copy.id, created: false, duplicateOf: copy };
    }

    const filePath = path.join(config.storage.booksPath, `${fileHash}.epub`);
    await saveFile(filePath, epubBuffer);

    let coverPath: string | undefined;
    if (structure.metadata.coverData) {
      coverPath = path.join(config.storage.booksPath, `${fileHash}-cover.jpg`);
      await saveFile(coverPath, structure.metadata.coverData);
    }

    const normalizeField = normalize;

    const { coverData: _, ...epubMetadata } = structure.metadata;

    try {
      book = await prisma.book.create({
        data: {
          title: normalizeField(structure.metadata.title) || 'Untitled',
          author: normalizeField(structure.metadata.author),
          isbn: source
            ? looksLikeIsbn(normalizeField(structure.metadata.isbn))
              ? normalizeField(structure.metadata.isbn)
              : undefined
            : normalizeField(structure.metadata.isbn),
          language: normalizeField(structure.metadata.language),
          publisher: normalizeField(structure.metadata.publisher),
          description: normalizeField(structure.metadata.description),
          coverPath,
          filePath,
          fileSize: source ? source.fileSize : epubBuffer.length,
          fileHash,
          sourceFormat: source ? 'pdf' : 'epub',
          sourcePath: source ? source.pdfPath : null,
          hasText: true,
          epubMetadata: epubMetadata as any,
          totalWords: structure.totalWords,
          totalCharacters: structure.totalCharacters,
          totalChapters: structure.chapters.length,
        },
      });
    } catch (error: any) {
      // The same file was added by something else in the meantime
      const winner = error?.code === 'P2002' ? await prisma.book.findUnique({ where: { fileHash } }) : null;
      if (winner) {
        await this.linkBookToUser(userId, winner.id);
        return { bookId: winner.id, created: false };
      }
      await deleteFile(filePath);
      if (coverPath) await deleteFile(coverPath);
      throw error;
    }

    try {
      await this.createChapters(book.id, structure.chapters);
      await this.linkBookToUser(userId, book.id);
    } catch (error) {
      // Do not leave half a book behind: it would be found by its hash and linked as if complete
      await prisma.book.delete({ where: { id: book.id } }).catch(() => undefined);
      await deleteFile(filePath);
      if (coverPath) await deleteFile(coverPath);
      throw error;
    }

    return { bookId: book.id, created: true };
  }

  /** Save the chapters (and their paragraphs) of a parsed EPUB for a book */
  private async createChapters(
    bookId: string,
    chapters: Array<{
      index: number;
      title?: string;
      href: string;
      htmlContent: string;
      textContent: string;
    }>
  ): Promise<void> {
    let globalCharPosition = 0;

    for (const chapterData of chapters) {
      const startPosition = globalCharPosition;
      const endPosition = startPosition + chapterData.textContent.length;

      const chapter = await prisma.chapter.create({
        data: {
          bookId,
          index: chapterData.index,
          title: chapterData.title,
          href: chapterData.href,
          htmlContent: chapterData.htmlContent,
          textContent: chapterData.textContent,
          startPosition,
          endPosition,
          wordCount: countWords(chapterData.textContent),
          charCount: chapterData.textContent.length,
        },
      });

      await this.processParagraphs(chapter.id, chapterData.textContent, startPosition);

      globalCharPosition = endPosition;
    }
  }

  /**
   * Give a book that was imported without text (a scanned PDF) its text, from an EPUB made by
   * text recognition. The book becomes a normal readable, listenable book; its PDF is kept.
   */
  async attachChapters(bookId: string, epubBuffer: Buffer): Promise<void> {
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    if (!book) throw new Error('Book not found');

    const structure = await parseEPUB(epubBuffer);
    if (structure.chapters.length === 0) {
      throw new Error('The recognised text has no chapters');
    }

    const epubPath = path.join(config.storage.booksPath, `${book.fileHash}.epub`);
    await saveFile(epubPath, epubBuffer);

    try {
      await this.createChapters(book.id, structure.chapters);
      await prisma.book.update({
        where: { id: book.id },
        data: {
          filePath: epubPath, // the book is now backed by an EPUB; the PDF stays as sourcePath
          hasText: true,
          totalWords: structure.totalWords,
          totalCharacters: structure.totalCharacters,
          totalChapters: structure.chapters.length,
          ocrStatus: 'done',
          ocrProgress: book.pageCount ?? 0,
          ocrError: null,
        },
      });
    } catch (error) {
      // Leave the book as it was: a scan with no text
      await prisma.chapter.deleteMany({ where: { bookId: book.id } });
      await deleteFile(epubPath);
      throw error;
    }
  }

  private async processParagraphs(
    chapterId: string,
    chapterText: string,
    chapterStartPosition: number
  ): Promise<void> {
    // Split into paragraphs on double newlines (paragraph boundaries)
    // Single newlines (from <br> tags) are kept within paragraphs
    const paragraphs = chapterText.split(/\n\n+/).filter((p) => p.trim().length > 0);

    let paragraphStartInChapter = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i];
      const tokens = tokenize(text);
      const globalStartPosition = chapterStartPosition + paragraphStartInChapter;
      const globalEndPosition = globalStartPosition + text.length;

      await prisma.paragraph.create({
        data: {
          chapterId,
          index: i,
          text,
          tokens: tokens as any,
          startPosition: globalStartPosition,
          endPosition: globalEndPosition,
          wordCount: tokens.filter((t) => t.type === 'word').length,
        },
      });

      paragraphStartInChapter += text.length + 1;
    }
  }

  async linkBookToUser(userId: string, bookId: string): Promise<void> {
    const existing = await prisma.userBook.findUnique({
      where: {
        userId_bookId: {
          userId,
          bookId,
        },
      },
    });

    if (!existing) {
      await prisma.userBook.create({
        data: {
          userId,
          bookId,
          tags: [],
        },
      });
    }
  }
}

export const epubProcessor = new EPUBProcessor();
