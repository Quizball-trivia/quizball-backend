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
  }
  if (!pubClient) {
    pubClient = createClient({ url: config.REDIS_URL });
  }
  if (!subClient) {
    subClient = pubClient.duplicate();
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
