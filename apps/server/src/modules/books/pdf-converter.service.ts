import { config } from '../../core/config';

export interface ConvertedPdf {
  /** False for scanned PDFs: there is no text layer to read or listen to */
  hasText: boolean;
  /** Why there is no text: "no_text" (a scan) or "unreadable" (OCR found only noise) */
  reason?: string;
  pages: number;
  /** Height / width of the first page */
  aspect?: number;
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
  reason?: string;
  pages: number;
  aspect?: number;
  title: string;
  author?: string;
  language?: string;
  cover?: string;
  epub?: string;
}

export interface OcrStatus {
  /** none = the converter does not know this job (never started, or it restarted) */
  state: 'none' | 'queued' | 'running' | 'done' | 'failed';
  page?: number;
  pages?: number;
  position?: number;
  error?: string;
  hasText?: boolean;
  reason?: string;
}

export interface OcrResult {
  hasText: boolean;
  reason?: string;
  epub: Buffer | null;
}

const UNREACHABLE =
  'The PDF converter is not reachable. Check that the pdf2epub container is running.';

/**
 * Client for the pdf2epub service (services/pdf2epub). It reads the PDF text, removes page
 * numbers and running headers, repairs line wraps and hyphenation, finds chapters, and returns an
 * EPUB. For a scanned PDF it reports that there is no text; the OCR calls then recognise the text
 * in the background, and the page calls serve page images for the page viewer.
 */
export class PdfConverterService {
  private url(path: string): string {
    return `${config.pdf.converterUrl}${path}`;
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
    try {
      return await fetch(this.url(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') {
        throw new Error('The PDF converter took too long to answer');
      }
      throw new Error(UNREACHABLE);
    }
  }

  private async fail(response: Response, what: string): Promise<never> {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `${what} (${response.status})`);
  }

  async convert(pdf: Buffer, filename: string): Promise<ConvertedPdf> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
    form.append('filename', filename);

    // Converting a big PDF can take a while on a NAS
    const response = await this.request(
      '/convert',
      { method: 'POST', body: form },
      config.pdf.converterTimeoutMs
    ).catch((error: Error) => {
      if (error.message.includes('took too long')) {
        throw new Error('Converting the PDF took too long and was stopped');
      }
      throw error;
    });
    if (!response.ok) await this.fail(response, 'The PDF converter failed');

    const data = (await response.json()) as ConverterResponse;
    return {
      hasText: data.hasText,
      reason: data.reason || undefined,
      pages: data.pages,
      aspect: data.aspect || undefined,
      title: data.title,
      author: data.author || undefined,
      language: data.language || undefined,
      cover: data.cover ? Buffer.from(data.cover, 'base64') : null,
      epub: data.epub ? Buffer.from(data.epub, 'base64') : null,
    };
  }

  /** Start text recognition of a stored PDF. Safe to call again; `force` starts it over. */
  async startOcr(fileHash: string, force = false): Promise<OcrStatus> {
    const response = await this.request(`/ocr/${fileHash}${force ? '?force=1' : ''}`, {
      method: 'POST',
    });
    if (!response.ok) await this.fail(response, 'Could not start text recognition');
    return (await response.json()) as OcrStatus;
  }

  async getOcrStatus(fileHash: string): Promise<OcrStatus> {
    const response = await this.request(`/ocr/${fileHash}`);
    if (!response.ok) await this.fail(response, 'Could not read text recognition progress');
    return (await response.json()) as OcrStatus;
  }

  async getOcrResult(fileHash: string): Promise<OcrResult> {
    const response = await this.request(`/ocr/${fileHash}/result`, {}, 120000);
    if (!response.ok) await this.fail(response, 'Could not get the text recognition result');
    const data = (await response.json()) as { hasText: boolean; reason?: string; epub?: string };
    return {
      hasText: data.hasText,
      reason: data.reason || undefined,
      epub: data.epub ? Buffer.from(data.epub, 'base64') : null,
    };
  }

  /** Stop and forget a job (best effort) */
  async cancelOcr(fileHash: string): Promise<void> {
    // Short timeout: deleting a book must not wait for a converter that is not answering
    await this.request(`/ocr/${fileHash}`, { method: 'DELETE' }, 3000).catch(() => undefined);
  }

  /** Page count and page shape of a stored PDF */
  async getInfo(fileHash: string): Promise<{ pages: number; aspect: number }> {
    const response = await this.request(`/info/${fileHash}`);
    if (!response.ok) await this.fail(response, 'Could not read the PDF');
    return (await response.json()) as { pages: number; aspect: number };
  }

  /** One page (1-based) of a stored PDF as a JPEG */
  async renderPage(fileHash: string, page: number, width: number): Promise<Buffer> {
    const response = await this.request(`/pages/${fileHash}/${page}?w=${width}`, {}, 60000);
    if (!response.ok) await this.fail(response, 'Could not render the page');
    return Buffer.from(await response.arrayBuffer());
  }
}

export const pdfConverterService = new PdfConverterService();
