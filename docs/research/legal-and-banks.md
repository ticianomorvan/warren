> Research as of 2026-11-17; not legal advice.

# Warren: legal and bank research (2026-11-17)

Background research for a founder. This is NOT legal advice. Every point marked "LAWYER" must be confirmed by an Argentine lawyer before launch.

Labels: VERIFIED = a primary page was read today (URL given). UNVERIFIED = only a secondary source, a search summary, or memory.
Note: page reads went through a summarising fetch tool, so quotes are short excerpts, not full text. Re-read the primary page before relying on exact wording.

## Recommendations

1. Keep Warren outside the CNV "asesoramiento" definition: the knowledge base stays general (principles, scams, dated facts). Never produce a recommendation about a named security, fund, bond or token for a named user.
2. Put the personalised reasoning in the user's own agent, not in Warren. Warren supplies data and general content. Say this in the terms and in the MCP server instructions.
3. Add a visible disclaimer ("educational information, not investment advice, Warren is not registered with the CNV") and keep the MCP prompts from steering the agent to buy/sell calls on named securities. A disclaimer alone does not decide the question; substance does.
4. Stay free and take no commission or referral fee from any broker, exchange or bank. Do not "link or connect clients to registered agents" (RG 1002 lists that as restricted).
5. Do the AAIP step: register Warren as a "responsable" and its user database in the RNBD (Argentina-based, so use the TAD route). Ask the lawyer if a free open-source service is exempt (the AAIP page lists no exemptions).
6. Publish a privacy policy and terms before the first outside user. Collect express, informed consent at sign-up (Ley 25.326 art. 5 and 6).
7. Treat US/Brazil hosting as an international transfer to non-adequate countries. Use the AAIP model clauses (Res. 198/2023 or Disp. 60/2016) with Vercel and Neon, or rely on express user consent. Lawyer to pick.
8. Vercel Hobby is "personal or non-commercial" only. A free service for other people is a grey zone; donations make it worse. Plan to move to Pro the day you take a donation or add a paid tier. Ask Vercel support in writing.
9. Build the delete and export paths now: access answer in 10 calendar days, rectification/deletion in 5 business days (art. 14 and 16).
10. Next bank templates: Galicia, Santander, Macro, then Mercado Pago and Naranja X. All have DMARC p=reject or quarantine. Confirm real alert mails first, because DNS cannot show which headers are signed.

## 1. Advice to other people (CNV)

### What the rule says

RG 1002/2024 (CNV), signed 2024-05-15, published in the Boletin Oficial 2024-05-16 (no. 35422, p. 28), in force the next day. It replaces art. 3, Section III, Chapter III, Title XII of the CNV Normas (N.T. 2013). VERIFIED (argentina.gob.ar norma page, read today):

- https://www.argentina.gob.ar/normativa/nacional/norma-399372/texto
- Boletin Oficial notice: https://www.boletinoficial.gob.ar/detalleAviso/primera/307566/1

Points from the text (VERIFIED, excerpts):

- It reaches issuers, clearing houses, trading agents "and any person" who intervenes or offers itself in the public offering of securities.
- Art. 3(d) prohibits: "Ofrecer servicios de asesoramiento de valores negociables sin contar con el registro en cualquiera de las categorias".
- It also restricts promoting securities, and capturing or linking clients to registered agents, without CNV authorisation.
- The considerandos define advice: "la prestacion de recomendaciones personalizadas a un cliente, teniendo en cuenta sus circunstancias personales, con respecto a una o mas operaciones relativas a valores negociables".
- Not advice: "(i) las opiniones de caracter generico sobre inversiones", "la mera divulgacion de informacion o explicacion de las caracteristicas y riesgos de una operacion o valor negociable", and "(ii) la elaboracion de reportes, informes o analisis de caracter general, aun cuando incluyan una recomendacion de compra o venta".
- Penalties point to art. 117(c) of Ley 26.831 (administrative sanctions, criminal law untouched). The fetch tool paraphrased this; confirm the exact reference.

So the earlier note was half right: RG 1002/2024 does make unregistered advice a prohibited act, but the definition is narrow. It needs personalised recommendations on securities (valores negociables).

Amendments: the argentina.gob.ar "normas modificadas" page lists RG 1002 as modifying RG 622/2013 and Ley 26.831 and shows nothing later that changes it. That does not prove no later CNV rule exists. UNVERIFIED for later changes. https://www.argentina.gob.ar/normativa/nacional/norma-399372/normas-modificadas

Secondary commentary (UNVERIFIED, consistent with the above): https://www.marval.com/publicacion/supuestos-en-los-que-se-prohibe-la-intervencion-no-autorizada-en-el-regimen-de-oferta-publica-16823?lang=en . It says nothing about apps or AI tools.

### Does Warren fall inside or outside?

Likely outside, if the design holds. Reasons:

- Warren does not make any recommendation itself. The user's own agent does.
- Warren's content is general: principles, scam alerts, dated facts. That matches the "general information / general reports" carve-outs.
- The scope is "valores negociables". Budgeting, saving, scam warnings, FX facts and spending analysis are not about securities at all.

Risks that keep this a lawyer question (LAWYER):

- The ledger is the user's personal circumstances. An agent that reads it and says "buy X" is personalised advice. A regulator could ask whether Warren "enables" that, because the rule reaches "any person who intervenes".
- Warren's MCP server is the pipe that joins circumstances to the advice. A curated knowledge base that favours specific products could be read as a promotion.
- Whether crypto tokens held in Belo are "valores negociables" is unclear. CNV regulates PSAV (virtual asset providers) separately (RG 994/2024, UNVERIFIED, not opened). Advice on crypto might be a different regime.
- No case law or CNV statement on AI agents was found. UNVERIFIED.

### Design choices that move it further outside

- General content only: principles, risks, how instruments work. No "best fund now" lists.
- No named security, fund, token or issuer recommended in the knowledge base. If an instrument is named, describe it neutrally with its risks, as the carve-out allows.
- No output from Warren that is addressed to one user and phrased as "you should buy/sell/hold".
- Prompts and tool descriptions tell the agent: give education, show data, send the user to a registered professional (asesor registrado) for security-specific decisions.
- Clear disclaimers at sign-up, in the knowledge base, and in tool descriptions. Helpful, not decisive.
- No compensation of any kind: no fees, no commissions, no affiliate links, no sponsored entries, no data sales.
- No lead generation: do not link or introduce users to brokers or exchanges.
- No execution, no custody, no credentials (already true). Keep it that way.
- Keep the model off Warren's servers. The user brings their own agent. State this in the terms.
- Date and source every Argentine fact so it reads as information, not opinion.

### BCRA, apps that read bank data

- Warren reads forwarded emails, not bank APIs. So it is not an "account aggregator" and does not log into banks. No BCRA licence was found that applies. UNVERIFIED (no BCRA text read).
- Decreto 353/2025 created an Open Finance system, with BCRA as lead authority. Per secondary sources it was not operational yet, with technical standards pending. UNVERIFIED (only secondary summaries). If standards appear, a third party reading bank data by API may need to register. Watch this.
- BCRA Com. "A" 8298 (2025-08-07) creates a shared CBU/CVU to CUIT registry for financial entities and PSPs. It is not aimed at apps like Warren. UNVERIFIED, from https://www.marval.com/Publicacion/open-finance-nuevas-medidas-para-mitigar-el-fraude-17280?lang=en
- Bank terms of use may forbid forwarding alerts to third parties. That is a contract question, not BCRA. LAWYER.
- Bank secrecy (Ley 21.526 art. 39) binds banks, not the customer. A customer forwarding their own alert is fine. UNVERIFIED, not opened.

## 2. Personal data law (Ley 25.326)

Law text: https://servicios.infoleg.gob.ar/infolegInternet/anexos/60000-64999/64790/texact.htm (VERIFIED, read today). Warren is a "responsable de base de datos" because it keeps identifiable users' transactions.

### Obligations

- Consent (art. 5): processing is unlawful without "consentimiento libre, expreso e informado", given in writing or an equivalent way. VERIFIED.
- Information at collection (art. 6): purpose, who may receive the data, identity and address of the controller, whether answers are mandatory, consequences of refusing, and the user's rights of access, rectification and deletion. VERIFIED. AAIP says this notice must be visible (Res. AAIP 14/2018). VERIFIED via https://www.argentina.gob.ar/node/53779
- Sensitive data (art. 7): health, political, religious, union, sex life, ethnic origin. Nobody can be forced to give it. Bank movements can reveal such data (a hospital, a union dues, a church donation). Lawyer to say how to handle that. LAWYER.
- Security (art. 9): technical and organisational measures against loss, alteration and unauthorised access. VERIFIED.
- Transfers (art. 12): banned to countries without adequate protection, with exceptions. VERIFIED.
- Sanctions (art. 31): warning, suspension, fine, closure of the file. The fine figures in the law ($1,000 to $100,000) are old; the AAIP updated them by later rules. UNVERIFIED on current amounts.

### Registration with the AAIP

- Still required. The AAIP page says databases that allow information about people to be obtained "deben estar inscriptos" in the Registro Nacional de Bases de Datos Personales. Files for exclusively personal use are exempt. VERIFIED: https://www.argentina.gob.ar/node/53779 and https://www.argentina.gob.ar/aaip/datospersonales/tramites
- How: first register the "responsable" (legal entity with AFIP/ARCA clave fiscal, or a natural person via TAD), then register each database, then download the certificate with QR. VERIFIED (same page).
- Foreign controllers use a dedicated form. Not Warren's case if the founder is in Argentina. VERIFIED.
- Contact on the page: registrobasesdedatos@aaip.gob.ar.
- A free open-source service with one developer is not listed as exempt. The page lists no exemptions. LAWYER: is a sole developer without a legal entity registered as a natural person? Is a per-user ledger "for reports"?
- The self-hosted case: if a third party installs Warren from GitHub, they are the controller, not the Warren author. Say so in the README. LAWYER.

### Security measures

- Res. AAIP 47/2018 approves RECOMMENDED security measures (informatised and non-informatised media), and repeals the old Disp. 11/06 and 9/08 three-level scheme. The AAIP cites it when sanctioning security failures. UNVERIFIED in primary text this session (search summary only): https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-47-2018-312662/texto
- It includes an incident-handling annex with minimum content for notifying the AAIP. UNVERIFIED.
- Practical set: encryption in transit and at rest, per-user access control, least-privilege tokens for MCP, logging, backups, a written incident plan, deletion on request. Matches what the repo already does (hash-chained ledger is good for integrity).
- No general breach-notice deadline was verified for Argentina. UNVERIFIED. LAWYER.

### International transfer (US / Brazil servers)

VERIFIED from https://argentina.gob.ar/aaip/datospersonales/transferencias-internacionales (read today):

- Adequate countries listed: EU/EEA, UK, Switzerland, Guernsey, Jersey, Isle of Man, Faroe Islands, Canada (private sector only), Andorra, New Zealand, Uruguay, Israel (automated processing only).
- The United States and Brazil are NOT on the list.
- Route for non-adequate countries: model clauses. Disp. DNPDP 60/2016 (assignment and service-provision models, amended by Res. AAIP 34/2019), and Res. AAIP 198/2023 (RIPD model clauses, controller-to-controller and controller-to-processor).
- A custom contract that differs from the models must be sent to the AAIP within 30 calendar days of signing.
- Art. 12 also allows transfer with the user's express consent (per the AAIP page). Exceptions for "banking or stock transactions" exist in art. 12 but are narrow. LAWYER.

Practical: Vercel and Neon are processors. Their DPAs may contain Argentine-compatible clauses or not. Neon's terms page I opened was a Databricks cloud services schedule that refers to an external DPA and names Grafana Labs (US) as subprocessor. UNVERIFIED which clauses apply. https://neon.com/terms-of-service . Action: collect their DPAs, attach AAIP model clauses (Res. 198/2023 processor version), and add a consent line at sign-up naming the countries. LAWYER.

Where is the data? Check the Neon project region and Vercel function region. The founder's note says "likely US or Brazil". Confirm and write it in the privacy policy.

### User rights and time limits

VERIFIED (Ley 25.326 text):

- Access (art. 14): answer within 10 calendar days of a formal demand (intimacion fehaciente). Free once every six months unless a legitimate interest is shown. Holder chooses format. Failing that, habeas data action.
- Rectification, update, deletion, confidential treatment (art. 16): 5 business days. Notify anyone who received the data. Deletion can be refused if it harms third parties or the law requires retention. Block or flag the data while checking.
- Art. 15: answers must be clear, in plain language, covering the full record.
- The AAIP page on obligations does not list deadlines, so the days come from the law, not that page.
  Design note: with a hash-chained append-only ledger, deletion needs a plan (crypto-shredding, tombstones, or per-user keys). LAWYER and engineer to agree.

### Replacement bill

- Ley 25.326 is still in force. Several reform bills exist (the Executive/AAIP bill, 83 articles, 2023; 2025 bills including Yeza's 1948-D-2025 and 644-S-2025; Carro and Donate bills; partial bills 3540-D-2025 on algorithmic transparency and 2968-D-2025 on portability). The 2018 bill lost parliamentary status. A Diario Judicial piece from July 2026 says the reform is still pending. UNVERIFIED (search results only; no committee status confirmed).
- AAIP project page: https://www.argentina.gob.ar/aaip/proyecto-ley-datos-personales (not opened).
- Expect GDPR-like rules (portability, breach notice, DPO) if one passes. Build deletion and export now to be ready.

### Minimum privacy policy

Must say (from arts. 5, 6, 9, 12, 14, 16):

1. Who is the controller: name, address, email contact for rights.
2. What data: forwarded alert emails, parsed movements (amount, date, counterparty, bank), account email, MCP access logs.
3. Purpose: keep the ledger, send notices, serve the user's own agent. No sale, no ads, no model training by Warren.
4. Recipients and processors: Vercel, Neon, Sentry, and the user's own AI provider (data leaves Warren when their agent reads the ledger; that is the user's choice).
5. Countries where data is stored, and that they are not adequate under Argentine law, with the legal basis (model clauses or consent).
6. Whether answers are mandatory and what happens if the user refuses.
7. Retention and deletion.
8. Rights of access, rectification, deletion, and how to use them, with the 10-day and 5-business-day commitments.
9. The AAIP's role: the AAIP is the control body and users may complain to it. The AAIP's standard legend ("El titular de los datos personales tiene la facultad de ejercer el derecho de acceso... La AGENCIA DE ACCESO A LA INFORMACION PUBLICA...") is traditionally included. UNVERIFIED wording; LAWYER to supply.
10. Security measures in plain language, incident handling.
11. RNBD registration number, once obtained.
12. Cookies/analytics if any.

### Minimum terms of service

1. What Warren is: a free open-source tool that stores a ledger and exposes data to the user's own agent. Not a bank, not a broker, not an adviser.
2. Not investment, tax, legal or financial advice; not registered with the CNV; the user's agent produces the answers; consult a registered professional for securities decisions.
3. No money movement, no credentials requested, no trades.
4. User duties: forward only their own mails; do not share the MCP token; lawful use.
5. Data and AI agent: the user decides which agent reads the data; Warren is not responsible for the third-party model's output.
6. Accuracy: parsing may fail; the user must check against their bank.
7. Availability: free, best effort, may stop with notice; export available.
8. Liability limit and no warranty (MIT licence for code; terms for the service). Consumer law (Ley 24.240) limits some waivers even for free services. LAWYER.
9. Termination and deletion.
10. Governing law and courts (Argentina); contact.
11. Third-party names (BBVA, Belo) are used only to describe compatibility; no affiliation.

## 3. Vercel Hobby and Neon free

### Vercel

- Terms of Service, section 4: "You shall only use the Services under a Hobby plan for your personal or non-commercial use." VERIFIED: https://vercel.com/legal/terms
- The terms page I read does not define "commercial". It says nothing about donations, ads or free services used by others. VERIFIED (as an absence in what the tool returned).
- Fair use guidelines (last updated 2026-11-12) give usage ranges for Hobby (100 GB transfer, 1M invocations, 4 CPU-hours) and say "Circumventing or otherwise misusing Vercel's limits... is a violation". The "Examples of fair use / Never fair use" lists appeared empty in the fetched copy, so I could not read them. VERIFIED partly: https://vercel.com/docs/limits/fair-use-guidelines
- Hobby page: no personal/commercial wording in the copy I read; exceeding limits means waiting 30 days. https://vercel.com/docs/plans/hobby
- Search results (UNVERIFIED) say Vercel's guidelines treat "all commercial usage" as needing Pro, and a third-party blog says a donation button crosses the line. No official text on donations was found. Community forum threads ask about internal tools; no official answer seen.

Reading: a free, non-profit service used by other people is not clearly "personal". It is non-commercial though, and the clause says "personal OR non-commercial". Donations, sponsorship, a paid tier or running it for a company push it to commercial. Open source with a public deployment is common on Hobby, but Vercel can enforce. LAWYER is not needed for this; ask Vercel support by email and keep the answer.

Pro costs $20 per seat per month (VERIFIED, hobby page). Moving to Pro also gives longer logs and spend control.

### Neon

- Free plan, per the plans page (last updated 2026-11-12): 100 projects; 10 branches per project; 100 CU-hours per project per month; 1 GB storage per project (20 GB total); 5 GB network per project per month; scale-to-zero after 5 minutes, cannot be disabled. At limits compute suspends or writes fail; data is not deleted. VERIFIED: https://neon.com/docs/introduction/plans
- No commercial-use restriction was stated on that page. https://neon.com/terms-of-service gave me a Databricks cloud schedule, not a clear free-plan clause. So: no restriction found, but UNVERIFIED in the main terms. Re-check the master agreement.
- Practical risk is technical, not legal: the 1 GB cap and cold starts. Neon's "Launch" plan restores access if limits are hit.

## 4. Argentine banks and wallets: alerts and DKIM/DMARC

### Method

Today I queried `_dmarc.<domain>` TXT with node's dns module (dig is not installed here). Results are current as of 2026-11-17. VERIFIED (DNS).

Limits of DNS (important):

- DMARC p=reject/quarantine tells you the domain asks receivers to reject unauthenticated mail. It does NOT show that the per-operation alert is sent from that domain, nor that it is DKIM-signed.
- DKIM signatures are found only in message headers (the `DKIM-Signature` header with `h=` listing signed headers). Whether `To` is in `h=` can only be read from a real email. DNS cannot show this.
- DKIM selectors are unknown without a real message, so I did not probe them.
- Alert mails are often sent by a vendor (for example a mass-mail platform) with the bank's `From`. DMARC alignment then depends on the vendor's DKIM key for the bank domain. Check a real mail.
- Sending domain may differ from the web domain (e.g. a subdomain like `alertas.` or `notificaciones.`). DMARC `sp=` covers subdomains.

### DMARC results

| Domain              | DMARC policy (today)                 | Notes                                                   |
| ------------------- | ------------------------------------ | ------------------------------------------------------- |
| bbva.com.ar         | p=reject; sp=reject                  | strict, reports to BBVA group                           |
| bancogalicia.com.ar | p=reject; pct=100                    | also bancogalicia.com p=reject                          |
| santander.com.ar    | p=reject; pct=100                    | santander.com also p=reject                             |
| macro.com.ar        | p=reject; sp=quarantine; pct=100     | adkim=r; aspf=r                                         |
| bancociudad.com.ar  | p=quarantine; pct=100                | adkim=s; aspf=s (strict alignment)                      |
| bna.com.ar          | p=quarantine; sp=none; pct=10        | weak: only 10% of failures quarantined; subdomains none |
| icbc.com.ar         | p=quarantine                         | no pct                                                  |
| brubank.com         | p=none                               | monitoring only, no enforcement                         |
| uala.com.ar         | p=quarantine; sp=quarantine; pct=100 |                                                         |
| naranjax.com        | p=reject                             | reports via Cloudflare                                  |
| mercadopago.com     | p=reject; adkim=s                    | also mercadopago.com.ar p=reject                        |
| belo.app            | p=reject; pct=100; aspf=r            |                                                         |
| bancomacro.com.ar   | no record (domain not found)         | not Macro's real domain                                 |
| belo.com.ar         | lookup failed (SERVFAIL)             | not relevant                                            |

### Per-operation alerts (what is knowable from public pages)

- BBVA Argentina: card purchase notifications are set in Banca Online (Mis gestiones / Mensajes y Alertas) and the app (Configuracion / Notificaciones). Channels are mostly push; the contract refers to an email address for "mensajes, avisos y alertas". Email per-operation for transfers is not confirmed by an official page. UNVERIFIED (search summary; official page: https://www.bbva.com/es/ar/salud-financiera/bbva-activa-las-notificaciones-de-consumos-con-tarjetas-de-credito-y-debito/ not opened). Warren already parses BBVA transfer mails, so real mails exist; the founder should inspect their headers.
- Banco Nacion: documented alerts by email for balance, last movements, due dates, on a schedule; not per-operation, and the page does not say incoming transfers trigger a mail. VERIFIED: https://bna.com.ar/Home/ServicioDeMensajesYAlertas . Combined with DMARC pct=10, a weak candidate.
- Santander: per-consumption push notifications began in 2024 (blog source, UNVERIFIED): https://www.sirchandler.com.ar/2024/10/el-santander-comienza-a-implementar-las-notificaciones-push-por-los-consumos/
- Galicia, Macro, Ciudad, ICBC, Brubank, Uala, Naranja X, Mercado Pago, Belo: I found no official help page confirming per-operation email alerts. UNVERIFIED for all. Best next step is to open a real alert mail from each (or ask users to forward one) and read the headers.
- BCRA requires banks to show the sender of each received transfer on statements (BCRA release, UNVERIFIED, not opened): https://web2.bcra.gob.ar/Noticias/BCRA_facilita_la_identificacion_i.asp

### Ranking by what is knowable

Score = enforcing DMARC on the main domain, plus evidence of per-operation email alerts. Evidence of alerts is thin everywhere.

1. BBVA Argentina: p=reject (+sp). Parser exists. Alerts confirmed by real mails.
2. Mercado Pago: p=reject, strict DKIM alignment (adkim=s). Huge user base; sends per-payment mails (general knowledge, UNVERIFIED). Likely strong DKIM from its own domain. Top next candidate.
3. Banco Galicia: p=reject, pct=100. Largest private bank; alert mails likely. UNVERIFIED.
4. Santander: p=reject, pct=100. Mostly push per search; check for email.
5. Naranja X: p=reject. Wallet with per-movement mails likely. UNVERIFIED.
6. Belo: p=reject, pct=100, relaxed SPF alignment. Already a launch target. Per-operation mails: check a real one.
7. Macro: p=reject, subdomains quarantine. Check where the alert mail is sent from.
8. Uala: p=quarantine, pct=100. Wallet, sends movement mails likely.
9. Banco Ciudad: p=quarantine with strict alignment; fine if alerts exist.
10. ICBC: p=quarantine.
11. BNA: p=quarantine pct=10 and alerts are scheduled summaries. Low priority.
12. Brubank: p=none. No enforcement, so spoofed mails are not blocked by receivers; weakest authenticity guarantee. Do not support until a real mail shows a valid DKIM `d=brubank.com` signature.

For every bank: Warren must verify DKIM itself (d= matches the bank domain, signature valid, From aligned) and should treat "To" as unsigned unless `h=` includes it. Where `To` is not signed, a forwarded mail can be re-addressed, so bind the user via the forwarding address and a one-time token, not the To header.

## Questions for a lawyer

1. Does a free tool that supplies a user's ledger and general educational content to the user's own AI agent "intervene in the public offering" under RG 1002/2024 art. 3, or offer "asesoramiento"? Does the answer change if the knowledge base names specific instruments?
2. Are crypto tokens held in Belo "valores negociables"? Does the CNV PSAV regime (RG 994/2024) apply to advice about them?
3. Is a disclaimer plus "your own agent decides" enough, or must the terms or MCP instructions forbid security-specific recommendations?
4. Must a sole developer without a company register as "responsable" with the AAIP? Is a free open-source service exempt? What if third parties self-host?
5. Which legal basis for the US/Brazil transfer: model clauses with Vercel and Neon, or express consent? Are the vendors' DPAs enough? Must the AAIP be notified (30-day rule)?
6. How to treat sensitive data (art. 7) revealed by bank movements?
7. Deletion in a hash-chained, append-only ledger: is crypto-shredding or tombstoning compliant with art. 16?
8. What breach-notification duty exists today, and what are current fine amounts under art. 31?
9. Can the terms limit liability for a free service, given consumer law (Ley 24.240)? Is Warren a "proveedor" at all?
10. Do bank terms of use forbid forwarding alert mails to a third party? Any bank-secrecy or contract exposure for Warren or users?
11. If Decreto 353/2025 Open Finance standards arrive, what authorisation would a service reading bank data need?
12. Does accepting donations change the legal analysis anywhere (CNV, data law, tax/ARCA)?
13. Required text of the AAIP rights legend in the privacy policy, and the language (Spanish) requirements for terms.

## Could not confirm

- The full, verbatim operative text of RG 1002/2024 art. 3 (read only through a summarising tool; definition is from the considerandos, not the article). Also whether the exact penalty cross-reference to art. 117(c) is right.
- Any CNV rule after RG 1002/2024 that changes advice registration categories; the categories themselves (asesor de inversion, etc.) were not listed in what I read.
- Whether CNV or any Argentine authority has said anything about AI agents or MCP tools giving advice.
- CNV PSAV rules on crypto advice (not opened).
- Primary text of Res. AAIP 47/2018, 14/2018, 198/2023, Disp. 60/2016, 34/2019 (relied on the AAIP pages and search summaries).
- Current AAIP fine amounts and any breach-notice deadline.
- Parliamentary status of the data-protection reform bills in November 2026.
- Whether Vercel's "Examples of fair use / Never fair use" lists define commercial use. The fetched pages showed those headings empty. Vercel's stance on donations is not in an official text I could read.
- Neon's free-plan commercial-use terms in its master agreement and DPA, and the actual regions of Warren's Neon and Vercel projects.
- Which banks send per-operation emails, and which headers any bank signs. DNS cannot answer the second; it needs real mail headers.
- DKIM selectors and SPF records (not probed).
- Whether the Decreto 353/2025 Open Finance system has operating standards today.
- The AAIP page https://www.argentina.gob.ar/aaip/datospersonales/reg-ley25326 and the security-measures page returned 404.
