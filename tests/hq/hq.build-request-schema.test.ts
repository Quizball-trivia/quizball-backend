import { describe, expect, it } from 'vitest';
import { createBuildBodySchema } from '../../src/modules/hq/hq.schemas.js';

const VALID = {
  title: 'Invented sandbox build',
  spec: 'An invented spec used only by this schema test.',
  kind: 'feature',
  repos: ['backend'],
};

function parse(over: Record<string, unknown> = {}) {
  return createBuildBodySchema.safeParse({ ...VALID, ...over });
}

function expectAccepted(over: Record<string, unknown>) {
  const result = parse(over);
  expect(result.success).toBe(true);
  return result.data;
}

function expectRejected(over: Record<string, unknown>, path: (string | number)[]) {
  const result = parse(over);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
}

describe('createBuildBodySchema', () => {
  it('accepts a valid request and returns it unchanged', () => {
    expect(expectAccepted({})).toEqual(VALID);
  });

  it('trims title and spec in the parsed output', () => {
    const data = expectAccepted({ title: '  Invented sandbox build \n', spec: `\n\t ${VALID.spec}  ` });
    expect(data).toEqual(VALID);
  });

  describe('title', () => {
    it.each([1, 200])('accepts a %i-character title', (length) => {
      expect(expectAccepted({ title: 't'.repeat(length) })?.title).toHaveLength(length);
    });

    it('counts length after trimming at the upper bound', () => {
      expect(expectAccepted({ title: `  ${'t'.repeat(200)}  ` })?.title).toHaveLength(200);
    });

    it.each([
      ['an empty title', ''],
      ['a whitespace-only title', ' \t\n '],
      ['a 201-character title', 't'.repeat(201)],
    ])('rejects %s', (_label, title) => {
      expectRejected({ title }, ['title']);
    });
  });

  describe('spec', () => {
    it.each([20, 30000])('accepts a %i-character spec', (length) => {
      expect(expectAccepted({ spec: 's'.repeat(length) })?.spec).toHaveLength(length);
    });

    it.each([19, 30001])('rejects a %i-character spec', (length) => {
      expectRejected({ spec: 's'.repeat(length) }, ['spec']);
    });

    it('rejects 19 real characters padded past 20', () => {
      expectRejected({ spec: `   ${'s'.repeat(19)} \n ` }, ['spec']);
    });

    it('counts length after trimming at the upper bound', () => {
      expect(expectAccepted({ spec: `  ${'s'.repeat(30000)}  ` })?.spec).toHaveLength(30000);
    });
  });

  describe('kind', () => {
    it.each(['game_mode', 'feature', 'bug_fix', 'other'])('accepts %s', (kind) => {
      expect(expectAccepted({ kind })?.kind).toBe(kind);
    });

    it.each(['refactor', 'Feature'])('rejects %s', (kind) => {
      expectRejected({ kind }, ['kind']);
    });
  });

  describe('repos', () => {
    it.each(['backend', 'web', 'cms'])('accepts %s', (repo) => {
      expect(expectAccepted({ repos: [repo] })?.repos).toEqual([repo]);
    });

    it('accepts all three repos', () => {
      expect(expectAccepted({ repos: ['backend', 'web', 'cms'] })?.repos).toEqual(['backend', 'web', 'cms']);
    });

    it('rejects an unknown repo', () => {
      expectRejected({ repos: ['mobile'] }, ['repos', 0]);
    });

    it('rejects an empty list', () => {
      expectRejected({ repos: [] }, ['repos']);
    });

    it('rejects a 4-entry list', () => {
      expectRejected({ repos: ['backend', 'web', 'cms', 'backend'] }, ['repos']);
    });
  });

  describe('required fields', () => {
    it.each(['title', 'spec', 'kind', 'repos'])('rejects a request without %s', (field) => {
      const body: Record<string, unknown> = { ...VALID };
      delete body[field];
      const result = createBuildBodySchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([[field]]);
    });

    it('rejects an empty body', () => {
      const result = createBuildBodySchema.safeParse({});
      expect(result.success).toBe(false);
      const paths = result.error?.issues.map((issue) => issue.path);
      expect(paths).toHaveLength(4);
      expect(paths).toEqual(expect.arrayContaining([['title'], ['spec'], ['kind'], ['repos']]));
    });
  });
});
