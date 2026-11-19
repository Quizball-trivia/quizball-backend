/**
 * Deploy readiness: work a new replica should finish before it takes traffic (Railway switches a deploy over once its
 * health check passes; the previous replicas serve until then). Liveness (/health) never waits on any of this.
 * A gate that never settles cannot hold a deploy back: past READINESS_CAP_MS of uptime the replica is ready anyway.
 */
export const READINESS_CAP_MS = 45_000;

const gates = new Map<string, () => boolean>();

export function registerReadinessGate(name: string, isReady: () => boolean): void {
  gates.set(name, isReady);
}

/** Gates must be cheap and synchronous; one that throws counts as pending (and the cap still applies). */
export function readinessState(uptimeMs: number): { ready: boolean; waiting: string[] } {
  if (uptimeMs >= READINESS_CAP_MS) return { ready: true, waiting: [] };
  const waiting = [...gates].filter(([, isReady]) => {
    try { return !isReady(); } catch { return true; }
  }).map(([name]) => name);
  return { ready: waiting.length === 0, waiting };
}

/** Tests only. */
export function resetReadinessGates(): void {
  gates.clear();
}
