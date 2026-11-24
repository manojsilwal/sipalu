import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ensureDemoFixtures, pool, runAutoMigrations } from './db.js';
import { realtimeHub } from './ws.js';
import { authAndKycRouter } from './routes/authAndKyc.js';
import { catalogAndBookingsRouter } from './routes/catalogAndBookings.js';
import { financeTrustOpsRouter } from './routes/financeTrustOps.js';
import { paymentGatewaysRouter } from './routes/paymentGateways.js';
import { wrapAsyncRouter } from './asyncWrap.js';

const app = express();
const PORT = Number(process.env.PORT || 8080);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'sipalu-api', version: '2.1.0', db: 'connected', auth_mode: 'username_password' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: String(err) });
  }
});

app.use('/v1', wrapAsyncRouter(authAndKycRouter));
app.use('/v1', wrapAsyncRouter(catalogAndBookingsRouter));
app.use('/v1', wrapAsyncRouter(financeTrustOpsRouter));
app.use('/v1', wrapAsyncRouter(paymentGatewaysRouter));

// Unified Single-Container Mode (Azure for Students Free Tier): serve built React SPA if present
const staticWebDir = process.env.STATIC_WEB_DIR || path.resolve(process.cwd(), 'public');
if (fs.existsSync(staticWebDir) && fs.existsSync(path.join(staticWebDir, 'index.html'))) {
  app.use(express.static(staticWebDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1') || req.path.startsWith('/ws') || req.path === '/health') {
      next();
      return;
    }
    res.sendFile(path.join(staticWebDir, 'index.html'));
  });
}

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
  if (process.env.AUTO_MIGRATE === 'true') {
    await runAutoMigrations();
  }
  await ensureDemoFixtures();
  const server = http.createServer(app);
  realtimeHub.attach(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sipalu listening on http://0.0.0.0:${PORT} (WebSocket at /ws)`);
  });
}

start().catch((err) => {
  console.error('Failed to start Sipalu:', err);
  process.exit(1);
});
