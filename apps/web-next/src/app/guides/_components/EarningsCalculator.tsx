'use client';

import React, { useState } from 'react';

// Real plan prices from the product (billing templates): Pro $19/mo, Business
// $49/mo. Program commission rate is 20% of what each referred customer pays,
// recurring for as long as they stay subscribed. These are the actual numbers,
// not projections — only the *count* and *mix* are yours to move.
const PRO = 19;
const BUSINESS = 49;
const RATE = 0.2;

function usd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/**
 * Labels for both languages, defined HERE rather than passed in.
 *
 * The first version took a `labels` prop containing functions (for the "{n}%
 * Business" and the closing note). That is illegal across the RSC boundary —
 * "Functions cannot be passed directly to Client Components" — and it only
 * surfaced in a browser: tsc accepts it and a render-free unit test never
 * crosses the boundary. A `locale` string is serializable, so the server pages
 * stay server pages.
 *
 * The MATH is deliberately not localized. Prices, the 20% rate and the USD
 * formatting are the real commercial terms and are identical in either
 * language — only the words around them change.
 */
type Labels = {
  customers: string;
  mixLabel: string;
  mix: (bizPct: number) => string;
  perMonth: string;
  perYear: string;
  note: (avgMonthly: string, perCustomerYear: string) => React.ReactNode;
};

const LABELS: Record<'en' | 'zh', Labels> = {
  en: {
    customers: 'Paying customers you refer',
    mixLabel: 'Share on Business ($49) vs Pro ($19)',
    mix: (bizPct) => `${bizPct}% Business`,
    perMonth: 'Recurring / month',
    perYear: 'Per year',
    note: (avgMonthly, perCustomerYear) => (
      <>
        At <strong>20%</strong> commission on a blended <strong>{avgMonthly}/mo</strong> subscription, each
        referred customer is worth about <strong>{perCustomerYear}/year</strong> to you — and it repeats
        every year they stay. Recurring while their subscription is active; churn isn’t modeled here, and your
        exact rate is set in your partner agreement.
      </>
    ),
  },
  zh: {
    customers: '你推荐的付费客户数',
    mixLabel: 'Business（$49）与 Pro（$19）的占比',
    mix: (bizPct) => `${bizPct}% 选 Business`,
    perMonth: '每月持续收入',
    perYear: '每年',
    note: (avgMonthly, perCustomerYear) => (
      <>
        按 <strong>20%</strong> 的分成、折合 <strong>{avgMonthly}/月</strong> 的订阅计算，
        你推荐的每位客户每年大约值 <strong>{perCustomerYear}</strong>——只要他们继续订阅，每年都会重复。
        分成在订阅有效期内持续发放；这里没有计入客户流失，你的具体费率以合作伙伴协议为准。
      </>
    ),
  },
};

export function EarningsCalculator({ locale = 'en' }: { locale?: 'en' | 'zh' }) {
  const labels = LABELS[locale];
  const [customers, setCustomers] = useState(25);
  const [bizPct, setBizPct] = useState(30);

  const proPct = 100 - bizPct;
  const avgMonthly = (bizPct / 100) * BUSINESS + (proPct / 100) * PRO;
  const monthly = customers * avgMonthly * RATE;
  const annual = monthly * 12;
  const perCustomerYear = avgMonthly * RATE * 12;

  return (
    <div className="gd-calc">
      <div className="gd-calc-row">
        <label htmlFor="cust">
          <span>{labels.customers}</span>
          <span className="gd-calc-val">{customers}</span>
        </label>
        <input
          id="cust"
          type="range"
          min={1}
          max={200}
          value={customers}
          onChange={(e) => setCustomers(Number(e.target.value))}
        />
      </div>

      <div className="gd-calc-row">
        <label htmlFor="mix">
          <span>{labels.mixLabel}</span>
          <span className="gd-calc-val">{labels.mix(bizPct)}</span>
        </label>
        <input
          id="mix"
          type="range"
          min={0}
          max={100}
          value={bizPct}
          onChange={(e) => setBizPct(Number(e.target.value))}
        />
      </div>

      <div className="gd-calc-out">
        <div className="gd-metric">
          <div className="k">{labels.perMonth}</div>
          <div className="v">{usd(monthly)}</div>
        </div>
        <div className="gd-metric">
          <div className="k">{labels.perYear}</div>
          <div className="v">{usd(annual)}</div>
        </div>
      </div>

      <p className="gd-note">{labels.note(usd(avgMonthly), usd(perCustomerYear))}</p>
    </div>
  );
}
