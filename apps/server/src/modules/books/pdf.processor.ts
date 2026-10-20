import crypto from 'crypto';
import path from 'path';
import { prisma } from '../../core/database';
import { config } from '../../core/config';
import { saveFile, deleteFile } from '../../core/storage';
import { epubProcessor } from './epub.processor';
import { pdfConverterService } from './pdf-converter.service';
import { ocrService } from './ocr.service';

export function isPdf(buffer: Buffer): boolean {
  return buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

export class PDFProcessor {
  /**
   * Import a PDF.
   *
   * - PDF with text: converted to an EPUB, which is what gets read and listened to. The original
   *   PDF is kept next to it.
   * - Scanned PDF (no text layer): stored as a PDF-only book that opens in the page viewer, with
   *   listening disabled. Text recognition (OCR) then runs in the background; if it works, the
   *   book becomes a normal readable and listenable one (see OcrService).
   *
   * The book is identified by the hash and size of the PDF itself, so importing the same PDF
   * again is recognised, and the original can be found again in a watched folder.
   */
  async processPDF(userId: string, pdfBuffer: Buffer, filename: string): Promise<string> {
    const fileHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    const existing = await prisma.book.findUnique({ where: { fileHash } });
    if (existing) {
      await epubProcessor.linkBookToUser(userId, existing.id);
      return existing.id;
    }

    const converted = await pdfConverterService.convert(pdfBuffer, filename);

    const pdfPath = path.join(config.storage.booksPath, `${fileHash}.pdf`);
    await saveFile(pdfPath, pdfBuffer);

    try {
      if (converted.hasText && converted.epub) {
        return await epubProcessor.processEPUB(userId, converted.epub, filename, {
          fileHash,
          fileSize: pdfBuffer.length,
          pdfPath,
        });
      }

      return await this.createScannedBook(userId, pdfBuffer, pdfPath, fileHash, converted);
    } catch (error) {
      await deleteFile(pdfPath);
      throw error;
    }
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
      coverPath = path.join(config.storage.booksPath, `${fileHash}-cover.jpg`);
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
