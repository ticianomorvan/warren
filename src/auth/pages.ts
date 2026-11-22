// The two pages a person sees while connecting an agent: the sign-in (a code to send on WhatsApp) and the
// consent. Server-rendered, no framework, no outside assets: one inline stylesheet and one small script, both
// under a CSP nonce. Mostly opened on a phone, and the person comes back to it from WhatsApp.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f5f1; --card: #ffffff; --fg: #1f1d1a; --muted: #6a645c; --line: #e4dfd6;
  --accent: #0b6b4d; --accent-fg: #ffffff; --accent-soft: #e3f1ea; --code: #f1ede6; --warn: #8a3b12;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14130f; --card: #1d1c17; --fg: #f1eee8; --muted: #a39d92; --line: #302e27;
    --accent: #5fc79f; --accent-fg: #0c1f17; --accent-soft: #183126; --code: #26241d; --warn: #f0a77d;
  }
}
* { box-sizing: border-box; }
html { -webkit-tap-highlight-color: transparent; overscroll-behavior: none; -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100dvh; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
main { width: 100%; max-width: 27rem; margin: 0 auto; }
.brand { font-weight: 700; letter-spacing: .01em; margin: 4px 0 20px; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px 20px;
}
h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 8px; text-wrap: balance; overflow-wrap: anywhere; }
p { margin: 0 0 14px; text-wrap: pretty; }
.muted { color: var(--muted); font-size: .9rem; }
.code {
  display: block; width: 100%; background: var(--code); border-radius: 12px; padding: 14px 12px;
  font: 600 1.35rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .06em;
  text-align: center; user-select: all; -webkit-user-select: all; overflow-wrap: anywhere; margin: 0 0 16px;
}
.code b { font-size: 1.9rem; letter-spacing: .14em; display: block; margin-top: 4px; }
.btn {
  display: flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; padding: 0 18px;
  border-radius: 12px; border: 1px solid transparent; font: inherit; font-weight: 600; text-decoration: none;
  cursor: pointer; touch-action: manipulation; user-select: none; -webkit-user-select: none;
  transition: transform .12s ease, background-color .12s ease;
}
.btn:active { transform: scale(.98); }
.btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.primary { background: var(--accent); color: var(--accent-fg); }
.secondary { background: transparent; color: var(--fg); border-color: var(--line); margin-top: 10px; }
.btn[disabled] { opacity: .55; cursor: default; }
@media (hover: hover) and (pointer: fine) {
  .primary:hover { filter: brightness(1.08); }
  .secondary:hover { background: var(--code); }
}
.status {
  display: flex; gap: 10px; align-items: flex-start; margin: 18px 0 0; padding: 12px 14px;
  background: var(--accent-soft); border-radius: 12px; font-size: .95rem;
}
.status.bad { background: transparent; border: 1px solid var(--line); color: var(--warn); }
.dot { flex: none; width: 10px; height: 10px; margin-top: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
.bad .dot, .done .dot { animation: none; }
.bad .dot { background: var(--warn); }
@keyframes pulse { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } .btn { transition: none; } }
p.tight { margin-top: 14px; }
.closed .live { display: none; }
.closed .status { margin-top: 0; }
p.foot { margin: 14px 0 0; }
.number { font-weight: 600; white-space: nowrap; }
ul.scopes { list-style: none; margin: 0 0 18px; padding: 0; }
ul.scopes li { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
ul.scopes li:first-child { border-top: 0; }
ul.scopes li::before { content: "✓"; color: var(--accent); font-weight: 700; flex: none; }
dl { margin: 0 0 16px; }
dt { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
dd { margin: 0 0 10px; font-weight: 600; overflow-wrap: anywhere; }
.err { color: var(--warn); font-size: .92rem; margin: 12px 0 0; }
`

function shell(title: string, body: string, nonce: string, script = ''): string {
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<div class="brand">Warren</div>
${body}
</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`
}

export interface SignInView {
  nonce: string
  client: string
  code: string
  /** The WhatsApp number as the person reads it ("+54 9 11 …"). */
  displayNumber: string
  /** The `wa.me` link with the message already written. */
  waLink: string
  minutes: number
}

const SIGN_IN_SCRIPT = `
(() => {
  const status = document.getElementById('status');
  const text = document.getElementById('status-text');
  const query = location.search.slice(1);
  const say = (t, kind) => { text.textContent = t; status.className = 'status ' + (kind || ''); };
  const copy = document.getElementById('copy');
  if (copy && navigator.clipboard) {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(copy.dataset.text); copy.textContent = 'Copiado'; }
      catch { copy.textContent = 'Copialo a mano'; }
    });
  }
  let finished = false;
  async function complete() {
    finished = true;
    say('Listo, conectando…', 'done');
    try {
      const res = await fetch('/api/auth/warren/link/complete', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oauth_query: query }),
      });
      const next = res.ok ? await res.json() : null;
      if (next && next.url) { location.replace(next.url); return; }
    } catch {}
    say('No pudimos terminar la conexión. Volvé a Claude y probá de nuevo.', 'bad');
  }
  async function poll() {
    if (finished) return;
    try {
      const res = await fetch('/sign-in/status', { credentials: 'same-origin', cache: 'no-store' });
      const { state } = await res.json();
      if (state === 'confirmed') return complete();
      if (state === 'closed') { finished = true; document.body.classList.add('closed'); return say('Este código venció. Volvé a Claude y tocá conectar de nuevo.', 'bad'); }
      say(state === 'asked' ? 'Warren te preguntó por WhatsApp. Respondé “sí” para conectar.' : 'Esperando tu mensaje…');
    } catch {}
    setTimeout(poll, 2000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !finished) poll(); });
  poll();
})();
`

/** The sign-in page: the code to send, the WhatsApp link, and a line that follows the progress. */
export function signInPage(v: SignInView): string {
  const message = `vincular ${v.code}`
  return shell(
    'Conectar con Warren',
    `<div class="card">
<h1>Conectá ${esc(v.client)} con Warren</h1>
<p class="live">Para confirmar que sos vos, mandale este mensaje a Warren por WhatsApp:</p>
<span class="code live" aria-label="Mensaje: vincular ${esc(v.code.split('').join(' '))}">vincular<b>${esc(v.code)}</b></span>
<a class="btn primary live" href="${esc(v.waLink)}" rel="noopener">Abrir WhatsApp</a>
<button class="btn secondary live" id="copy" type="button" data-text="${esc(message)}" hidden>Copiar mensaje</button>
<p class="muted tight live">¿Estás en la compu? Mandalo desde tu celular al <span class="number">${esc(v.displayNumber)}</span>.</p>
<div class="status" id="status" role="status" aria-live="polite"><span class="dot"></span><span id="status-text">Esperando tu mensaje…</span></div>
<p class="muted foot live">El código vence a los ${v.minutes} minutos. Si no fuiste vos quien pidió conectar, cerrá esta página.</p>
</div>`,
    v.nonce,
    SIGN_IN_SCRIPT,
  )
}

/** A page with one message: a link opened without its flow, a sign-in table that is full. */
export function messagePage(nonce: string, title: string, message: string): string {
  return shell(title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`, nonce)
}

/** What each scope lets the client do, in the person's words. */
const SCOPE_TEXT: Record<string, string> = {
  'ledger:read': 'Ver tus movimientos y pedir resúmenes de tus gastos.',
  'ledger:write':
    'Anotar, corregir y borrar movimientos, y guardar o borrar lo que Warren recuerda de vos.',
  offline_access: 'Seguir conectado sin pedirte permiso de nuevo, hasta que lo desconectes.',
}

export const scopeText = (scope: string) => SCOPE_TEXT[scope] ?? `Permiso “${scope}”.`

export interface ConsentView {
  nonce: string
  client: string
  /** The host the client is sent back to with the code. */
  redirectHost: string
  scopes: string[]
}

const CONSENT_SCRIPT = `
(() => {
  const query = location.search.slice(1);
  const buttons = document.querySelectorAll('button[data-accept]');
  const err = document.getElementById('err');
  async function answer(accept) {
    buttons.forEach((b) => (b.disabled = true));
    err.hidden = true;
    try {
      const res = await fetch('/api/auth/oauth2/consent', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept, oauth_query: query }),
      });
      const next = res.ok ? await res.json() : null;
      if (next && next.url) { location.replace(next.url); return; }
    } catch {}
    err.textContent = 'No se pudo completar. Volvé a Claude y empezá de nuevo.';
    err.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
  buttons.forEach((b) => b.addEventListener('click', () => answer(b.dataset.accept === 'yes')));
})();
`

/** The consent page: who asks, where they are sent back to, what they get, and two buttons. */
export function consentPage(v: ConsentView): string {
  return shell(
    'Permitir acceso a Warren',
    `<div class="card">
<h1>${esc(v.client)} quiere acceder a tu Warren</h1>
<dl><dt>Después te lleva a</dt><dd>${esc(v.redirectHost)}</dd></dl>
<p>Con este permiso va a poder:</p>
<ul class="scopes">${v.scopes.map((s) => `<li>${esc(scopeText(s))}</li>`).join('')}</ul>
<button class="btn primary" type="button" data-accept="yes">Permitir</button>
<button class="btn secondary" type="button" data-accept="no">Cancelar</button>
<p class="err" id="err" role="alert" hidden></p>
<p class="muted foot">Si no empezaste esta conexión vos, tocá Cancelar.</p>
</div>`,
    v.nonce,
    CONSENT_SCRIPT,
  )
}
