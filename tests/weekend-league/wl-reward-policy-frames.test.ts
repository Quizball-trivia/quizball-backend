import { describe, expect, it } from 'vitest';
import { wlPackItemSlugs, wlRewardPolicyVersion } from '../../src/modules/weekend-league/wl-reward-policy.js';
import { avatarCustomizationSchema, parseStoredAvatarCustomization } from '../../src/modules/users/avatar-customization.js';
import { avatarMetadataSchema } from '../../src/modules/store/store.schemas.js';

describe('Weekend League podium packs (policy v2)', () => {
  it('with frames off (the default) a pack is the jersey only, as policy v1', () => {
    expect(wlRewardPolicyVersion(false)).toBe(1);
    expect(wlPackItemSlugs(false)).toEqual({
      1: ['avatar_jersey_wl_retro_home'], 2: ['avatar_jersey_wl_retro_away'], 3: ['avatar_jersey_wl_retro_training'],
    });
  });

  it('with frames on each podium place carries its jersey and its own frame (v2)', () => {
    expect(wlRewardPolicyVersion(true)).toBe(2);
    expect(wlPackItemSlugs(true)).toEqual({
      1: ['avatar_jersey_wl_retro_home', 'avatar_frame_wl_champion'],
      2: ['avatar_jersey_wl_retro_away', 'avatar_frame_wl_runnerup'],
      3: ['avatar_jersey_wl_retro_training', 'avatar_frame_wl_podium'],
    });
  });
});

describe('frame slot', () => {
  it('a stored customization with a frame survives parsing instead of nulling the whole avatar', () => {
    const stored = { skin: 'skin_male_white', jersey: 'jersey_wl_retro_home', frame: 'frame_wl_champion' };
    expect(parseStoredAvatarCustomization(stored)).toEqual(stored);
    expect(avatarCustomizationSchema.safeParse({ frame: 'Frame With Spaces' }).success).toBe(false);
  });

  it('frame products parse as avatar metadata, so inventory listing does not fail for their owners', () => {
    const parsed = avatarMetadataSchema.safeParse({
      avatarPartId: 'frame_wl_champion', slot: 'frame', assetUrl: '/assets/store/rewards/wl-frames/champion.svg', rewardOnly: true,
    });
    expect(parsed.success).toBe(true);
  });
});
