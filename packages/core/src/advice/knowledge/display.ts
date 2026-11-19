import { formatAmount, formatMoney } from '../../notify/text'

const MONEY = /^(ARS|USD)(?: per (.+))?$/
const PERCENT = /^%(?: (.+))?$/

/**
 * A fact's number as shown to the person, from its decimal string and unit: "$ 12.009.410,45",
 * "$ 1.558,2427 per US$", "23,25 % TNA". Pure string work (rule 1). Undefined for a unit it does
 * not know, which a test treats as a failure for every fact that has a value.
 */
export function factDisplay(value: string, unit: string): string | undefined {
  const money = MONEY.exec(unit)
  if (money) {
    const per = money[2] === 'USD' ? 'US$' : money[2]
    return `${formatMoney(value, money[1] ?? '')}${per ? ` per ${per}` : ''}`
  }
  const percent = PERCENT.exec(unit)
  if (percent)
    return `${formatAmount(value).replace(/,00$/, '')} %${percent[1] ? ` ${percent[1]}` : ''}`
  return undefined
}
