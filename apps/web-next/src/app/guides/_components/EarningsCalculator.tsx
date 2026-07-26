'use client';

import { useState } from 'react';

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

export function EarningsCalculator() {
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
          <span>Paying customers you refer</span>
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
          <span>Share on Business ($49) vs Pro ($19)</span>
          <span className="gd-calc-val">{bizPct}% Business</span>
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
          <div className="k">Recurring / month</div>
          <div className="v">{usd(monthly)}</div>
        </div>
        <div className="gd-metric">
          <div className="k">Per year</div>
          <div className="v">{usd(annual)}</div>
        </div>
      </div>

      <p className="gd-note">
        At <strong>20%</strong> commission on a blended <strong>{usd(avgMonthly)}/mo</strong> subscription, each
        referred customer is worth about <strong>{usd(perCustomerYear)}/year</strong> to you — and it repeats
        every year they stay. Recurring while their subscription is active; churn isn’t modeled here, and your
        exact rate is set in your partner agreement.
      </p>
    </div>
  );
}
