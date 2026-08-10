/**
 * The user-install regression: a DM with ANOTHER user is `ChannelType.DM` too,
 * so only `context` can tell it apart from the bot's own DM. Getting this wrong
 * made the bot reply in a channel it cannot edit -> "Missing Access".
 */
import { InteractionContextType, type BaseInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { isBotDm } from '../src/discord/context.js';

const at = (context: InteractionContextType | null): BaseInteraction =>
  ({ context }) as unknown as BaseInteraction;

describe('isBotDm', () => {
  it('is true only in the 1:1 DM with the bot', () => {
    expect(isBotDm(at(InteractionContextType.BotDM))).toBe(true);
  });

  it("is false in someone else's DM / a group DM (user-install)", () => {
    expect(isBotDm(at(InteractionContextType.PrivateChannel))).toBe(false);
  });

  it('is false in a guild channel', () => {
    expect(isBotDm(at(InteractionContextType.Guild))).toBe(false);
  });

  it('fails safe when the payload carries no context', () => {
    expect(isBotDm(at(null))).toBe(false);
  });
});
