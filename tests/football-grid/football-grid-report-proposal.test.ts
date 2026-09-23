import { describe, expect, it } from 'vitest';
import { footballGridAdminReportProposalSchema } from '../../src/modules/football-grid/football-grid-admin.schemas.js';

const proposal = {
  playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  names: {
    en: 'Thierry Henry', ka: 'ტიერი ანრი',
    es: 'Thierry Henry', tr: 'Thierry Henry',
  },
  aliases: [
    { locale: 'en', value: 'Henry', acceptancePolicy: 'unique_only' },
    { locale: 'ka', value: 'ტიერი ანრი', acceptancePolicy: 'safe_typo' },
    { locale: 'es', value: 'Thierry Henry', acceptancePolicy: 'exact' },
    { locale: 'tr', value: 'Thierry Henry', acceptancePolicy: 'exact' },
  ],
  evidenceUrl: 'https://www.premierleague.com/players/1659/Thierry-Henry/overview',
  evidenceNote: 'Arsenal appearances under Arsène Wenger',
};

describe('Football Grid correction proposals', () => {
  it('keeps four-language names, reviewed aliases and evidence together', () => {
    expect(footballGridAdminReportProposalSchema.parse(proposal)).toMatchObject(proposal);
  });

  it('rejects incomplete languages and unsupported matching policies', () => {
    const missingTurkish = { en: proposal.names.en, ka: proposal.names.ka, es: proposal.names.es };
    expect(footballGridAdminReportProposalSchema.safeParse({ ...proposal, names: missingTurkish }).success).toBe(false);
    expect(footballGridAdminReportProposalSchema.safeParse({
      ...proposal, aliases: [
        ...proposal.aliases.slice(1),
        { locale: 'en', value: 'Henry', acceptancePolicy: 'fuzzy_any' },
      ],
    }).success).toBe(false);
    expect(footballGridAdminReportProposalSchema.safeParse({
      ...proposal, aliases: proposal.aliases.filter((alias) => alias.locale !== 'tr'),
    }).success).toBe(false);
  });

  it('rejects an invalid evidence URL before saving the draft', () => {
    expect(footballGridAdminReportProposalSchema.safeParse({
      ...proposal, evidenceUrl: 'not a URL',
    }).success).toBe(false);
  });
});
