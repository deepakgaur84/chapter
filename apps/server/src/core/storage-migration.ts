import fs from 'fs/promises';
import path from 'path';
import { prisma } from './database';
import { config } from './config';

export interface MigrationResult {
  moved: number;
  alreadyThere: number;
  missing: number;
  failed: number;
}

const inside = (file: string, dir: string): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Move a file into `destDir`, keeping its name. Returns the new path, or null when the file is
 * missing. Works across disks (copy, then delete the original). Nothing is deleted before the
 * copy is complete, and a half-copied file is never left under its final name.
 */
export async function moveInto(file: string, destDir: string): Promise<string | null> {
  const dest = path.join(destDir, path.basename(file));
  await fs.mkdir(destDir, { recursive: true });

  const destExists = await fs.stat(dest).then(() => true, () => false);
  const sourceExists = await fs.stat(file).then(() => true, () => false);

  if (!sourceExists) return destExists ? dest : null;
  if (path.resolve(file) === path.resolve(dest)) return dest;

  if (destExists) {
    // Same name already there (an earlier interrupted move): the source is a leftover
    await fs.unlink(file).catch(() => undefined);
    return dest;
  }

  try {
    await fs.rename(file, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const temp = `${dest}.${process.pid}.tmp`;
    try {
      await fs.copyFile(file, temp);
      await fs.rename(temp, dest);
    } catch (copyError) {
      await fs.unlink(temp).catch(() => undefined);
      throw copyError;
    }
    await fs.unlink(file);
  }
  return dest;
}

/**
 * When a work folder is configured, move everything an earlier version stored (books, covers and
 * generated audio) into it and update the database. Safe to run on every start: files already in
 * place are skipped, and a restart half-way simply carries on.
 */
export async function migrateToWorkFolder(
  log: (message: string) => void = console.log
): Promise<MigrationResult> {
  const result: MigrationResult = { moved: 0, alreadyThere: 0, missing: 0, failed: 0 };
  if (!config.storage.workPath) return result;

  const { epubsPath, pdfsPath, coversPath, audioPath } = config.storage;

  const relocate = async (file: string | null, dir: string): Promise<string | null> => {
    if (!file) return file;
    if (inside(file, dir)) {
      result.alreadyThere++;
      return file;
    }
    try {
      const moved = await moveInto(file, dir);
      if (moved === null) {
        result.missing++;
        return file;
      }
      result.moved++;
      return moved;
    } catch (error) {
      result.failed++;
      log(`Could not move ${file}: ${(error as Error).message}`);
      return file;
    }
  };

  const books = await prisma.book.findMany({
    select: { id: true, filePath: true, sourcePath: true, coverPath: true, pdfHash: true, hasText: true, fileHash: true },
  });

  for (const book of books) {
    const isPdfFile = book.filePath.toLowerCase().endsWith('.pdf');
    const filePath = await relocate(book.filePath, isPdfFile ? pdfsPath : epubsPath);
    // A scanned book's stored file and its PDF are the same file
    const sourcePath =
      book.sourcePath && book.sourcePath === book.filePath
        ? filePath
        : await relocate(book.sourcePath, pdfsPath);
    const coverPath = await relocate(book.coverPath, coversPath);

    if (filePath !== book.filePath || sourcePath !== book.sourcePath || coverPath !== book.coverPath) {
      await prisma.book.update({
        where: { id: book.id },
        data: { filePath: filePath!, sourcePath, coverPath },
      });
    }
  }

  // Generated audio: many small files, so go through the rows a page at a time
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.tTSCache.findMany({
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, audioPath: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const moved = await relocate(row.audioPath, audioPath);
      if (moved && moved !== row.audioPath) {
        await prisma.tTSCache.update({ where: { id: row.id }, data: { audioPath: moved } });
      }
    }
  }

  if (result.moved || result.failed || result.missing) {
    log(
      `Work folder: moved ${result.moved} file(s), ${result.alreadyThere} already in place, ` +
        `${result.missing} missing, ${result.failed} failed`
    );
  }
  return result;
}
