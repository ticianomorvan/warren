import type { Principle } from './types'

/** In the order they apply. Everything here is general; none of it names a security. */
export const PRINCIPLES: readonly Principle[] = [
  {
    id: 'dated-facts-and-professionals',
    title: 'Date every fact, and defer to professionals on the law',
    body:
      'State a rate, threshold or rule only with its date and where it comes from. Argentine ' +
      'rules on foreign exchange, monotributo, reporting thresholds and taxes change often, so ' +
      'a figure without a date is a guess. Questions of tax, law or insurance go to a contador, ' +
      'an abogado or a productor asesor de seguros; a decision about a security goes to an asesor registrado ' +
      'with the CNV.',
    applies_to: ['professional', 'taxes', 'compliance'],
  },
  {
    id: 'compliance-before-optimising',
    title: 'Be compliant before optimising',
    body:
      'Being in the right tax category (for a monotributista, the right monotributo category), ' +
      'invoicing what must be invoiced and following the rules that apply to the kind of ' +
      'income the person has come before any attempt to earn more. For example, a person paid ' +
      'from abroad needs to know which BCRA rules apply to those proceeds. Being excluded ' +
      'retroactively from a regime can cost more than most yields earn. Check the category ' +
      'when income changes; the dated scale is in the facts (monotributo-scale).',
    applies_to: ['compliance', 'taxes', 'professional'],
  },
  {
    id: 'liquidity-first',
    title: 'Survival and liquidity come first',
    body:
      'Build a starter buffer of one month of essential expenses, then an emergency fund. ' +
      'Salaried people with stable income often target three to six months; people with ' +
      'variable or concentrated income (for example one client) need more, commonly six to ' +
      'twelve. These are common heuristics, not rules. Keep it in an ' +
      'instrument that can be withdrawn the same day without loss, and refill it before ' +
      'anything else after a withdrawal. It is insurance, not an investment, so it is not ' +
      'judged by its yield.',
    applies_to: ['emergency-fund', 'liquidity', 'income-risk'],
  },
  {
    id: 'debt-before-investing',
    title: 'Pay expensive debt before investing',
    body:
      'Paying down a debt earns its interest rate with no risk. A card balance that is ' +
      'revolved usually costs a CFT far above what registered instruments pay (compare it ' +
      'with the deposit rates in the facts), so after the starter buffer, balances at that ' +
      'cost come before investing for return. Compare the CFT (total financial cost), not ' +
      'the nominal rate.',
    applies_to: ['debt', 'cards', 'investing'],
  },
  {
    id: 'diversify-counterparties',
    title: 'No yield without an explained source, and no single custodian for most of the money',
    body:
      'A yield above what registered bank deposits pay is compensation for a risk, and the ' +
      'question is which one: the issuer failing, the platform failing, a currency peg ' +
      'breaking, or a rule changing. If nobody can name the source of the return, treat it as ' +
      'principal at risk. Bank deposits are guaranteed by SEDESA up to a cap; balances held ' +
      'with uninsured platforms are not. Avoid keeping most liquid money with one uninsured ' +
      'custodian, and never put the emergency fund into yield products.',
    applies_to: ['diversification', 'liquidity', 'scams', 'deposits'],
  },
  {
    id: 'match-currency-and-horizon',
    title: 'Match each pot of money to its currency and its horizon',
    body:
      'Money to be spent within weeks belongs where it can be used without delay or loss. ' +
      'Money for a goal one or two years away should be in the currency the goal is priced in, ' +
      'in low-risk instruments. Long-term money tolerates volatility, and its currency should ' +
      'be the one the person will spend in. A currency mismatch between assets and spending is ' +
      'a risk the person takes whether or not they notice it.',
    applies_to: ['currency', 'fx', 'investing', 'inflation'],
  },
  {
    id: 'real-versus-nominal',
    title: 'Compare a rate with inflation, not with zero',
    body:
      'A peso rate is judged by what it leaves after inflation: a rate below the CPI change ' +
      'over the same period loses purchasing power even while the balance grows. The facts ' +
      'carry the CPI change (the facts of topic inflation give the month and the year-over-year ' +
      'figure) and the deposit rates; use the figures as given. A TNA is a nominal annual ' +
      'rate without compounding, and the year-over-year CPI change includes it, so comparing ' +
      'the two is approximate and should say so. Pesos are for spending and short-term ' +
      'needs; holding them for a long time is a bet that inflation will stay below the rate ' +
      'earned.',
    applies_to: ['inflation', 'rates', 'savings'],
  },
  {
    id: 'automate-saving',
    title: 'Automate saving, and raise it with every raise',
    body:
      'Saving that depends on willpower at the end of the month tends not to happen. A ' +
      'transfer on payday into labelled pots (emergency, a goal, long term) works better, and ' +
      'committing a share of each raise or windfall in advance keeps lifestyle from absorbing ' +
      'it. For retirement and long-term goals a common heuristic is 20% to 25% of gross ' +
      'income, on top of the buffers; it is a starting point, not a floor. The public ' +
      'pension (see the facts of topic pensions) replaces only a small part of a higher income, ' +
      'so private saving carries the rest.',
    applies_to: ['savings', 'pensions'],
  },
  {
    id: 'cards-are-a-payment-rail',
    title: 'A card is a way to pay, not credit',
    body:
      'Pay the full statement balance every time. Instalments (cuotas) at 0% are worth taking ' +
      'only at the cash price: compare the price in cuotas with the cash or debit price, and ' +
      'if they are the same, the cuotas are free credit. Count the total of committed future ' +
      'instalments as a liability, because stacked instalments are the documented way ' +
      'cards turn into revolving debt. Revolving a balance costs a CFT that is usually many ' +
      'times the inflation rate. Foreign-currency spending settled in pesos carries a ' +
      'perception (see card-foreign-perception).',
    applies_to: ['cards', 'debt', 'taxes'],
  },
  {
    id: 'big-purchases-after-reserve',
    title: 'Make large purchases only after the reserve exists',
    body:
      'For a large purchase, two tests: the emergency reserve is intact after paying, and the ' +
      'all-in running cost (for a vehicle: insurance, tax, fuel, maintenance, parking) stays ' +
      'at or below a share of income the person can carry; about 10% of gross income is a ' +
      'common heuristic. Add transfer, registration and taxes to the price.',
    applies_to: ['purchases', 'liquidity', 'debt'],
  },
  {
    id: 'shared-money-agreements',
    title: 'Agree in writing who owns and who pays when money is shared',
    body:
      'When two people share a purchase, an account or a goal, agree in advance who owns it, ' +
      'who pays what and what happens if the arrangement ends. People accept a split more ' +
      'readily when they see it as fair than when it is merely equal or proportional. A ' +
      'lawyer or contador can put the agreement in a form that holds.',
    applies_to: ['purchases', 'professional'],
  },
  {
    id: 'insure-ruin',
    title: 'Insure ruin, not inconvenience',
    body:
      'A common order of priority is health, loss of income or disability, liability ' +
      '(including any cover the law makes mandatory), then damage and theft of an asset that ' +
      'is a large part of net worth. Small, affordable losses are cheaper to carry from the ' +
      "reserve. Life insurance matters when someone depends on the person's income. A " +
      'productor asesor de seguros should confirm which product fits the case.',
    applies_to: ['insurance', 'income-risk', 'professional'],
  },
  {
    id: 'invest-cheaply-and-broadly',
    title: 'Long-term money: cost and diversification decide most of the outcome',
    body:
      'Once the buffers are full, the evidence on retail investing is that low all-in cost ' +
      '(fees, spreads, FX spread, withholding), broad diversification and a long horizon ' +
      'explain most of the result, while picking single names and timing the market lose more ' +
      'often than they win. Speculation, if the person wants it, is kept to a small, capped ' +
      'share (5% or less is a common heuristic) with no top-ups after losses. Which ' +
      'instruments to hold is a matter for an asesor registrado, and Warren does not ' +
      'name any.',
    applies_to: ['investing', 'diversification'],
  },
  {
    id: 'protect-human-capital',
    title: 'Protect and diversify income',
    body:
      'For most people the largest asset is future income. When most of it comes from one ' +
      'employer or client, that is a single point of failure, so consider a second source or ' +
      'a live pipeline, budget for skills, and avoid holding an investment portfolio ' +
      'concentrated in the same sector as the job. For a contractor, compare the rate with an ' +
      'employee equivalent: a rate that looks high often leaves out leave, benefits, tax and ' +
      'idle time.',
    applies_to: ['income-risk', 'diversification'],
  },
  {
    id: 'run-the-legitimacy-check',
    title: 'Run the legitimacy check on anything new, and never move money because someone called',
    body:
      'Verify the registration yourself, through a channel you looked up, not one the seller ' +
      'gave you: the CNV public registers for investment intermediaries and the BCRA list for ' +
      'financial entities. One red flag is enough to stop: unsolicited contact, a fixed high ' +
      'return in dollars, urgency, secrecy, difficulty withdrawing. Wait 48 to 72 hours ' +
      'before moving money for anything new.',
    applies_to: ['scams', 'professional', 'investing'],
  },
]
