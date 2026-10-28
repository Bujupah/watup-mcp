import QRCode from 'qrcode';
import type { SessionManager } from '../whatsapp/session.js';

export interface QrPayload {
  state: string;
  qr?: string;
  pairingCode?: string;
  linkedAs?: string;
  scanDeadline?: string;
  lastError?: string;
}

/** Renders QR strings to data URLs, caching the latest one (QRs rotate ~every 20s). */
export class QrRenderer {
  private last: { qr: string; url: string } | undefined;

  async dataUrl(qr: string): Promise<string> {
    if (this.last?.qr === qr) return this.last.url;
    const url = await QRCode.toDataURL(qr, { margin: 2, width: 320, errorCorrectionLevel: 'M' });
    this.last = { qr, url };
    return url;
  }
}

export async function buildQrPayload(session: SessionManager, renderer: QrRenderer): Promise<QrPayload> {
  const s = session.getStatus();
  const qr = session.getCurrentQr();
  return {
    state: s.state,
    ...(qr ? { qr: await renderer.dataUrl(qr) } : {}),
    ...(s.pairingCode ? { pairingCode: s.pairingCode } : {}),
    ...(s.linkedAs ? { linkedAs: s.linkedAs } : {}),
    ...(s.scanDeadline ? { scanDeadline: s.scanDeadline } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
  };
}

/** The /qr page. All dynamic content arrives over SSE and is inserted with textContent / img.src only. */
export function renderQrPage(token: string, nonce: string): string {
  const eventsUrl = `/qr/events?t=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Link WhatsApp</title>
<style nonce="${nonce}">
  :root { --bg:#f6f7f8; --fg:#1b1f23; --muted:#5b6670; --card:#fff; --ok:#128c4a; --err:#b42318; --border:#e3e6e8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111417; --fg:#e8eaed; --muted:#9aa4ad; --card:#1a1e22; --border:#2a3036; --ok:#3ccf7a; --err:#ff6b5e; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--fg);
         font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:16px; }
  main { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; max-width:420px; width:100%; text-align:center; }
  h1 { font-size:20px; margin:0 0 4px; }
  .state { color:var(--muted); font-size:14px; margin-bottom:20px; }
  .qr { background:#fff; border-radius:12px; padding:12px; display:inline-block; }
  .qr img { display:block; width:280px; height:280px; max-width:70vw; max-height:70vw; image-rendering:pixelated; }
  .code { font: 600 34px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:4px; margin:16px 0; }
  .steps { text-align:left; color:var(--muted); font-size:14px; margin:20px 0 0; padding-left:20px; }
  .ok { color:var(--ok); font-weight:600; font-size:18px; }
  .err { color:var(--err); font-size:14px; margin-top:12px; }
  .countdown { color:var(--muted); font-size:13px; margin-top:12px; font-variant-numeric: tabular-nums; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>Link WhatsApp</h1>
  <div class="state" id="state">Connecting…</div>
  <div class="qr" id="qrbox" hidden><img id="qr" alt="WhatsApp linking QR code"></div>
  <div class="code" id="code" hidden></div>
  <div class="ok" id="ok" hidden></div>
  <div class="countdown" id="countdown" hidden></div>
  <div class="err" id="err" hidden></div>
  <ol class="steps" id="steps" hidden>
    <li>Open WhatsApp on your phone.</li>
    <li>Settings → Linked devices → Link a device.</li>
    <li id="step3">Point your phone at this QR code. It refreshes automatically.</li>
  </ol>
</main>
<script nonce="${nonce}">
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var deadline = null;
  var labels = { disconnected: 'Not linked', connecting: 'Connecting…', awaiting_scan: 'Waiting for you to scan', connected: 'Connected', logged_out: 'Logged out' };
  function show(el, on) { el.hidden = !on; }
  function render(p) {
    $('state').textContent = labels[p.state] || p.state;
    var scanning = p.state === 'awaiting_scan';
    show($('qrbox'), scanning && !!p.qr && !p.pairingCode);
    if (p.qr) $('qr').src = p.qr;
    show($('code'), scanning && !!p.pairingCode);
    if (p.pairingCode) $('code').textContent = p.pairingCode.length === 8 ? p.pairingCode.slice(0, 4) + '-' + p.pairingCode.slice(4) : p.pairingCode;
    $('step3').textContent = p.pairingCode ? 'Tap "Link with phone number instead" and enter the code above.' : 'Point your phone at this QR code. It refreshes automatically.';
    show($('steps'), scanning);
    show($('ok'), p.state === 'connected');
    if (p.state === 'connected') $('ok').textContent = 'Linked as ' + (p.linkedAs || 'your account') + '. You can close this page.';
    show($('err'), !!p.lastError && p.state !== 'connected');
    $('err').textContent = p.lastError || '';
    deadline = scanning && p.scanDeadline ? new Date(p.scanDeadline).getTime() : null;
    tick();
  }
  function tick() {
    if (!deadline) { show($('countdown'), false); return; }
    var s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    $('countdown').textContent = 'Linking window closes in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    show($('countdown'), true);
  }
  setInterval(tick, 1000);
  var es = new EventSource(${JSON.stringify(eventsUrl)});
  es.addEventListener('status', function (e) {
    var p = JSON.parse(e.data);
    render(p);
    if (p.state === 'connected') es.close();
  });
  es.addEventListener('expired', function () {
    es.close();
    $('err').textContent = 'This link has expired. Call whatsapp_login again for a new one.';
    show($('err'), true);
  });
  es.onerror = function () { $('state').textContent = 'Reconnecting to server…'; };
})();
</script>
</body>
</html>`;
}
