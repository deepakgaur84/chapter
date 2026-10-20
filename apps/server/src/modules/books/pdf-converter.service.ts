import { config } from '../../core/config';

export interface ConvertedPdf {
  /** False for scanned PDFs: there is no text layer to read or listen to */
  hasText: boolean;
  pages: number;
  title: string;
  author?: string;
  language?: string;
  /** JPEG of the first page, if it could be rendered */
  cover: Buffer | null;
  /** The reflowable EPUB. Only present when hasText is true */
  epub: Buffer | null;
}

interface ConverterResponse {
  hasText: boolean;
  pages: number;
  title: string;
  author?: string;
  language?: string;
  cover?: string;
  epub?: string;
}

/**
 * Client for the pdf2epub service (services/pdf2epub). The service reads the PDF text, removes
 * page numbers and running headers, repairs line wraps and hyphenation, finds chapters, and
 * returns an EPUB. For a scanned PDF it only reports that there is no text.
 */
export class PdfConverterService {
  async convert(pdf: Buffer, filename: string): Promise<ConvertedPdf> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
    form.append('filename', filename);

    let response: Response;
    try {
      response = await fetch(`${config.pdf.converterUrl}/convert`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(config.pdf.converterTimeoutMs),
      });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') {
        throw new Error('Converting the PDF took too long and was stopped');
      }
      throw new Error(
        'The PDF converter is not reachable. Check that the pdf2epub container is running.'
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `The PDF converter failed (${response.status})`);
    }

    const data = (await response.json()) as ConverterResponse;
    return {
      hasText: data.hasText,
      pages: data.pages,
      title: data.title,
      author: data.author || undefined,
      language: data.language || undefined,
      cover: data.cover ? Buffer.from(data.cover, 'base64') : null,
      epub: data.epub ? Buffer.from(data.epub, 'base64') : null,
    };
  }
}

export const pdfConverterService = new PdfConverterService();
