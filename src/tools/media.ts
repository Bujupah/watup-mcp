import { z } from 'zod';
import { fetchMedia } from '../media/fetchMedia.js';
import { ToolError, defineTool, jsonResult, requireConnected, toErrorResult } from './common.js';
import { resolveForSend } from './send.js';

const MAX_CAPTION = 1024;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export const prepareMedia = defineTool({
  name: 'prepare_media',
  title: 'Draft a WhatsApp image or document',
  description:
    'Step 1 of 2 for sending an image (JPEG/PNG/WebP) or a document (PDF, etc.) from a public https:// link, with an ' +
    'optional caption. Downloads and checks the file, runs guardrails and creates a draft valid for 10 minutes. It does NOT ' +
    'send. Show the user the recipient, file and caption, get explicit approval, then call confirm_send with the draftId. ' +
    'Audio and video are not supported. Never send bulk, marketing or unsolicited messages.',
  inputSchema: {
    to: z.string().min(1).max(200).describe('Recipient: JID, phone number with country code, or exact contact/group name'),
    url: z.string().min(1).max(2048).describe('Direct https:// link to the file'),
    kind: z.enum(['image', 'document']).describe('"image" shows inline in the chat; "document" arrives as a file'),
    caption: z.string().max(MAX_CAPTION).optional().describe(`Optional caption (max ${MAX_CAPTION} characters)`),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    try {
      requireConnected(ctx);
      const r = await resolveForSend(args.to, ctx);
      // Guardrails before downloading anything.
      const { isNewRecipient } = ctx.guardrails.check(r.jid);
      const media = await (ctx.fetchMedia ?? ((u, k) => fetchMedia(u, k, { maxBytes: DEFAULT_MAX_BYTES })))(args.url, args.kind);
      if (media.kind !== args.kind) throw new ToolError('Unexpected media kind.');
      const caption = args.caption?.trim() ?? '';
      const draft = ctx.guardrails.drafts.createMedia(r.jid, caption, media);
      ctx.guardrails.audit.record({ action: 'prepare', toJid: r.jid, draftId: draft.id, result: 'ok', newRecipient: isNewRecipient });
      const summary = jsonResult(
        `Draft ${draft.id} created. NOT sent yet. Show the user the recipient, file and caption below and ask for explicit ` +
          'approval; then call confirm_send with this draftId (or cancel_draft).',
        {
          draftId: draft.id,
          resolvedName: r.name,
          jid: r.jid,
          to: r.display,
          kind: media.kind,
          fileName: media.fileName,
          mimetype: media.mimetype,
          sizeKB: Math.ceil(media.data.length / 1024),
          caption: caption || null,
          firstMessageToThisRecipient: isNewRecipient,
          expiresAt: new Date(draft.expires_at).toISOString(),
        },
      );
      // Let the user see the image they're approving.
      if (media.kind === 'image' && media.data.length <= 4 * 1024 * 1024) {
        summary.content.unshift({ type: 'image', data: media.data.toString('base64'), mimeType: media.mimetype });
      }
      return summary;
    } catch (err) {
      ctx.guardrails.audit.record({ action: 'prepare', result: 'rejected', error: (err as Error).message });
      return toErrorResult(err, ctx.logger);
    }
  },
});
