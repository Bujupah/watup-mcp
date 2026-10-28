import { z } from 'zod';
import type { DraftVoice } from '../guardrails/drafts.js';
import { MAX_MESSAGE_LENGTH } from '../guardrails/index.js';
import { displayJid, isPnJid, phoneFromJid } from '../whatsapp/jid.js';
import {
  ToolError,
  defineTool,
  errorResult,
  jsonResult,
  requireConnected,
  resolveRecipient,
  textResult,
  toErrorResult,
  type ResolvedRecipient,
  type ToolContext,
} from './common.js';

const POLICY =
  'Never send bulk, marketing or unsolicited messages; only message people the user explicitly asked you to contact.';

const toSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Recipient: JID, phone number with country code, or exact contact/group name (resolve names with search_contacts first)');
const textSchema = z.string().min(1).max(MAX_MESSAGE_LENGTH * 4).describe(`Message text (max ${MAX_MESSAGE_LENGTH} characters)`);

/** Resolves the recipient and, for never-seen phone numbers, checks the number is on WhatsApp. */
export async function resolveForSend(to: string, ctx: ToolContext): Promise<ResolvedRecipient> {
  const r = resolveRecipient(to, ctx.cache);
  if (isPnJid(r.jid) && !ctx.cache.getContact(r.jid) && !ctx.cache.getChat(r.jid) && !ctx.guardrails.audit.hasSuccessfulSendTo(r.jid)) {
    const check = await ctx.session.onWhatsApp(phoneFromJid(r.jid)!);
    if (!check.exists) throw new ToolError(`${displayJid(r.jid)} is not registered on WhatsApp. Double-check the number with the user.`);
  }
  return r;
}

export function prepare(ctx: ToolContext, r: ResolvedRecipient, text: string, voice?: DraftVoice) {
  ctx.guardrails.checkText(text);
  const { isNewRecipient } = ctx.guardrails.check(r.jid);
  const draft = ctx.guardrails.drafts.create(r.jid, text, voice);
  ctx.guardrails.audit.record({ action: 'prepare', toJid: r.jid, draftId: draft.id, result: 'ok', newRecipient: isNewRecipient });
  ctx.logger.debug({ draftId: draft.id, to: r.jid, text }, 'draft created');
  return { draft, isNewRecipient };
}

/** Claims a draft, re-checks guardrails and sends it. */
export async function sendDraft(ctx: ToolContext, draftId: string) {
  const claim = ctx.guardrails.drafts.claim(draftId);
  if (!claim.ok) {
    const why: Record<typeof claim.reason, string> = {
      not_found: `No draft with id ${draftId}. Call prepare_message first.`,
      expired: 'This draft has expired (drafts last 10 minutes). Call prepare_message again and get the user\'s approval.',
      already_sent: 'This draft was already sent. Not sending it twice.',
      cancelled: 'This draft was cancelled.',
      in_progress: 'This draft is being sent right now.',
      failed: 'Sending this draft failed earlier. Call prepare_message again to retry.',
    };
    ctx.guardrails.audit.record({ action: 'confirm', draftId, result: 'rejected', error: claim.reason });
    throw new ToolError(why[claim.reason]);
  }
  const draft = claim.draft;
  if (draft.kind === 'call') {
    ctx.guardrails.drafts.release(draftId);
    throw new ToolError(`Draft ${draftId} is a phone call. Use confirm_call for it.`);
  }
  let isNewRecipient: boolean;
  try {
    requireConnected(ctx);
    ({ isNewRecipient } = ctx.guardrails.check(draft.to_jid));
  } catch (err) {
    ctx.guardrails.drafts.release(draftId);
    ctx.guardrails.audit.record({ action: 'confirm', toJid: draft.to_jid, draftId, result: 'rejected', error: (err as Error).message });
    throw err;
  }
  ctx.guardrails.audit.record({ action: 'confirm', toJid: draft.to_jid, draftId, result: 'ok' });
  ctx.guardrails.rate.consume();
  try {
    let sent: { id: string; timestamp: number };
    if (draft.kind === 'voice') {
      if (!draft.audio || !draft.audio_mime) throw new Error('voice draft has no audio');
      sent = await ctx.session.sendVoice(draft.to_jid, draft.audio, draft.audio_mime, draft.ptt === 1);
    } else {
      sent = await ctx.session.sendText(draft.to_jid, draft.text);
    }
    ctx.guardrails.drafts.markSent(draftId);
    ctx.guardrails.audit.record({ action: 'send', toJid: draft.to_jid, draftId, result: 'ok', newRecipient: isNewRecipient });
    ctx.logger.info({ draftId, to: draft.to_jid, messageId: sent.id }, 'message sent');
    return { draft, sent };
  } catch (err) {
    ctx.guardrails.drafts.markFailed(draftId);
    ctx.guardrails.audit.record({ action: 'send', toJid: draft.to_jid, draftId, result: 'error', error: (err as Error).message });
    throw new ToolError(`Sending failed: ${(err as Error).message}. Nothing was sent; prepare a new draft to retry.`);
  }
}

export const prepareMessage = defineTool({
  name: 'prepare_message',
  title: 'Draft a WhatsApp message',
  description:
    'Step 1 of 2 for sending. Resolves the recipient, runs guardrails (allowlist, rate limits, length) and creates a draft ' +
    'valid for 10 minutes. It does NOT send. Show the user the exact recipient and text from the result and get their ' +
    `explicit approval before calling confirm_send. If given a name, resolve it with search_contacts first. ${POLICY}`,
  inputSchema: { to: toSchema, text: textSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      requireConnected(ctx);
      ctx.guardrails.checkText(args.text);
      const r = await resolveForSend(args.to, ctx);
      const { draft, isNewRecipient } = prepare(ctx, r, args.text);
      return jsonResult(
        `Draft ${draft.id} created. NOT sent yet. Show the user the recipient and text below and ask for explicit approval; ` +
          'then call confirm_send with this draftId (or cancel_draft).',
        {
          draftId: draft.id,
          resolvedName: r.name,
          jid: r.jid,
          to: r.display,
          preview: args.text,
          length: args.text.length,
          firstMessageToThisRecipient: isNewRecipient,
          expiresAt: new Date(draft.expires_at).toISOString(),
        },
      );
    } catch (err) {
      ctx.guardrails.audit.record({ action: 'prepare', result: 'rejected', error: (err as Error).message });
      return toErrorResult(err, ctx.logger);
    }
  },
});

export const confirmSend = defineTool({
  name: 'confirm_send',
  title: 'Send a drafted WhatsApp message',
  description:
    'Step 2 of 2: sends a draft created by prepare_message. Only call this after the user has seen the draft and explicitly ' +
    `approved sending it. Each draft can be sent once. ${POLICY}`,
  inputSchema: { draftId: z.string().min(1).max(64) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    try {
      const { draft, sent } = await sendDraft(ctx, args.draftId);
      return jsonResult(`Sent to ${ctx.cache.displayName(draft.to_jid) ?? displayJid(draft.to_jid)}.`, {
        messageId: sent.id,
        timestamp: new Date(sent.timestamp).toISOString(),
        jid: draft.to_jid,
      });
    } catch (err) {
      return toErrorResult(err, ctx.logger);
    }
  },
});

export const cancelDraft = defineTool({
  name: 'cancel_draft',
  title: 'Cancel a WhatsApp draft',
  description: 'Cancels a draft created by prepare_message so it can no longer be sent.',
  inputSchema: { draftId: z.string().min(1).max(64) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const res = ctx.guardrails.drafts.cancel(args.draftId);
    if (res.ok) {
      ctx.guardrails.audit.record({ action: 'cancel', toJid: res.draft.to_jid, draftId: args.draftId, result: 'ok' });
      return textResult(`Draft ${args.draftId} cancelled.`);
    }
    if (res.reason === 'cancelled') return textResult(`Draft ${args.draftId} was already cancelled.`);
    if (res.reason === 'not_found') return errorResult(`No draft with id ${args.draftId}.`);
    return errorResult(`Draft ${args.draftId} cannot be cancelled (${res.reason.replace('_', ' ')}).`);
  },
});

/** One-step send. Only registered when WA_MCP_REQUIRE_CONFIRM=false. */
export const sendMessage = defineTool({
  name: 'send_message',
  title: 'Send a WhatsApp message',
  description:
    'Sends a text message immediately (two-step confirmation is disabled on this server). Still subject to the allowlist ' +
    `and rate limits. Confirm the recipient and text with the user before sending. ${POLICY}`,
  inputSchema: { to: toSchema, text: textSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    try {
      requireConnected(ctx);
      ctx.guardrails.checkText(args.text);
      const r = await resolveForSend(args.to, ctx);
      const { draft } = prepare(ctx, r, args.text);
      const { sent } = await sendDraft(ctx, draft.id);
      return jsonResult(`Sent to ${r.display}.`, {
        messageId: sent.id,
        timestamp: new Date(sent.timestamp).toISOString(),
        jid: r.jid,
      });
    } catch (err) {
      return toErrorResult(err, ctx.logger);
    }
  },
});
