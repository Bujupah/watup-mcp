import { EventEmitter } from 'node:events';
import { Boom } from '@hapi/boom';
import type { AnyMessageContent, BaileysEventEmitter, WAMessage } from 'baileys';
import type { SocketFactory, SocketFactoryOptions, SocketLike } from '../src/whatsapp/session.js';

export class FakeSocket implements SocketLike {
  ev = new EventEmitter() as unknown as BaileysEventEmitter & EventEmitter;
  user: { id: string; name?: string } | undefined;
  ended = false;
  loggedOut = false;
  sent: Array<{ jid: string; content: AnyMessageContent }> = [];
  presences: string[] = [];
  registered = new Set<string>();
  pairingCodeRequests: string[] = [];

  constructor(readonly opts: SocketFactoryOptions) {}

  async logout(): Promise<void> {
    this.loggedOut = true;
    this.close(401);
  }
  end(): void {
    this.ended = true;
  }
  async requestPairingCode(phone: string): Promise<string> {
    this.pairingCodeRequests.push(phone);
    return 'ABCD1234';
  }
  async onWhatsApp(...phones: string[]) {
    return phones.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: this.registered.has(p) }));
  }
  async sendMessage(jid: string, content: AnyMessageContent): Promise<WAMessage> {
    this.sent.push({ jid, content });
    return { key: { id: `MSG${this.sent.length}`, remoteJid: jid, fromMe: true }, messageTimestamp: 1_700_000_000 } as WAMessage;
  }
  async sendPresenceUpdate(type: string): Promise<void> {
    this.presences.push(type);
  }
  async groupMetadata(jid: string) {
    return { subject: `Group ${jid.slice(0, 4)}` };
  }

  // ---- test drivers ----
  qr(code = 'QR-1') {
    this.ev.emit('connection.update', { qr: code });
  }
  open(id = '14155550123:5@s.whatsapp.net') {
    this.user = { id, name: 'Me' };
    this.ev.emit('connection.update', { connection: 'open' });
  }
  close(statusCode?: number) {
    const error = statusCode ? new Boom('closed', { statusCode }) : new Error('closed');
    this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
  }
  /** Simulates Baileys' pairing success: creds get `me` + `account`. */
  pairSuccess(id = '14155550123:5@s.whatsapp.net') {
    const creds = this.opts.auth.creds;
    creds.me = { id, name: 'Me' };
    creds.account = { details: Buffer.from('x') };
    this.ev.emit('creds.update', { me: creds.me, account: creds.account });
  }
}

export function fakeFactory(): { factory: SocketFactory; sockets: FakeSocket[]; last: () => FakeSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    last: () => sockets[sockets.length - 1]!,
    factory: async (opts) => {
      const s = new FakeSocket(opts);
      sockets.push(s);
      return s;
    },
  };
}

export const flush = () => new Promise((r) => setImmediate(r));
