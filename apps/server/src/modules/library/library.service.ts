import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../../core/database';
import { config } from '../../core/config';
import { epubProcessor, type ImportResult } from '../books/epub.processor';
import { pdfProcessor, isPdf } from '../books/pdf.processor';

export interface IngestMeta {
  /** "library" = found in the books folder, "upload" = added through the web page */
  origin: 'library' | 'upload';
  path?: string;
  mtimeMs?: number;
}

export interface IngestResult extends ImportResult {
  /** The file belongs to a book that was removed on purpose, so it was not added back */
  removed?: boolean;
}

export interface ScanStatus {
  state: 'idle' | 'scanning';
  libraryPath: string;
  /** Book files found in the books folder in the current (or last) scan */
  total: number;
  /** Files looked at so far */
  done: number;
  imported: number;
  /** Files added to a book that was already there (its PDF or EPUB) */
  merged: number;
  /** Files that were already known, or are copies */
  skipped: number;
  failed: number;
  current: string | null;
  errors: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

const BOOK_FILE = /\.(epub|pdf)$/i;

/**
 * The books folder is read-only source material. This service reads it (never writes to it) and
 * adds what it finds to the library, keeping one book per title no matter how many files (PDF,
 * EPUB) it has. A list of known files (BookFile) makes a repeat scan quick and keeps books you
 * removed from coming back.
 */
export class LibraryService {
  private scanning: Promise<void> | null = null;
  private status: ScanStatus = this.freshStatus();

  private freshStatus(): ScanStatus {
    return {
      state: 'idle',
      libraryPath: config.library.path,
      total: 0,
      done: 0,
      imported: 0,
      merged: 0,
      skipped: 0,
      failed: 0,
      current: null,
      errors: [],
      startedAt: null,
      finishedAt: null,
    };
  }

  getStatus(): ScanStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  /**
   * Add one file to the library for these people: the one place every import (upload or books
   * folder) goes through. Files already known are not read again.
   */
  async ingest(
    userIds: string[],
    buffer: Buffer,
    filename: string,
    meta: IngestMeta
  ): Promise<IngestResult> {
    if (userIds.length === 0) throw new Error('No user to add the book for');

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const format = isPdf(buffer) ? 'pdf' : 'epub';
    const known = await prisma.bookFile.findUnique({ where: { hash } });

    if (known) {
      if (meta.path) {
        await prisma.bookFile.update({
          where: { hash },
          data: { path: meta.path, mtimeMs: meta.mtimeMs ?? null, size: buffer.length },
        });
      }
      if (known.ignored && meta.origin === 'library') {
        return { bookId: known.bookId ?? '', created: false, removed: true };
      }
      if (known.ignored) {
        // Adding it by hand again: that is a clear wish to have it back
        await prisma.bookFile.update({ where: { hash }, data: { ignored: false } });
      }
      if (known.bookId) {
        for (const userId of userIds) await epubProcessor.linkBookToUser(userId, known.bookId);
        return { bookId: known.bookId, created: false };
      }
      // Known, but its book is gone: import it again below
    }

    const result: ImportResult =
      format === 'pdf'
        ? await pdfProcessor.importPDF(userIds[0], buffer, filename)
        : await epubProcessor.importEPUB(userIds[0], buffer, filename);

    await prisma.bookFile.upsert({
      where: { hash },
      create: {
        hash,
        bookId: result.bookId,
        size: buffer.length,
        format,
        origin: meta.origin,
        path: meta.path ?? null,
        mtimeMs: meta.mtimeMs ?? null,
      },
      update: {
        bookId: result.bookId,
        size: buffer.length,
        format,
        origin: meta.origin,
        path: meta.path ?? null,
        mtimeMs: meta.mtimeMs ?? null,
        ignored: false,
      },
    });

    for (const userId of userIds.slice(1)) {
      await epubProcessor.linkBookToUser(userId, result.bookId);
    }
    return result;
  }

  /** Every book file in the books folder, EPUBs first (their text is better than a conversion) */
  async walk(root: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (dir: string, depth: number) => {
      if (depth > config.library.maxScanDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // hidden files, macOS "._" copies, .Trash
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, depth + 1);
        else if (entry.isFile() && BOOK_FILE.test(entry.name)) files.push(full);
      }
    };
    await visit(root, 0);
    const rank = (file: string) => (file.toLowerCase().endsWith('.epub') ? 0 : 1);
    return files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /** Start scanning the books folder in the background. Does nothing if a scan is running. */
  startScan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan()
      .catch((error) => {
        console.error('Library scan failed:', error);
        this.status.errors.push((error as Error).message);
      })
      .finally(() => {
        this.status.state = 'idle';
        this.status.current = null;
        this.status.finishedAt = new Date().toISOString();
        this.scanning = null;
      });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    this.status = { ...this.freshStatus(), state: 'scanning', startedAt: new Date().toISOString() };

    const users = (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id);
    if (users.length === 0) {
      console.log('📚 No users yet, the books folder will be scanned after the first sign-up');
      return;
    }

    const root = config.library.path;
    const rootOk = await fs.stat(root).then((s) => s.isDirectory(), () => false);
    if (!rootOk) {
      console.log(`📚 Books folder ${root} not found, nothing to scan`);
      return;
    }

    const files = await this.walk(root);
    this.status.total = files.length;
    console.log(`📚 Scanning ${files.length} book file(s) in ${root}`);

    for (const file of files) {
      this.status.current = path.basename(file);
      try {
        const stat = await fs.stat(file);
        const known = await prisma.bookFile.findFirst({ where: { path: file } });
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && (known.bookId || known.ignored)) {
          this.status.skipped++;
        } else {
          const buffer = await fs.readFile(file);
          const result = await this.ingest(users, buffer, path.basename(file), {
            origin: 'library',
            path: file,
            mtimeMs: stat.mtimeMs,
          });
          if (result.removed) this.status.skipped++;
          else if (result.created) this.status.imported++;
          else if (result.merged) this.status.merged++;
          else this.status.skipped++;
        }
      } catch (error) {
        this.status.failed++;
        const message = `${path.basename(file)}: ${(error as Error).message}`;
        if (this.status.errors.length < 20) this.status.errors.push(message);
        console.error('Library import failed:', message);
      }
      this.status.done++;
    }

    // People may have signed up while the scan ran
    await this.linkLibraryBooks((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
    console.log(
      `📚 Library scan done: ${this.status.imported} added, ${this.status.merged} merged, ` +
        `${this.status.skipped} unchanged, ${this.status.failed} failed`
    );
  }

  /** Make sure these people have every book that came from the books folder */
  async linkLibraryBooks(userIds: string[]): Promise<void> {
    const files = await prisma.bookFile.findMany({
      where: { origin: 'library', ignored: false, bookId: { not: null } },
      select: { bookId: true },
    });
    const bookIds = Array.from(new Set(files.map((f) => f.bookId as string)));
    for (const userId of userIds) {
      for (const bookId of bookIds) {
        await epubProcessor.linkBookToUser(userId, bookId);
      }
    }
  }

  /** A new person signs up: give them the books of the books folder too */
  async onUserCreated(userId: string): Promise<void> {
    await this.linkLibraryBooks([userId]);
    // The first sign-up on a new install has nobody to add the books for until now. A scan that is
    // already running links its results to everyone when it finishes; otherwise start one.
    this.startScan();
  }

  /** Files of removed books, which a scan skips */
  async listHidden(): Promise<Array<{ id: string; name: string; format: string; size: number }>> {
    const rows = await prisma.bookFile.findMany({
      where: { ignored: true, origin: 'library' },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.path ? path.basename(row.path) : row.hash.slice(0, 12),
      format: row.format,
      size: row.size,
    }));
  }

  /** Bring removed books back: they are added again by a scan right away */
  async restoreHidden(ids?: string[]): Promise<number> {
    const result = await prisma.bookFile.updateMany({
      where: { ignored: true, origin: 'library', ...(ids ? { id: { in: ids } } : {}) },
      data: { ignored: false },
    });
    if (result.count > 0) this.startScan();
    return result.count;
  }
}

export const libraryService = new LibraryService();
