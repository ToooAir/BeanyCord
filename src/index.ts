/**
 * Bot entry point. Run: `npm run bot` (sets --openssl-legacy-provider for the
 * DES-based OTP decrypt).
 *
 * One-time setup first: `npm run register` to publish the slash commands.
 */
import 'dotenv/config';

import { createBot } from './discord/bot.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is missing — copy .env.example to .env and fill it in.');
  process.exit(1);
}

// The launcher-identity check lives in `bot.ts`, not here: it now measures a
// real outage rather than a version difference, so it is worth scheduling — and
// worth running where there is a gateway to send someone a DM over.

createBot(token).catch((e: unknown) => {
  console.error('failed to start bot:', e instanceof Error ? e.message : e);
  process.exit(1);
});
