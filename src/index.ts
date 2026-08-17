/**
 * Bot entry point. Run: `npm run bot` (sets --openssl-legacy-provider for the
 * DES-based OTP decrypt).
 *
 * One-time setup first: `npm run register` to publish the slash commands.
 */
import 'dotenv/config';

import { ggmVerdict } from './beanfun/ggmCheck.js';
import { createBot } from './discord/bot.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is missing — copy .env.example to .env and fill it in.');
  process.exit(1);
}

// One line per deploy on the launcher identity we send. Not a monitor — the bot
// restarts often enough to make this naturally periodic, and a scheduled check
// would report a harmless version difference every day until it was ignored.
// Fire-and-forget: it must never delay or block startup.
void ggmVerdict().then((v) => {
  const say = v.status === 'aligned' ? console.log : console.warn;
  say(`[ggm] ${v.line}`);
});

createBot(token).catch((e: unknown) => {
  console.error('failed to start bot:', e instanceof Error ? e.message : e);
  process.exit(1);
});
