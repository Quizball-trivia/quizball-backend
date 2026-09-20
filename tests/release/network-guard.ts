import net from 'node:net';
// Rehearsal tests may create loopback HTTP servers. Any accidental cloud access
// or use of the developer's ordinary database/Redis must fail before connecting.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args: unknown[]) {
  const input = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof input === 'object' && input !== null
    ? input as { host?: string; port?: number | string; path?: string }
    : { port: input as number | string, host: typeof args[1] === 'string' ? args[1] : undefined };
  const host = options.host ?? 'localhost';
  const port = Number(options.port);
  if (options.path || !['127.0.0.1', 'localhost', '::1'].includes(host) || [5432, 6379, 6543, 54322].includes(port)) {
    throw new Error(`Release test attempted a connection outside its isolated services: ${host}:${port}`);
  }
  return Reflect.apply(connect, this, args);
} as typeof connect;
process.env.REDIS_URL = 'redis://127.0.0.1:55520/0';
