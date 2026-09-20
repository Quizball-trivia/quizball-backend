// Real HTTP and Socket.IO replicas confined to the disposable reference copy.
import './network-guard.js';
import '../setup.js';
import { createServer } from 'node:http';

const port = Number(process.env.RELEASE_PREVIEW_PORT);
if (![55521, 55523].includes(port) || process.env.RELEASE_TEST_DATABASE_URL !==
    'postgres://rehearsal@127.0.0.1:55519/rehearsal_staging_reference_full_v3') {
  throw new Error('Socket preview requires the dedicated local reference copy');
}
process.env.PORT = String(port);
process.env.CORS_ORIGINS = 'http://127.0.0.1:55522,http://localhost:55522';
process.env.GUEST_LOBBIES_PROVISIONING_ENABLED = 'true';
process.env.GUEST_LOBBIES_RECONNECT_ENABLED = 'true';
process.env.GUEST_BOT_MATCHES_ENABLED = 'true';
process.env.FOOTBALL_GRID_LOBBY_ENABLED = 'true';
process.env.FOOTBALL_GRID_CONTENT_ENABLED = 'true';
process.env.FOOTBALL_GRID_PACK_PREVIEW_ENABLED = 'true';
process.env.FOOTBALL_GRID_QUEUE_ENABLED = 'true';
process.env.FOOTBALL_GRID_BOTS_ENABLED = 'false';
process.env.FOOTBALL_GRID_COINS_ENABLED = 'false';
process.env.FOOTBALL_GRID_POINTS_ENABLED = 'false';
process.env.AUCTION_ENABLED = 'true';
process.env.GUEST_SIGNAL_HMAC_KEY = 'local-preview-guest-hmac-not-a-real-secret';

const { createApp } = await import('../../src/app.js');
const { initSocketServer } = await import('../../src/realtime/socket-server.js');
const server = createServer(createApp());
await initSocketServer(server);
server.listen(port, '127.0.0.1', () => console.log(`Local rehearsal replica ready on ${port}`));
