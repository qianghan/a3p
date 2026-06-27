export interface JurisdictionConfig {
  code: string;
  name: string;
  defaultCurrency: string;
  fiscalYearStart: number; // month 1–12
  quarterlyDeadlines: (year: number) => Array<{ quarter: number; deadline: Date; label: string }>;
  selfEmploymentTaxRate: number;
  incomeBrackets: Array<{ upToCents: number | null; rate: number }>;
  taxReserveRecommendedPercent: number;
  paymentReminderLeadDays: number[];
}

function nextBusinessDay(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay(); // 0=Sun, 6=Sat
  if (day === 6) r.setDate(r.getDate() + 2);
  else if (day === 0) r.setDate(r.getDate() + 1);
  return r;
}

const US_BRACKETS: Array<{ upToCents: number | null; rate: number }> = [
  { upToCents: 1147200, rate: 0.10 },
  { upToCents: 4382200, rate: 0.12 },
  { upToCents: 9325500, rate: 0.22 },
  { upToCents: 19741400, rate: 0.24 },
  { upToCents: 25046400, rate: 0.32 },
  { upToCents: 62547000, rate: 0.35 },
  { upToCents: null, rate: 0.37 },
];

const CA_BRACKETS: Array<{ upToCents: number | null; rate: number }> = [
  { upToCents: 5558000, rate: 0.15 },
  { upToCents: 11117300, rate: 0.205 },
  { upToCents: 15360800, rate: 0.26 },
  { upToCents: 18561200, rate: 0.29 },
  { upToCents: null, rate: 0.33 },
];

export const JURISDICTIONS: Record<string, JurisdictionConfig> = {
  us: {
    code: 'us', name: 'United States', defaultCurrency: 'USD', fiscalYearStart: 1,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: nextBusinessDay(new Date(`${y}-04-15`)), label: 'Q1 Estimated Tax (Form 1040-ES)' },
      { quarter: 2, deadline: nextBusinessDay(new Date(`${y}-06-15`)), label: 'Q2 Estimated Tax' },
      { quarter: 3, deadline: nextBusinessDay(new Date(`${y}-09-15`)), label: 'Q3 Estimated Tax' },
      { quarter: 4, deadline: nextBusinessDay(new Date(`${y + 1}-01-15`)), label: 'Q4 Estimated Tax' },
    ],
    selfEmploymentTaxRate: 0.153 * 0.9235,
    incomeBrackets: US_BRACKETS,
    taxReserveRecommendedPercent: 0.30,
    paymentReminderLeadDays: [30, 14, 3],
  },
  ca: {
    code: 'ca', name: 'Canada', defaultCurrency: 'CAD', fiscalYearStart: 1,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y}-03-15`), label: 'March Installment' },
      { quarter: 2, deadline: new Date(`${y}-06-15`), label: 'June Installment' },
      { quarter: 3, deadline: new Date(`${y}-09-15`), label: 'September Installment' },
      { quarter: 4, deadline: new Date(`${y}-12-15`), label: 'December Installment' },
    ],
    selfEmploymentTaxRate: 0.119,
    incomeBrackets: CA_BRACKETS,
    taxReserveRecommendedPercent: 0.25,
    paymentReminderLeadDays: [30, 14, 3],
  },
  uk: {
    code: 'uk', name: 'United Kingdom', defaultCurrency: 'GBP', fiscalYearStart: 4,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y + 1}-01-31`), label: '1st Payment on Account' },
      { quarter: 2, deadline: new Date(`${y + 1}-07-31`), label: '2nd Payment on Account' },
    ],
    selfEmploymentTaxRate: 0.092,
    incomeBrackets: [{ upToCents: 5000000, rate: 0.20 }, { upToCents: null, rate: 0.40 }],
    taxReserveRecommendedPercent: 0.30,
    paymentReminderLeadDays: [60, 30, 7],
  },
  au: {
    code: 'au', name: 'Australia', defaultCurrency: 'AUD', fiscalYearStart: 7,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y}-10-28`), label: 'Q1 BAS (Jul–Sep)' },
      { quarter: 2, deadline: new Date(`${y + 1}-02-28`), label: 'Q2 BAS (Oct–Dec)' },
      { quarter: 3, deadline: new Date(`${y + 1}-04-28`), label: 'Q3 BAS (Jan–Mar)' },
      { quarter: 4, deadline: new Date(`${y + 1}-07-28`), label: 'Q4 BAS (Apr–Jun)' },
    ],
    selfEmploymentTaxRate: 0.0,
    incomeBrackets: [{ upToCents: 1803300, rate: 0 }, { upToCents: null, rate: 0.34 }],
    taxReserveRecommendedPercent: 0.27,
    paymentReminderLeadDays: [30, 14, 3],
  },
  nz: {
    code: 'nz', name: 'New Zealand', defaultCurrency: 'NZD', fiscalYearStart: 4,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y}-08-28`), label: '1st Provisional Tax' },
      { quarter: 2, deadline: new Date(`${y + 1}-01-15`), label: '2nd Provisional Tax' },
      { quarter: 3, deadline: new Date(`${y + 1}-05-07`), label: '3rd Provisional Tax' },
    ],
    selfEmploymentTaxRate: 0.0,
    incomeBrackets: [{ upToCents: 1400000, rate: 0.105 }, { upToCents: null, rate: 0.33 }],
    taxReserveRecommendedPercent: 0.28,
    paymentReminderLeadDays: [30, 14, 3],
  },
};

export function getJurisdiction(code: string): JurisdictionConfig {
  return JURISDICTIONS[code?.toLowerCase()] ?? JURISDICTIONS.us;
}
