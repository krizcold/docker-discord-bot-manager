import { describe, expect, it } from 'vitest';
import { generateStatusPageHtml } from '../../src/templates/statusPage';
import type { BotConfig } from '../../src/types';

describe('status page text claims only what the manager knows', () => {
  it('says no web port was published rather than that the bot has no web interface', () => {
    const html = generateStatusPageHtml({ id: 'b1', displayName: 'Bot' } as unknown as BotConfig);
    expect(html).not.toContain('has no web interface');
    expect(html).toContain('Bot Manager did not publish a web port for this bot');
  });
});
