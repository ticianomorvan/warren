/**
 * What no text an agent reads may contain: a named security, token, issuer or product, or an
 * order to buy, sell or hold (legal-and-banks §1). Checked by tests over the knowledge base
 * and over the tool descriptions.
 */
export const DENYLIST: readonly (readonly [string, RegExp])[] = [
  ['a ticker', /\$[A-Z]{2,5}\b/],
  ['a bond ticker', /\b(AL|GD|AE|TX|TZX?|S)\d{2}[A-Z]?\b/],
  ['a CEDEAR of a name', /\bCEDEARs?\s+(de|of)\s+\S+/i],
  [
    'a named token, issuer or product',
    /\b(USDT|USDC|DAI|BTC|ETH|Bitcoin|Ethereum|Tether|Binance|Belo|Lemon|Mercado\s*(Pago|Libre)|Naranja\s*X|Ual[aá])\b/i,
  ],
  // Only the accented imperatives: "compra" and "vende" alone are ordinary nouns and verbs.
  [
    'a buy/sell imperative in Spanish',
    /(?<!\p{L})(comprá|vendé|invertí|mantené|comprar ya|vender ya)(?!\p{L})/iu,
  ],
  [
    'a buy/sell imperative',
    /\b(you should|should|let'?s|go|just)\s+(buy|sell)\b|\b(buy|sell)\s+(now|today|more|the dip)\b/i,
  ],
  [
    'a hold order',
    /\b(you should|should|must|let'?s)\s+hold\s+(on to\s+)?(\w+\s+){0,2}(stocks?|shares?|bonds?|positions?|securities|funds?|tokens?|coins?)\b/i,
  ],
  // The verb in any case, but the ticker in capitals: "buy it" is not an order.
  ['a buy/sell order', /\b(buy|Buy|BUY|sell|Sell|SELL|hold|Hold|HOLD)\s+[A-Z]{2,5}\b/],
]

/** The texts that break the policy, each with the rule it broke. */
export const policyViolations = (texts: readonly string[]): string[] =>
  texts.flatMap((text) =>
    DENYLIST.filter(([, re]) => re.test(text)).map(([name]) => `${name}: ${text.slice(0, 60)}`),
  )
