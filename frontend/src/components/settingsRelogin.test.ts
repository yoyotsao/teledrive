import { describe, expect, it } from 'vitest';
import { assertReloginTarget } from './SettingsDialog';

describe('assertReloginTarget', () => {
  it('rejects a Telegram session authenticated as a different linked account', () => {
    expect(() => assertReloginTarget(77, 88)).toThrow('登入的 Telegram 帳號與所選帳號不符');
  });

  it('accepts the Telegram account selected for re-login', () => {
    expect(() => assertReloginTarget(77, 77)).not.toThrow();
  });
});
