/**
 * Where did this interaction come from?
 *
 * With `DISCORD_USER_INSTALL=1` the commands are also usable in the
 * `PrivateChannel` context — i.e. inside a DM between the invoking user and
 * *someone else*, or a group DM, where the bot is not a channel member. Those
 * channels are ALSO `ChannelType.DM`/`GroupDM`, so a channel-type check cannot
 * tell them apart from the bot's own 1:1 DM.
 *
 * That distinction matters for two reasons:
 *  - privacy: a QR / OTP must never be posted into a channel someone else reads.
 *  - correctness: `Message#edit`/`delete` go through `PATCH /channels/…`, which
 *    needs channel access. In a channel the bot isn't in, the initial
 *    interaction reply succeeds (webhook route) but every follow-up edit fails
 *    with `Missing Access` — leaving the user stuck on a "⏳ …" placeholder.
 */
import { InteractionContextType, type BaseInteraction } from 'discord.js';

/** True only for the 1:1 DM between this bot and the invoking user — the one
 *  place where replying in line is both private and editable. */
export function isBotDm(interaction: BaseInteraction): boolean {
  // `context` is the only reliable discriminator (Discord sends it on every
  // interaction since user-installable apps shipped).
  if (interaction.context !== null) return interaction.context === InteractionContextType.BotDM;
  // Payload without `context`: fail safe. Treating it as "not the bot DM" routes
  // delivery to the user's real DM, which is always correct, just one extra
  // ephemeral message.
  return false;
}
