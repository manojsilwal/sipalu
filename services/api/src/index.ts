import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ensureDemoFixtures, pool } from './db.js';
import { realtimeHub } from './ws.js';
import { authAndKycRouter } from './routes/authAndKyc.js';
import { catalogAndBookingsRouter } from './routes/catalogAndBookings.js';
import { financeTrustOpsRouter } from './routes/financeTrustOps.js';
import { wrapAsyncRouter } from './asyncWrap.js';

const app = express();
const PORT = Number(process.env.PORT || 8080);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'sipalu-api', version: '2.0.0', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: String(err) });
  }
});

app.use('/v1', wrapAsyncRouter(authAndKycRouter));
app.use('/v1', wrapAsyncRouter(catalogAndBookingsRouter));
app.use('/v1', wrapAsyncRouter(financeTrustOpsRouter));

// Centralized Error Handler
app.use(
  (
    err: Error & { statusCode?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const code = err.statusCode || 500;
    if (code >= 500) {
      console.error('[API ERROR]', err);
    }
    res.status(code).json({ error: err.message || 'Internal server error' });
  }
);

async function start() {
  await ensureDemoFixtures();
  const server = http.createServer(app);
  realtimeHub.attach(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sipalu API listening on http://0.0.0.0:${PORT} (WebSocket at /ws)`);
  });
}

start().catch((err) => {
  console.error('Failed to start Sipalu API:', err);
  process.exit(1);
});
