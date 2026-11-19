import type { Trap } from './types'

/** Patterns of fraud and bad advice, as dated research found them. No product is named. */
export const TRAPS: readonly Trap[] = [
  {
    id: 'fixed-dollar-return',
    title: 'A fixed, high return in dollars',
    signs: [
      'A return promised in advance, from 1% a day to 7% or more a month, with little or no risk',
      'Returns that are the same every month whatever the market does',
      'Earlier investors are paid with the money of new ones, and recruiting pays a reward',
      'A story about technology, crypto or a secret strategy that cannot be checked',
    ],
    what_to_do:
      'Do not send money. Look the company up in the CNV public registers and, if it says ' +
      'it is a bank or a financial entity, in the BCRA list of financial entities, using ' +
      'an address you found yourself. Not being registered is enough to refuse. Every ' +
      'large Argentine mass fraud on record promised a fixed dollar return.',
  },
  {
    id: 'inbound-contact',
    title: 'Someone contacts you first',
    signs: [
      'A call, WhatsApp or social-media message from "your bank", a payment app, the BCRA, ' +
        'ARCA or a "broker" you never contacted',
      'A request for a code, a password, an app access or a screen share',
      'Urgency: "your account will be blocked", "only today", "only for you"',
    ],
    what_to_do:
      'Hang up and call the number on the back of the card or in the official app. No ' +
      'institution asks for a verification code or password. Do not move money because ' +
      'someone made contact; if money already moved, call the bank at once and ask it to ' +
      'block the account and report the transfer.',
  },
  {
    id: 'unregistered-broker',
    title: 'An unregistered broker or platform',
    signs: [
      'The firm is not in the CNV registers, or its registration cannot be shown',
      'The advisor is a "trader" or "mentor" in a social-media channel, paid by commission ' +
        'or by selling a course',
      'Withdrawals are slow, need a new fee, or are blocked until you deposit more',
    ],
    what_to_do:
      'Search the CNV public registers for the name and the tax id (CUIT) yourself, and ' +
      'confirm that the advisor is an asesor registrado. If there is no registration, ' +
      'treat the money as lost. Wait 48 to 72 hours before moving money to anything new.',
  },
  {
    id: 'advance-fee',
    title: 'Pay a fee to release a gain or a loan',
    signs: [
      'You are told a prize, a gain or a loan is ready, but you must first pay a tax, a ' +
        'fee or a deposit',
      'Each payment is followed by a new reason to pay more',
      'The "tax" or "fee" goes to a personal account',
    ],
    what_to_do:
      'Stop paying. Real taxes are paid to ARCA through its own channels, and real lenders ' +
      'take fees out of the loan, not before it. Report to the bank and to the police or ' +
      "the fraud unit of the prosecutor's office.",
  },
  {
    id: 'refund-by-mistake',
    title: '"I sent you money by mistake, send it back"',
    signs: [
      'A stranger says they transferred to you by mistake and asks for the money back',
      'A receipt is shown, but no money is in your account, or the transfer later reverses',
      'A buyer on an online marketplace sends a payment receipt image before the money arrives',
    ],
    what_to_do:
      'Check your own bank or wallet app, never the receipt or a link. Return nothing that ' +
      'is not in your account. If money did arrive by mistake, the bank handles the return ' +
      'through its own process.',
  },
  {
    id: 'guaranteed-yield-by-influencer',
    title: 'Advice from a "guru", finfluencer or a "passive income" course',
    signs: [
      'Guaranteed or very consistent returns, shown with screenshots of gains',
      'Pressure to join before a deadline, or to bring friends',
      'The seller earns from your fees, a course or commissions, not from your results',
    ],
    what_to_do:
      'Treat screenshots as marketing. Ask who is paid when you act, check the person in ' +
      'the CNV registers, and keep any speculation inside a small, capped share of your ' +
      'money. Send investment decisions to an asesor registrado.',
  },
  {
    id: 'stacked-instalments',
    title: 'Legal but expensive: stacked instalments and revolving card balances',
    signs: [
      'Many purchases in cuotas at once, so the monthly total keeps growing',
      'Paying only the minimum, or refinancing the statement balance',
      'A loan offered on the spot by an app, with the rate shown as a nominal annual rate ' +
        'instead of the CFT',
    ],
    what_to_do:
      'Compare the CFT (total financial cost) with inflation and with what savings earn. ' +
      'Add up all committed cuotas as a debt. Pay the full statement balance; a balance ' +
      'revolved at a CFT far above inflation is the first thing to pay down.',
  },
]
