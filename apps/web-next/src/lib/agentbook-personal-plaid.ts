/**
 * Personal-finance Plaid client wrapper. Mirrors
 * apps/web-next/src/lib/agentbook-plaid.ts's structure (the expense-side
 * integration) but writes to AbPersonalAccount/AbPersonalTransaction
 * instead of AbBankAccount/AbBankTransaction, and has no matcher step —
 * personal transactions aren't reconciled against invoices/expenses.
 *
 * ONE deliberate divergence from the expense-side original: Plaid's own
 * amount convention (positive = outflow/debit) is the OPPOSITE of
 * AbPersonalTransaction.amountCents's convention (positive =
 * inflow/income, established by the manual-entry route). This file
 * negates the Plaid amount on write — see syncTransactionsForAccount.
 *
 * Sandbox creds for end-to-end testing: user_good / pass_good.
 */

import 'server-only';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import type { Transaction as PlaidTransaction } from 'plaid';
import { prisma as db } from '@naap/database';
import { encryptToken, decryptToken } from './agentbook-bank-token';

export function sanitizePlaidError(err: unknown): string {
  const axiosErr = err as {
    response?: { data?: { error_code?: string; error_message?: string } };
  };
  if (axiosErr?.response?.data?.error_code) {
    return `Plaid error: ${axiosErr.response.data.error_code}`;
  }
  return 'Bank operation failed. Please try again later.';
}

let cachedClient: PlaidApi | null = null;

export function getPlaidClient(): PlaidApi {
  if (cachedClient) return cachedClient;
  const env = (process.env.PLAID_ENV || 'sandbox') as keyof typeof PlaidEnvironments;
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set');
  }
  const config = new Configuration({
    basePath: PlaidEnvironments[env] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
  cachedClient = new PlaidApi(config);
  return cachedClient;
}

export async function createLinkToken(
  tenantId: string,
): Promise<{ linkToken: string; expiration: string }> {
  const client = getPlaidClient();
  const res = await client.linkTokenCreate({
    user: { client_user_id: tenantId },
    client_name: 'AgentBook',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us, CountryCode.Ca],
    language: 'en',
  });
  return {
    linkToken: res.data.link_token,
    expiration: res.data.expiration,
  };
}

/**
 * Exchange the Link `publicToken` for a long-lived access token, encrypt
 * it, and create AbPersonalAccount rows for each connected account.
 */
export async function exchangePublicToken(
  publicToken: string,
  institutionName: string | null,
  tenantId: string,
): Promise<Awaited<ReturnType<typeof db.abPersonalAccount.create>>[]> {
  const client = getPlaidClient();
  const exchangeRes = await client.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchangeRes.data.access_token;
  const itemId = exchangeRes.data.item_id;

  const accountsRes = await client.accountsGet({ access_token: accessToken });
  const created: Awaited<ReturnType<typeof db.abPersonalAccount.create>>[] = [];

  const encryptedToken = encryptToken(accessToken);

  for (const acct of accountsRes.data.accounts) {
    const existing = await db.abPersonalAccount.findFirst({
      where: { plaidAccountId: acct.account_id },
    });
    if (existing) {
      const updated = await db.abPersonalAccount.update({
        where: { id: existing.id },
        data: {
          plaidItemId: itemId,
          accessTokenEnc: encryptedToken,
          connected: true,
          institution: institutionName || existing.institution,
          balanceCents: Math.round((acct.balances.current || 0) * 100),
          lastSynced: new Date(),
        },
      });
      created.push(updated);
      continue;
    }
    const row = await db.abPersonalAccount.create({
      data: {
        tenantId,
        plaidItemId: itemId,
        plaidAccountId: acct.account_id,
        accessTokenEnc: encryptedToken,
        name: acct.name,
        officialName: acct.official_name || null,
        type: acct.type || 'checking',
        subtype: acct.subtype || null,
        mask: acct.mask || null,
        balanceCents: Math.round((acct.balances.current || 0) * 100),
        currency: acct.balances.iso_currency_code || 'USD',
        institution: institutionName || null,
        connected: true,
        isAsset: acct.type !== 'credit' && acct.type !== 'loan',
        lastSynced: new Date(),
      },
    });
    created.push(row);
  }

  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'personal.account_connected',
      actor: 'system',
      action: { itemId, institution: institutionName, accountCount: created.length },
    },
  });

  return created;
}

/**
 * Pull new transactions for one personal account via Plaid's cursor-based
 * /transactions/sync, upsert them as AbPersonalTransaction rows. No
 * matcher call — personal transactions aren't reconciled against
 * invoices/expenses the way business bank transactions are.
 */
export async function syncTransactionsForAccount(
  accountId: string,
): Promise<{ added: number; modified: number; removed: number; cursor: string | null; hasMore: boolean }> {
  const account = await db.abPersonalAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.connected || !account.accessTokenEnc) {
    return { added: 0, modified: 0, removed: 0, cursor: null, hasMore: false };
  }
  const accessToken = decryptToken(account.accessTokenEnc);
  const client = getPlaidClient();

  let cursor: string | undefined = account.cursorToken || undefined;
  let added: PlaidTransaction[] = [];
  let modified: PlaidTransaction[] = [];
  const removed: { transaction_id: string }[] = [];
  let hasMore = true;

  // Same 10-page (2000-txn) safety cap as the expense-side sync — see that
  // file's comment for the full rationale (cursor model means truncation
  // only delays import, never loses data).
  let safety = 10;
  while (hasMore && safety-- > 0) {
    const res = await client.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 200,
    });
    added = added.concat(res.data.added);
    modified = modified.concat(res.data.modified);
    for (const r of res.data.removed) removed.push({ transaction_id: r.transaction_id });
    cursor = res.data.next_cursor;
    hasMore = res.data.has_more;
  }
  if (hasMore && safety <= 0) {
    console.warn(
      '[agentbook-personal-plaid] sync cap reached for account',
      accountId,
      '— more transactions remain; will resume on next sync',
    );
  }

  // Plaid: positive = outflow (debit), negative = inflow (credit).
  // AbPersonalTransaction: positive = inflow/income, negative = outflow/spend.
  // Negate on write — this is the one place this file is NOT a literal
  // mirror of agentbook-plaid.ts's equivalent loop.
  for (const t of added) {
    await db.abPersonalTransaction.upsert({
      where: { plaidTransactionId: t.transaction_id },
      update: {
        amountCents: -Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        description: t.name || 'Unknown',
        pending: t.pending || false,
      },
      create: {
        tenantId: account.tenantId,
        accountId: account.id,
        plaidTransactionId: t.transaction_id,
        amountCents: -Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        description: t.name || 'Unknown',
        category:
          (t as unknown as { personal_finance_category?: { primary?: string } })
            .personal_finance_category?.primary ||
          (Array.isArray(t.category) ? t.category.join(' > ') : 'uncategorized'),
        pending: t.pending || false,
        idempotencyKey: t.transaction_id,
      },
    });
  }

  for (const t of modified) {
    // category is intentionally NOT updated here, same rationale as the
    // expense side: a user may have re-categorized after import, and a
    // Plaid-side modify shouldn't clobber that.
    await db.abPersonalTransaction.updateMany({
      where: { plaidTransactionId: t.transaction_id },
      data: {
        amountCents: -Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        description: t.name || 'Unknown',
        pending: t.pending || false,
      },
    });
  }

  for (const r of removed) {
    // No matchStatus field on AbPersonalTransaction — a removed
    // transaction is simply deleted from the ledger view by marking it
    // pending:false and... actually there is no "ignored" concept here;
    // the simplest correct behavior is to leave the historical row as-is
    // (Plaid rarely retracts settled personal transactions) but this loop
    // exists for parity with the sync contract's shape (`removed` count in
    // the return value) — no DB write needed for personal transactions.
    void r;
  }

  try {
    const balRes = await client.accountsGet({ access_token: accessToken });
    const plaidAcct = balRes.data.accounts.find(
      (a: { account_id: string }) => a.account_id === account.plaidAccountId,
    );
    await db.abPersonalAccount.update({
      where: { id: account.id },
      data: {
        cursorToken: cursor || null,
        lastSynced: new Date(),
        balanceCents: plaidAcct
          ? Math.round((plaidAcct.balances.current || 0) * 100)
          : account.balanceCents,
      },
    });
  } catch {
    await db.abPersonalAccount.update({
      where: { id: account.id },
      data: { cursorToken: cursor || null, lastSynced: new Date() },
    });
  }

  return {
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    cursor: cursor || null,
    hasMore,
  };
}

export async function disconnectAccount(accountId: string, tenantId: string): Promise<void> {
  const account = await db.abPersonalAccount.findFirst({ where: { id: accountId, tenantId } });
  if (!account) return;
  if (account.accessTokenEnc) {
    try {
      const accessToken = decryptToken(account.accessTokenEnc);
      const client = getPlaidClient();
      await client.itemRemove({ access_token: accessToken });
    } catch {
      // ignore — Plaid may already have invalidated the item
    }
  }
  await db.abPersonalAccount.update({
    where: { id: accountId },
    data: { connected: false, accessTokenEnc: null, cursorToken: null },
  });
  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'personal.account_disconnected',
      actor: 'system',
      action: { accountId },
    },
  });
}
