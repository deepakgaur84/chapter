import { prisma } from '../../core/database';
import { config } from '../../core/config';
import { epubProcessor } from './epub.processor';
import { pdfConverterService, type OcrStatus } from './pdf-converter.service';

const MAX_RESTARTS = 2; // times a vanished job is started again before giving up
const MAX_CONSECUTIVE_ERRORS = 30; // failed progress checks in a row (about 2.5 minutes)

const REASONS: Record<string, string> = {
  no_text: 'No text could be recognised on these pages.',
  unreadable: 'The scan is too rough to read reliably (the recognised text looked like noise).',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Text recognition (OCR) of scanned PDFs, in the background.
 *
 * A scanned PDF is imported straight away as a book with a page viewer. This service asks the
 * pdf2epub converter to recognise the text, follows its progress, and, if the text is good,
 * turns the book into a normal readable and listenable one. If anything goes wrong the book
 * simply stays a scan with its page viewer, with the reason saved for the user to see.
 */
export class OcrService {
  private active = new Set<string>();

  /** Start following (and, if needed, starting) text recognition for a book. Returns at once. */
  enqueue(bookId: string): void {
    if (!config.pdf.ocrEnabled || this.active.has(bookId)) return;
    this.run(bookId).catch((error) => {
      console.error(`Text recognition for book ${bookId} stopped:`, error);
    });
  }

  /** The user pressed "Try again" / "Make readable": start over for this book */
  async retry(userId: string, bookId: string): Promise<void> {
    if (!config.pdf.ocrEnabled) {
      throw new Error('Text recognition is turned off on this server (OCR_ENABLED=false)');
    }

    const userBook = await prisma.userBook.findUnique({
      where: { userId_bookId: { userId, bookId } },
      include: { book: true },
    });
    if (!userBook) throw new Error('Book not found');

    const book = userBook.book;
    if (book.hasText) throw new Error('This book already has readable text');
    if (!book.sourcePath) throw new Error('This book has no PDF to recognise');
    if (book.ocrStatus === 'pending' || book.ocrStatus === 'running') return; // already working

    await prisma.book.update({
      where: { id: bookId },
      data: { ocrStatus: 'pending', ocrProgress: 0, ocrError: null },
    });
    // Start the converter job over, so an earlier failed or finished result is not reused
    await pdfConverterService.startOcr(book.fileHash, true).catch(() => undefined);
    this.enqueue(bookId);
  }

  /** On server start: carry on with recognition that a restart interrupted, fill in page info */
  async resumePending(): Promise<void> {
    const waiting = await prisma.book.findMany({
      where: { hasText: false, ocrStatus: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    for (const { id } of waiting) this.enqueue(id);

    // Scans imported before the page viewer existed have no page count or shape yet
    const needInfo = await prisma.book.findMany({
      where: { hasText: false, sourcePath: { not: null }, pageAspect: null },
      select: { id: true, fileHash: true },
    });
    for (const book of needInfo) {
      try {
        const info = await pdfConverterService.getInfo(book.fileHash);
        await prisma.book.update({
          where: { id: book.id },
          data: { pageCount: info.pages, pageAspect: info.aspect },
        });
      } catch {
        // The converter may not be up yet; the viewer falls back to a standard page shape
        break;
      }
    }
  }

  /** The book was deleted: stop the converter working on it */
  async cancel(fileHash: string): Promise<void> {
    await pdfConverterService.cancelOcr(fileHash);
  }

  private async setState(bookId: string, data: Record<string, unknown>): Promise<boolean> {
    try {
      await prisma.book.update({ where: { id: bookId }, data });
      return true;
    } catch {
      return false; // the book was deleted meanwhile
    }
  }

  private async fail(bookId: string, message: string): Promise<void> {
    console.warn(`Text recognition failed for book ${bookId}: ${message}`);
    await this.setState(bookId, { ocrStatus: 'failed', ocrError: message });
  }

  private async run(bookId: string): Promise<void> {
    this.active.add(bookId);
    try {
      const book = await prisma.book.findUnique({ where: { id: bookId } });
      if (!book || book.hasText || !book.sourcePath) return;
      const hash = book.fileHash;

      if (!(await this.setState(bookId, { ocrStatus: 'running', ocrError: null }))) return;

      let status: OcrStatus;
      try {
        status = await pdfConverterService.startOcr(hash);
      } catch (error) {
        await this.fail(bookId, (error as Error).message);
        return;
      }

      let restarts = 0;
      let errors = 0;
      let lastPage = book.ocrProgress ?? 0;

      for (;;) {
        // Stop quietly if the book was deleted while we were waiting
        const current = await prisma.book.findUnique({
          where: { id: bookId },
          select: { id: true, hasText: true },
        });
        if (!current || current.hasText) {
          if (!current) await this.cancel(hash);
          return;
        }

        if (status.state === 'running' || status.state === 'queued') {
          const page = status.page ?? 0;
          if (page !== lastPage) {
            lastPage = page;
            await this.setState(bookId, { ocrProgress: page });
          }
        } else if (status.state === 'none') {
          if (restarts++ >= MAX_RESTARTS) {
            await this.fail(bookId, 'The text recognition job was lost. Please try again.');
            return;
          }
          try {
            status = await pdfConverterService.startOcr(hash);
            continue;
          } catch (error) {
            await this.fail(bookId, (error as Error).message);
            return;
          }
        } else if (status.state === 'failed') {
          await this.fail(bookId, status.error || 'Text recognition failed');
          return;
        } else if (status.state === 'done') {
          await this.finish(bookId, hash);
          return;
        }

        await sleep(config.pdf.ocrPollMs);

        try {
          status = await pdfConverterService.getOcrStatus(hash);
          errors = 0;
        } catch (error) {
          if (++errors >= MAX_CONSECUTIVE_ERRORS) {
            await this.fail(bookId, (error as Error).message);
            return;
          }
        }
      }
    } finally {
      this.active.delete(bookId);
    }
  }

  private async finish(bookId: string, hash: string): Promise<void> {
    try {
      const result = await pdfConverterService.getOcrResult(hash);
      if (!result.hasText || !result.epub) {
        await this.fail(bookId, REASONS[result.reason || 'no_text'] || REASONS.no_text);
        return;
      }
      await epubProcessor.attachChapters(bookId, result.epub);
    } catch (error) {
      await this.fail(bookId, `Could not use the recognised text: ${(error as Error).message}`);
    }
  }
}

export const ocrService = new OcrService();
