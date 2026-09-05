import { describe, expect, it } from 'vitest';
import { TelegramClientManager, adoptClient } from './gramjs.ts';

describe('TelegramClientManager log identity', () => {
  it('retains the account id and display name supplied at construction', () => {
    const manager = new TelegramClientManager(8773541354, 'test1');
    expect(manager.accountId).toBe(8773541354);
    expect(manager.accountName).toBe('test1');
  });

  it('adopts a freshly authenticated manager with its resolved label', () => {
    const manager = new TelegramClientManager();
    adoptClient(8838273312, manager, 'ji32k7au6y4');
    expect(manager.accountId).toBe(8838273312);
    expect(manager.accountName).toBe('ji32k7au6y4');
  });
});
