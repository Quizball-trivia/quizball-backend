import type { StagingClient } from './staging-client.mjs';

export interface BotBehaviorOptions {
  legacyProtocol?: boolean;
  onDraftBanSent?: (payload: { categoryId: string; lobbyId?: string }) => void;
  onBeforeKickoffUiReady?: (payload: { matchId?: string; phase?: string }) => boolean;
  answerPlan?: (ctx: {
    client: StagingClient;
    question: QuestionPayload;
  }) => AnswerMode | BotAnswerInstruction | undefined;
}

export type AnswerMode = 'correct' | 'wrong';

export type BotAnswerInstruction = {
  mode?: AnswerMode;
  timeMs?: number;
  /** Wall-clock think time before emitting the answer (load-test realism). */
  delayMs?: number;
};

export type QuestionPayload = {
  matchId: string; qIndex: number; correctIndex?: number; playableAt?: string;
  phaseKind?: string; shooterSeat?: 1 | 2 | null;
  question?: { kind?: string; items?: Array<{ id: string }> };
};

export function autoAnswer(client: StagingClient, options: BotBehaviorOptions = {}): void {
  const completed = new Set<string>();
  let activeQuestion: QuestionPayload | null = null;
  const keyFor = (matchId: string, qIndex: number) => `${matchId}:${qIndex}`;

  const sendAnswer = (q: QuestionPayload, retryDelayMs = 50) => {
    const key = keyFor(q.matchId, q.qIndex);
    if (completed.has(key)) return;
    const waitMs = q.playableAt ? Math.max(0, new Date(q.playableAt).getTime() - Date.now()) : 0;
    const planned = options.answerPlan?.({ client, question: q });
    const delayMs = typeof planned === 'object' && typeof planned.delayMs === 'number'
      ? Math.max(0, planned.delayMs)
      : 0;
    setTimeout(() => {
      if (completed.has(key)) return;
      const kind = q.question?.kind ?? 'multipleChoice';
      const base = { matchId: q.matchId, qIndex: q.qIndex };
      const mode = typeof planned === 'string' ? planned : planned?.mode ?? 'correct';
      const timeMs = typeof planned === 'object' && typeof planned.timeMs === 'number' ? planned.timeMs : 500;
      if (kind === 'countdown') {
        client.socket.emit('match:countdown_guess', { ...base, guess: mode === 'wrong' ? 'zzzznotananswer' : 'one' });
      } else if (kind === 'putInOrder') {
        const orderedItemIds = (q.question?.items ?? []).map((i) => i.id);
        client.socket.emit('match:put_in_order_answer', {
          ...base,
          orderedItemIds: mode === 'wrong' ? [...orderedItemIds].reverse() : orderedItemIds,
          timeMs,
        });
      } else if (kind === 'clues') {
        client.socket.emit('match:clues_answer', { kind: 'guess', ...base, guess: mode === 'wrong' ? 'zzzznotananswer' : 'answer', timeMs });
      } else {
        const correct = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
        client.socket.emit('match:answer', {
          ...base,
          selectedIndex: mode === 'wrong' ? (correct === 0 ? 1 : 0) : correct,
          timeMs,
        });
      }
    }, waitMs + retryDelayMs + delayMs);
  };

  client.socket.on('match:question', (q: QuestionPayload) => {
    activeQuestion = q;
    sendAnswer(q);
  });

  client.socket.on('match:answer_ack', (ack: { matchId?: string; qIndex?: number }) => {
    if (ack.matchId && typeof ack.qIndex === 'number') completed.add(keyFor(ack.matchId, ack.qIndex));
  });
  client.socket.on('match:round_result', (result: { matchId?: string; qIndex?: number }) => {
    if (result.matchId && typeof result.qIndex === 'number') {
      completed.add(keyFor(result.matchId, result.qIndex));
      client.socket.emit('match:ready_for_next_question', {
        matchId: result.matchId,
        qIndex: result.qIndex,
      });
    }
  });
  client.socket.on('match:resume', () => {
    if (activeQuestion) sendAnswer(activeQuestion, 250);
  });
  client.socket.on('connect', () => {
    if (activeQuestion) sendAnswer(activeQuestion, 250);
  });
}

export function autoRecover(client: StagingClient, options: BotBehaviorOptions = {}): void {
  client.socket.on('match:rejoin_available', (p: { matchId?: string }) => {
    client.socket.emit('match:rejoin', p?.matchId ? { matchId: p.matchId } : {});
  });
  // Mid-draft reconnect: the web client re-enters the lobby via draft:rejoin
  // before acting; without it any post-reconnect draft:ban gets NOT_IN_LOBBY.
  let inDraft = false;
  let draftLobbyId: string | undefined;
  client.socket.on('draft:start', (state: { lobbyId?: string }) => {
    inDraft = true;
    draftLobbyId = state?.lobbyId;
  });
  client.socket.on('draft:complete', () => { inDraft = false; });
  client.socket.on('match:start', () => { inDraft = false; });
  client.socket.on('connect', () => {
    if (inDraft) client.socket.emit('draft:rejoin', draftLobbyId ? { lobbyId: draftLobbyId } : {});
  });
  client.socket.on('match:waiting_for_ready', (p: { matchId?: string; phase?: string }) => {
    if (!p?.matchId) return;
    if (options.legacyProtocol) return;
    if (p.phase === 'resume') client.socket.emit('match:resume_ui_ready', { matchId: p.matchId });
    else if (p.phase === 'kickoff') {
      if (options.onBeforeKickoffUiReady?.(p)) return;
      client.socket.emit('match:kickoff_ui_ready', { matchId: p.matchId });
    }
  });
}

export function autoHalftime(client: StagingClient): void {
  const uiReady = new Set<string>();
  const bansSent = new Set<string>();
  client.socket.on('match:state', (s: {
    matchId?: string;
    phase?: string;
    halftime?: {
      deadlineAt?: string | null;
      categoryOptions?: Array<{ id: string }>;
      firstBanSeat?: 1 | 2 | null;
      bans?: { seat1?: string | null; seat2?: string | null };
    };
  }) => {
    if (s.phase !== 'HALFTIME' || !s.matchId) return;
    const opts = s.halftime?.categoryOptions ?? [];
    const optionKey = opts.map((o) => o.id).join(',');
    const readyKey = `${s.matchId}:${s.halftime?.deadlineAt ?? 'no-deadline'}:${optionKey}`;
    if (!uiReady.has(readyKey)) {
      uiReady.add(readyKey);
      client.socket.emit('match:halftime_ui_ready', { matchId: s.matchId });
    }
    const mySeat = client.latest<{ mySeat?: number }>('match:start')?.mySeat;
    if (mySeat !== 1 && mySeat !== 2) return;
    const firstBanSeat = s.halftime?.firstBanSeat ?? 1;
    const secondBanSeat: 1 | 2 = firstBanSeat === 1 ? 2 : 1;
    const bans = s.halftime?.bans ?? {};
    const firstKey = firstBanSeat === 1 ? 'seat1' : 'seat2';
    const secondKey = secondBanSeat === 1 ? 'seat1' : 'seat2';
    const turnSeat: 1 | 2 | null = !bans[firstKey]
      ? firstBanSeat
      : !bans[secondKey]
        ? secondBanSeat
        : null;
    if (turnSeat !== mySeat) return;
    const banned = new Set([bans.seat1, bans.seat2].filter((id): id is string => typeof id === 'string'));
    const category = opts.find((option) => !banned.has(option.id));
    if (!category) return;
    const banKey = `${s.matchId}:${mySeat}:${category.id}:${optionKey}`;
    if (bansSent.has(banKey)) return;
    bansSent.add(banKey);
    setTimeout(() => client.socket.emit('match:halftime_ban', { matchId: s.matchId!, categoryId: category.id }), 300);
  });
}

export function autoDraft(client: StagingClient, options: BotBehaviorOptions = {}): void {
  let banCount = 0;
  let draftLobbyId: string | undefined;
  let lastAttemptedBanId: string | null = null;
  let retryArmed = false;
  const emitBan = (categoryId: string) => {
    lastAttemptedBanId = categoryId;
    const payload = { categoryId, ...(draftLobbyId ? { lobbyId: draftLobbyId } : {}) };
    client.socket.emit('draft:ban', payload);
    options.onDraftBanSent?.(payload);
  };
  const bannedCategoryIds = new Set<string>();
  client.socket.on('draft:start', (state: { lobbyId?: string; categories: Array<{ id: string }>; turnUserId: string }) => {
    banCount = 0;
    draftLobbyId = state.lobbyId;
    bannedCategoryIds.clear();
    if (!options.legacyProtocol) {
      client.socket.emit('draft:ui_ready', { ...(state.lobbyId ? { lobbyId: state.lobbyId } : {}), banCount });
    }
    if (state.turnUserId === client.userId && state.categories[0]) {
      bannedCategoryIds.add(state.categories[0].id);
      emitBan(state.categories[0].id);
    }
  });
  client.socket.on('draft:banned', (banned: { actorId?: string; categoryId?: string } | undefined) => {
    const state = client.latest<{ lobbyId?: string; categories: Array<{ id: string }>; turnUserId: string }>('draft:start');
    banCount = Math.min(banCount + 1, 2);
    if (banned?.categoryId) {
      bannedCategoryIds.add(banned.categoryId);
      if (banned.categoryId === lastAttemptedBanId) lastAttemptedBanId = null;
    }
    if (!options.legacyProtocol && banCount < 2) {
      client.socket.emit('draft:ui_ready', { ...(state?.lobbyId ? { lobbyId: state.lobbyId } : {}), banCount });
    }
    // After a ban, the other member owns the next turn. `draft:start.turnUserId`
    // is only the initial actor and must not be reused for every subsequent
    // event (doing that made the bot emit extra bans after the lobby closed).
    if (banCount < 2 && state && banned?.actorId && banned.actorId !== client.userId) {
      const next = state.categories.find((c) => !bannedCategoryIds.has(c.id));
      if (next) {
        bannedCategoryIds.add(next.id);
        emitBan(next.id);
      }
    }
  });
  // A ban sent while the draft is paused (our own reconnect racing the resume)
  // is rejected with DRAFT_PAUSED — retry it once the server resumes the draft.
  client.socket.on('error', (err: { code?: string } | undefined) => {
    if (err?.code !== 'DRAFT_PAUSED' || !lastAttemptedBanId || retryArmed) return;
    retryArmed = true;
    const retry = () => {
      retryArmed = false;
      if (lastAttemptedBanId) emitBan(lastAttemptedBanId);
    };
    client.socket.once('draft:resume', retry);
    setTimeout(() => {
      if (!retryArmed) return;
      client.socket.off('draft:resume', retry);
      retry();
    }, 4_000);
  });
}
