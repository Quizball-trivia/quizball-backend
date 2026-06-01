import { describe, expect, it } from 'vitest';
import {
  findBannedNicknameTerm,
  isNicknameAllowed,
  normalizeModerationText,
} from '../../src/modules/moderation/text-moderation.js';
import '../setup.js';

describe('nickname text moderation', () => {
  it('normalizes case, separators, and common leetspeak', () => {
    expect(normalizeModerationText(' N-1.g g.3 r ')).toBe('nigger');
  });

  it('blocks severe English hate terms with common obfuscation', () => {
    expect(findBannedNicknameTerm(`Ni${'gg'}eR`)).toMatchObject({
      reason: 'hate',
      language: 'en',
    });
    expect(isNicknameAllowed(`n1${'gg'}3r`)).toBe(false);
    expect(isNicknameAllowed(`n i ${'g g'} a`)).toBe(false);
  });

  it('blocks common English abuse, sexual, violence, and extremist nickname terms', () => {
    expect(findBannedNicknameTerm(`neo${'nazi'}`)).toMatchObject({ reason: 'extremism' });
    expect(findBannedNicknameTerm(`x${'porn'}x`)).toMatchObject({ reason: 'sexual' });
    expect(findBannedNicknameTerm(`f${'u'}ck`)).toMatchObject({ reason: 'harassment' });
  });

  it('blocks exact-mode terms with numeric decoration', () => {
    expect(isNicknameAllowed(`${'sex'}123`)).toBe(false);
    expect(isNicknameAllowed(`123${'d1ck'}`)).toBe(false);
  });

  it('allows unrelated names that share only a short prefix', () => {
    expect(isNicknameAllowed('NigerUnited')).toBe(true);
    expect(isNicknameAllowed('Nigar')).toBe(true);
    expect(isNicknameAllowed('Scunthorpe')).toBe(true);
    expect(isNicknameAllowed('EssexFan')).toBe(true);
    expect(isNicknameAllowed('Cockburn')).toBe(true);
    expect(isNicknameAllowed('Dickson')).toBe(true);
    expect(isNicknameAllowed('ClassyPlayer')).toBe(true);
    expect(isNicknameAllowed('Skiller')).toBe(true);
    expect(isNicknameAllowed('bitchiko')).toBe(true);
    expect(isNicknameAllowed('nikusha_740a7175')).toBe(true);
    expect(isNicknameAllowed('sandrooo5_b237175a')).toBe(true);
    expect(isNicknameAllowed('rochkkkkkk.jr7')).toBe(true);
    expect(isNicknameAllowed('Killera')).toBe(true);
    expect(isNicknameAllowed('Killer')).toBe(true);
    expect(isNicknameAllowed('CleanPlayer')).toBe(true);
  });
});
