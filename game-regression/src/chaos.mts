import type { BotAnswerPlan } from './runner.mjs';

export type ChaosActionKind =
  | 'flap'
  | 'staleDisconnect'
  | 'quitRejoin'
  | 'multiTab'
  | 'zombieReconnect'
  | 'expireGraceAfterDisconnect'
  | 'flapAtKickoffGate'
  | 'engineRestart'
  | 'duplicateEmits'
  | 'withholdReadyAcks'
  | 'timingSkew';

export type ChaosPhaseTarget = 'halftime' | 'clue_chain' | 'countdown' | 'put_in_order' | 'penalty';

export interface ChaosAction {
  atQIndex?: number;
  atPhase?: ChaosPhaseTarget;
  kind: ChaosActionKind;
  params?: Record<string, unknown>;
}

export interface ChaosPlan {
  seed: number;
  actions: ChaosAction[];
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveChaosSeed(runTag: string, matchIndex: number, baseSeed?: string): number {
  const input = `${baseSeed && baseSeed.length > 0 ? baseSeed : runTag}:${matchIndex}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function weighted<T extends string>(rng: () => number, entries: Array<{ value: T; weight: number }>): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let pick = rng() * total;
  for (const entry of entries) {
    pick -= entry.weight;
    if (pick <= 0) return entry.value;
  }
  return entries[entries.length - 1]!.value;
}

function actionCount(rng: () => number): number {
  const roll = rng();
  if (roll < 0.20) return 0;
  if (roll < 0.58) return 1;
  if (roll < 0.88) return 2;
  return 3;
}

function randomQIndex(rng: () => number): number {
  return Math.floor(rng() * 8) + 1;
}

function randomFlapCount(rng: () => number): number {
  const roll = rng();
  if (roll < 0.70) return 1;
  if (roll < 0.90) return 2;
  return 3;
}

function timingSkewParams(rng: () => number): Record<string, unknown> {
  const cases = [
    { emitRevealAckAtMs: 100, answerAtMs: 850, timeMs: 750 },
    { emitRevealAckAtMs: 1000, answerAtMs: 1800, timeMs: 800 },
    { emitRevealAckAtMs: -400, answerAtMs: 250, timeMs: 250 },
    { answerAtMs: -900, timeMs: 1400 },
    { answerAtMs: 4100, timeMs: 900 },
  ];
  return cases[Math.floor(rng() * cases.length)]!;
}

function kickoffGateFlapParams(rng: () => number): Record<string, unknown> {
  return {
    reconnectDelayMs: Math.floor(3000 + rng() * 5000),
    mode: rng() < 0.5 ? 'blind' : 'recover',
  };
}

function randomPhaseTarget(rng: () => number): ChaosPhaseTarget {
  const phases: ChaosPhaseTarget[] = ['halftime', 'clue_chain', 'countdown', 'put_in_order', 'penalty'];
  return phases[Math.floor(rng() * phases.length)]!;
}

export function generateChaosPlan(seed: number): ChaosPlan {
  const rng = mulberry32(seed);
  const count = actionCount(rng);
  const actions: ChaosAction[] = [];
  let hasKickoffGateFlap = false;
  for (let i = 0; i < count; i += 1) {
    let kind = weighted(rng, [
      { value: 'flap', weight: 26 },
      { value: 'staleDisconnect', weight: 20 },
      { value: 'timingSkew', weight: 18 },
      { value: 'multiTab', weight: 12 },
      { value: 'quitRejoin', weight: 10 },
      { value: 'flapAtKickoffGate', weight: 8 },
      { value: 'expireGraceAfterDisconnect', weight: 6 },
      { value: 'zombieReconnect', weight: 5 },
      { value: 'duplicateEmits', weight: 5 },
      { value: 'engineRestart', weight: 3 },
      { value: 'withholdReadyAcks', weight: 3 },
    ]);
    if (kind === 'flapAtKickoffGate' && hasKickoffGateFlap) kind = 'flap';
    if (kind === 'flapAtKickoffGate') hasKickoffGateFlap = true;
    const params =
      kind === 'flap'
        ? { n: randomFlapCount(rng) }
        : kind === 'timingSkew'
          ? timingSkewParams(rng)
          : kind === 'flapAtKickoffGate'
            ? kickoffGateFlapParams(rng)
          : undefined;
    const phaseTarget =
      kind !== 'flapAtKickoffGate' &&
      (kind === 'engineRestart' || kind === 'duplicateEmits' || kind === 'flap' || kind === 'quitRejoin') &&
      rng() < 0.25
        ? randomPhaseTarget(rng)
        : null;
    actions.push({
      ...(phaseTarget ? { atPhase: phaseTarget } : { atQIndex: kind === 'flapAtKickoffGate' ? 0 : randomQIndex(rng) }),
      kind,
      ...(params ? { params } : {}),
    });
  }
  actions.sort((a, b) => (a.atQIndex ?? 99) - (b.atQIndex ?? 99) || (a.atPhase ?? '').localeCompare(b.atPhase ?? '') || a.kind.localeCompare(b.kind));
  return { seed: seed >>> 0, actions };
}

export function planUsesWithheldReadyAcks(plan: ChaosPlan | null | undefined): boolean {
  return Boolean(plan?.actions.some((action) => action.kind === 'withholdReadyAcks'));
}

export function planAllowsEarlyTerminal(plan: ChaosPlan | null | undefined): boolean {
  // withholdReadyAcks: a permanently silent client can legitimately end the
  // match abandoned when a later rejoin's resume gate never completes
  // (see CHAOS-FINDINGS.md Finding 3 on abandon-vs-progress attribution).
  return Boolean(plan?.actions.some((action) =>
      action.kind === 'zombieReconnect' ||
      action.kind === 'expireGraceAfterDisconnect' ||
      action.kind === 'engineRestart' ||
      action.kind === 'withholdReadyAcks'
  ));
}

export function answerPlanFromChaosPlan(plan: ChaosPlan | null | undefined): Record<number, BotAnswerPlan> {
  const answerPlan: Record<number, BotAnswerPlan> = {};
  for (const action of plan?.actions ?? []) {
    if (action.kind !== 'timingSkew') continue;
    if (typeof action.atQIndex !== 'number') continue;
    const params = action.params ?? {};
    answerPlan[action.atQIndex] = {
      ...(typeof params.mode === 'string' && (params.mode === 'correct' || params.mode === 'wrong')
        ? { mode: params.mode }
        : {}),
      ...(typeof params.timeMs === 'number' ? { timeMs: params.timeMs } : {}),
      ...(typeof params.emitRevealAckAtMs === 'number' ? { emitRevealAckAtMs: params.emitRevealAckAtMs } : {}),
      ...(typeof params.answerAtMs === 'number' ? { answerAtMs: params.answerAtMs } : {}),
    };
  }
  return answerPlan;
}

export function realDisconnectEpisodesForPlan(plan: ChaosPlan | null | undefined): number {
  let count = 0;
  for (const action of plan?.actions ?? []) {
    if (action.kind === 'flap') {
      count += Math.max(1, Math.floor(Number(action.params?.n ?? 1) || 1));
    } else if (
      action.kind === 'multiTab' ||
      action.kind === 'quitRejoin' ||
      action.kind === 'zombieReconnect' ||
      action.kind === 'expireGraceAfterDisconnect' ||
      action.kind === 'flapAtKickoffGate' ||
      action.kind === 'engineRestart'
    ) {
      count += 1;
    }
  }
  return count;
}

export function chaosActionsSummary(plan: ChaosPlan | null | undefined): string {
  if (!plan || plan.actions.length === 0) return 'none';
  return plan.actions
    .map((action) => {
      if (action.kind === 'flapAtKickoffGate') {
        return `boot:flapAtKickoffGate(${Number(action.params?.reconnectDelayMs ?? 0)}ms)`;
      }
      const target = action.atPhase ? `phase:${action.atPhase}` : `q${action.atQIndex ?? '?'}`;
      if (action.kind === 'flap') return `${target}:flap(${Number(action.params?.n ?? 1)})`;
      if (action.kind === 'timingSkew') return `${target}:timingSkew`;
      return `${target}:${action.kind}`;
    })
    .join(',');
}
