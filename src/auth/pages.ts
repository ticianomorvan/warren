// The pages of the web (docs/design.md, "The web"): the sign-in ("Continuar con Google"), the consent, the account page and the
// public documents (landing, privacy, terms). Server-rendered, no framework, no outside assets: one inline stylesheet and, where a
// button needs it, one small script, both under a CSP nonce. Mostly opened on a phone.

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
main.wide { max-width: 42rem; }
.brand { font-weight: 700; letter-spacing: .01em; margin: 4px 0 20px; }
.brand a { color: inherit; text-decoration: none; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px 20px;
}
h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 8px; text-wrap: balance; overflow-wrap: anywhere; }
p { margin: 0 0 14px; text-wrap: pretty; }
.muted { color: var(--muted); font-size: .9rem; }
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
.closed .live, .confirming .live, .confirming .status, .closed .ack { display: none; }
.closed .status { margin-top: 0; }
.ack p { margin-bottom: 16px; }
.ack b { overflow-wrap: anywhere; white-space: nowrap; }
p.foot { margin: 14px 0 0; }
.number { font-weight: 600; white-space: nowrap; }
ul.scopes { list-style: none; margin: 0 0 18px; padding: 0; }
ul.scopes li { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
ul.scopes li:first-child { border-top: 0; }
ul.scopes li::before { content: "✓"; color: var(--accent); font-weight: 700; flex: none; }
dl { margin: 0 0 16px; }
dt { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
dd { margin: 0 0 10px; font-weight: 600; overflow-wrap: anywhere; }
.doc h1 { font-size: 1.75rem; }
.doc h2 { font-size: 1.2rem; margin: 26px 0 8px; }
.doc h3 { font-size: 1.02rem; margin: 20px 0 6px; }
.doc ul, .doc ol { margin: 0 0 14px; padding-left: 1.3rem; }
.doc li { margin: 0 0 6px; }
.doc a { color: var(--accent); }
.doc code { background: var(--code); border-radius: 6px; padding: 1px 5px; font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.doc pre { background: var(--code); border-radius: 12px; padding: 12px 14px; overflow-x: auto; margin: 0 0 14px; }
.doc pre code { background: none; padding: 0; overflow-wrap: normal; }
.doc .foot a { color: var(--muted); }
nav.links { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 26px; font-size: .9rem; }
nav.links a { color: var(--muted); }
.err { color: var(--warn); font-size: .92rem; margin: 12px 0 0; }
`

export function shell(
  title: string,
  body: string,
  nonce: string,
  script = '',
  o: { indexable?: boolean; wide?: boolean } = {},
): string {
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
${o.indexable ? '' : '<meta name="robots" content="noindex">\n'}<title>${esc(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main${o.wide ? ' class="wide"' : ''}>
<div class="brand"><a href="/">Warren</a></div>
${body}
</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`
}

const SIGN_IN_SCRIPT = `
(() => {
  const button = document.getElementById('google');
  const err = document.getElementById('err');
  button.addEventListener('click', async () => {
    button.disabled = true;
    err.hidden = true;
    // With the signed query of an agent's authorization, signing in goes on to consent; without it, to the page that asked.
    const query = location.search.slice(1);
    const body = { provider: 'google', callbackURL: button.dataset.next };
    if (query) body.oauth_query = query;
    try {
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const next = res.ok ? await res.json() : null;
      if (next && next.url) { location.assign(next.url); return; }
    } catch {}
    err.textContent = 'No pudimos abrir Google. Probá de nuevo en un momento.';
    err.hidden = false;
    button.disabled = false;
  });
})();
`

export interface SignInView {
  nonce: string
  /** Who asks to connect ("Claude (claude.ai)"); empty when the person came to the account page. */
  client: string
  /** Where the browser goes after Google when there is no agent's authorization to continue (a path of ours). */
  next: string
}

/** The sign-in page: one button. Open to anyone with a Google account; no password, no email form. */
export function signInPage(v: SignInView): string {
  return shell(
    v.client ? 'Conectar con Warren' : 'Entrar a Warren',
    `<div class="card">
<h1>${v.client ? `Conectá ${esc(v.client)} con Warren` : 'Entrá a tu cuenta de Warren'}</h1>
<p>Entrás con tu cuenta de Google. Warren no lee tu mail ni tus archivos: solo usa Google para saber quién sos.</p>
<button class="btn primary" id="google" type="button" data-next="${esc(v.next)}">Continuar con Google</button>
<p class="err" id="err" role="alert" hidden></p>
<p class="muted foot">Al continuar aceptás los <a href="/terms">términos</a> y la <a href="/privacy">política de privacidad</a>.</p>
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
  offline_access:
    'Seguir conectado sin pedirte permiso de nuevo, hasta que desconectes tus agentes.',
}

export const scopeText = (scope: string) => SCOPE_TEXT[scope] ?? `Permiso “${scope}”.`

export interface ConsentView {
  nonce: string
  client: string
  /** The Google email of the person signed in: whose account this connects. */
  account: string
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
    err.textContent = 'No se pudo completar. Volvé a tu agente y empezá de nuevo.';
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
<dl>
${v.account ? `<dt>Se conecta a la cuenta de</dt><dd>${esc(v.account)}</dd>` : ''}
<dt>Después te lleva a</dt><dd>${esc(v.redirectHost)}</dd>
</dl>
<p>Con este permiso va a poder:</p>
<ul class="scopes">${v.scopes.map((s) => `<li>${esc(scopeText(s))}</li>`).join('')}</ul>
<button class="btn primary" type="button" data-accept="yes">Permitir</button>
<button class="btn secondary" type="button" data-accept="no">Cancelar</button>
<p class="err" id="err" role="alert" hidden></p>
<p class="muted foot">Si esa cuenta no es la tuya, o no empezaste esta conexión vos, tocá Cancelar.</p>
</div>`,
    v.nonce,
    CONSENT_SCRIPT,
  )
}

export interface AccountView {
  nonce: string
  email: string
  /** The session is younger than five minutes: deleting is allowed without signing in again. */
  fresh: boolean
}

const ACCOUNT_SCRIPT = `
(() => {
  const err = document.getElementById('err');
  const ok = document.getElementById('ok');
  const buttons = document.querySelectorAll('button[data-do]');
  const fail = (t) => { ok.hidden = true; err.textContent = t; err.hidden = false; buttons.forEach((b) => (b.disabled = false)); };
  async function post(path) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
  }
  async function reauth() {
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/account' }),
    });
    const next = res.ok ? await res.json() : null;
    if (next && next.url) location.assign(next.url); else fail('No pudimos abrir Google. Probá de nuevo.');
  }
  buttons.forEach((b) => b.addEventListener('click', async () => {
    err.hidden = true; ok.hidden = true;
    const action = b.dataset.do;
    if (action === 'reauth') { b.disabled = true; return reauth(); }
    if (action === 'delete' && !confirm('Se borra tu cuenta y todos tus movimientos, para siempre. ¿Seguro?')) return;
    buttons.forEach((x) => (x.disabled = true));
    try {
      const res = await post(action === 'delete' ? '/account/delete' : '/account/disconnect');
      if (res.ok && action === 'delete') { location.replace('/?cuenta=eliminada'); return; }
      if (res.ok) { ok.textContent = 'Listo: los agentes conectados tienen que pedir permiso de nuevo.'; ok.hidden = false; buttons.forEach((x) => (x.disabled = false)); return; }
      if (res.status === 403) return fail('Para borrar la cuenta tenés que volver a entrar con Google.');
    } catch {}
    fail('No se pudo completar. Probá de nuevo.');
  }));
  const out = document.getElementById('signout');
  if (out) out.addEventListener('click', async () => { await post('/api/auth/sign-out'); location.replace('/'); });
})();
`

/** The account page: who is signed in, and the three things that cannot wait for an agent: disconnect, download, delete. */
export function accountPage(v: AccountView): string {
  return shell(
    'Tu cuenta',
    `<div class="card">
<h1>Tu cuenta</h1>
<dl><dt>Entraste con</dt><dd>${esc(v.email)}</dd></dl>
<h2>Agentes conectados</h2>
<p class="muted">Corta el acceso de todos los agentes que conectaste (Claude, ChatGPT, Cursor…). Después tienen que pedirte permiso de nuevo.</p>
<button class="btn secondary" type="button" data-do="disconnect">Desconectar todos los agentes</button>
<h2>Tus datos</h2>
<p class="muted">Todo lo que Warren guarda de vos, en un archivo JSON.</p>
<a class="btn secondary" href="/account/export" download="warren.json">Descargar mis datos</a>
<h2>Borrar la cuenta</h2>
<p class="muted">Borra tu cuenta y todos tus movimientos, sin vuelta atrás. ${v.fresh ? '' : 'Antes tenés que volver a entrar con Google.'}</p>
${
  v.fresh
    ? '<button class="btn secondary" type="button" data-do="delete">Borrar mi cuenta</button>'
    : '<button class="btn secondary" type="button" data-do="reauth">Volver a entrar con Google</button>'
}
<p class="err" id="err" role="alert" hidden></p>
<p class="status" id="ok" role="status" hidden></p>
<p class="muted foot"><button class="btn secondary" id="signout" type="button">Salir</button></p>
</div>`,
    v.nonce,
    ACCOUNT_SCRIPT,
  )
}

/** A public document (landing, privacy, terms) from its Markdown, with links to the others. Indexable. */
export function documentPage(title: string, html: string, nonce: string): string {
  return shell(
    title,
    `<div class="card doc">${html}<nav class="links"><a href="/">Inicio</a><a href="/privacy">Privacidad</a><a href="/terms">Términos</a><a href="/setup.md">Setup (para agentes)</a><a href="/account">Mi cuenta</a></nav></div>`,
    nonce,
    '',
    { indexable: true, wide: true },
  )
}
