/**
 * Dev-only: ask, on demand, whether the launcher identity we send is still the
 * one Beanfun accepts. Same code the bot runs at startup and on a refusal — this
 * is just the entry point for when you are looking rather than waiting.
 *
 * Usage: `npm run check:ggm`
 *
 * Run this when OTP starts failing with a server refusal you cannot read. An
 * `aligned` answer eliminates the pair as a suspect, which is worth as much as
 * a hit.
 */
import 'dotenv/config';

import { compareGgm, readGgmSources } from '../beanfun/ggmCheck.js';

async function main(): Promise<void> {
  const sources = await readGgmSources();
  const verdict = compareGgm(sources);

  console.log(`local     cv=${sources.local.cv} hash=${sources.local.hash} arch=${sources.local.arch}`);
  console.log(
    sources.upstream
      ? `upstream  cv=${sources.upstream.cv} hash=${sources.upstream.hash}`
      : 'upstream  <unavailable>',
  );
  console.log(`beanfun   version=${sources.beanfunVersion ?? '<unavailable>'}`);
  for (const p of sources.problems) console.log(`          ! ${p}`);

  console.log(`\n[${verdict.status}] ${verdict.line}`);

  // `differs` is information, not an outage: beanfun may keep accepting the old
  // pair for a long time. Only a genuinely unusable answer is worth an exit code.
  if (verdict.status === 'unknown') process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[check:ggm] failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
