import type { Fact } from './types'

const BCRA = 'https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias'

/**
 * Dated values, each read from its source on `as_of` and entered by hand (Warren fetches
 * nothing). A moving fact goes stale in days or weeks; a slow one at its next scheduled change.
 * `stale` is computed from `review_by` when a fact is read, not stored here.
 */
export const FACTS: readonly Fact[] = [
  {
    id: 'fx-official-wholesale',
    topic: 'fx',
    statement:
      'BCRA wholesale reference exchange rate (tipo de cambio mayorista de referencia, Com. A 3500), ' +
      'pesos per US dollar.',
    value: '1558.2427',
    unit: 'ARS per USD',
    as_of: '2026-11-18',
    review_by: '2026-11-25',
    volatility: 'moving',
    source_url: `${BCRA}/5`,
    source_name: 'BCRA Estadísticas Monetarias v4.0, variable 5',
  },
  {
    id: 'fx-official-retail',
    topic: 'fx',
    statement:
      'BCRA survey of retail banks: average selling rate (promedio vendedor), pesos per US dollar.',
    value: '1582.68',
    unit: 'ARS per USD',
    as_of: '2026-11-18',
    review_by: '2026-11-25',
    volatility: 'moving',
    source_url: `${BCRA}/4`,
    source_name: 'BCRA Estadísticas Monetarias v4.0, variable 4',
  },
  {
    id: 'rate-badlar-private',
    topic: 'rates',
    statement:
      'BADLAR rate of private banks (deposits of ARS 1 million or more, 30 to 35 days), a ' +
      'nominal annual rate (TNA), as a benchmark for what peso fixed-term deposits pay.',
    value: '23.25',
    unit: '% TNA',
    as_of: '2026-11-17',
    review_by: '2026-12-22',
    volatility: 'moving',
    source_url: `${BCRA}/7`,
    source_name: 'BCRA Estadísticas Monetarias v4.0, variable 7',
  },
  {
    id: 'rate-deposit-30d',
    topic: 'deposits',
    statement:
      'Average rate on 30-day peso time deposits across financial entities, a nominal annual rate (TNA).',
    value: '21.18',
    unit: '% TNA',
    as_of: '2026-11-17',
    review_by: '2026-12-22',
    volatility: 'moving',
    source_url: `${BCRA}/12`,
    source_name: 'BCRA Estadísticas Monetarias v4.0, variable 12',
  },
  {
    id: 'cpi-monthly-2026-10',
    topic: 'inflation',
    statement:
      'INDEC national consumer price index for October 2026, general level, base December 2016: September 2026 ' +
      '12514.1508, October 2026 12785.9321, October 2025 9603.8623. Computed from these levels ' +
      'by code: change over September 2.17%, change over October 2025 33.13%. Percentages are ' +
      'rounded to two decimals; INDEC publishes them to one.',
    value: '2.17',
    unit: '% month over month',
    as_of: '2026-11-19',
    review_by: '2026-12-24',
    volatility: 'moving',
    source_url:
      'https://apis.datos.gob.ar/series/api/series/?ids=148.3_INIVELNAL_DICI_M_26&start_date=2025-09-01&format=json',
    source_name: 'INDEC, via the datos.gob.ar series API (148.3_INIVELNAL_DICI_M_26)',
  },
  {
    id: 'monotributo-scale',
    topic: 'taxes',
    statement:
      'Monotributo maximum annual gross income by category, in pesos, from 2026-08-01; ' +
      'one amount per category in `parts`. The scale is updated twice a year; the next update ' +
      'is expected from February 2027.',
    parts: [
      ['A', '12009410.45'],
      ['B', '17595182.74'],
      ['C', '24670494.31'],
      ['D', '30628651.43'],
      ['E', '36028231.33'],
      ['F', '45151659.41'],
      ['G', '53995798.87'],
      ['H', '81924660.37'],
      ['I', '91699761.90'],
      ['J', '105012519.20'],
      ['K', '126610838.75'],
    ].map(([label, value]) => ({ label: `Category ${label}`, value: value ?? '', unit: 'ARS' })),
    as_of: '2026-11-19',
    review_by: '2027-02-01',
    volatility: 'slow',
    source_url: 'https://www.arca.gob.ar/monotributo/categorias.asp',
    source_name: 'ARCA, Monotributo categories',
    needs_professional: 'contador',
  },
  {
    id: 'sedesa-deposit-guarantee',
    topic: 'deposits',
    statement:
      'The SEDESA deposit guarantee covers up to ARS 50,000,000 per person, across accounts ' +
      'and deposits, at a bank. It does not cover balances held in uninsured platforms.',
    value: '50000000',
    unit: 'ARS per person',
    as_of: '2026-11-19',
    review_by: '2027-05-19',
    volatility: 'slow',
    source_url: 'https://www.sedesa.com.ar/sistema-de-garantia-de-los-depositos/',
    source_name: 'SEDESA, Sistema de Garantía de los Depósitos',
  },
  {
    id: 'card-foreign-perception',
    topic: 'cards',
    statement:
      'RG 5617 sets a 30% perception on card purchases and services abroad (and services from ' +
      'non-residents, and tourism or transport abroad) when settled in pesos. It is an ' +
      'advance payment of Ganancias or, for those outside Ganancias, of Bienes Personales, ' +
      'creditable in the annual return; those in neither can ask for a refund after the ' +
      'calendar year ends. Whether paying the card balance in dollars avoids it depends on ' +
      'the bank and its payment window.',
    value: '30',
    unit: '% of the peso amount',
    as_of: '2026-11-19',
    review_by: '2027-05-19',
    volatility: 'slow',
    source_url:
      'https://servicios.infoleg.gob.ar/infolegInternet/anexos/405000-409999/407430/norma.htm',
    source_name: 'Infoleg, ARCA Resolución General 5617/2024',
    needs_professional: 'contador',
  },
  {
    id: 'bienes-personales-minimum-2025',
    topic: 'taxes',
    statement:
      'Bienes Personales, fiscal year 2025: the non-taxable minimum (mínimo no imponible) is ' +
      'ARS 384,728,044.57; the tax applies to the value that exceeds it. The figure for ' +
      'fiscal year 2026 was not published on the source page.',
    value: '384728044.57',
    unit: 'ARS',
    as_of: '2026-11-19',
    review_by: '2027-03-01',
    volatility: 'slow',
    source_url:
      'https://arca.gob.ar/gananciasYBienes/bienes-personales/conceptos-basicos/alicuotas.asp',
    source_name: 'ARCA, Bienes Personales rates',
    needs_professional: 'contador',
  },
  {
    id: 'pension-minimum-2026-11',
    topic: 'pensions',
    statement:
      'Minimum SIPA pension (haber mínimo) in the November 2026 publication. The November ' +
      'extraordinary bonus and the Prestación Básica Universal (PBU) are in `parts`.',
    parts: [
      { label: 'November extraordinary bonus', value: '70000', unit: 'ARS' },
      { label: 'Prestación Básica Universal (PBU)', value: '203182', unit: 'ARS per month' },
    ],
    value: '444158',
    unit: 'ARS per month',
    as_of: '2026-11-19',
    review_by: '2026-12-20',
    volatility: 'moving',
    source_url: 'https://www.argentina.gob.ar/trabajo/seguridadsocial/imss',
    source_name: 'argentina.gob.ar, Indicadores de la seguridad social (IMSS)',
  },
  {
    id: 'reporting-threshold-wallets',
    topic: 'compliance',
    statement:
      'ARCA reporting regime for virtual wallets: for individuals (personas humanas) the ' +
      'threshold of total income or outflows is ARS 50,000,000, applicable from April 2026 ' +
      '(updated under RG 5804). The source does not label the figure as monthly.',
    value: '50000000',
    unit: 'ARS',
    as_of: '2026-11-19',
    review_by: '2027-05-19',
    volatility: 'slow',
    source_url:
      'https://www.arca.gob.ar/economia-digital/activos-virtuales-y-no-virtuales/servicios-administracion-intermediacion/evolucion-umbrales.asp',
    source_name: 'ARCA, evolution of reporting thresholds',
    needs_professional: 'contador',
  },
]
