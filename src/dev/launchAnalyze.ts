/**
 * Dev-only, OFFLINE: work out how a captured `m_objData.data` blob decodes.
 *
 * `decodeLaunchTicket` implements the algorithm exactly as reverse-engineered
 * upstream (pungin/Beanfun#368: selector = `data[0]`, table = `n % 4`, map each
 * character to its index in the table, DES key = 8 characters at offset `n + 1`
 * of the result, DES-ECB/NoPadding on the rest) — and that algorithm, verified
 * there against a real sample, does not decode the blob this account gets.
 *
 * Guessing which detail differs is what this replaces. It reads a captured blob
 * and tries the cross product of the plausible variations, ranking them by how
 * much of the output looks like text: a correct decode is ~100% printable ASCII
 * and a wrong one is noise, so the answer stands out with no marker needed.
 *
 * Usage:
 *   npm run probe:otp -- --write     # captures capture/otp/1_launch_data.txt
 *   npm run analyze:launch           # then iterate here, offline, forever
 *
 * Prints field NAMES and value lengths, never values: a decoded payload carries
 * a live LaunchTicket and the account id.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TABLES } from '../beanfun/launchData.js';
import { decryptHex } from '../beanfun/wcdes.js';

const HEX = '0123456789abcdef';

/** The known tables, plus the two mappings that are not substitutions at all. */
const CANDIDATE_TABLES: { name: string; table: string }[] = [
  ...TABLES.map((table, i) => ({ name: `table${i}`, table })),
  { name: 'identity', table: HEX },
  { name: 'reversed', table: [...HEX].reverse().join('') },
];

interface Attempt {
  table: string;
  direction: 'index' | 'forward';
  offset: string;
  printable: number;
  text: string;
}

/** Fraction of the string that is printable ASCII — a decode's signal. */
function printableRatio(s: string): number {
  if (s.length === 0) return 0;
  let n = 0;
  for (const c of s) if (c >= ' ' && c <= '~') n++;
  return n / s.length;
}

function attempt(
  body: string,
  table: string,
  direction: 'index' | 'forward',
  keyOffset: number,
): string | null {
  let normalized = '';
  for (const ch of body) {
    // `index`: the character's position in the table (the documented rule).
    // `forward`: the table applied as a substitution instead of its inverse —
    // the two differ unless the table is an involution, and none of them are.
    const mapped =
      direction === 'index'
        ? table.indexOf(ch)
        : /^[0-9a-f]$/.test(ch)
          ? HEX.indexOf(table[parseInt(ch, 16)]!)
          : -1;
    if (mapped < 0) return null;
    normalized += mapped.toString(16);
  }
  if (normalized.length < keyOffset + 8) return null;

  const key = normalized.slice(keyOffset, keyOffset + 8);
  const cipherHex = normalized.slice(0, keyOffset) + normalized.slice(keyOffset + 8);
  if ((cipherHex.length / 2) % 8 !== 0) return null;
  try {
    return decryptHex(cipherHex, key).replace(/\0+$/, '');
  } catch {
    return null;
  }
}

function main(): void {
  const path = process.argv[2] ?? join(process.env.CAPTURE_OUT?.trim() || 'capture', 'otp', '1_launch_data.txt');
  let blob: string;
  try {
    blob = readFileSync(path, 'utf8').trim();
  } catch {
    console.error(`Cannot read ${path}. Run \`npm run probe:otp -- --write\` first.`);
    process.exitCode = 1;
    return;
  }

  const selectorChar = blob[0]!;
  const selector = parseInt(selectorChar, 16);
  const body = blob.slice(1);
  const alphabet = [...new Set(body)].sort().join('');

  console.log(`blob: ${blob.length} characters`);
  console.log(`  selector char: ${JSON.stringify(selectorChar)} -> n = ${selector}`);
  console.log(`  alphabet used: ${JSON.stringify(alphabet)} (${alphabet.length} distinct)`);
  console.log(`  body ${body.length} chars; minus 8 key = ${body.length - 8} hex = ${(body.length - 8) / 2} bytes = ${(body.length - 8) / 16} DES blocks\n`);

  if (alphabet.length !== 16) {
    console.log(`  NOTE: ${alphabet.length} distinct characters, not 16 — a full-alphabet blob is expected.\n`);
  }

  // The documented offset is n+1; the others cover an off-by-one or a rule that
  // does not depend on the selector at all.
  const offsets: { name: string; value: number }[] = [
    { name: 'n+1', value: selector + 1 },
    { name: 'n', value: selector },
    { name: '0', value: 0 },
    { name: '1', value: 1 },
    { name: '8', value: 8 },
  ];

  const results: Attempt[] = [];
  for (const { name, table } of CANDIDATE_TABLES) {
    for (const direction of ['index', 'forward'] as const) {
      for (const off of offsets) {
        const text = attempt(body, table, direction, off.value);
        if (text === null) continue;
        results.push({
          table: name,
          direction,
          offset: off.name,
          printable: printableRatio(text),
          text,
        });
      }
    }
  }

  results.sort((a, b) => b.printable - a.printable);
  console.log('top candidates by printable-ASCII ratio:');
  for (const r of results.slice(0, 8)) {
    const hit = r.text.includes('LaunchTicket=') ? '  <-- LaunchTicket!' : '';
    console.log(
      `  ${(r.printable * 100).toFixed(1).padStart(5)}%  ${r.table.padEnd(9)} ${r.direction.padEnd(7)} offset=${r.offset}${hit}`,
    );
  }

  const best = results[0];
  if (!best || best.printable < 0.9) {
    console.log(
      '\nNothing decoded to text. The blob is not this algorithm with a different\n' +
        'table — the format itself differs from what GGM 1.5.0.2 reads.',
    );
    return;
  }

  // Structure only: a real payload carries a live LaunchTicket and account id.
  console.log(`\nbest candidate decodes to ${best.text.length} characters. Field shape:`);
  for (const field of best.text.split(';')[0]!.split('&')) {
    const eq = field.indexOf('=');
    console.log(eq < 0 ? `  <no '='> (${field.length}c)` : `  ${field.slice(0, eq)} = <${field.length - eq - 1} chars>`);
  }
}

main();
