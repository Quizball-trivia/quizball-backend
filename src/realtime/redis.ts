import { createClient, type RedisClientType } from 'redis';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

let commandClient: RedisClientType | null = null;
let pubClient: RedisClientType | null = null;
let subClient: RedisClientType | null = null;

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

export async function initRedisClients(): Promise<{
  pubClient: RedisClientType;
  subClient: RedisClientType;
}> {
  if (!config.REDIS_URL) {
    throw new Error('REDIS_URL is required for realtime features');
  }

  if (!commandClient) {
    commandClient = createClient({ url: config.REDIS_URL });
  }
  if (!pubClient) {
    pubClient = createClient({ url: config.REDIS_URL });
  }
  if (!subClient) {
    subClient = pubClient.duplicate();
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

  return { pubClient, subClient };
}

export function getRedisClient(): RedisClientType | null {
  return commandClient;
}

export async function closeRedisClients(): Promise<void> {
  const clients = [commandClient, pubClient, subClient].filter(
    (client): client is RedisClientType => !!client && client.isOpen
  );

  if (clients.length === 0) return;

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

  logger.info('Redis clients disconnected');
}
