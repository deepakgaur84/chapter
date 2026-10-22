import fs from 'fs/promises';
import path from 'path';
import { config } from './config';

export async function ensureStorageDirectories() {
  const directories = Array.from(
    new Set([
      config.storage.epubsPath,
      config.storage.pdfsPath,
      config.storage.coversPath,
      config.storage.audioPath,
    ])
  );

  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
      // Writing is what fails when a folder is mounted without permission for the container user
      await fs.access(dir, fs.constants.W_OK);
      console.log(`✅ Storage directory ready: ${dir}`);
    } catch (error) {
      console.error(
        `❌ Chapter cannot write to ${dir} (${(error as NodeJS.ErrnoException).code || (error as Error).message}). ` +
          'If this is a mounted folder, give the container user (uid 1001) read and write access to it, ' +
          'and make sure it is not mounted read-only.'
      );
      throw error;
    }
  }
}

export async function saveFile(filePath: string, data: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function readFile(filePath: string): Promise<Buffer> {
  return await fs.readFile(filePath);
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    // Ignore if file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getFileSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size;
}
