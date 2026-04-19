type ReadyGate<Token> = {
  token: Token;
  waitingUserIds: Set<string>;
  timeoutId: ReturnType<typeof setTimeout>;
  dispatch: () => void;
};

export function createReadyGateRegistry<Token>() {
  const pendingReadyGates = new Map<string, ReadyGate<Token>>();

  function clear(scopeId: string): void {
    const gate = pendingReadyGates.get(scopeId);
    if (!gate) return;
    clearTimeout(gate.timeoutId);
    pendingReadyGates.delete(scopeId);
  }

  function acknowledge(userId: string, scopeId: string, token: Token): boolean {
    const gate = pendingReadyGates.get(scopeId);
    if (!gate || gate.token !== token) return false;
    if (!gate.waitingUserIds.delete(userId)) return false;
    if (gate.waitingUserIds.size === 0) {
      clearTimeout(gate.timeoutId);
      pendingReadyGates.delete(scopeId);
      gate.dispatch();
    }
    return true;
  }

  function open(params: {
    scopeId: string;
    token: Token;
    waitingUserIds: Iterable<string>;
    ceilingMs: number;
    dispatch: () => void;
    onTimeout?: (missingUserIds: string[]) => void;
  }): void {
    clear(params.scopeId);

    const waitingUserIds = new Set(params.waitingUserIds);
    if (waitingUserIds.size === 0) {
      setTimeout(() => params.dispatch(), 0);
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingReadyGates.delete(params.scopeId);
      params.onTimeout?.([...waitingUserIds]);
      params.dispatch();
    }, params.ceilingMs);

    pendingReadyGates.set(params.scopeId, {
      token: params.token,
      waitingUserIds,
      timeoutId,
      dispatch: params.dispatch,
    });
  }

  return {
    clear,
    acknowledge,
    open,
  };
}
