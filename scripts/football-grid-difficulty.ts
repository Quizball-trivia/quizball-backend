/**
 * Tic Tac Toe board checker: scores every live board from typed answers and lists the labels that do not fit.
 * Read-only unless --write (stores the scores) or --apply (makes the suggested labels the ones selection uses).
 *
 *   npx tsx scripts/football-grid-difficulty.ts --target local|staging|production
 *     [--write] [--apply --actor <name> [--basis measured|predicted]] [--counts <cells.csv>] [--report <out.json>]
 *
 * --counts scores this database's boards against answer counts exported from another environment (header:
 * canonical_checksum,cell_index,row_key,row_family,col_key,col_family,n,c; extra columns are ignored).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import type { GridDifficultyCellCount } from '../src/modules/football-grid/football-grid-difficulty.service.js';

interface Args {
  target?: PistasSeedTarget;
  write: boolean;
  apply: boolean;
  actor?: string;
  basis?: 'measured' | 'predicted';
  counts?: string;
  report?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { write: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]);
    if (arg === '--write') args.write = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--actor')) args.actor = value();
    else if (arg.startsWith('--counts')) args.counts = value();
    else if (arg.startsWith('--report')) args.report = value();
    else if (arg.startsWith('--basis')) {
      const basis = value();
      if (basis !== 'measured' && basis !== 'predicted') throw new Error('--basis must be measured or predicted');
      args.basis = basis;
    } else if (arg.startsWith('--target')) {
      const target = value();
      if (!SEED_TARGETS.includes(target as PistasSeedTarget)) throw new Error('--target must be local, staging or production');
      args.target = target as PistasSeedTarget;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (args.apply && !args.actor) throw new Error('--apply needs --actor <name>');
  return args;
}

function readCounts(file: string): GridDifficultyCellCount[] {
  const [header, ...lines] = readFileSync(resolve(file), 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const columns = (header ?? '').split(',').map((column) => column.trim());
  const at = (name: string): number => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`${file}: missing column ${name}`);
    return index;
  };
  const index = {
    checksum: at('canonical_checksum'), cell: at('cell_index'), rowKey: at('row_key'), rowFamily: at('row_family'),
    colKey: at('col_key'), colFamily: at('col_family'), answers: at('n'), correct: at('c'),
  };
  return lines.map((line, row) => {
    const cells = line.split(',').map((cell) => cell.trim());
    // A blank or broken number would become NaN and spoil every rate computed from the file.
    const count = (position: number, name: string): number => {
      const value = Number(cells[position]);
      if (cells[position] === '' || !Number.isInteger(value) || value < 0) throw new Error(`Counts file row ${row + 2}: ${name} is not a whole number`);
      return value;
    };
    return {
      checksum: cells[index.checksum],
      cellIndex: count(index.cell, 'cell_index'),
      rowKey: cells[index.rowKey],
      rowFamily: cells[index.rowFamily],
      colKey: cells[index.colKey],
      colFamily: cells[index.colFamily],
      answers: count(index.answers, 'n'),
      correct: count(index.correct, 'c'),
    };
  });
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, args.target);
  const { footballGridDifficultyService } = await import('../src/modules/football-grid/football-grid-difficulty.service.js');
  const { sql } = await import('../src/db/index.js');
  try {
    const counts = args.counts ? readCounts(args.counts) : undefined;
    const { summary, scores } = await footballGridDifficultyService.recompute({ write: args.write, counts });
    console.log(`Board checker -> ${target.label}${counts ? ` (answers from ${args.counts})` : ''}`);
    console.log(`${summary.boards} live boards, ${summary.measured} with 30+ typed answers, ${summary.answers} answers, ${percent(summary.globalRate)} right overall`);
    console.log(`By category family: ${Object.entries(summary.familyRates).sort((a, b) => a[1] - b[1]).map(([family, rate]) => `${family} ${percent(rate)}`).join(', ')}`);
    for (const label of ['easy', 'normal', 'hard'] as const) {
      const row = summary.byLabel[label];
      console.log(`  label ${label.padEnd(6)} ${String(row.boards).padStart(5)} boards (${row.measured} measured): keep ${row.keep}, move ${row.move}, retire ${row.retire}; scored easy ${row.suggested.easy} / normal ${row.suggested.normal} / hard ${row.suggested.hard}`);
    }
    if (args.report) {
      writeFileSync(resolve(args.report), JSON.stringify({ target: target.label, summary, scores }, null, 1));
      console.log(`Report written to ${args.report}`);
    }
    if (args.apply) {
      if (!args.write) throw new Error('--apply needs --write, so the labels applied are the ones just scored');
      const { applied } = await footballGridDifficultyService.applySuggested({ actor: args.actor!, basis: args.basis });
      console.log(`Applied ${applied} suggested labels as ${args.actor}.`);
    } else if (!args.write) {
      console.log('Dry run: nothing stored (add --write).');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
