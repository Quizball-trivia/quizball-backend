import { createClient, type RedisClientType } from 'redis';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

let commandClient: RedisClientType | null = null;
let pubClient: RedisClientType | null = null;
let subClient: RedisClientType | null = null;

export async function initRedisClients(): Promise<{
  pubClient: RedisClientType;
  subClient: RedisClientType;
}> {
  if (!config.REDIS_URL) {
    throw new Error('REDIS_URL is required for realtime features');
  }

  if (!commandClient) {
    commandClient = createClient({ url: config.REDIS_URL });
    commandClient.on('error', (err) => {
      logger.error({ err, client: 'command' }, 'Redis command client error');
    });
  }
  if (!pubClient) {
    pubClient = createClient({ url: config.REDIS_URL });
    pubClient.on('error', (err) => {
      logger.error({ err, client: 'pub' }, 'Redis pub client error');
    });
  }
  if (!subClient) {
    subClient = pubClient.duplicate();
    subClient.on('error', (err) => {
      logger.error({ err, client: 'sub' }, 'Redis sub client error');
    });
  }

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

  await Promise.allSettled(clients.map((client) => client.quit()));

  commandClient = null;
  pubClient = null;
  subClient = null;

  logger.info('Redis clients disconnected');
}
