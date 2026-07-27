/**
 * Append-only JSONL receipt (finding 3). One HEADER line, then per fixture a
 * PLANNED line (flushed + fsync'd BEFORE that fixture's DB writes) and a WRITTEN
 * line (after). Because the PLANNED line is durable before any DB mutation, a
 * crash can never leave an unrecorded fixture: on resume every fixture that may
 * have touched the DB is enumerated, and the writer's field-by-field row
 * verification reconciles partial state.
 */
import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync } from 'node:fs';
import type { ReceiptLine, ReceiptHeaderLine, ReceiptFixtureLine } from './types.js';

export class ReceiptWriter {
  private fd: number;
  constructor(private path: string, append: boolean) {
    // 'a' append (resume) or 'w' truncate (fresh). Header is written once.
    this.fd = openSync(path, append ? 'a' : 'w');
  }
  private writeLine(line: ReceiptLine): void {
    writeSync(this.fd, JSON.stringify(line) + '\n');
    fsyncSync(this.fd); // durable before the caller proceeds to DB writes
  }
  writeHeader(header: ReceiptHeaderLine): void {
    this.writeLine(header);
  }
  writePlanned(line: Omit<ReceiptFixtureLine, 'kind'>): void {
    this.writeLine({ kind: 'planned', ...line });
  }
  writeWritten(line: Omit<ReceiptFixtureLine, 'kind'>): void {
    this.writeLine({ kind: 'written', ...line });
  }
  close(): void {
    closeSync(this.fd);
  }
}

export interface ParsedReceipt {
  header: ReceiptHeaderLine;
  planned: ReceiptFixtureLine[];
  written: ReceiptFixtureLine[];
}

/** Parse a JSONL receipt. Throws if the header line is missing/malformed. */
export function parseReceipt(path: string): ParsedReceipt {
  if (!existsSync(path)) throw new Error(`receipt not found: ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const parsed = lines.map((l) => JSON.parse(l) as ReceiptLine);
  const header = parsed.find((l): l is ReceiptHeaderLine => l.kind === 'header');
  if (!header) throw new Error(`receipt ${path} has no header line`);
  const planned = parsed.filter((l): l is ReceiptFixtureLine => l.kind === 'planned');
  const written = parsed.filter((l): l is ReceiptFixtureLine => l.kind === 'written');
  return { header, planned, written };
}

/** All fixture lines (planned ∪ written), de-duplicated by matchId. */
export function receiptFixtures(receipt: ParsedReceipt): ReceiptFixtureLine[] {
  const byMatch = new Map<string, ReceiptFixtureLine>();
  for (const line of [...receipt.planned, ...receipt.written]) {
    byMatch.set(line.matchId, line);
  }
  return [...byMatch.values()];
}
