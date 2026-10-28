/**
 * Outbound phone calls through an ElevenLabs Conversational AI agent. ElevenLabs dials the number
 * from a phone number imported into the workspace (Twilio or a SIP trunk) and the agent holds the
 * conversation. This is a regular phone call, not a WhatsApp call.
 */

export type CallProvider = 'twilio' | 'sip_trunk';

export interface CallsOptions {
  apiKey: string;
  agentId: string;
  /** ElevenLabs id of the imported phone number to call from. */
  phoneNumberId: string;
  provider: CallProvider;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PlacedCall {
  conversationId: string;
  callId: string | null;
}

export interface CallTurn {
  role: string;
  message: string;
  atSecs: number | null;
}

export interface CallDetails {
  conversationId: string;
  status: string;
  durationSecs: number | null;
  transcript: CallTurn[];
  summary: string | null;
}

export class CallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

export class ElevenLabsCalls {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CallsOptions) {
    this.base = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { 'xi-api-key': this.opts.apiKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new CallError(`Could not reach ElevenLabs: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const d = body.detail as { message?: string } | string | undefined;
      const detail = typeof d === 'string' ? d : (d?.message ?? '');
      throw new CallError(`ElevenLabs returned ${res.status}${detail ? `: ${detail}` : ''}.`, res.status);
    }
    return body as T;
  }

  /** Starts an outbound call. `toNumber` must be E.164, e.g. +21698123456. */
  async placeCall(toNumber: string, dynamicVariables: Record<string, string> = {}): Promise<PlacedCall> {
    const path = this.opts.provider === 'sip_trunk' ? '/v1/convai/sip-trunk/outbound-call' : '/v1/convai/twilio/outbound-call';
    const body = await this.request<{
      success?: boolean;
      message?: string;
      conversation_id?: string | null;
      callSid?: string | null;
      sip_call_id?: string | null;
    }>(path, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.opts.agentId,
        agent_phone_number_id: this.opts.phoneNumberId,
        to_number: toNumber,
        conversation_initiation_client_data: { dynamic_variables: dynamicVariables },
      }),
    });
    if (body.success === false || !body.conversation_id) {
      throw new CallError(`The call could not be started${body.message ? `: ${body.message}` : '.'}`);
    }
    return { conversationId: body.conversation_id, callId: body.callSid ?? body.sip_call_id ?? null };
  }

  /** Fetches status and transcript of a call. */
  async getCall(conversationId: string): Promise<CallDetails> {
    const body = await this.request<{
      conversation_id?: string;
      status?: string;
      transcript?: Array<{ role?: string; message?: string | null; time_in_call_secs?: number }>;
      metadata?: { call_duration_secs?: number };
      analysis?: { transcript_summary?: string | null };
    }>(`/v1/convai/conversations/${encodeURIComponent(conversationId)}`, { method: 'GET' });
    return {
      conversationId: body.conversation_id ?? conversationId,
      status: body.status ?? 'unknown',
      durationSecs: body.metadata?.call_duration_secs ?? null,
      transcript: (body.transcript ?? [])
        .filter((t) => t.message)
        .map((t) => ({ role: t.role ?? 'unknown', message: t.message!, atSecs: t.time_in_call_secs ?? null })),
      summary: body.analysis?.transcript_summary ?? null,
    };
  }
}
