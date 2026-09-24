import { describe, it, expect } from 'vitest';
import {
  contentKeyOf,
  contentKeyOfDealt,
  expandAcceptedAnswers,
  normalizeText,
  wlShapeIssues,
} from '../../src/modules/weekend-league/wl-content-normalize.js';
import { findCrestClub, resolveCrests } from '../../src/modules/weekend-league/wl-crest-registry.js';
import { isForbiddenHostname, isPrivateAddress } from '../../src/modules/weekend-league/wl-content-net.js';

describe('normalizeText', () => {
  it('ignores case, accents, punctuation and apostrophe styles', () => {
    expect(normalizeText('Newell’s Old Boys')).toBe(normalizeText("newell's old boys"));
    expect(normalizeText('Zlatan Ibrahimović')).toBe('zlatan ibrahimovic');
    expect(normalizeText('  Order these — clubs!  ')).toBe('order these clubs');
  });
});

describe('contentKeyOf', () => {
  it('keys typed rounds by the answered player, not the shared prompt', () => {
    const a = contentKeyOf('career_path', { en: 'Whose career path is this?' }, { display_answer: { en: 'Dennis Bergkamp' } });
    const b = contentKeyOf('career_path', { en: 'Question' }, { display_answer: { en: 'dennis bergkamp' } });
    expect(a).toBe(b);
    expect(a).toBe('career_path:dennis bergkamp');
  });

  it('keys put-in-order by the item set regardless of listed order', () => {
    const items = (labels: string[]) => ({ items: labels.map((l, i) => ({ label: { en: l }, sort_value: i + 1 })) });
    expect(contentKeyOf('put_in_order', 'x', items(['Inter', 'Milan', 'Juventus', 'Roma'])))
      .toBe(contentKeyOf('put_in_order', 'y', items(['Roma', 'Juventus', 'Milan', 'Inter'])));
  });

  it('matches a dealt wl_questions row to its source shape', () => {
    const src = contentKeyOf('mcq_single', { en: 'Which stadium is this?' }, { options: [] });
    const dealt = contentKeyOfDealt('mcq', { prompt: { en: 'Which stadium is this?' } }, { correct_id: 'a' });
    expect(dealt).toBe(src);
    expect(contentKeyOfDealt('who_am_i', { clues: [] }, { display_answer: { en: 'Guti' } })).toBe('clue_chain:guti');
  });

  it('returns null when there is nothing to key on', () => {
    expect(contentKeyOf('true_false', { en: '' }, {})).toBeNull();
    expect(contentKeyOf('high_low', { en: 'x' }, {})).toBeNull();
  });
});

describe('expandAcceptedAnswers', () => {
  it('adds family, bare surname and given-name forms in both scripts, minus -ი', () => {
    const out = expandAcceptedAnswers({ en: 'Edwin van der Sar', ka: 'ედვინ ვან დერ სარი' }, ['van der Sar']);
    expect(out).toEqual(expect.arrayContaining(['van der Sar', 'Edwin van der Sar', 'Sar', 'Edwin', 'ვან დერ სარი', 'სარი', 'სარ', 'ედვინ']));
    // deduped through normalization: existing alias is kept once
    expect(out.filter((v) => normalizeText(v) === 'van der sar')).toHaveLength(1);
  });

  it('never accepts generic suffixes on their own', () => {
    const out = expandAcceptedAnswers({ en: 'Neymar Junior', ka: 'ნეიმარი' });
    expect(out).not.toContain('Junior');
    expect(out).toContain('Neymar');
  });
});

describe('wlShapeIssues', () => {
  it('requires a photo, four options and one key for the mcq round', () => {
    const issues = wlShapeIssues('mcq_single', { options: [{ is_correct: true }, { is_correct: true }, {}] });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['mcq_no_image', 'mcq_options', 'mcq_key']));
  });

  it('requires exactly four uniquely ranked items for put in order', () => {
    const items = (ranks: number[]) => ({ items: ranks.map((n, i) => ({ label: { en: `item ${i}` }, sort_value: n })) });
    expect(wlShapeIssues('put_in_order', items([1, 2, 3, 4]))).toEqual([]);
    expect(wlShapeIssues('put_in_order', items([1, 1, 2, 3])).map((i) => i.code)).toContain('pio_ties');
    // The parser gives an item the Answer block forgot rank 0 — unique ranks, wrong key.
    expect(wlShapeIssues('put_in_order', items([0, 1, 2, 3])).map((i) => i.code)).toContain('pio_ranks');
    const twin = { items: ['Inter', 'Inter', 'Milan', 'Roma'].map((l, i) => ({ label: { en: l }, sort_value: i + 1 })) };
    expect(wlShapeIssues('put_in_order', twin).map((i) => i.code)).toContain('pio_dupe_items');
  });

  it('requires five clues and warns when a clue names the answer', () => {
    const clues = ['a', 'b', 'c', 'd', 'I am Álvaro Recoba'].map((c) => ({ content: { en: c } }));
    const issues = wlShapeIssues('clue_chain', { clues, display_answer: { en: 'Álvaro Recoba' }, accepted_answers: ['Recoba'] });
    expect(issues.find((i) => i.code === 'whoami_leak')?.severity).toBe('warning');
    expect(wlShapeIssues('clue_chain', { clues: clues.slice(0, 3), display_answer: { en: 'X Y' }, accepted_answers: ['Y'] }).map((i) => i.code)).toContain('whoami_clues');
  });
});

describe('crest registry', () => {
  it('resolves canonical names, aliases and generic-token variants', () => {
    expect(findCrestClub('Manchester United')?.id).toBe('manchester-united');
    expect(findCrestClub('Man Utd')?.id).toBe('manchester-united');
    expect(findCrestClub('Inter')?.id).toBe('inter-milan');
    expect(findCrestClub('AC Milan')?.id).toBe('ac-milan');
    expect(findCrestClub('FC Barcelona')?.id).toBe('fc-barcelona');
    expect(findCrestClub('Atalanta')?.id).toBe('atalanta-bc');
  });

  it('does not invent badges by loose prefix matching', () => {
    // Both were false crests in the 2026-09-11 batch under the web app's looser rule.
    expect(findCrestClub('Santos Laguna')).toBeNull();
    expect(findCrestClub('Lyon-Duchère')).toBeNull();
    expect(findCrestClub('Clausenengen')).toBeNull();
  });

  it('reports per-club resolution with a logo url when found', () => {
    const [hit, miss] = resolveCrests(['Arsenal', 'Cobh Ramblers']);
    expect(hit?.club_id).toBe('arsenal');
    expect(hit?.logo_url).toMatch(/club-logos\/arsenal\.webp$/);
    expect(miss).toEqual({ club: 'Cobh Ramblers', club_id: null, logo_url: null });
  });
});

describe('image probe address policy', () => {
  it('blocks loopback, private, link-local and IPv4-mapped IPv6 forms', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.9', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fe90::1', 'fd00::1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '185.199.108.153', '2606:4700::6810:85e5', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('refuses local hostnames outright', () => {
    expect(isForbiddenHostname('localhost')).toBe(true);
    expect(isForbiddenHostname('db.internal')).toBe(true);
    expect(isForbiddenHostname('upload.wikimedia.org')).toBe(false);
  });
});
