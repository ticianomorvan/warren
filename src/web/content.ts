/**
 * The words of the web, in Markdown: the single source of every public page and of its twin for agents. `site.ts` serves each as
 * HTML (people) and as Markdown (agents: `/setup.md`, `/privacy.md`, `/terms.md`, and `Accept: text/markdown` on `/`). Each takes the
 * public URL, so a link or a command is always the one of the host that serves it.
 */

/** The repository, where bugs and privacy requests go: Warren has no company and no support mailbox. */
export const REPO = 'https://github.com/ticianomorvan/warren'

export const landing = (url: string): string => `# Warren

Tu libro de gastos, dentro del agente que ya usás.

Warren guarda tus gastos e ingresos (en pesos y dólares) y los deja en manos de tu agente: Claude, ChatGPT, Cursor o el que prefieras. Le decís "café 3500 con la visa" o le pasás el resumen de la tarjeta, y Warren lo anota. Le preguntás "¿cuánto gasté este mes en el súper?" y la cuenta la hace Warren, no el modelo: los totales nunca se inventan.

## Cómo empezar

Decile a tu agente: **"Configurá Warren desde ${url}"**. Él lee [las instrucciones](${url}/setup.md), conecta Warren a su cliente y solo te pide lo que no puede hacer solo: entrar con tu cuenta de Google y permitir el acceso.

## Qué tenés que saber

- Entrás con Google, sin contraseña. Warren no lee tu mail ni tus archivos: tu agente sí puede leerlos, Warren no.
- Nada se pisa ni se borra: cada corrección es una versión nueva, y siempre podés deshacer lo último.
- Desde [tu cuenta](${url}/account) desconectás todos los agentes, descargás todos tus datos o borrás todo.
- Es un proyecto personal y gratuito, sin empresa detrás. El código es abierto: ${REPO}.

[Privacidad](${url}/privacy) · [Términos](${url}/terms) · [Instrucciones para agentes](${url}/setup.md)
`

export const setup = (url: string): string => {
  const mcp = `${url}/mcp`
  const cursor = Buffer.from(JSON.stringify({ url: mcp })).toString('base64')
  const vscode = encodeURIComponent(JSON.stringify({ name: 'warren', type: 'http', url: mcp }))
  return `# Set up Warren

Warren is a personal-finance ledger (spending and income, ARS and USD) served as an MCP server. You, the agent, drive it for the person:
you turn a sentence, a statement or a spreadsheet into movements, and Warren stores them, keeps every version and computes every total.
This page is for you. If a person told you "set up Warren", do the steps below in your own client and hand the person only what you cannot do yourself.

## The server

- URL: \`${mcp}\`
- Transport: Streamable HTTP. No API key.
- Auth: OAuth 2.1 authorization code with PKCE, signing in with Google. Clients identify themselves with a Client ID Metadata Document (CIMD) served over https from any public host, or register themselves with Dynamic Client Registration (the \`registration_endpoint\` in the metadata). Discovery is standard: an unauthenticated request to the URL answers \`401\` with a \`WWW-Authenticate\` header whose \`resource_metadata\` points to \`${url}/.well-known/oauth-protected-resource/mcp\`; the authorization server is described at \`${url}/.well-known/oauth-authorization-server\`.
- Scopes: \`ledger:read\` (look and summarize), \`ledger:write\` (log, correct, delete, undo, remember), \`offline_access\` (a refresh token, so the person signs in once).
- Any MCP client with OAuth support can connect. If sign-in fails anyway, tell the person and point them to ${REPO}/issues.

## Claude Code

Run:

\`\`\`sh
claude mcp add --transport http warren ${mcp}
\`\`\`

Then, in a Claude Code session, run \`/mcp\`, choose \`warren\` and select Authenticate. A browser opens: the person taps **Continuar con Google**, then **Permitir**. That click is the one step you cannot take.

## Claude on the web, desktop and mobile

The person adds Warren as a custom connector (you cannot do this for them): Settings, Connectors, Add custom connector, name \`Warren\`, URL \`${mcp}\`, then Connect and sign in with Google. Connectors added on the web or desktop show up in the mobile app.

## ChatGPT

In Settings, Connectors (Apps), enable Developer mode, create a connector with the URL \`${mcp}\` and OAuth authentication. ChatGPT registers itself (Dynamic Client Registration) and then sends the person to sign in with Google.

## Cursor

Install link (opens Cursor): \`cursor://anysphere.cursor-deeplink/mcp/install?name=warren&config=${cursor}\`

Or add to \`.cursor/mcp.json\`:

\`\`\`json
{ "mcpServers": { "warren": { "url": "${mcp}" } } }
\`\`\`

## VS Code

\`\`\`sh
code --add-mcp '{"name":"warren","type":"http","url":"${mcp}"}'
\`\`\`

Install link: \`vscode:mcp/install?${vscode}\`

## Any other MCP client

Use the URL \`${mcp}\`, transport Streamable HTTP, OAuth with the scopes above, and let the client discover the rest from the \`401\` challenge.

## Check it worked

After the person signs in, call \`warren_summarize\` with \`{"range":{"period":"this_month"}}\`. A new account answers with no totals: that is a working connection. Then ask the person what to log or import.

## How to behave

- Never add, convert or round money yourself. Quote \`display\` and the totals Warren returns. Ask Warren (\`warren_summarize\`) for any total or comparison.
- Log only what the person said, and ask before a choice that changes totals (the category, the day, a possible duplicate).
- \`warren_undo_last\` takes back the newest change as a whole, within 24 hours. A write takes an optional \`request_id\`: send the same one when you retry.
- The person can disconnect every agent, download everything or delete the account at ${url}/account.

Privacy: ${url}/privacy.md. Terms: ${url}/terms.md.
`
}

export const privacy = (url: string): string => `# Política de privacidad

Última actualización: noviembre de 2026.

Warren es un proyecto personal y gratuito de Ticiano Morvan, una persona, no una empresa. Esta política dice qué guarda Warren, para qué y cómo lo borrás. Código: ${REPO}.

## Qué guarda

- **Tu cuenta**: la dirección de email y el nombre de la cuenta de Google con la que entrás, y un identificador interno. Warren no guarda ninguna credencial de Google (ni claves de acceso a tu mail o tus archivos): Google solo confirma quién sos.
- **Tu libro**: los movimientos (monto, moneda, fecha, descripción, categoría, medio de pago) y las notas que le pedís que recuerde, con todas sus versiones. Cada cambio queda registrado con el agente (cliente) que lo hizo.
- **Tus conexiones**: qué agentes autorizaste y sus tokens de acceso, que vencen a los 15 minutos y se renuevan.

Warren **no guarda** claves, números de tarjeta, CBU/CVU, documentos, teléfonos ni emails dentro de tu libro: si tu agente los manda, se rechazan o no se conserva lo que mandó.

## Qué no hace

- No lee tu mail, tus archivos ni tu cuenta de Google. Tu agente puede leerlos con tu permiso; eso pasa entre vos y tu agente, no con Warren.
- No vende ni comparte tus datos, no hace publicidad y no usa tus datos para entrenar modelos. Warren no ejecuta ningún modelo de IA propio.

## Quién ve tus datos

Solo vos y los agentes que autorizás. El proveedor de infraestructura (Railway, en Estados Unidos) aloja el servidor y la base de datos. Cuando un agente consulta tu libro, lo que le devuelve Warren pasa a su proveedor de IA y se rige por las condiciones de ese agente.

## Cómo los borrás

En [tu cuenta](${url}/account) podés desconectar todos los agentes, descargar todos tus datos en JSON y borrar tu cuenta: se borran tu cuenta y todos tus movimientos y notas, sin vuelta atrás. Las copias de seguridad del proveedor pueden conservarlos unos días más hasta que se renuevan.

## Cookies

Solo la cookie de sesión de Warren, necesaria para entrar y usar la cuenta. Sin analítica ni publicidad.

## Contacto

Abrí un issue en ${REPO}/issues (sin datos personales) o, para algo de seguridad, usá el aviso privado de GitHub (ver SECURITY.md). Si cambia esta política, la fecha de arriba cambia.
`

export const terms = (url: string): string => `# Términos de uso

Última actualización: noviembre de 2026.

Warren es un proyecto personal y gratuito de Ticiano Morvan, una persona, no una empresa. Al entrar aceptás esto.

## Qué es

Un libro de gastos e ingresos al que accede tu agente (Claude, ChatGPT, Cursor u otro) por MCP. Warren guarda lo que tu agente le manda y calcula los totales. No es un servicio financiero: no da asesoramiento, no mueve plata ni se conecta con bancos.

## Lo que vos ponés

- Sos responsable de lo que tu agente anota en tu nombre. Warren valida que los valores sean válidos (montos, fechas), no que sean ciertos: una carga equivocada pero válida se guarda.
- Usalo solo para tus propios gastos, sin violar la ley ni abusar del servicio (por ejemplo, cargas masivas automáticas). Hay límites por cuenta (cantidad de movimientos y de llamadas por minuto); si los superás, Warren rechaza el pedido.

## Sin garantías

El servicio se ofrece "tal cual", sin garantía de disponibilidad ni de que no haya errores. Puede cambiar, tener cortes o cerrar. Conviene descargar tus datos de vez en cuando desde [tu cuenta](${url}/account). En la medida que permite la ley, no me hago responsable de pérdidas por usar o no poder usar Warren.

## Tu cuenta

Podés desconectar agentes, descargar tus datos y borrar tu cuenta cuando quieras. Puedo suspender una cuenta que abuse del servicio.

## Código y nombre

El código es abierto (licencia MIT, ${REPO}); el nombre y el dominio tienen las condiciones de TRADEMARK.md.

## Cambios y contacto

Si estos términos cambian, la fecha de arriba cambia. Contacto: ${REPO}/issues. La [política de privacidad](${url}/privacy) explica qué datos se guardan.
`

export const llms = (url: string): string => `# Warren

> Warren is a personal-finance ledger (spending and income, ARS and USD) served as an MCP server at ${url}/mcp. The person's own agent drives it; Warren runs no model. Sign-in is Google, through OAuth.

To set Warren up, read the setup page and follow it in your own client.

- [Set up Warren](${url}/setup.md): the MCP URL, the auth, and the exact steps per client (Claude Code, Claude, ChatGPT, Cursor, VS Code, any client).
- [Landing](${url}/): what Warren is, for people (Spanish). Send \`Accept: text/markdown\` to get the Markdown.
- [Privacy](${url}/privacy.md): what is stored and how to delete it.
- [Terms](${url}/terms.md): the terms of use.
- [Source](${REPO}): code, issues and security reports.
`
