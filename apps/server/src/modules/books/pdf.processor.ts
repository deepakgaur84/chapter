import crypto from 'crypto';
import path from 'path';
import { prisma } from '../../core/database';
import { config } from '../../core/config';
import { saveFile, deleteFile } from '../../core/storage';
import { epubProcessor, type ImportResult } from './epub.processor';
import { pdfConverterService } from './pdf-converter.service';
import { ocrService } from './ocr.service';

export function isPdf(buffer: Buffer): boolean {
  return buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export class PDFProcessor {
  /**
   * Import a PDF.
   *
   * - PDF of a book that is already in the library (for example its EPUB was added first): the
   *   PDF is attached to that book, so there is one book with a PDF view and a text view.
   * - PDF with text: converted to an EPUB, which is what gets read and listened to. A working
   *   copy of the PDF is kept next to it for the PDF view.
   * - Scanned PDF (no text layer): stored as a PDF-only book that opens in the page viewer, with
   *   listening disabled. Text recognition (OCR) then runs in the background; if it works, the
   *   book becomes a normal readable and listenable one (see OcrService).
   *
   * The book is identified by the hash and size of the PDF itself, so importing the same PDF
   * again is recognised.
   */
  async processPDF(userId: string, pdfBuffer: Buffer, filename: string): Promise<string> {
    return (await this.importPDF(userId, pdfBuffer, filename)).bookId;
  }

  /** Like processPDF, but says whether a book was added or the file was a duplicate */
  async importPDF(userId: string, pdfBuffer: Buffer, filename: string): Promise<ImportResult> {
    const fileHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    const existing = await prisma.book.findUnique({ where: { fileHash } });
    if (existing) {
      await epubProcessor.linkBookToUser(userId, existing.id);
      return { bookId: existing.id, created: false };
    }

    const converted = await pdfConverterService.convert(pdfBuffer, filename);

    // The same book may already be here in another format: attach this PDF to it
    const copy = await epubProcessor.findCopyInLibrary(userId, {
      title: converted.title || '',
      author: converted.author,
    });
    if (copy) {
      const attached = await this.attachPdf(copy.id, pdfBuffer, fileHash, converted);
      return {
        bookId: copy.id,
        created: false,
        duplicateOf: { id: copy.id, title: copy.title },
        merged: attached,
      };
    }

    const pdfPath = path.join(config.storage.pdfsPath, `${fileHash}.pdf`);
    await saveFile(pdfPath, pdfBuffer);

    try {
      if (converted.hasText && converted.epub) {
        const result = await epubProcessor.importEPUB(userId, converted.epub, filename, {
          fileHash,
          fileSize: pdfBuffer.length,
          pdfPath,
        });
        if (!result.created && !result.merged) {
          // A copy of a book already in the library: the stored PDF is not needed
          await deleteFile(pdfPath);
        }
        return result;
      }

      return {
        bookId: await this.createScannedBook(userId, pdfBuffer, pdfPath, fileHash, converted),
        created: true,
      };
    } catch (error) {
      await deleteFile(pdfPath);
      throw error;
    }
  }

  /**
   * Give a book that has no PDF yet this one: a working copy is stored and the page count and
   * shape are saved, so the book gets a PDF view. Returns false when the book already has a PDF.
   */
  private async attachPdf(
    bookId: string,
    pdfBuffer: Buffer,
    pdfHash: string,
    converted: Awaited<ReturnType<typeof pdfConverterService.convert>>
  ): Promise<boolean> {
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    if (!book || book.sourcePath) return false;

    const pdfPath = path.join(config.storage.pdfsPath, `${pdfHash}.pdf`);
    await saveFile(pdfPath, pdfBuffer);
    try {
      await prisma.book.update({
        where: { id: bookId },
        data: {
          sourcePath: pdfPath,
          pdfHash,
          pageCount: converted.pages,
          pageAspect: converted.aspect ?? null,
        },
      });
    } catch (error) {
      await deleteFile(pdfPath);
      throw error;
    }
    return true;
  }

  private async createScannedBook(
    userId: string,
    pdfBuffer: Buffer,
    pdfPath: string,
    fileHash: string,
    converted: Awaited<ReturnType<typeof pdfConverterService.convert>>
  ): Promise<string> {
    let coverPath: string | undefined;
    if (converted.cover && converted.cover.length > 0) {
      coverPath = path.join(config.storage.coversPath, `${fileHash}-cover.jpg`);
      await saveFile(coverPath, converted.cover);
    }

    const book = await prisma.book.create({
      data: {
        title: converted.title || 'Untitled',
        author: converted.author,
        coverPath,
        // A scanned book has no EPUB, so its stored file is the PDF itself
        filePath: pdfPath,
        fileSize: pdfBuffer.length,
        fileHash,
        sourceFormat: 'pdf',
        sourcePath: pdfPath,
        pdfHash: fileHash,
        hasText: false,
        epubMetadata: { scanned: true, pages: converted.pages } as any,
        pageCount: converted.pages,
        pageAspect: converted.aspect,
        ocrStatus: config.pdf.ocrEnabled ? 'pending' : null,
        totalWords: 0,
        totalCharacters: 0,
        totalChapters: 0,
      },
    });

    await epubProcessor.linkBookToUser(userId, book.id);
    ocrService.enqueue(book.id);
    return book.id;
  }
}

export const pdfProcessor = new PDFProcessor();
