import 'server-only';
import type { PlanFeatures, PlanQuotas } from '@naap/billing';

export interface PlanTemplate {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  features: PlanFeatures;
  quotas: PlanQuotas;
}

export const SEED_TEMPLATES: PlanTemplate[] = [
  {
    code: 'free',
    name: 'Free',
    description: 'For getting started — try AgentBook with no commitment.',
    priceCents: 0,
    currency: 'usd',
    interval: 'month',
    features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
    quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Telegram bot, tax exports, generous quotas for active solo users.',
    priceCents: 1900,
    currency: 'usd',
    interval: 'month',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Unlimited everything. Team seats coming soon.',
    priceCents: 4900,
    currency: 'usd',
    interval: 'month',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
  },
];
