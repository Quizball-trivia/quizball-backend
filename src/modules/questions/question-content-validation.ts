import { normalizeAnswer } from '../../realtime/possession-answer-matching.js';

/**
 * Deterministic content gate for anything that becomes (or mutates) a published
 * question. The LLM judge in the generation pipeline handles factuality; this
 * module rejects the mechanically detectable defects that have shipped to prod:
 * serialization corruption, missing locales, self-solving ordering questions,
 * and typed-answer questions whose canonical answers are not accepted.
 */

export type IssueSeverity = 'block' | 'review';

export interface QuestionContentIssue {
  code: string;
  path: string;
  severity: IssueSeverity;
  message: string;
}

interface ValidateInput {
  type: string;
  prompt: unknown;
  explanation?: unknown;
  payload: unknown;
}

const REQUIRED_LOCALES = ['en', 'ka'] as const;
const TYPED_ANSWER_TYPES = new Set(['clue_chain', 'career_path', 'football_logic']);

const CORRUPTED_PATTERNS = [/\[object Object\]/, /^undefined$/, /^NaN$/];

function isI18nObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localeString(field: unknown, locale: string): string | null {
  if (!isI18nObject(field)) return null;
  const value = field[locale];
  return typeof value === 'string' ? value : null;
}

function collectCorruptedStrings(node: unknown, path: string, issues: QuestionContentIssue[]): void {
  if (typeof node === 'string') {
    if (CORRUPTED_PATTERNS.some((re) => re.test(node))) {
      issues.push({
        code: 'corrupted-string',
        path,
        severity: 'block',
        message: `Corrupted serialized value ${JSON.stringify(node.slice(0, 40))}`,
      });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectCorruptedStrings(child, `${path}[${index}]`, issues));
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      collectCorruptedStrings(child, path ? `${path}.${key}` : key, issues);
    }
  }
}

function requireLocales(field: unknown, path: string, issues: QuestionContentIssue[]): void {
  for (const locale of REQUIRED_LOCALES) {
    const value = localeString(field, locale);
    if (!value || !value.trim()) {
      issues.push({
        code: 'missing-locale',
        path: `${path}.${locale}`,
        severity: 'block',
        message: `Missing or empty ${locale} text`,
      });
    }
  }
}

function firstNumber(label: string): number | null {
  const match = label.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function isStrictlyMonotonic(values: number[]): boolean {
  if (values.length < 2) return false;
  const ascending = values.every((v, i) => i === 0 || v > values[i - 1]);
  const descending = values.every((v, i) => i === 0 || v < values[i - 1]);
  return ascending || descending;
}

interface OrderItem {
  label?: unknown;
  details?: unknown;
  sort_value?: unknown;
}

function validatePutInOrder(payload: Record<string, unknown>, issues: QuestionContentIssue[]): void {
  const items = Array.isArray(payload.items) ? (payload.items as OrderItem[]) : [];
  if (items.length < 3) {
    issues.push({
      code: 'too-few-items',
      path: 'payload.items',
      severity: 'block',
      message: `Ordering question has ${items.length} items; needs at least 3`,
    });
    return;
  }

  const sortValues = items.map((item) => Number(item.sort_value));
  if (sortValues.some((v) => !Number.isFinite(v))) {
    issues.push({
      code: 'invalid-sort-value',
      path: 'payload.items',
      severity: 'block',
      message: 'Every item needs a finite numeric sort_value',
    });
    return;
  }
  if (new Set(sortValues).size !== sortValues.length) {
    issues.push({
      code: 'tied-sort-values',
      path: 'payload.items',
      severity: 'block',
      message: 'Duplicate sort_value: the correct order is ambiguous',
    });
  }

  items.forEach((item, index) => requireLocales(item.label, `payload.items[${index}].label`, issues));

  const ranked = [...items].sort((a, b) => Number(a.sort_value) - Number(b.sort_value));
  const locales = new Set<string>();
  for (const item of ranked) {
    if (isI18nObject(item.label)) for (const key of Object.keys(item.label)) locales.add(key);
  }
  for (const locale of locales) {
    for (const source of ['label', 'details'] as const) {
      const texts = ranked.map((item) => localeString(item[source], locale) ?? '');
      if (texts.some((text) => !text)) continue;
      const numbers = texts.map(firstNumber);
      if (numbers.some((n) => n === null)) continue;
      if (isStrictlyMonotonic(numbers as number[])) {
        issues.push({
          code: 'ordering-value-leak',
          path: `payload.items[*].${source}.${locale}`,
          // 3-item lists are monotonic by coincidence 1 time in 3 — too noisy to block
          severity: ranked.length >= 4 ? 'block' : 'review',
          message:
            `Visible numbers in every ${locale} ${source} sort exactly in answer order — ` +
            'the question solves itself by reading',
        });
        break;
      }
    }
  }
}

function normalizedSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAnswer(value);
    if (normalized) out.add(normalized);
  }
  return out;
}

function validateAcceptedAnswers(
  payload: Record<string, unknown>,
  issues: QuestionContentIssue[]
): void {
  const accepted = Array.isArray(payload.accepted_answers) ? payload.accepted_answers : [];
  const strings = accepted.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
  if (strings.length === 0) {
    issues.push({
      code: 'no-accepted-answers',
      path: 'payload.accepted_answers',
      severity: 'block',
      message: 'accepted_answers is empty',
    });
    return;
  }
  if (strings.length !== accepted.length) {
    issues.push({
      code: 'invalid-accepted-answer',
      path: 'payload.accepted_answers',
      severity: 'block',
      message: 'accepted_answers contains empty or non-string entries',
    });
  }

  const normalized = normalizedSet(strings);
  if (normalized.size < strings.length) {
    issues.push({
      code: 'duplicate-accepted-answers',
      path: 'payload.accepted_answers',
      severity: 'review',
      message: 'accepted_answers contains normalized duplicates',
    });
  }
  if (normalized.size < 3) {
    issues.push({
      code: 'thin-aliases',
      path: 'payload.accepted_answers',
      severity: 'review',
      message: 'Fewer than 3 distinct accepted answers — check surname/locale/nickname coverage',
    });
  }

  const display = payload.display_answer;
  for (const locale of REQUIRED_LOCALES) {
    const value = localeString(display, locale);
    if (!value || !value.trim()) {
      issues.push({
        code: 'missing-locale',
        path: `payload.display_answer.${locale}`,
        severity: 'block',
        message: `Missing or empty ${locale} display answer`,
      });
      continue;
    }
    if (!normalized.has(normalizeAnswer(value))) {
      issues.push({
        code: 'display-answer-not-accepted',
        path: `payload.display_answer.${locale}`,
        severity: 'block',
        message: `The ${locale} display answer is not in accepted_answers — a player typing the shown answer would be rejected`,
      });
    }
  }
}

function validateOptions(payload: Record<string, unknown>, issues: QuestionContentIssue[]): void {
  const options = Array.isArray(payload.options) ? payload.options : [];
  if (options.length < 2) {
    issues.push({
      code: 'too-few-options',
      path: 'payload.options',
      severity: 'block',
      message: `Question has ${options.length} options; needs at least 2`,
    });
    return;
  }
  const correct = options.filter((option) => (option as { is_correct?: unknown }).is_correct === true);
  if (correct.length === 0) {
    issues.push({
      code: 'no-correct-option',
      path: 'payload.options',
      severity: 'block',
      message: 'No option is marked correct',
    });
  }
  const byLocale = new Map<string, string[]>();
  options.forEach((option, index) => {
    const text = (option as { text?: unknown }).text;
    requireLocales(text, `payload.options[${index}].text`, issues);
    if (isI18nObject(text)) {
      for (const [locale, value] of Object.entries(text)) {
        if (typeof value === 'string' && value.trim()) {
          const bucket = byLocale.get(locale) ?? [];
          bucket.push(value);
          byLocale.set(locale, bucket);
        }
      }
    }
  });
  for (const [locale, texts] of byLocale) {
    if (normalizedSet(texts).size < texts.length) {
      issues.push({
        code: 'duplicate-options',
        path: `payload.options[*].text.${locale}`,
        severity: 'block',
        message: `Duplicate ${locale} option texts`,
      });
    }
  }
}

function validateCountdown(payload: Record<string, unknown>, issues: QuestionContentIssue[]): void {
  const groups = Array.isArray(payload.answer_groups) ? payload.answer_groups : [];
  if (groups.length === 0) {
    issues.push({
      code: 'no-answer-groups',
      path: 'payload.answer_groups',
      severity: 'block',
      message: 'Countdown question has no answer groups',
    });
    return;
  }
  groups.forEach((group, index) => {
    const g = group as { display?: unknown; accepted_answers?: unknown };
    requireLocales(g.display, `payload.answer_groups[${index}].display`, issues);
    const accepted = Array.isArray(g.accepted_answers)
      ? g.accepted_answers.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      : [];
    if (accepted.length === 0) {
      issues.push({
        code: 'no-accepted-answers',
        path: `payload.answer_groups[${index}].accepted_answers`,
        severity: 'block',
        message: 'Answer group has no accepted answers',
      });
      return;
    }
    const normalized = normalizedSet(accepted);
    for (const locale of REQUIRED_LOCALES) {
      const value = localeString(g.display, locale);
      if (value && value.trim() && !normalized.has(normalizeAnswer(value))) {
        issues.push({
          code: 'display-answer-not-accepted',
          path: `payload.answer_groups[${index}].display.${locale}`,
          severity: 'block',
          message: `Group ${locale} display value is not in its accepted_answers`,
        });
      }
    }
  });
}

function validateHighLow(payload: Record<string, unknown>, issues: QuestionContentIssue[]): void {
  const matchups = Array.isArray(payload.matchups) ? payload.matchups : [];
  if (matchups.length === 0) {
    issues.push({
      code: 'no-matchups',
      path: 'payload.matchups',
      severity: 'block',
      message: 'High/low question has no matchups',
    });
    return;
  }
  matchups.forEach((matchup, index) => {
    const m = matchup as { left_name?: unknown; right_name?: unknown; left_value?: unknown; right_value?: unknown };
    requireLocales(m.left_name, `payload.matchups[${index}].left_name`, issues);
    requireLocales(m.right_name, `payload.matchups[${index}].right_name`, issues);
    if (Number(m.left_value) === Number(m.right_value)) {
      issues.push({
        code: 'tied-matchup',
        path: `payload.matchups[${index}]`,
        severity: 'block',
        message: 'left_value equals right_value: no correct answer exists',
      });
    }
  });
}

function validateCareerClubs(payload: Record<string, unknown>, issues: QuestionContentIssue[]): void {
  const clubs = Array.isArray(payload.clubs) ? payload.clubs : [];
  if (clubs.length < 2) {
    issues.push({
      code: 'too-few-clubs',
      path: 'payload.clubs',
      severity: 'block',
      message: 'Career path needs at least 2 clubs',
    });
  }
  clubs.forEach((club, index) => requireLocales(club, `payload.clubs[${index}]`, issues));
}

function validateClueItems(payload: Record<string, unknown>, issues: QuestionContentIssue[]): void {
  const clues = Array.isArray(payload.clues) ? payload.clues : [];
  if (clues.length === 0) {
    issues.push({
      code: 'no-clues',
      path: 'payload.clues',
      severity: 'block',
      message: 'Clue question has no clues',
    });
  }
  clues.forEach((clue, index) => {
    requireLocales((clue as { content?: unknown }).content, `payload.clues[${index}].content`, issues);
  });
}

const OBSERVABLE_PROMPT_EN = /(what|which)\s+colou?r|how many (players|people|balls)/i;
const OBSERVABLE_PROMPT_KA = /რა ფერის|რომელი ფერის|რამდენი (მოთამაშე|ადამიანი|ბურთი)/;

export function validateQuestionContent(input: ValidateInput): QuestionContentIssue[] {
  const issues: QuestionContentIssue[] = [];

  collectCorruptedStrings(input.prompt, 'prompt', issues);
  collectCorruptedStrings(input.explanation ?? null, 'explanation', issues);
  collectCorruptedStrings(input.payload, 'payload', issues);

  requireLocales(input.prompt, 'prompt', issues);

  const promptEn = localeString(input.prompt, 'en') ?? '';
  const promptKa = localeString(input.prompt, 'ka') ?? '';
  if (OBSERVABLE_PROMPT_EN.test(promptEn) || OBSERVABLE_PROMPT_KA.test(promptKa)) {
    issues.push({
      code: 'observable-answer-prompt',
      path: 'prompt',
      severity: 'review',
      message: 'Prompt asks for a colour/count — check the answer is not trivially observable',
    });
  }

  let payloadCandidate = input.payload;
  if (typeof payloadCandidate === 'string') {
    try {
      payloadCandidate = JSON.parse(payloadCandidate);
    } catch {
      payloadCandidate = null;
    }
  }
  if (!isI18nObject(payloadCandidate)) {
    issues.push({
      code: 'missing-payload',
      path: 'payload',
      severity: 'block',
      message: 'Question has no payload object — it cannot be played',
    });
    return issues;
  }
  const payload = payloadCandidate;

  switch (input.type) {
    case 'put_in_order':
      validatePutInOrder(payload, issues);
      break;
    case 'countdown_list':
      validateCountdown(payload, issues);
      break;
    case 'high_low':
      validateHighLow(payload, issues);
      break;
    case 'mcq_single':
    case 'true_false':
    case 'imposter_multi_select':
      validateOptions(payload, issues);
      break;
    case 'input_text': {
      const answers = Array.isArray(payload.accepted_answers) ? payload.accepted_answers : [];
      if (answers.length === 0) {
        issues.push({
          code: 'no-accepted-answers',
          path: 'payload.accepted_answers',
          severity: 'block',
          message: 'Text-input question has no accepted answers',
        });
        break;
      }
      for (const locale of REQUIRED_LOCALES) {
        const covered = answers.some((answer) => {
          const value = localeString(answer, locale);
          return Boolean(value && value.trim());
        });
        if (!covered) {
          issues.push({
            code: 'missing-locale',
            path: `payload.accepted_answers[*].${locale}`,
            severity: 'block',
            message: `No accepted answer has a ${locale} value`,
          });
        }
      }
      break;
    }
    default:
      break;
  }

  if (TYPED_ANSWER_TYPES.has(input.type)) {
    validateAcceptedAnswers(payload, issues);
    if (input.type === 'career_path') validateCareerClubs(payload, issues);
    if (input.type === 'clue_chain') validateClueItems(payload, issues);
  }

  return issues;
}

export function blockingIssues(issues: QuestionContentIssue[]): QuestionContentIssue[] {
  return issues.filter((issue) => issue.severity === 'block');
}

export function formatIssues(issues: QuestionContentIssue[]): string {
  return issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ');
}
