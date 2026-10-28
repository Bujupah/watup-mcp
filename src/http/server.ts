import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { safeEqual } from '../crypto.js';
import type { ToolContext } from '../tools/index.js';
import type { SessionStatus } from '../whatsapp/session.js';
import { mcpMethodNotAllowed, mcpPostHandler } from './mcp.js';
import { QrRenderer, buildQrPayload, renderQrPage } from './qrPage.js';

export interface HttpOptions {
  host: string;
  port: number;
  token: string;
  allowRemote: boolean;
}

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && (LOOPBACK_ADDRS.has(addr) || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}

/** Rejects requests whose Host header isn't a loopback name (DNS-rebinding protection) when bound locally. */
function hostGuard(opts: HttpOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (opts.allowRemote) return next();
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return next();
    res.status(403).json({ error: 'Forbidden host' });
  };
}

function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && safeEqual(m[1]!.trim(), token)) return next();
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="whatsapp-mcp"')
      .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' }, id: null });
  };
}

function qrGuard(ctx: ToolContext, opts: HttpOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!opts.allowRemote && !isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).type('text/plain').send('The QR page is only available from this machine.');
      return;
    }
    const t = typeof req.query.t === 'string' ? req.query.t : undefined;
    if (!ctx.qrTokens.isValid(t)) {
      res.status(403).type('text/plain').send('This QR link is missing, invalid or expired. Call whatsapp_login again.');
      return;
    }
    next();
  };
}

export function createApp(ctx: ToolContext, opts: HttpOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard(opts));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, state: ctx.session.getState() });
  });

  const auth = bearerAuth(opts.token);
  app.post('/mcp', auth, express.json({ limit: '1mb' }), mcpPostHandler(ctx));
  app.get('/mcp', auth, mcpMethodNotAllowed);
  app.delete('/mcp', auth, mcpMethodNotAllowed);

  const renderer = new QrRenderer();
  app.get('/qr', qrGuard(ctx, opts), (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    res.set('Referrer-Policy', 'no-referrer');
    res.type('html').send(renderQrPage(req.query.t as string, nonce));
  });

  app.get('/qr/events', qrGuard(ctx, opts), (req, res) => {
    const token = req.query.t as string;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const send = async () => {
      if (closed) return;
      const payload = await buildQrPayload(ctx.session, renderer);
      if (closed) return;
      res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
      if (payload.state === 'connected') finish();
    };
    // The session emits 'state' on every transition and on every QR rotation.
    const onState = (_s: SessionStatus) => void send().catch((err: unknown) => ctx.logger.warn({ err }, 'SSE send failed'));
    const heartbeat = setInterval(() => {
      if (!ctx.qrTokens.isValid(token)) {
        res.write('event: expired\ndata: {}\n\n');
        finish();
        return;
      }
      res.write(': ping\n\n');
    }, 15_000);
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      ctx.session.off('state', onState);
      res.end();
    };
    ctx.session.on('state', onState);
    req.on('close', finish);
    onState(ctx.session.getStatus());
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  return app;
}

export function listen(app: express.Express, opts: HttpOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port, opts.host, (err?: Error) => {
      if (err) reject(err);
      else resolve(server);
    });
    server.on('error', reject);
  });
}
