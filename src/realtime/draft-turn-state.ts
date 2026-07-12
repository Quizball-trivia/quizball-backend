import { getRedisClient } from './redis.js';

const DRAFT_TURN_STATE_TTL_SEC = 600;

export interface DraftTurnState {
  firstActorUserId: string;
  nextActorUserId: string | null;
  aiUserId: string | null;
  participantUserIds: [string, string];
  banCount: number;
}

const localStates = new Map<string, DraftTurnState>();

function draftTurnStateKey(lobbyId: string): string {
  return `draft:turn_state:${lobbyId}`;
}

function parseDraftTurnState(value: string | null): DraftTurnState | null {
  if (!value) return null;
  try {
    const state = JSON.parse(value) as DraftTurnState;
    if (
      typeof state.firstActorUserId !== 'string'
      || (typeof state.nextActorUserId !== 'string' && state.nextActorUserId !== null)
      || (typeof state.aiUserId !== 'string' && state.aiUserId !== null)
      || !Array.isArray(state.participantUserIds)
      || state.participantUserIds.length !== 2
      || state.participantUserIds.some((id) => typeof id !== 'string')
      || !Number.isInteger(state.banCount)
    ) return null;
    return state;
  } catch {
    return null;
  }
}

export async function persistInitialDraftTurnState(
  lobbyId: string,
  state: DraftTurnState
): Promise<void> {
  localStates.set(lobbyId, state);
  const redis = getRedisClient();
  if (redis?.isOpen) {
    await redis.set(draftTurnStateKey(lobbyId), JSON.stringify(state), { EX: DRAFT_TURN_STATE_TTL_SEC });
  }
}

export async function readDraftTurnState(lobbyId: string): Promise<DraftTurnState | null> {
  const redis = getRedisClient();
  if (redis?.isOpen) {
    const persisted = parseDraftTurnState(await redis.get(draftTurnStateKey(lobbyId)));
    if (persisted) {
      localStates.set(lobbyId, persisted);
      return persisted;
    }
  }
  return localStates.get(lobbyId) ?? null;
}

const ADVANCE_DRAFT_TURN_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local state = cjson.decode(raw)
if state.nextActorUserId ~= ARGV[1] or state.banCount ~= tonumber(ARGV[2]) then return nil end
state.banCount = state.banCount + 1
if ARGV[3] == '' then
  state.nextActorUserId = cjson.null
else
  state.nextActorUserId = ARGV[3]
end
local updated = cjson.encode(state)
redis.call('SET', KEYS[1], updated, 'EX', ARGV[4])
return updated
`;

export async function advanceDraftTurnState(
  lobbyId: string,
  actorUserId: string,
  expectedBanCount: number
): Promise<DraftTurnState | null> {
  const current = await readDraftTurnState(lobbyId);
  if (
    !current
    || current.nextActorUserId !== actorUserId
    || current.banCount !== expectedBanCount
  ) return null;

  const nextActorUserId = expectedBanCount + 1 >= 2
    ? null
    : current.participantUserIds.find((userId) => userId !== actorUserId) ?? null;
  const redis = getRedisClient();
  const hasPersistedRedisState = redis?.isOpen
    ? parseDraftTurnState(await redis.get(draftTurnStateKey(lobbyId))) !== null
    : false;
  if (redis?.isOpen && hasPersistedRedisState && typeof redis.eval === 'function') {
    const raw = await redis.eval(ADVANCE_DRAFT_TURN_SCRIPT, {
      keys: [draftTurnStateKey(lobbyId)],
      arguments: [actorUserId, String(expectedBanCount), nextActorUserId ?? '', String(DRAFT_TURN_STATE_TTL_SEC)],
    });
    const advanced = parseDraftTurnState(typeof raw === 'string' ? raw : null);
    if (!advanced) return null;
    localStates.set(lobbyId, advanced);
    return advanced;
  }

  const advanced: DraftTurnState = {
    ...current,
    nextActorUserId,
    banCount: expectedBanCount + 1,
  };
  localStates.set(lobbyId, advanced);
  return advanced;
}

export function resetDraftTurnStateForTests(): void {
  localStates.clear();
}
