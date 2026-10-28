import { whatsappLogin, whatsappLogout, whatsappStatus } from './auth.js';
import type { ToolDef, ZodShape } from './common.js';
import { listChats, readMessages, searchContactsTool } from './read.js';
import { cancelDraft, confirmSend, prepareMessage, sendMessage } from './send.js';

/** The tools this server exposes, given whether two-step confirmation is required. */
export function toolList(requireConfirm: boolean): ToolDef<ZodShape>[] {
  const tools = [
    whatsappStatus,
    whatsappLogin,
    whatsappLogout,
    searchContactsTool,
    listChats,
    readMessages,
    prepareMessage,
    confirmSend,
    cancelDraft,
    ...(requireConfirm ? [] : [sendMessage]),
  ];
  return tools as unknown as ToolDef<ZodShape>[];
}

export type { ToolContext } from './common.js';
