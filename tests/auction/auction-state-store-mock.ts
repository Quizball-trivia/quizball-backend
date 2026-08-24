import type { Mock } from 'vitest';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';

interface AuctionStateStoreMock {
  load: Mock;
  save: Mock;
  mutate: Mock;
}

interface MutationOptions {
  now?: Date | (() => Date);
  onMissingState?: () => unknown;
}

type MutationResult =
  | AuctionMatchState
  | {
    kind: 'save';
    state: AuctionMatchState;
    map: (saved: AuctionMatchState) => unknown;
  }
  | {
    kind: 'skip';
    result: unknown;
  };

export function installAuctionStateStoreMutationMock(store: AuctionStateStoreMock): void {
  store.mutate.mockImplementation(async (
    matchId: string,
    mutator: (current: AuctionMatchState) => MutationResult | Promise<MutationResult>,
    options: MutationOptions = {}
  ) => {
    const current = await store.load(matchId) as AuctionMatchState | null;
    if (!current) {
      if (options.onMissingState) return options.onMissingState();
      throw new Error(`Auction match state not found: ${matchId}`);
    }

    const mutation = await mutator(current);
    if (isSkipMutation(mutation)) return mutation.result;

    const nextState = isSaveMutation(mutation) ? mutation.state : mutation;
    const now = typeof options.now === 'function' ? options.now() : options.now;
    const saved = await store.save({
      ...nextState,
      version: current.version + 1,
    }, {
      expectedVersion: current.version,
      now,
    }) as AuctionMatchState;

    return isSaveMutation(mutation) ? mutation.map(saved) : saved;
  });
}

function isSaveMutation(
  mutation: MutationResult
): mutation is Extract<MutationResult, { kind: 'save' }> {
  return (
    typeof mutation === 'object'
    && mutation !== null
    && 'kind' in mutation
    && mutation.kind === 'save'
  );
}

function isSkipMutation(
  mutation: MutationResult
): mutation is Extract<MutationResult, { kind: 'skip' }> {
  return (
    typeof mutation === 'object'
    && mutation !== null
    && 'kind' in mutation
    && mutation.kind === 'skip'
  );
}
