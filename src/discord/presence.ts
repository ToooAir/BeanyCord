/**
 * Public bot presence — rotates a few neutral lines (uptime + a call-to-action +
 * a mascot line). It deliberately does NOT broadcast the live session count;
 * that's authorized-only via /status, so we don't publicly advertise how many
 * people use the bot.
 */
import { ActivityType, type Client } from 'discord.js';

const ROTATE_MS = 20_000; // keep >= 15s to respect Discord's presence rate limit

/** Human uptime: "3d 4h" / "5h 12m" / "8m". */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Start rotating the bot's custom status. Returns the interval handle. */
export function startPresenceRotation(client: Client, startedAt: number): NodeJS.Timeout {
  const lines = (): string[] => [
    `⏱ 已運行 ${formatUptime(Date.now() - startedAt)}`,
    '🔒 /login 取得 OTP',
    '🔑 你的 OTP,交給我',
  ];
  let i = 0;
  const tick = (): void => {
    const list = lines();
    const text = list[i % list.length]!;
    client.user?.setPresence({
      activities: [{ name: text, state: text, type: ActivityType.Custom }],
      status: 'online',
    });
    i += 1;
  };
  tick(); // set one immediately, don't wait a full interval
  return setInterval(tick, ROTATE_MS);
}
