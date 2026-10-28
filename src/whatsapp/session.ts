import { EventEmitter } from 'node:events';
import type { Boom } from '@hapi/boom';
import {
  Browsers,
  downloadMediaMessage,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
  type AnyMessageContent,
  type AuthenticationState,
  type BaileysEventEmitter,
  type ConnectionState,
  type WAMessage,
  type WAMessageKey,
  type WAPresence,
  type WAVersion,
} from 'baileys';
import type { Logger } from 'pino';
import type { CacheStore } from '../db/cache.js';
import { attachCacheSync } from './cacheSync.js';
import type { AuthStore } from './authStore.js';
import { normalizePhone, phoneFromJid } from './jid.js';

export type SessionState = 'disconnected' | 'connecting' | 'awaiting_scan' | 'connected' | 'logged_out';
export type LoginMethod = 'qr' | 'pairing_code';

/** The subset of the Baileys socket the SessionManager relies on (lets tests inject a fake). */
export interface SocketLike {
  ev: BaileysEventEmitter;
  user?: { id: string; name?: string } | undefined;
  logout(msg?: string): Promise<void>;
  end(error: Error | undefined): unknown;
  requestPairingCode(phoneNumber: string): Promise<string>;
  onWhatsApp(...phoneNumbers: string[]): Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined>;
  sendPresenceUpdate(type: WAPresence, toJid?: string): Promise<void>;
  groupMetadata(jid: string): Promise<{ subject: string }>;
  updateMediaMessage(message: WAMessage): Promise<WAMessage>;
}

export interface SocketFactoryOptions {
  auth: AuthenticationState;
  logger: Logger;
  syncFullHistory: boolean;
  getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  /** Logger for our own diagnostics (the Baileys logger is usually quieter). */
  appLogger?: Logger;
}

export type SocketFactory = (opts: SocketFactoryOptions) => Promise<SocketLike>;

export interface SessionStatus {
  state: SessionState;
  linkedAs?: string;
  name?: string;
  lastConnectedAt?: string;
  lastError?: string;
  loginMethod?: LoginMethod;
  qrAvailable: boolean;
  pairingCode?: string;
  scanDeadline?: string;
}

export interface LoginResult {
  status: 'already_connected' | 'qr' | 'pairing_code' | 'connecting';
  qr?: string;
  pairingCode?: string;
  scanDeadline?: number;
}

export interface SessionManagerOptions {
  auth: AuthStore;
  cache: CacheStore;
  logger: Logger;
  socketFactory?: SocketFactory;
  syncFullHistory?: boolean;
  /** Log level for Baileys' internal logger (default "warn"). */
  baileysLogLevel?: string;
  /** How long a QR / pairing-code session may wait for the user before giving up. */
  scanTimeoutMs?: number;
  /** How long login() waits for the first QR / for the socket to be ready. */
  firstQrTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Random delay range applied before each send (human-like pacing). */
  pacingMs?: [number, number];
  random?: () => number;
}

class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}
export { SessionError };

const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
let cachedVersion: { version: WAVersion; at: number } | undefined;

type VersionResult = { version: WAVersion; isLatest: boolean; error?: unknown };

function withTimeout(p: Promise<VersionResult>, ms: number): Promise<VersionResult | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]).catch(() => undefined);
}

/**
 * Picks the WhatsApp Web version to announce. A stale version makes the phone reject linking
 * ("Couldn't link device"), so prefer the live revision from web.whatsapp.com, then the one in
 * Baileys' GitHub repo, then the bundled default. Both fetchers swallow errors and return the
 * bundled version with isLatest=false, so check that flag rather than relying on exceptions.
 */
async function resolveWaVersion(log: Logger): Promise<WAVersion | undefined> {
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) return cachedVersion.version;
  const sources: Array<[string, () => Promise<VersionResult>]> = [
    ['web.whatsapp.com', () => fetchLatestWaWebVersion() as Promise<VersionResult>],
    ['Baileys repo', () => fetchLatestBaileysVersion() as Promise<VersionResult>],
  ];
  for (const [source, fetcher] of sources) {
    const res = await withTimeout(fetcher(), 8000);
    if (res?.isLatest) {
      cachedVersion = { version: res.version, at: Date.now() };
      log.info({ version: res.version.join('.'), source }, 'using WhatsApp Web version');
      return res.version;
    }
    log.warn({ source, error: (res?.error as Error | undefined)?.message ?? 'timeout' }, 'could not fetch WhatsApp Web version');
  }
  log.warn('falling back to the WhatsApp Web version bundled with Baileys; linking may fail if it is outdated');
  return cachedVersion?.version;
}

/** Creates a real Baileys socket. */
export const defaultSocketFactory: SocketFactory = async ({ auth, logger, syncFullHistory, getMessage, appLogger }) => {
  const version = await resolveWaVersion(appLogger ?? logger);
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    logger,
    // A recognised browser name keeps the companion platform id valid for pairing codes.
    // WhatsApp only grants full history sync to desktop companions.
    browser: syncFullHistory ? Browsers.macOS('Desktop') : Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory,
    getMessage,
  });
  return sock as unknown as SocketLike;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns the single Baileys socket for an account and exposes a small state machine:
 * disconnected → connecting → (awaiting_scan →) connected, with reconnect/backoff and logout handling.
 *
 * Events: 'state' (SessionStatus), 'qr' (string), 'pairing_code' (string), 'connected', 'logged_out'.
 */
export class SessionManager extends EventEmitter {
  private state: SessionState = 'disconnected';
  private sock: SocketLike | undefined;
  private generation = 0;
  private detachSync: (() => void) | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopping = false;
  private currentQr: string | undefined;
  private pairingCode: string | undefined;
  private pairingPhone: string | undefined;
  private loginMethod: LoginMethod | undefined;
  private scanDeadline: number | undefined;
  private lastConnectedAt: number | undefined;
  private lastError: string | undefined;
  private me: { id: string; name?: string } | undefined;
  private sendChain: Promise<unknown> = Promise.resolve();

  private readonly log: Logger;
  private readonly factory: SocketFactory;
  private readonly scanTimeoutMs: number;
  private readonly firstQrTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly pacingMs: [number, number];
  private readonly random: () => number;

  constructor(private readonly opts: SessionManagerOptions) {
    super();
    this.log = opts.logger.child({ mod: 'session' });
    this.factory = opts.socketFactory ?? defaultSocketFactory;
    this.scanTimeoutMs = opts.scanTimeoutMs ?? 3 * 60_000;
    this.firstQrTimeoutMs = opts.firstQrTimeoutMs ?? 30_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60_000;
    this.pacingMs = opts.pacingMs ?? [500, 2000];
    this.random = opts.random ?? Math.random;
    this.setMaxListeners(100);
  }

  // ---- public API ----------------------------------------------------------

  /** Connects silently if the device was linked before; otherwise stays disconnected until login(). */
  async start(): Promise<void> {
    if (this.isLinked()) {
      this.log.info('stored credentials found, connecting');
      await this.connect();
    } else {
      this.log.info('not linked yet; call whatsapp_login to link this device');
    }
  }

  /** True when stored credentials represent a completed pairing. */
  isLinked(): boolean {
    const c = this.opts.auth.state.creds;
    return !!c.account && !!c.me?.id;
  }

  getState(): SessionState {
    return this.state;
  }

  getStatus(): SessionStatus {
    const me = this.me ?? (this.isLinked() ? this.opts.auth.state.creds.me : undefined);
    const phone = phoneFromJid(me?.id ? me.id.replace(/:\d+@/, '@') : undefined);
    return {
      state: this.state,
      ...(phone ? { linkedAs: `+${phone}` } : {}),
      ...(me?.name ? { name: me.name } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: new Date(this.lastConnectedAt).toISOString() } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.loginMethod && this.state === 'awaiting_scan' ? { loginMethod: this.loginMethod } : {}),
      qrAvailable: this.state === 'awaiting_scan' && !!this.currentQr && this.loginMethod === 'qr',
      ...(this.pairingCode && this.state === 'awaiting_scan' ? { pairingCode: this.pairingCode } : {}),
      ...(this.scanDeadline && this.state === 'awaiting_scan' ? { scanDeadline: new Date(this.scanDeadline).toISOString() } : {}),
    };
  }

  getCurrentQr(): string | undefined {
    return this.state === 'awaiting_scan' && this.loginMethod === 'qr' ? this.currentQr : undefined;
  }

  /**
   * Starts linking. For QR, resolves with the first QR string. For pairing codes, resolves with the
   * 8-character code once the socket is ready.
   */
  async login(opts: { method: LoginMethod; phone?: string }): Promise<LoginResult> {
    if (this.state === 'connected') return { status: 'already_connected' };
    if (this.isLinked()) {
      // Already paired: just (re)connect; no QR needed.
      if (this.state === 'disconnected' || this.state === 'logged_out') {
        const opened = this.waitForEvent('connected', this.firstQrTimeoutMs).then(
          () => true,
          () => false,
        );
        await this.connect();
        if (await opened) return { status: 'already_connected' };
      }
      return { status: 'connecting' };
    }

    let phoneDigits: string | undefined;
    if (opts.method === 'pairing_code') {
      if (!opts.phone) throw new SessionError('A phone number (with country code) is required for pairing_code login.');
      phoneDigits = normalizePhone(opts.phone);
    }

    // Reuse an in-flight scan session if it matches.
    if (this.state === 'awaiting_scan' && this.loginMethod === opts.method) {
      if (opts.method === 'qr' && this.currentQr) return { status: 'qr', qr: this.currentQr, scanDeadline: this.scanDeadline! };
      if (opts.method === 'pairing_code' && this.pairingCode && this.pairingPhone === phoneDigits) {
        return { status: 'pairing_code', pairingCode: this.pairingCode, scanDeadline: this.scanDeadline! };
      }
    }

    // Start fresh: tear down anything in flight (unlinked sockets only).
    await this.teardownSocket();
    this.clearTimers();
    this.loginMethod = opts.method;
    this.pairingPhone = phoneDigits;
    this.pairingCode = undefined;
    this.currentQr = undefined;
    this.lastError = undefined;
    this.scanDeadline = Date.now() + this.scanTimeoutMs;
    this.scanTimer = setTimeout(() => this.onScanTimeout(), this.scanTimeoutMs);
    this.scanTimer.unref?.();

    const firstQr = this.waitForFirstQr();
    firstQr.catch(() => undefined);
    await this.connect();

    let qr: string;
    try {
      qr = await firstQr;
    } catch (err) {
      if (this.getState() === 'connected') return { status: 'already_connected' };
      const msg = (err as Error).message;
      await this.abortLogin(msg);
      throw new SessionError(msg.includes('whatsapp_login') ? msg : `${msg} Check network connectivity and try again.`);
    }

    if (opts.method === 'qr') return { status: 'qr', qr, scanDeadline: this.scanDeadline };

    try {
      const code = await this.sock!.requestPairingCode(phoneDigits!);
      this.pairingCode = code;
      this.emit('pairing_code', code);
      this.emitState();
      return { status: 'pairing_code', pairingCode: code, scanDeadline: this.scanDeadline };
    } catch (err) {
      await this.abortLogin(`Pairing code request failed: ${(err as Error).message}`);
      throw new SessionError(`WhatsApp rejected the pairing code request: ${(err as Error).message}`);
    }
  }

  /** Unlinks the device (removes it from the phone's Linked devices) and wipes credentials. */
  async logout(): Promise<{ remoteUnlinked: boolean }> {
    let remoteUnlinked = false;
    if (this.state !== 'connected' && this.isLinked()) {
      // Try to come online briefly so the phone actually drops this device.
      const opened = this.waitForEvent('connected', 20_000).then(
        () => true,
        () => false,
      );
      if (this.state === 'disconnected' || this.state === 'logged_out') await this.connect();
      await opened;
    }
    this.stopping = true;
    try {
      if (this.sock && this.state === 'connected') {
        try {
          await this.sock.logout('whatsapp-mcp logout');
          remoteUnlinked = true;
        } catch (err) {
          this.log.warn({ err }, 'sock.logout() failed; wiping local credentials anyway');
        }
      }
      await this.teardownSocket();
      this.clearTimers();
      await this.opts.auth.clear();
      this.me = undefined;
      this.resetLogin();
      this.setState('disconnected');
    } finally {
      this.stopping = false;
    }
    return { remoteUnlinked };
  }

  /** Closes the socket without touching credentials. */
  async stop(): Promise<void> {
    this.stopping = true;
    try {
      this.clearTimers();
      await this.teardownSocket();
      this.resetLogin();
      this.setState('disconnected');
    } finally {
      this.stopping = false;
    }
  }

  /** Checks whether a phone number is registered on WhatsApp. */
  async onWhatsApp(phone: string): Promise<{ exists: boolean; jid?: string }> {
    const sock = this.requireConnected();
    const digits = normalizePhone(phone);
    const res = await sock.onWhatsApp(digits);
    const hit = res?.find((r) => r.exists);
    return hit ? { exists: true, jid: hit.jid } : { exists: false };
  }

  /** Sends a text message. All sends are serialized through a single queue with human-like pacing. */
  sendText(jid: string, text: string): Promise<{ id: string; timestamp: number }> {
    return this.enqueueSend(jid, 'composing', { text });
  }

  /** Sends audio; with ptt it shows as a voice note (needs Ogg/Opus). Same queue and pacing as text. */
  sendVoice(jid: string, audio: Buffer, mimetype: string, ptt: boolean): Promise<{ id: string; timestamp: number }> {
    return this.enqueueSend(jid, 'recording', { audio, mimetype, ptt });
  }

  /** Sends an image or a document, with an optional caption. Same queue and pacing as text. */
  sendMedia(
    jid: string,
    media: { kind: 'image' | 'document'; data: Buffer; mimetype: string; fileName: string; caption?: string },
  ): Promise<{ id: string; timestamp: number }> {
    const caption = media.caption ? { caption: media.caption } : {};
    const content: AnyMessageContent =
      media.kind === 'image'
        ? { image: media.data, mimetype: media.mimetype, ...caption }
        : { document: media.data, mimetype: media.mimetype, fileName: media.fileName, ...caption };
    return this.enqueueSend(jid, 'composing', content);
  }

  /** Downloads the media of a message (re-requesting expired media from the phone if needed). */
  async downloadMedia(message: WAMessage): Promise<Buffer> {
    const sock = this.requireConnected();
    return downloadMediaMessage(
      message,
      'buffer',
      {},
      { logger: this.opts.logger.child({ mod: 'baileys' }, { level: 'warn' }), reuploadRequest: (m) => sock.updateMediaMessage(m) },
    );
  }

  private enqueueSend(jid: string, presence: WAPresence, content: AnyMessageContent): Promise<{ id: string; timestamp: number }> {
    const run = async () => {
      const sock = this.requireConnected();
      const [min, max] = this.pacingMs;
      const delay = min + Math.floor(this.random() * Math.max(0, max - min));
      try {
        await sock.sendPresenceUpdate(presence, jid);
      } catch (err) {
        this.log.debug({ err }, 'presence update failed');
      }
      if (delay > 0) await sleep(delay);
      const sent = await this.requireConnected().sendMessage(jid, content);
      sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
      const id = sent?.key?.id;
      if (!id) throw new SessionError('WhatsApp did not return a message id.');
      const tsRaw = sent.messageTimestamp;
      const ts = tsRaw ? Number(tsRaw) * 1000 : Date.now();
      return { id, timestamp: ts };
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => undefined);
    return p;
  }

  // ---- internals -----------------------------------------------------------

  private requireConnected(): SocketLike {
    if (this.state !== 'connected' || !this.sock) {
      throw new SessionError(
        this.isLinked()
          ? `WhatsApp is ${this.state}, not connected. Wait a moment and retry, or check whatsapp_status.`
          : 'Not linked. Call whatsapp_login.',
      );
    }
    return this.sock;
  }

  private async connect(): Promise<void> {
    this.clearReconnect();
    const gen = ++this.generation;
    this.setState('connecting');
    let sock: SocketLike;
    try {
      sock = await this.factory({
        auth: this.opts.auth.state,
        logger: this.opts.logger.child({ mod: 'baileys' }, { level: this.opts.baileysLogLevel ?? 'warn' }),
        appLogger: this.log,
        syncFullHistory: this.opts.syncFullHistory ?? false,
        getMessage: async (key) => this.loadMessage(key),
      });
    } catch (err) {
      this.log.error({ err }, 'failed to create WhatsApp socket');
      this.lastError = `Socket creation failed: ${(err as Error).message}`;
      if (gen === this.generation) this.scheduleReconnect();
      return;
    }
    if (gen !== this.generation) {
      sock.end(undefined);
      return;
    }
    this.sock = sock;
    this.detachSync = attachCacheSync(sock.ev, this.opts.cache, {
      logger: this.log,
      fetchGroupName: async (jid) => (await sock.groupMetadata(jid)).subject,
    });
    sock.ev.on('creds.update', () => {
      // A torn-down socket must not overwrite credentials (e.g. after logout wiped them).
      if (gen !== this.generation) return;
      void this.opts.auth.saveCreds().catch((err: unknown) => this.log.error({ err }, 'failed to persist creds'));
    });
    sock.ev.on('connection.update', (u) => {
      if (gen !== this.generation) return;
      void this.onConnectionUpdate(u, sock).catch((err: unknown) => this.log.error({ err }, 'connection.update handler failed'));
    });
  }

  private async onConnectionUpdate(u: Partial<ConnectionState>, sock: SocketLike): Promise<void> {
    if (u.qr) {
      this.log.info({ method: this.loginMethod ?? 'qr' }, this.currentQr ? 'QR rotated' : 'QR issued; waiting for scan');
      this.currentQr = u.qr;
      if (this.state !== 'awaiting_scan') this.setState('awaiting_scan');
      // In pairing-code mode the first QR only signals that the socket is ready for requestPairingCode().
      this.emit('qr', u.qr);
      if (this.loginMethod !== 'pairing_code') this.emitState();
    }
    if (u.connection === 'connecting' && this.state !== 'awaiting_scan') this.setState('connecting');
    if (u.isNewLogin) this.log.info('pairing accepted by the phone; waiting for WhatsApp to restart the connection');
    if (u.connection === 'open') {
      this.attempt = 0;
      this.lastConnectedAt = Date.now();
      this.lastError = undefined;
      this.me = sock.user ?? this.opts.auth.state.creds.me;
      this.clearScanTimer();
      this.resetLogin();
      this.setState('connected');
      this.emit('connected');
      this.log.info({ linkedAs: this.getStatus().linkedAs }, 'WhatsApp connected');
    }
    if (u.connection === 'close') await this.onClose(u.lastDisconnect?.error);
  }

  private async onClose(error: Error | Boom | undefined): Promise<void> {
    const statusCode = (error as Boom | undefined)?.output?.statusCode;
    const reason = describeDisconnect(statusCode, error);
    this.detach();
    this.sock = undefined;
    if (this.stopping) return;
    this.log.info({ statusCode, reason }, 'WhatsApp connection closed');

    if (statusCode === DisconnectReason.loggedOut) {
      this.clearTimers();
      await this.opts.auth.clear();
      this.me = undefined;
      this.resetLogin();
      this.lastError = 'Device was unlinked (logged out from the phone). Call whatsapp_login to link again.';
      this.setState('logged_out');
      this.emit('logged_out');
      this.setState('disconnected');
      return;
    }
    if (statusCode === DisconnectReason.restartRequired) {
      // Expected right after a successful scan: recreate the socket immediately.
      this.log.info('restart required (normal after pairing); reconnecting');
      await this.connect();
      return;
    }
    if (!this.isLinked()) {
      // QR / pairing flow ended without a link. Don't keep generating QR codes nobody is looking at.
      this.clearTimers();
      this.resetLogin();
      this.lastError = `Linking stopped: ${reason}. Call whatsapp_login to try again.`;
      this.setState('disconnected');
      return;
    }
    if (statusCode === DisconnectReason.connectionReplaced) {
      this.clearTimers();
      this.lastError =
        'Connection replaced: another client is using these credentials (two sockets kick each other off). ' +
        'Stop the other whatsapp-mcp instance, then call whatsapp_login or restart this server.';
      this.setState('disconnected');
      return;
    }
    if (statusCode === DisconnectReason.forbidden) {
      this.clearTimers();
      this.lastError = 'WhatsApp refused the connection (403). The account may be restricted.';
      this.setState('disconnected');
      return;
    }
    this.lastError = reason;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    const delay = Math.min(this.backoffMaxMs, Math.round(exp * (0.75 + this.random() * 0.5)));
    this.attempt++;
    this.setState('connecting');
    this.log.info({ delayMs: delay, attempt: this.attempt }, 'reconnecting with backoff');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Number of consecutive reconnect attempts since the last successful open. */
  get reconnectAttempt(): number {
    return this.attempt;
  }

  private onScanTimeout(): void {
    this.scanTimer = undefined;
    if (this.isLinked()) return;
    this.log.info('no scan within the time limit; stopping link attempt');
    void this.abortLogin('QR / pairing code expired before it was scanned. Call whatsapp_login again.');
  }

  private async abortLogin(message: string): Promise<void> {
    this.stopping = true;
    try {
      this.clearTimers();
      await this.teardownSocket();
      this.resetLogin();
      this.lastError = message;
      this.setState('disconnected');
    } finally {
      this.stopping = false;
    }
  }

  private async teardownSocket(): Promise<void> {
    const sock = this.sock;
    this.generation++;
    this.detach();
    this.sock = undefined;
    if (sock) {
      try {
        await sock.end(undefined);
      } catch {
        // already closed
      }
    }
  }

  private detach(): void {
    this.detachSync?.();
    this.detachSync = undefined;
  }

  private resetLogin(): void {
    this.currentQr = undefined;
    this.pairingCode = undefined;
    this.pairingPhone = undefined;
    this.loginMethod = undefined;
    this.scanDeadline = undefined;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearScanTimer(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
  }

  private clearTimers(): void {
    this.clearReconnect();
    this.clearScanTimer();
  }

  private setState(s: SessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.getStatus());
  }

  /** Resolves with the first QR, or rejects if the link attempt ends or times out first. */
  private waitForFirstQr(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('qr', onQr);
        this.off('state', onState);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SessionError('Timed out waiting for WhatsApp to issue a QR code.'));
      }, this.firstQrTimeoutMs);
      timer.unref?.();
      const onQr = (qr: string) => {
        cleanup();
        resolve(qr);
      };
      const onState = (st: SessionStatus) => {
        if (st.state === 'disconnected' || st.state === 'connected') {
          cleanup();
          reject(new SessionError(st.lastError ?? `Link attempt ended (${st.state}).`));
        }
      };
      this.on('qr', onQr);
      this.on('state', onState);
    });
  }

  private waitForEvent<T = void>(event: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, onEvent);
        reject(new SessionError(`Timed out waiting for ${event}`));
      }, timeoutMs);
      timer.unref?.();
      const onEvent = (arg: T) => {
        clearTimeout(timer);
        this.off(event, onEvent);
        resolve(arg);
      };
      this.on(event, onEvent);
    });
  }

  private async loadMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id) return undefined;
    const raw = this.opts.cache.getRawMessage(key.remoteJid ?? undefined, key.id);
    if (!raw) return undefined;
    try {
      return proto.Message.fromObject(JSON.parse(raw.toString('utf8'), BufferJSON.reviver) as object);
    } catch {
      return undefined;
    }
  }
}

export function describeDisconnect(statusCode: number | undefined, error: Error | undefined): string {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return 'logged out';
    case DisconnectReason.restartRequired:
      return 'restart required';
    case DisconnectReason.connectionReplaced:
      return 'connection replaced by another client';
    case DisconnectReason.connectionClosed:
      return 'connection closed';
    case DisconnectReason.connectionLost:
      return 'connection lost / timed out';
    case DisconnectReason.badSession:
      return 'bad session';
    case DisconnectReason.multideviceMismatch:
      return 'multi-device mismatch';
    case DisconnectReason.forbidden:
      return 'forbidden';
    case DisconnectReason.unavailableService:
      return 'service unavailable';
    default:
      return error?.message ? `${error.message}${statusCode ? ` (${statusCode})` : ''}` : `unknown (${statusCode ?? 'no code'})`;
  }
}
