// Local-only preview of the candidate API against a disposable content copy.
import './network-guard.js';
import '../setup.js';
import { createServer } from 'node:http';
process.env.CORS_ORIGINS = 'http://127.0.0.1:55522,http://localhost:55522';
process.env.GUEST_LOBBIES_PROVISIONING_ENABLED = 'true';
process.env.GUEST_LOBBIES_RECONNECT_ENABLED = 'true';
process.env.GUEST_BOT_MATCHES_ENABLED = 'true';
process.env.GUEST_SIGNAL_HMAC_KEY = 'local-preview-guest-hmac-not-a-real-secret';
const { createApp } = await import('../../src/app.js');
const { initRedisClients } = await import('../../src/realtime/redis.js');
await initRedisClients();
const server = createServer(createApp());
server.listen(55521, '127.0.0.1', () => console.log('Isolated candidate HTTP preview ready on 127.0.0.1:55521'));
