import { createClient, type RedisClientType } from 'redis';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

let commandClient: RedisClientType | null = null;
let pubClient: RedisClientType | null = null;
let subClient: RedisClientType | null = null;
let adapterSubClient: RedisClientType | null = null;

type TrackedSubscription = {
  method: 'subscribe' | 'pSubscribe';
  channels: string | string[];
  listener: Parameters<RedisClientType['subscribe']>[1];
  bufferMode: boolean | undefined;
};

const trackedSubClientSubscriptions: TrackedSubscription[] = [];

// Named error handlers for Redis clients
const handleCommandError = (err: Error) => {
  logger.error({ err, client: 'command' }, 'Redis command client error');
};

const handlePubError = (err: Error) => {
  logger.error({ err, client: 'pub' }, 'Redis pub client error');
};

const handleSubError = (err: Error) => {
  logger.error({ err, client: 'sub' }, 'Redis sub client error');
};

const CONNECT_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_STEP_MS = 200;
const RECONNECT_BACKOFF_CAP_MS = 5_000;

// node-redis v4's built-in reconnect only fires on a socket 'error'/'close'
// event. A silently-dead TCP connection (e.g. a network middlebox dropping the
// flow after a Railway incident, 2026-07-02) emits neither: writes just buffer
// against the dead socket until the OS retransmission timer gives up ~16 min
// later. The watchdog below actively probes with PING and force-recycles the
// socket ourselves — the piece v4 does not do for us.
const WATCHDOG_INTERVAL_MS = 10_000;
const WATCHDOG_PING_TIMEOUT_MS = 8_000;
const WATCHDOG_MAX_STALLED_ROUNDS = 2;

const socketOptions = {
  connectTimeout: CONNECT_TIMEOUT_MS,
  keepAlive: KEEP_ALIVE_MS,
  reconnectStrategy: (retries: number) =>
    Math.min(retries * RECONNECT_BACKOFF_STEP_MS, RECONNECT_BACKOFF_CAP_MS),
};

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTickInFlight = false;
let stalledRounds = 0;
let watchdogGeneration = 0;

export async function initRedisClients(): Promise<{
  pubClient: RedisClientType;
  subClient: RedisClientType;
}> {
  if (!config.REDIS_URL) {
    throw new Error('REDIS_URL is required for realtime features');
  }

  if (!commandClient) {
    commandClient = createClient({
      url: config.REDIS_URL,
      socket: socketOptions,
      pingInterval: PING_INTERVAL_MS,
    });
  }
  if (!pubClient) {
    pubClient = createClient({
      url: config.REDIS_URL,
      socket: socketOptions,
      pingInterval: PING_INTERVAL_MS,
    });
  }
  if (!subClient) {
    subClient = pubClient.duplicate();
    adapterSubClient = trackSubClientSubscriptions(subClient);
  }

  // Attach error handlers (remove specific handler first to avoid duplicates on re-init)
  commandClient.removeListener('error', handleCommandError);
  commandClient.on('error', handleCommandError);

  pubClient.removeListener('error', handlePubError);
  pubClient.on('error', handlePubError);

  subClient.removeListener('error', handleSubError);
  subClient.on('error', handleSubError);

  const toConnect = [commandClient, pubClient, subClient].filter(
    (client) => !client.isOpen
  );

  await Promise.all(toConnect.map((client) => client.connect()));

  logger.info('Redis clients connected');

  startWatchdog();

  return { pubClient, subClient: adapterSubClient ?? subClient };
}

export function getRedisClient(): RedisClientType | null {
  return commandClient;
}

export async function closeRedisClients(): Promise<void> {
  stopWatchdog();

  const clients = [commandClient, pubClient, subClient].filter(
    (client): client is RedisClientType => !!client && client.isOpen
  );

  if (clients.length === 0) {
    commandClient = null;
    pubClient = null;
    subClient = null;
    adapterSubClient = null;
    trackedSubClientSubscriptions.length = 0;
    return;
  }

  const results = await Promise.allSettled(clients.map((client) => client.quit()));

  // Log any quit failures but continue with cleanup
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(
        { err: result.reason, clientIndex: index },
        'Redis client quit failed'
      );
    }
  });

  commandClient = null;
  pubClient = null;
  subClient = null;
  adapterSubClient = null;
  trackedSubClientSubscriptions.length = 0;

  logger.info('Redis clients disconnected');
}

type NamedClient = { name: string; client: RedisClientType };

function watchdogClients(): NamedClient[] {
  const named: NamedClient[] = [];
  if (commandClient) named.push({ name: 'command', client: commandClient });
  if (pubClient) named.push({ name: 'pub', client: pubClient });
  if (subClient) named.push({ name: 'sub', client: subClient });
  return named;
}

function startWatchdog(): void {
  if (watchdogTimer) return;
  const generation = watchdogGeneration;
  stalledRounds = 0;
  watchdogTickInFlight = false;
  watchdogTimer = setInterval(() => {
    void runWatchdogTick(watchdogClients(), { generation });
  }, WATCHDOG_INTERVAL_MS);
  // Don't let the watchdog keep the event loop alive on its own.
  watchdogTimer.unref?.();
}

function stopWatchdog(): void {
  watchdogGeneration += 1;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  watchdogTickInFlight = false;
  stalledRounds = 0;
}

function pingWithTimeout(client: RedisClientType, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('redis ping timed out'));
    }, timeoutMs);

    Promise.resolve()
      .then(() => client.ping())
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
  });
}

function trackSubClientSubscriptions(client: RedisClientType): RedisClientType {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'subscribe' || property === 'pSubscribe') {
        const subscribe = property === 'subscribe'
          ? target.subscribe.bind(target)
          : target.pSubscribe.bind(target);
        return (
          channels: string | string[],
          listener: TrackedSubscription['listener'],
          bufferMode?: boolean
        ) => {
          trackedSubClientSubscriptions.push({
            method: property,
            channels: Array.isArray(channels) ? [...channels] : channels,
            listener,
            bufferMode,
          });
          return subscribe(channels, listener as never, bufferMode as never);
        };
      }

      if (property === 'unsubscribe' || property === 'pUnsubscribe') {
        const unsubscribe = property === 'unsubscribe'
          ? target.unsubscribe.bind(target)
          : target.pUnsubscribe.bind(target);
        const method = property === 'unsubscribe' ? 'subscribe' : 'pSubscribe';
        return async (
          channels?: string | string[],
          listener?: TrackedSubscription['listener'],
          bufferMode?: boolean
        ) => {
          await unsubscribe(channels, listener as never, bufferMode as never);
          removeTrackedSubClientSubscriptions(method, channels, listener, bufferMode);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RedisClientType;
}

function removeTrackedSubClientSubscriptions(
  method: TrackedSubscription['method'],
  channels?: string | string[],
  listener?: TrackedSubscription['listener'],
  bufferMode?: boolean
): void {
  if (!channels) {
    for (let index = trackedSubClientSubscriptions.length - 1; index >= 0; index -= 1) {
      if (trackedSubClientSubscriptions[index].method === method) {
        trackedSubClientSubscriptions.splice(index, 1);
      }
    }
    return;
  }

  const removedChannels = new Set(Array.isArray(channels) ? channels : [channels]);
  for (let index = trackedSubClientSubscriptions.length - 1; index >= 0; index -= 1) {
    const subscription = trackedSubClientSubscriptions[index];
    if (
      subscription.method !== method
      || (listener && subscription.listener !== listener)
      || (bufferMode !== undefined && subscription.bufferMode !== bufferMode)
    ) {
      continue;
    }

    const remainingChannels = (Array.isArray(subscription.channels)
      ? subscription.channels
      : [subscription.channels]
    ).filter((channel) => !removedChannels.has(channel));

    if (remainingChannels.length === 0) {
      trackedSubClientSubscriptions.splice(index, 1);
    } else {
      subscription.channels = remainingChannels.length === 1
        ? remainingChannels[0]
        : remainingChannels;
    }
  }
}

async function restoreSubClientSubscriptions(client: RedisClientType): Promise<void> {
  for (const subscription of trackedSubClientSubscriptions) {
    const unsubscribe = subscription.method === 'subscribe'
      ? client.unsubscribe.bind(client)
      : client.pUnsubscribe.bind(client);
    const subscribe = subscription.method === 'subscribe'
      ? client.subscribe.bind(client)
      : client.pSubscribe.bind(client);

    await unsubscribe(
      subscription.channels,
      subscription.listener as never,
      subscription.bufferMode as never
    );
    await subscribe(
      subscription.channels,
      subscription.listener as never,
      subscription.bufferMode as never
    );
  }
}

// Force a full reconnect cycle on a client whose socket is (probably) silently
// dead. v4's disconnect() tears the socket down immediately with socket.destroy()
// and flushes the command queue WITHOUT sending a QUIT (which would itself hang
// on a dead socket); connect() then re-establishes. This is the recycle v4's
// own reconnectStrategy never triggers for a stalled-but-not-closed connection.
async function forceReconnect(named: NamedClient): Promise<void> {
  const { name, client } = named;
  try {
    if (client.isOpen) {
      await client.disconnect();
    }
  } catch (err) {
    logger.error({ err, client: name }, 'Redis watchdog disconnect failed');
  }
  await client.connect();
  if (name === 'sub') {
    await restoreSubClientSubscriptions(client);
  }
}

export async function runWatchdogTick(
  clients: NamedClient[],
  options: {
    pingTimeoutMs?: number;
    maxStalledRounds?: number;
    onFatal?: () => void;
    generation?: number;
  } = {}
): Promise<void> {
  const generation = options.generation ?? watchdogGeneration;
  const shouldContinue = () => generation === watchdogGeneration;
  if (!shouldContinue()) return;
  if (watchdogTickInFlight) return;
  watchdogTickInFlight = true;

  const pingTimeoutMs = options.pingTimeoutMs ?? WATCHDOG_PING_TIMEOUT_MS;
  const maxStalledRounds = options.maxStalledRounds ?? WATCHDOG_MAX_STALLED_ROUNDS;
  const onFatal = options.onFatal ?? (() => process.exit(1));

  try {
    const results = await Promise.allSettled(
      clients.map((named) => pingWithTimeout(named.client, pingTimeoutMs))
    );

    const stalled = results
      .map((result, index) => ({ result, named: clients[index]! }))
      .filter(({ result }) => result.status === 'rejected');

    if (!shouldContinue()) return;

    if (stalled.length === 0) {
      stalledRounds = 0;
      return;
    }

    stalledRounds += 1;

    logger.error(
      {
        stalledClients: stalled.map(({ named }) => named.name),
        stalledRounds,
        maxStalledRounds,
      },
      'Redis watchdog: PING stalled, attempting forced reconnect'
    );

    if (stalledRounds >= maxStalledRounds) {
      if (!shouldContinue()) return;
      logger.fatal(
        { stalledRounds },
        'Redis watchdog: clients unrecoverable after repeated stalls, exiting for a clean restart'
      );
      onFatal();
      return;
    }

    if (!shouldContinue()) return;
    await Promise.allSettled(
      stalled.map(({ named }) => forceReconnect(named))
    );
  } finally {
    if (shouldContinue()) {
      watchdogTickInFlight = false;
    }
  }
}

export const __watchdogTestHooks = {
  resetState() {
    stalledRounds = 0;
    watchdogTickInFlight = false;
    watchdogGeneration = 0;
    trackedSubClientSubscriptions.length = 0;
  },
  getStalledRounds: () => stalledRounds,
  forceReconnect,
  trackSubClientSubscriptions,
};
