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

import { runGgmCanary } from '../beanfun/ggmCanary.js';
import { combineGgm, compareGgm, readGgmSources } from '../beanfun/ggmCheck.js';

async function main(): Promise<void> {
  const [sources, canary] = await Promise.all([readGgmSources(), runGgmCanary()]);
  const verdict = combineGgm(compareGgm(sources), canary);

  console.log(`local     cv=${sources.local.cv} hash=${sources.local.hash} arch=${sources.local.arch}`);
  console.log(
    sources.upstream
      ? `upstream  cv=${sources.upstream.cv} hash=${sources.upstream.hash}`
      : 'upstream  <unavailable>',
  );
  console.log(`beanfun   version=${sources.beanfunVersion ?? '<unavailable>'}`);
  // The one line here that is a measurement rather than a comparison.
  console.log(`canary    ${canary.status} — ${canary.line}`);
  for (const p of sources.problems) console.log(`          ! ${p}`);

  console.log(`\n[${verdict.status}] ${verdict.line}`);

  // `differs` is information, not an outage: beanfun may keep accepting the old
  // pair for a long time — and when the canary says `accepted`, that is no
  // longer even a guess. A refusal, on the other hand, IS the outage.
  if (verdict.status === 'rejected' || verdict.status === 'unknown') process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[check:ggm] failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
