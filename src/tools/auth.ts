import QRCode from 'qrcode';
import { z } from 'zod';
import { defineTool, errorResult, jsonResult, textResult, toErrorResult } from './common.js';

export const whatsappStatus = defineTool({
  name: 'whatsapp_status',
  title: 'WhatsApp status',
  description:
    'Shows whether this server is linked to WhatsApp and connected, which number it is linked as, and cache sizes. ' +
    'Call this first if another tool reports a connection problem.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    const s = ctx.session.getStatus();
    const data = {
      state: s.state,
      ...(s.linkedAs ? { linkedAs: s.linkedAs } : {}),
      ...(s.name ? { name: s.name } : {}),
      ...(s.lastConnectedAt ? { lastConnectedAt: s.lastConnectedAt } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      ...(s.state === 'awaiting_scan' ? { loginMethod: s.loginMethod, scanDeadline: s.scanDeadline } : {}),
      cacheStats: ctx.cache.stats(),
      guardrails: {
        requireConfirm: ctx.requireConfirm,
        allowlist: ctx.guardrails.allowlist.isEmpty ? 'disabled (all recipients allowed)' : `${ctx.guardrails.allowlist.size} entries`,
      },
    };
    const hint =
      s.state === 'connected'
        ? `Connected as ${s.linkedAs ?? 'unknown'}.`
        : !ctx.session.isLinked()
          ? 'Not linked. Call whatsapp_login to link this server as a WhatsApp companion device.'
          : `Linked but ${s.state}.`;
    return jsonResult(hint, data);
  },
});

export const whatsappLogin = defineTool({
  name: 'whatsapp_login',
  title: 'Link WhatsApp',
  description:
    'Links this server to the user\'s WhatsApp account as a companion device (like WhatsApp Web). ' +
    'method "qr" (default) returns a QR image plus a live page URL that keeps the rotating QR fresh; the user scans it in ' +
    'WhatsApp → Settings → Linked devices → Link a device. method "pairing_code" needs `phone` (with country code) and ' +
    'returns an 8-character code the user types on their phone instead. Show the QR/URL or code to the user and wait for them; ' +
    'then call whatsapp_status to confirm.',
  inputSchema: {
    method: z.enum(['qr', 'pairing_code']).default('qr').describe('Linking method'),
    phone: z.string().min(1).optional().describe('Required for pairing_code: the account phone number with country code, e.g. +14155550123'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    try {
      const res = await ctx.session.login({ method: args.method, ...(args.phone ? { phone: args.phone } : {}) });
      ctx.guardrails.audit.record({ action: 'login', result: 'ok', error: `method=${args.method};status=${res.status}` });
      if (res.status === 'already_connected') {
        return textResult(`Already linked and connected as ${ctx.session.getStatus().linkedAs ?? 'this account'}. Nothing to do.`);
      }
      if (res.status === 'connecting') {
        return textResult('This device is already linked and is reconnecting. Call whatsapp_status in a few seconds.');
      }
      const deadline = res.scanDeadline ? new Date(res.scanDeadline).toISOString() : undefined;
      if (res.status === 'pairing_code') {
        const code = res.pairingCode!;
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        return textResult(
          `Pairing code: ${pretty}\n\n` +
            'On the phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead", ' +
            `then enter the code.${deadline ? ` The code is valid until about ${deadline}.` : ''}\n` +
            'After entering it, call whatsapp_status to confirm the link.',
        );
      }
      const { token } = ctx.qrTokens.issue();
      const url = ctx.qrUrl(token);
      const png = await QRCode.toBuffer(res.qr!, { type: 'png', margin: 2, width: 320, errorCorrectionLevel: 'M' });
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          {
            type: 'text',
            text:
              'Scan this QR in WhatsApp → Settings → Linked devices → Link a device.\n\n' +
              `The QR rotates about every 20 seconds, so the image above may go stale. Live page (always current, valid 5 minutes): ${url}\n` +
              `${deadline ? `Linking times out at about ${deadline}. ` : ''}After scanning, call whatsapp_status to confirm.`,
          },
        ],
      };
    } catch (err) {
      ctx.guardrails.audit.record({ action: 'login', result: 'error', error: (err as Error).message });
      return toErrorResult(err, ctx.logger);
    }
  },
});

export const whatsappLogout = defineTool({
  name: 'whatsapp_logout',
  title: 'Unlink WhatsApp',
  description:
    'Unlinks this server from WhatsApp (it disappears from the phone\'s Linked devices) and deletes the stored credentials. ' +
    'Only call this when the user explicitly asks. Requires confirm: true. Set wipeCache: true to also delete cached contacts, chats and messages.',
  inputSchema: {
    confirm: z.literal(true).describe('Must be true'),
    wipeCache: z.boolean().default(false).describe('Also delete cached contacts, chats and messages'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    try {
      const wasLinked = ctx.session.isLinked();
      const { remoteUnlinked } = await ctx.session.logout();
      if (args.wipeCache) ctx.cache.wipe();
      ctx.guardrails.audit.record({ action: 'logout', result: 'ok', error: args.wipeCache ? 'cache wiped' : null });
      if (!wasLinked) return textResult(`Was not linked; local credentials cleared${args.wipeCache ? ' and cache wiped' : ''}.`);
      return textResult(
        (remoteUnlinked
          ? 'Unlinked: the device was removed from the phone\'s Linked devices and local credentials were deleted.'
          : 'Local credentials were deleted, but the server could not reach WhatsApp to unlink remotely. ' +
            'Remove "whatsapp-mcp" manually from the phone\'s Linked devices list.') +
          (args.wipeCache ? ' Cache wiped.' : ''),
      );
    } catch (err) {
      ctx.guardrails.audit.record({ action: 'logout', result: 'error', error: (err as Error).message });
      return errorResult(`Logout failed: ${(err as Error).message}`);
    }
  },
});
