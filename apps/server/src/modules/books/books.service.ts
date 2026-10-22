import { prisma } from '../../core/database';
import { libraryService } from '../library/library.service';
import { pdfConverterService } from './pdf-converter.service';
import { ocrService } from './ocr.service';
import { audioPrepService } from '../tts/audio-prep.service';
import { readFile, deleteFile, saveFile } from '../../core/storage';
import { config } from '../../core/config';
import { openLibraryService } from './open-library.service';
import { groupLikelyDuplicates, pickBookToKeep } from './duplicates';
import type { AlternativeCover } from '@chapter/types';
import path from 'path';

export class BooksService {
  async uploadBook(userId: string, fileBuffer: Buffer, filename: string): Promise<any> {
    // PDFs are recognised by their content, not their name. A PDF or EPUB of a book that is
    // already in the library is added to that book instead of becoming a second one.
    const result = await libraryService.ingest([userId], fileBuffer, filename, { origin: 'upload' });
    const book = await this.getBookById(userId, result.bookId);
    // When the file was a copy of a book already in the library, say which one
    return result.duplicateOf ? { ...book, duplicateOf: result.duplicateOf } : book;
  }

  async getUserBooks(userId: string): Promise<any[]> {
    const userBooks = await prisma.userBook.findMany({
      where: { userId },
      include: {
        book: {
          select: {
            id: true,
            title: true,
            author: true,
            isbn: true,
            publisher: true,
            language: true,
            description: true,
            coverPath: true,
            filePath: true,
            fileSize: true,
            fileHash: true,
            totalWords: true,
            totalCharacters: true,
            totalChapters: true,
            sourceFormat: true,
            sourcePath: true,
            hasText: true,
            pageCount: true,
            ocrStatus: true,
            ocrProgress: true,
            createdAt: true,
            updatedAt: true,
            readingProgress: {
              where: { userId },
              select: {
                lastReadAt: true,
                percentage: true,
              },
              take: 1,
            },
          },
        },
      },
      orderBy: {
        addedAt: 'desc',
      },
    });

    return userBooks.map((ub) => {
      const { sourcePath, ...book } = ub.book;
      return {
        ...book,
        // True when the book has a PDF to look at (it is then opened as a PDF first)
        hasPdf: !!sourcePath,
        isFavorite: ub.isFavorite,
        isArchived: ub.isArchived,
        rating: ub.rating,
        tags: ub.tags,
        addedAt: ub.addedAt,
        lastReadAt: ub.book.readingProgress[0]?.lastReadAt || null,
        progress: ub.book.readingProgress[0]?.percentage || 0,
      };
    });
  }

  async getBookById(userId: string, bookId: string): Promise<any> {
    const userBook = await prisma.userBook.findUnique({
      where: {
        userId_bookId: {
          userId,
          bookId,
        },
      },
      include: {
        book: true,
      },
    });

    if (!userBook) {
      throw new Error('Book not found');
    }

    return {
      ...userBook.book,
      hasPdf: !!userBook.book.sourcePath,
      isFavorite: userBook.isFavorite,
      isArchived: userBook.isArchived,
      rating: userBook.rating,
      tags: userBook.tags,
    };
  }

  async getBookStructure(userId: string, bookId: string): Promise<any> {
    await this.getBookById(userId, bookId);

    const chapters = await prisma.chapter.findMany({
      where: { bookId },
      orderBy: { index: 'asc' },
      select: {
        id: true,
        index: true,
        title: true,
        href: true,
        wordCount: true,
        charCount: true,
        startPosition: true,
        endPosition: true,
      },
    });

    return { chapters };
  }

  async getChapter(userId: string, bookId: string, chapterIndex: number): Promise<any> {
    await this.getBookById(userId, bookId);

    const chapter = await prisma.chapter.findUnique({
      where: {
        bookId_index: {
          bookId,
          index: chapterIndex,
        },
      },
      include: {
        paragraphs: {
          orderBy: { index: 'asc' },
        },
      },
    });

    if (!chapter) {
      throw new Error('Chapter not found');
    }

    return chapter;
  }

  async deleteBook(userId: string, bookId: string): Promise<void> {
    await this.getBookById(userId, bookId);

    await prisma.userBook.delete({
      where: {
        userId_bookId: {
          userId,
          bookId,
        },
      },
    });

    const remainingUsers = await prisma.userBook.count({
      where: { bookId },
    });

    if (remainingUsers === 0) {
      const book = await prisma.book.findUnique({
        where: { id: bookId },
      });

      if (book) {
        // Stop any audio preparation still running for this book
        await audioPrepService.cancel(bookId);

        // Remove the generated audio files too. Deleting the book removes their database rows,
        // but not the files, which would otherwise stay on disk forever.
        const audioEntries = await prisma.tTSCache.findMany({
          where: { bookId },
          select: { audioPath: true },
        });
        for (const entry of audioEntries) {
          try {
            await deleteFile(entry.audioPath);
          } catch (error) {
            console.error(`Failed to delete audio file ${entry.audioPath}:`, error);
          }
        }

        // These are Chapter's own copies in the work folder (the EPUB, the PDF and the cover; for
        // a scanned book the EPUB and PDF are the same file). The books folder is read-only and
        // never touched.
        if (book.sourcePath) {
          // Stop the converter if it is still recognising this scan, and let it forget the job
          await ocrService.cancel(book.pdfHash ?? book.fileHash);
        }

        // Remember which files of the books folder belonged to this book, so the next scan does
        // not add it back. Files that came from an upload are simply forgotten.
        await prisma.bookFile.updateMany({
          where: { bookId, origin: 'library' },
          data: { ignored: true },
        });
        await prisma.bookFile.deleteMany({ where: { bookId, origin: 'upload' } });
        const storedFiles = new Set<string>([book.filePath]);
        if (book.sourcePath) storedFiles.add(book.sourcePath);
        for (const storedFile of storedFiles) {
          await deleteFile(storedFile);
        }
        if (book.coverPath) {
          await deleteFile(book.coverPath);
        }

        await prisma.book.delete({
          where: { id: bookId },
        });
      }
    }
  }

  async getCover(userId: string, bookId: string): Promise<Buffer | null> {
    const book = await this.getBookById(userId, bookId);

    if (!book.coverPath) {
      return null;
    }

    return await readFile(book.coverPath);
  }

  async getEpubFile(userId: string, bookId: string): Promise<{ buffer: Buffer; filename: string }> {
    const book = await this.getBookById(userId, bookId);

    if (!book.hasText) {
      throw new Error('This PDF has no readable text, so there is no EPUB version');
    }

    if (!book.filePath) {
      throw new Error('EPUB file not found');
    }

    const buffer = await readFile(book.filePath);
    const filename = `${book.title || 'book'}.epub`;

    return { buffer, filename };
  }

  async getPdfFile(userId: string, bookId: string): Promise<{ buffer: Buffer; filename: string }> {
    const book = await this.getBookById(userId, bookId);

    if (!book.sourcePath) {
      throw new Error('This book has no PDF file');
    }

    const buffer = await readFile(book.sourcePath);
    const filename = `${book.title || 'book'}.pdf`;

    return { buffer, filename };
  }

  /** One page of a PDF book as a JPEG, for the page viewer of scanned books */
  async getPageImage(
    userId: string,
    bookId: string,
    page: number,
    width: number
  ): Promise<Buffer> {
    const book = await this.getBookById(userId, bookId);

    if (!book.sourcePath) {
      throw new Error('This book has no PDF');
    }
    if (!Number.isInteger(page) || page < 1 || (book.pageCount && page > book.pageCount)) {
      throw new Error('Page not found');
    }

    return await pdfConverterService.renderPage(book.pdfHash ?? book.fileHash, page, width);
  }

  async getAlternativeCovers(userId: string, bookId: string): Promise<AlternativeCover[]> {
    const book = await this.getBookById(userId, bookId);

    return await openLibraryService.searchEditions(book.title, book.author, book.isbn);
  }

  async updateCoverFromOpenLibrary(
    userId: string,
    bookId: string,
    coverUrl: string
  ): Promise<void> {
    const book = await this.getBookById(userId, bookId);

    const coverBuffer = await openLibraryService.downloadCover(coverUrl);
    const extension = coverUrl.includes('.png') ? 'png' : 'jpg';
    // fileHash, not the file name: a scanned PDF book is stored as <hash>.pdf
    const fileHash = book.fileHash;
    const coverPath = path.join(config.storage.coversPath, `${fileHash}-cover.${extension}`);

    if (book.coverPath && book.coverPath !== coverPath) {
      await deleteFile(book.coverPath);
    }

    await saveFile(coverPath, coverBuffer);

    await prisma.book.update({
      where: { id: bookId },
      data: { coverPath },
    });
  }

  async updateMetadata(
    userId: string,
    bookId: string,
    metadata: {
      title?: string;
      author?: string;
      isbn?: string;
      publisher?: string;
      language?: string;
      description?: string;
      publishedYear?: string;
      coverUrl?: string;
    }
  ): Promise<void> {
    await this.getBookById(userId, bookId);

    const updateData: any = {};

    if (metadata.title !== undefined) updateData.title = metadata.title;
    if (metadata.author !== undefined) updateData.author = metadata.author;
    if (metadata.isbn !== undefined) updateData.isbn = metadata.isbn;
    if (metadata.publisher !== undefined) updateData.publisher = metadata.publisher;
    if (metadata.language !== undefined) updateData.language = metadata.language;
    if (metadata.description !== undefined) updateData.description = metadata.description;

    if (metadata.coverUrl) {
      await this.updateCoverFromOpenLibrary(userId, bookId, metadata.coverUrl);
    }

    await prisma.book.update({
      where: { id: bookId },
      data: updateData,
    });
  }

  /**
   * Books in this person's library that look like the same book more than once (another format
   * or edition, a copy from a second folder), with the copy to keep suggested for each group.
   */
  async findDuplicateGroups(userId: string) {
    const links = await prisma.userBook.findMany({
      where: { userId },
      select: {
        isFavorite: true,
        book: {
          select: {
            id: true,
            title: true,
            author: true,
            isbn: true,
            sourceFormat: true,
            hasText: true,
            totalWords: true,
            fileSize: true,
            createdAt: true,
            readingProgress: { where: { userId }, select: { percentage: true }, take: 1 },
          },
        },
      },
    });

    const ids = links.map((link) => link.book.id);
    const audio = ids.length
      ? await prisma.tTSCache.groupBy({
          by: ['bookId'],
          where: { bookId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const audioByBook = new Map(audio.map((row) => [row.bookId, row._count._all]));

    const candidates = links.map((link) => ({
      id: link.book.id,
      title: link.book.title,
      author: link.book.author,
      isbn: link.book.isbn,
      sourceFormat: link.book.sourceFormat,
      hasText: link.book.hasText,
      totalWords: link.book.totalWords,
      fileSize: link.book.fileSize,
      createdAt: link.book.createdAt,
      isFavorite: link.isFavorite,
      progress: link.book.readingProgress[0]?.percentage ?? 0,
      audioChunks: audioByBook.get(link.book.id) ?? 0,
    }));

    return groupLikelyDuplicates(candidates).map((group) => ({
      confidence: group.confidence,
      keepId: pickBookToKeep(group.books).id,
      books: group.books,
    }));
  }

  /**
   * Before a duplicate is removed: its source files (PDF, EPUB) become files of the book that is
   * kept, and if the kept book has no PDF yet it takes over the duplicate's PDF.
   */
  private async absorbFiles(keepId: string, removeId: string): Promise<void> {
    const [keep, removed] = await Promise.all([
      prisma.book.findUnique({ where: { id: keepId } }),
      prisma.book.findUnique({ where: { id: removeId } }),
    ]);
    if (!keep || !removed) return;

    await prisma.bookFile.updateMany({ where: { bookId: removeId }, data: { bookId: keepId } });

    if (!keep.sourcePath && removed.sourcePath && removed.hasText) {
      const pdf = {
        sourcePath: removed.sourcePath,
        pdfHash: removed.pdfHash ?? removed.fileHash,
        pageCount: removed.pageCount,
        pageAspect: removed.pageAspect,
      };
      // Let go of the PDF first: deleting the removed book deletes the files it still points to
      await prisma.book.update({ where: { id: removeId }, data: { sourcePath: null, pdfHash: null } });
      await prisma.book.update({ where: { id: keepId }, data: pdf });
    }
  }

  /**
   * Remove duplicate copies, keeping one book per group. The removed copies' generated audio is
   * deleted with them; a favourite mark moves to the book that is kept. Files in watched folders
   * are not touched.
   */
  async mergeDuplicates(
    userId: string,
    merges: Array<{ keepId: string; removeIds: string[] }>
  ): Promise<{ removed: number }> {
    let removed = 0;

    for (const merge of merges) {
      const keep = await prisma.userBook.findUnique({
        where: { userId_bookId: { userId, bookId: merge.keepId } },
      });
      if (!keep) throw new Error('A book to keep was not found in your library');

      let favorite = false;
      for (const removeId of merge.removeIds) {
        if (removeId === merge.keepId) continue;
        const link = await prisma.userBook.findUnique({
          where: { userId_bookId: { userId, bookId: removeId } },
        });
        if (!link) continue;
        favorite = favorite || link.isFavorite;
        await this.absorbFiles(merge.keepId, removeId);
        await this.deleteBook(userId, removeId);
        removed += 1;
      }

      if (favorite && !keep.isFavorite) {
        await prisma.userBook.update({
          where: { userId_bookId: { userId, bookId: merge.keepId } },
          data: { isFavorite: true },
        });
      }
    }

    return { removed };
  }

  async getMetadataStats(): Promise<{
    totalBooks: number;
    bloatedBooks: number;
    estimatedBloatMB: number;
  }> {
    const books = await prisma.book.findMany({
      select: { id: true, epubMetadata: true },
    });

    let bloatedBooks = 0;
    let estimatedBloatBytes = 0;

    for (const book of books) {
      const meta = book.epubMetadata as Record<string, unknown> | null;
      if (meta && 'coverData' in meta) {
        bloatedBooks++;
        const coverJson = JSON.stringify(meta.coverData);
        estimatedBloatBytes += Buffer.byteLength(coverJson, 'utf8');
      }
    }

    return {
      totalBooks: books.length,
      bloatedBooks,
      estimatedBloatMB: Math.round((estimatedBloatBytes / 1024 / 1024) * 10) / 10,
    };
  }

  async cleanMetadata(): Promise<{ cleaned: number }> {
    const books = await prisma.book.findMany({
      select: { id: true, epubMetadata: true },
    });

    let cleaned = 0;

    for (const book of books) {
      const meta = book.epubMetadata as Record<string, unknown> | null;
      if (meta && 'coverData' in meta) {
        const { coverData, ...rest } = meta;
        await prisma.book.update({
          where: { id: book.id },
          data: { epubMetadata: rest as any },
        });
        cleaned++;
      }
    }

    return { cleaned };
  }

  async setFavorite(userId: string, bookId: string, isFavorite: boolean): Promise<void> {
    await prisma.userBook.update({
      where: {
        userId_bookId: {
          userId,
          bookId,
        },
      },
      data: { isFavorite },
    });
  }
}

export const booksService = new BooksService();
