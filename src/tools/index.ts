import { whatsappLogin, whatsappLogout, whatsappStatus } from './auth.js';
import { confirmCall, getCall, prepareCall } from './calls.js';
import type { ToolDef, ZodShape } from './common.js';
import { getMedia } from './getMedia.js';
import { prepareMedia } from './media.js';
import { listChats, readMessages, searchContactsTool } from './read.js';
import { cancelDraft, confirmSend, prepareMessage, sendMessage } from './send.js';

/** The tools this server exposes, given whether two-step confirmation is required. */
export function toolList(requireConfirm: boolean, opts: { calls?: boolean } = {}): ToolDef<ZodShape>[] {
  const tools = [
    whatsappStatus,
    whatsappLogin,
    whatsappLogout,
    searchContactsTool,
    listChats,
    readMessages,
    getMedia,
    prepareMessage,
    prepareMedia,
    confirmSend,
    cancelDraft,
    ...(requireConfirm ? [] : [sendMessage]),
    ...(opts.calls ? [prepareCall, confirmCall, getCall] : []),
  ];
  return tools as unknown as ToolDef<ZodShape>[];
}

export type { ToolContext } from './common.js';
