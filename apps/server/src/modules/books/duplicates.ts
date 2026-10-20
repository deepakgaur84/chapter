/**
 * Finding books that are probably the same book imported more than once: an EPUB and a PDF of
 * it, two editions, copies in two folders. Different files have different hashes, so the exact
 * file match used at import cannot see these. Title, author and ISBN can.
 */

export interface BookKey {
  id: string;
  title: string;
  author?: string | null;
  isbn?: string | null;
}

const UNKNOWN_TITLES = new Set(['untitled', 'unknown', 'book', 'document']);

/** "The Barefoot Investor: The only money guide you'll ever need (2020)" -> "barefoot investor" */
export function normalizeTitle(title: string | null | undefined): string {
  let t = (title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.(epub|pdf)$/i, '');
  // Drop a subtitle or edition note
  t = t.split(/\s*[:–—]\s*|\s+-\s+|\s*[([]/)[0] || '';
  t = t
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an)\s+/, '');
  return t;
}

/** Surnames of the authors, lower case: "Peterson, Jordan B" and "Jordan B. Peterson" both give "peterson" */
export function authorSurnames(author: string | null | undefined): string[] {
  if (!author) return [];
  const names = author
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s*(?:&|;|\/|\band\b)\s*/);
  const surnames: string[] = [];
  for (const name of names) {
    const beforeComma = name.includes(',') ? name.split(',')[0] : name;
    const tokens = beforeComma.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    const surname = name.includes(',') ? tokens[tokens.length - 1] : tokens[tokens.length - 1];
    if (surname && surname.length > 1) surnames.push(surname);
  }
  return surnames;
}

export function normalizeIsbn(isbn: string | null | undefined): string {
  const digits = (isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return digits.length === 10 || digits.length === 13 ? digits : '';
}

function strongTitle(key: string): boolean {
  return key.length >= 6 && !UNKNOWN_TITLES.has(key);
}

export type Match = 'none' | 'sure' | 'check';

/**
 * How likely two books are the same:
 *  - "sure": same ISBN, or same title and an author in common
 *  - "check": same title but an author is missing on one side, so it needs a person's eye
 */
export function compareBooks(a: BookKey, b: BookKey): Match {
  const isbnA = normalizeIsbn(a.isbn);
  if (isbnA && isbnA === normalizeIsbn(b.isbn)) return 'sure';

  const titleA = normalizeTitle(a.title);
  if (!strongTitle(titleA) || titleA !== normalizeTitle(b.title)) return 'none';

  const authorsA = authorSurnames(a.author);
  const authorsB = authorSurnames(b.author);
  if (authorsA.length === 0 || authorsB.length === 0) return 'check';
  return authorsA.some((name) => authorsB.includes(name)) ? 'sure' : 'none';
}

export interface DuplicateGroup<T extends BookKey> {
  books: T[];
  /** "sure" when every book in the group is a sure match for another one in it, else "check" */
  confidence: 'sure' | 'check';
}

/** Group books that look like the same book (matches are followed transitively) */
export function groupLikelyDuplicates<T extends BookKey>(books: T[]): DuplicateGroup<T>[] {
  const parent = books.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const strength = new Map<string, Match>();

  for (let i = 0; i < books.length; i++) {
    for (let j = i + 1; j < books.length; j++) {
      const match = compareBooks(books[i], books[j]);
      if (match === 'none') continue;
      strength.set(`${i}:${j}`, match);
      parent[find(i)] = find(j);
    }
  }

  const groups = new Map<number, number[]>();
  books.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) || []), i]);
  });

  const result: DuplicateGroup<T>[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sureMembers = new Set<number>();
    for (const [pair, match] of strength) {
      if (match !== 'sure') continue;
      const [i, j] = pair.split(':').map(Number);
      if (members.includes(i)) {
        sureMembers.add(i);
        sureMembers.add(j);
      }
    }
    result.push({
      books: members.map((i) => books[i]),
      confidence: members.every((i) => sureMembers.has(i)) ? 'sure' : 'check',
    });
  }
  return result;
}

export interface KeepCandidate extends BookKey {
  sourceFormat?: string | null;
  hasText?: boolean;
  totalWords?: number | null;
  progress?: number | null;
  audioChunks?: number | null;
  createdAt?: Date | string | null;
}

/**
 * The copy to keep by default: the one being read, then one with readable text, an original EPUB
 * over one converted from a PDF, more audio already made, more text, and the older import.
 */
export function pickBookToKeep<T extends KeepCandidate>(books: T[]): T {
  const score = (book: T): number[] => [
    (book.progress ?? 0) > 0 ? 1 : 0,
    book.hasText === false ? 0 : 1,
    book.sourceFormat === 'pdf' ? 0 : 1,
    (book.audioChunks ?? 0) > 0 ? 1 : 0,
    book.totalWords ?? 0,
    -new Date(book.createdAt ?? 0).getTime(),
  ];
  return [...books].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sb[i] - sa[i];
    }
    return 0;
  })[0];
}
