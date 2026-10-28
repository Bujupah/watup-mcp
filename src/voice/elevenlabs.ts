/**
 * Minimal ElevenLabs client: text-to-speech for WhatsApp voice notes and speech-to-text for
 * incoming ones. Uses plain fetch so it has no extra dependencies.
 */

export interface SpeechAudio {
  audio: Buffer;
  /** MIME type to send to WhatsApp. */
  mimetype: string;
  /** True when the audio is Ogg/Opus and can be sent as a push-to-talk voice note. */
  ptt: boolean;
}

export interface Transcript {
  text: string;
  languageCode: string | null;
}

export interface VoiceInfo {
  voiceId: string;
  name: string;
  category: string | null;
  labels: Record<string, string>;
  languages: string[];
}

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  ttsModel: string;
  sttModel: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

const isOgg = (b: Buffer) => b.length > 4 && b.subarray(0, 4).toString('latin1') === 'OggS';
const isMp3 = (b: Buffer) =>
  b.length > 3 && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0));

export class ElevenLabs {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.base = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get defaultVoiceId(): string {
    return this.opts.voiceId;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { 'xi-api-key': this.opts.apiKey, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ElevenLabsError(`Could not reach ElevenLabs: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { detail?: { message?: string; status?: string } | string };
        detail = typeof body.detail === 'string' ? body.detail : (body.detail?.message ?? body.detail?.status ?? '');
      } catch {
        // non-JSON error body
      }
      const hint =
        res.status === 401 ? ' Check ELEVENLABS_API_KEY.' : res.status === 429 ? ' Rate limited or out of credits.' : '';
      throw new ElevenLabsError(`ElevenLabs returned ${res.status}${detail ? `: ${detail}` : ''}.${hint}`, res.status);
    }
    return res;
  }

  private async ttsRaw(text: string, voiceId: string, outputFormat: string): Promise<Buffer> {
    const res = await this.request(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/*' },
        body: JSON.stringify({ text, model_id: this.opts.ttsModel }),
      },
    );
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Synthesizes speech. Prefers Ogg/Opus (WhatsApp's native voice-note format); if the account or
   * model can't produce it, falls back to MP3, which WhatsApp plays as a regular audio file.
   */
  async tts(text: string, voiceId = this.opts.voiceId): Promise<SpeechAudio> {
    try {
      const opus = await this.ttsRaw(text, voiceId, 'opus_48000_64');
      if (isOgg(opus)) return { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    } catch (err) {
      // Only fall back when the format itself was refused; auth/credit errors should surface.
      if (!(err instanceof ElevenLabsError) || (err.status !== 400 && err.status !== 422 && err.status !== 403)) throw err;
    }
    const mp3 = await this.ttsRaw(text, voiceId, 'mp3_44100_128');
    if (!isMp3(mp3)) throw new ElevenLabsError('ElevenLabs returned audio in an unexpected format.');
    return { audio: mp3, mimetype: 'audio/mpeg', ptt: false };
  }

  /** Transcribes audio (any format ElevenLabs accepts, e.g. WhatsApp's Ogg/Opus voice notes). */
  async stt(audio: Buffer, mimetype: string, languageCode?: string): Promise<Transcript> {
    const form = new FormData();
    form.append('model_id', this.opts.sttModel);
    if (languageCode) form.append('language_code', languageCode);
    const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('mp4') ? 'm4a' : 'bin';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype.split(';')[0] }), `voice.${ext}`);
    const res = await this.request('/v1/speech-to-text', { method: 'POST', body: form });
    const body = (await res.json()) as { text?: string; language_code?: string };
    return { text: (body.text ?? '').trim(), languageCode: body.language_code ?? null };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await this.request('/v1/voices', { method: 'GET' });
    const body = (await res.json()) as {
      voices?: Array<{
        voice_id: string;
        name: string;
        category?: string;
        labels?: Record<string, string>;
        verified_languages?: Array<{ language?: string }>;
      }>;
    };
    return (body.voices ?? []).map((v) => ({
      voiceId: v.voice_id,
      name: v.name,
      category: v.category ?? null,
      labels: v.labels ?? {},
      languages: (v.verified_languages ?? []).map((l) => l.language).filter((l): l is string => !!l),
    }));
  }
}
