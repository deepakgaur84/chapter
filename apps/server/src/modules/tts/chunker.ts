import crypto from 'crypto';

export interface TextChunk {
  index: number;
  text: string;
  startPosition: number;
  endPosition: number;
  hash: string;
  wordCount: number;
}

export interface ChunkOptions {
  targetSize?: number; // Target characters per chunk (default: 800)
  maxSize?: number; // Maximum characters per chunk (default: 1200)
  minSize?: number; // Minimum characters per chunk (default: 400)
  /**
   * Target sizes (in characters) for the first chunks of a chapter, in order.
   * Small early chunks let playback start quickly; later chunks grow to targetSize.
   * Example: [250, 375, 560] makes chunk 0 about 250 characters, chunk 1 about 375,
   * chunk 2 about 560, and every chunk after that targetSize.
   */
  rampUpSizes?: number[];
}

export class TextChunker {
  private targetSize: number;
  private maxSize: number;
  private minSize: number;
  private rampUpSizes: number[];

  constructor(options: ChunkOptions = {}) {
    this.targetSize = options.targetSize || 800; // Smaller chunks for faster generation
    this.maxSize = options.maxSize || 1200;
    this.minSize = options.minSize || 400;
    this.rampUpSizes = options.rampUpSizes ?? [];
  }

  /** Target size for the chunk at this index (ramp-up sizes first, then targetSize). */
  private targetFor(index: number): number {
    const ramp = this.rampUpSizes[index];
    return ramp !== undefined ? Math.min(ramp, this.targetSize) : this.targetSize;
  }

  /** Hard size limit for the chunk at this index. Early ramp-up chunks get a tighter limit. */
  private maxFor(index: number): number {
    if (this.rampUpSizes[index] === undefined) {
      return this.maxSize;
    }
    return Math.min(this.maxSize, Math.round(this.targetFor(index) * 1.5));
  }

  /** Smallest size a chunk is allowed to stop at once it has passed its target. */
  private minFor(index: number): number {
    return Math.min(this.minSize, Math.round(this.targetFor(index) * 0.6));
  }

  /**
   * Decide whether the chunk being built should be closed before adding more text.
   * Close it when the combined size would pass the hard limit, or when it would pass the target
   * and the chunk is already big enough to stand on its own.
   */
  private shouldClose(currentLength: number, combinedLength: number, index: number): boolean {
    if (combinedLength > this.maxFor(index)) {
      return true;
    }
    return combinedLength > this.targetFor(index) && currentLength >= this.minFor(index);
  }

  chunk(text: string, globalStartPosition: number = 0): TextChunk[] {
    const paragraphs = this.splitParagraphs(text);

    const chunks: TextChunk[] = [];
    let position = globalStartPosition;

    const emit = (parts: string[]) => {
      if (parts.length === 0) {
        return;
      }
      chunks.push(this.createChunk(chunks.length, parts, position));
      position += this.calculateLength(parts);
    };

    let current: string[] = [];
    let currentLength = 0; // characters including the blank-line separators between paragraphs

    const flush = () => {
      emit(current);
      current = [];
      currentLength = 0;
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length > this.maxFor(chunks.length)) {
        // Paragraph is too long for the chunk being built: close it and split by sentences.
        flush();

        let sentenceChunk: string[] = [];
        let sentenceLength = 0;

        for (const sentence of this.splitSentences(paragraph, this.maxFor(chunks.length))) {
          const combined =
            sentenceChunk.length > 0 ? sentenceLength + 2 + sentence.length : sentence.length;

          if (
            sentenceChunk.length > 0 &&
            this.shouldClose(sentenceLength, combined, chunks.length)
          ) {
            emit(sentenceChunk);
            sentenceChunk = [];
            sentenceLength = 0;
          }

          sentenceLength =
            sentenceChunk.length > 0 ? sentenceLength + 2 + sentence.length : sentence.length;
          sentenceChunk.push(sentence);
        }

        emit(sentenceChunk);
        continue;
      }

      const combined = current.length > 0 ? currentLength + 2 + paragraph.length : paragraph.length;

      if (current.length > 0 && this.shouldClose(currentLength, combined, chunks.length)) {
        flush();
      }

      currentLength =
        current.length > 0 ? currentLength + 2 + paragraph.length : paragraph.length;
      current.push(paragraph);
    }

    flush();

    return chunks;
  }

  private createChunk(index: number, paragraphs: string[], startPosition: number): TextChunk {
    const text = paragraphs.join('\n\n');
    const hash = this.createHash(text);
    const wordCount = this.countWords(text);

    return {
      index,
      text,
      startPosition,
      endPosition: startPosition + text.length,
      hash,
      wordCount,
    };
  }

  private splitParagraphs(text: string): string[] {
    return text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  /**
   * Split a paragraph into sentences. Text is never dropped: a sentence that is still longer
   * than `limit` is broken on spaces so no single piece is oversized.
   */
  private splitSentences(text: string, limit: number): string[] {
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const result: string[] = [];
    for (const sentence of sentences) {
      if (sentence.length <= limit) {
        result.push(sentence);
        continue;
      }

      let piece = '';
      for (const word of sentence.split(/\s+/)) {
        if (piece.length > 0 && piece.length + 1 + word.length > limit) {
          result.push(piece);
          piece = word;
        } else {
          piece = piece.length > 0 ? `${piece} ${word}` : word;
        }
      }
      if (piece.length > 0) {
        result.push(piece);
      }
    }

    return result;
  }

  private calculateLength(paragraphs: string[]): number {
    return paragraphs.reduce((sum, p) => sum + p.length + 2, 0);
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter((w) => w.length > 0).length;
  }

  private createHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
  }
}

export function createCacheHash(text: string, voiceId: string, settings: any = {}): string {
  const combined = JSON.stringify({
    text,
    voiceId,
    speed: settings.speed || 1.0,
    temperature: settings.temperature || 0.7,
  });

  return crypto.createHash('sha256').update(combined).digest('hex');
}

export const chunker = new TextChunker();

/**
 * Chunker used for audio generation. Chunks are about 50 words (300 characters) so each piece
 * is quick to generate and little work is wasted when playback stops. The first two chunks of
 * every chapter are smaller (150 and 225 characters) so playback can start within seconds on a
 * slow CPU; each step is at most 1.5x the previous one, so generation of the next chunk
 * finishes before the current one has finished playing.
 */
export const ttsChunker = new TextChunker({
  targetSize: 300,
  maxSize: 400,
  minSize: 200,
  rampUpSizes: [150, 225],
});
