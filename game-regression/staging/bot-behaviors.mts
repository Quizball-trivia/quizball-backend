import type { StagingClient } from './staging-client.mjs';

export function autoAnswer(client: StagingClient): void {
  type QuestionPayload = {
    matchId: string; qIndex: number; correctIndex?: number; playableAt?: string;
    question?: { kind?: string; items?: Array<{ id: string }> };
  };

  const completed = new Set<string>();
  let activeQuestion: QuestionPayload | null = null;
  const keyFor = (matchId: string, qIndex: number) => `${matchId}:${qIndex}`;

  const sendAnswer = (q: QuestionPayload, retryDelayMs = 50) => {
    const key = keyFor(q.matchId, q.qIndex);
    if (completed.has(key)) return;
    const waitMs = q.playableAt ? Math.max(0, new Date(q.playableAt).getTime() - Date.now()) : 0;
    setTimeout(() => {
      if (completed.has(key)) return;
      const kind = q.question?.kind ?? 'multipleChoice';
      const base = { matchId: q.matchId, qIndex: q.qIndex };
      if (kind === 'countdown') {
        client.socket.emit('match:countdown_guess', { ...base, guess: 'one' });
      } else if (kind === 'putInOrder') {
        const orderedItemIds = (q.question?.items ?? []).map((i) => i.id);
        client.socket.emit('match:put_in_order_answer', { ...base, orderedItemIds, timeMs: 500 });
      } else if (kind === 'clues') {
        client.socket.emit('match:clues_answer', { kind: 'guess', ...base, guess: 'answer' });
      } else {
        client.socket.emit('match:answer', {
          ...base, selectedIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0, timeMs: 500,
        });
      }
    }, waitMs + retryDelayMs);
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

export function autoRecover(client: StagingClient): void {
  client.socket.on('match:rejoin_available', (p: { matchId?: string }) => {
    client.socket.emit('match:rejoin', p?.matchId ? { matchId: p.matchId } : {});
  });
  client.socket.on('match:waiting_for_ready', (p: { matchId?: string; phase?: string }) => {
    if (!p?.matchId) return;
    if (p.phase === 'resume') client.socket.emit('match:resume_ui_ready', { matchId: p.matchId });
    else if (p.phase === 'kickoff') client.socket.emit('match:kickoff_ui_ready', { matchId: p.matchId });
  });
}

export function autoHalftime(client: StagingClient): void {
  const handled = new Set<string>();
  client.socket.on('match:state', (s: { matchId?: string; phase?: string; halftime?: { categoryOptions?: Array<{ id: string }> } }) => {
    if (s.phase !== 'HALFTIME' || !s.matchId) return;
    const opts = s.halftime?.categoryOptions ?? [];
    const key = `${s.matchId}:${opts.map((o) => o.id).join(',')}`;
    if (handled.has(key)) return;
    handled.add(key);
    client.socket.emit('match:halftime_ui_ready', { matchId: s.matchId });
    if (opts[0]) {
      setTimeout(() => client.socket.emit('match:halftime_ban', { matchId: s.matchId!, categoryId: opts[0].id }), 300);
    }
  });
}

export function autoDraft(client: StagingClient): void {
  let banCount = 0;
  client.socket.on('draft:start', (state: { lobbyId?: string; categories: Array<{ id: string }>; turnUserId: string }) => {
    banCount = 0;
    client.socket.emit('draft:ui_ready', { ...(state.lobbyId ? { lobbyId: state.lobbyId } : {}), banCount });
    if (state.turnUserId === client.userId && state.categories[0]) {
      client.socket.emit('draft:ban', { categoryId: state.categories[0].id });
    }
  });
  client.socket.on('draft:banned', () => {
    const state = client.latest<{ lobbyId?: string; categories: Array<{ id: string }>; turnUserId: string }>('draft:start');
    banCount = Math.min(banCount + 1, 2);
    client.socket.emit('draft:ui_ready', { ...(state?.lobbyId ? { lobbyId: state.lobbyId } : {}), banCount });
    if (state && state.turnUserId === client.userId) {
      const next = state.categories.find((c) => c.id);
      if (next) client.socket.emit('draft:ban', { categoryId: next.id });
    }
  });
}
