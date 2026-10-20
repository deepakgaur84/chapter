import fs from 'fs/promises';
import { createReadStream } from 'fs';
import crypto from 'crypto';
import path from 'path';

export interface RemoveFilesResult {
  deleted: number;
  failed: { path: string; error: string }[];
}

/** SHA-256 of a file, read as a stream so large books are not loaded into memory. */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * From a list of .epub / .pdf paths, return the ones that are exactly this book.
 * A file only counts when its size AND its SHA-256 match the stored book, so a different edition
 * of the same title is never touched. The size check keeps the number of files that have to be
 * read to a minimum.
 */
export async function findFilesMatchingBook(
  bookPaths: string[],
  fileHash: string,
  fileSize: number
): Promise<string[]> {
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const epubPath of bookPaths) {
    const resolved = path.resolve(epubPath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile() || stats.size !== fileSize) continue;
      if ((await hashFile(resolved)) === fileHash) {
        matches.push(resolved);
      }
    } catch {
      // A file that cannot be read cannot be a match we are able to delete
      continue;
    }
  }

  return matches;
}

/**
 * Check, before anything is deleted, that Chapter is allowed to delete every file.
 * Deleting a file needs write access to its folder. A folder mounted read-only into the
 * container fails here, so the book is not removed while its file stays behind.
 */
export async function assertFilesDeletable(filePaths: string[]): Promise<void> {
  for (const filePath of filePaths) {
    const dir = path.dirname(filePath);
    try {
      await fs.access(dir, fs.constants.W_OK);
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code || (error as Error).message;
      throw new Error(
        `Chapter cannot delete files in ${dir} (${reason}). Nothing was deleted. ` +
          'If this folder is mounted read-only, remove the ":ro" from its volume, or delete ' +
          'the book without the folder option.'
      );
    }
  }
}

/** Delete the files. Every file is attempted; failures are reported, not thrown. */
export async function removeFiles(filePaths: string[]): Promise<RemoveFilesResult> {
  const result: RemoveFilesResult = { deleted: 0, failed: [] };

  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
      result.deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already gone: that is the outcome we wanted
        result.deleted++;
      } else {
        result.failed.push({ path: filePath, error: (error as Error).message });
      }
    }
  }

  return result;
}
