/**
 * Plaid client wrapper. All Plaid API access for AgentBook goes through
 * here so that:
 *   1. Access tokens are encrypted at rest (AbBankAccount.accessTokenEnc)
 *   2. Cursor state for /transactions/sync lives on the row (cursorToken)
 *   3. The matcher gets called consistently after every sync
 *
 * Sandbox creds for end-to-end testing: user_good / pass_good.
 */

import 'server-only';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import type { Transaction as PlaidTransaction } from 'plaid';
import { prisma as db } from '@naap/database';
import { encryptToken, decryptToken } from './agentbook-bank-token';
import {
  matchTransaction,
  AUTO_MATCH_THRESHOLD,
  REVIEW_THRESHOLD,
  type MatchableTxn,
} from './agentbook-payment-matcher';

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
 * Exchange the Link `publicToken` for a long-lived access token,
 * encrypt it, and create AbBankAccount rows for each connected account.
 * Returns the created rows (sans access token) so the UI can render them.
 */
export async function exchangePublicToken(
  publicToken: string,
  institutionName: string | null,
  tenantId: string,
): Promise<Awaited<ReturnType<typeof db.abBankAccount.create>>[]> {
  const client = getPlaidClient();
  const exchangeRes = await client.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchangeRes.data.access_token;
  const itemId = exchangeRes.data.item_id;

  const accountsRes = await client.accountsGet({ access_token: accessToken });
  const created: Awaited<ReturnType<typeof db.abBankAccount.create>>[] = [];

  const encryptedToken = encryptToken(accessToken);

  for (const acct of accountsRes.data.accounts) {
    const existing = await db.abBankAccount.findFirst({
      where: { plaidAccountId: acct.account_id },
    });
    if (existing) {
      // Refresh institution + access token + reconnect.
      const updated = await db.abBankAccount.update({
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
    const row = await db.abBankAccount.create({
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
        lastSynced: new Date(),
      },
    });
    created.push(row);
  }

  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'plaid.account_connected',
      actor: 'system',
      action: { itemId, institution: institutionName, accountCount: created.length },
    },
  });

  return created;
}

/**
 * Pull new transactions for one bank account using Plaid's cursor-based
 * `/transactions/sync` endpoint, upsert them as AbBankTransaction rows,
 * then run the matcher on the new ones. Idempotent because we upsert by
 * `plaidTransactionId @unique` — re-running with the same cursor adds
 * nothing.
 */
export async function syncTransactionsForAccount(
  accountId: string,
): Promise<{ added: number; modified: number; removed: number; cursor: string | null }> {
  const account = await db.abBankAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.connected || !account.accessTokenEnc) {
    return { added: 0, modified: 0, removed: 0, cursor: null };
  }
  const accessToken = decryptToken(account.accessTokenEnc);
  const client = getPlaidClient();

  let cursor: string | undefined = account.cursorToken || undefined;
  let added: PlaidTransaction[] = [];
  let modified: PlaidTransaction[] = [];
  const removed: { transaction_id: string }[] = [];
  let hasMore = true;

  // /transactions/sync paginates with `has_more`. Bound the loop so a
  // misbehaving server can't pin us forever.
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

  // Upsert rows. Plaid amounts: positive = outflow (debit), negative = inflow.
  // We store the same sign convention.
  for (const t of added) {
    await db.abBankTransaction.upsert({
      where: { plaidTransactionId: t.transaction_id },
      update: {
        amount: Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        name: t.name || 'Unknown',
        category:
          (t as unknown as { personal_finance_category?: { primary?: string } })
            .personal_finance_category?.primary ||
          (Array.isArray(t.category) ? t.category.join(' > ') : null),
        pending: t.pending || false,
      },
      create: {
        tenantId: account.tenantId,
        bankAccountId: account.id,
        plaidTransactionId: t.transaction_id,
        amount: Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        name: t.name || 'Unknown',
        category:
          (t as unknown as { personal_finance_category?: { primary?: string } })
            .personal_finance_category?.primary ||
          (Array.isArray(t.category) ? t.category.join(' > ') : null),
        pending: t.pending || false,
        matchStatus: 'pending',
        idempotencyKey: t.transaction_id,
      },
    });
  }

  for (const t of modified) {
    await db.abBankTransaction.updateMany({
      where: { plaidTransactionId: t.transaction_id },
      data: {
        amount: Math.round(t.amount * 100),
        date: new Date(t.date),
        merchantName: t.merchant_name || null,
        name: t.name || 'Unknown',
        pending: t.pending || false,
      },
    });
  }

  for (const r of removed) {
    await db.abBankTransaction.updateMany({
      where: { plaidTransactionId: r.transaction_id },
      data: { matchStatus: 'ignored' },
    });
  }

  // Persist cursor + last-sync timestamp so the next run picks up where
  // we left off, and refresh balance from Plaid.
  try {
    const balRes = await client.accountsGet({ access_token: accessToken });
    const plaidAcct = balRes.data.accounts.find(
      (a: { account_id: string }) => a.account_id === account.plaidAccountId,
    );
    await db.abBankAccount.update({
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
    await db.abBankAccount.update({
      where: { id: account.id },
      data: { cursorToken: cursor || null, lastSynced: new Date() },
    });
  }

  // Run the matcher on newly added rows.
  const newRows = await db.abBankTransaction.findMany({
    where: {
      plaidTransactionId: { in: added.map((a) => a.transaction_id) },
      matchStatus: 'pending',
    },
  });
  for (const row of newRows) {
    await runMatcherOnTransaction(account.tenantId, row);
  }

  return {
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    cursor: cursor || null,
  };
}

/**
 * Apply the matcher to one bank transaction. ≥0.85 → auto-match (mark
 * the invoice paid + create payment, or link the expense). 0.55–0.85 →
 * leave the row marked 'exception' so the morning digest can surface
 * it. <0.55 → leave 'pending' for the next day's matcher to retry.
 *
 * Exported so the cron + manual-sync route can reuse it.
 */
export async function runMatcherOnTransaction(
  tenantId: string,
  row: { id: string; amount: number; date: Date; name: string; merchantName: string | null },
): Promise<{ matchStatus: string; targetId?: string; score: number }> {
  const txn: MatchableTxn = {
    id: row.id,
    amountCents: row.amount,
    date: row.date,
    name: row.name,
    merchantName: row.merchantName,
  };

  const result = await matchTransaction(tenantId, txn);
  if (result.score >= AUTO_MATCH_THRESHOLD && result.targetId) {
    if (result.kind === 'invoice') {
      // Mark the invoice paid + create a payment row.
      const invoice = await db.abInvoice.findUnique({ where: { id: result.targetId } });
      if (invoice) {
        await db.$transaction([
          db.abInvoice.update({
            where: { id: invoice.id },
            data: { status: 'paid' },
          }),
          db.abPayment.create({
            data: {
              tenantId,
              invoiceId: invoice.id,
              amountCents: Math.abs(row.amount),
              method: 'bank_transfer',
              date: row.date,
            },
          }),
          db.abBankTransaction.update({
            where: { id: row.id },
            data: {
              matchedInvoiceId: invoice.id,
              matchStatus: 'matched',
            },
          }),
        ]);
      }
      return { matchStatus: 'matched', targetId: invoice?.id, score: result.score };
    }
    if (result.kind === 'expense') {
      await db.abBankTransaction.update({
        where: { id: row.id },
        data: { matchedExpenseId: result.targetId, matchStatus: 'matched' },
      });
      return { matchStatus: 'matched', targetId: result.targetId, score: result.score };
    }
  }

  if (result.score >= REVIEW_THRESHOLD && result.targetId) {
    const data: Record<string, string> = { matchStatus: 'exception' };
    if (result.kind === 'invoice') data.matchedInvoiceId = result.targetId;
    else if (result.kind === 'expense') data.matchedExpenseId = result.targetId;
    await db.abBankTransaction.update({ where: { id: row.id }, data });
    return { matchStatus: 'exception', targetId: result.targetId, score: result.score };
  }

  return { matchStatus: 'pending', score: result.score };
}

export async function disconnectAccount(accountId: string, tenantId: string): Promise<void> {
  const account = await db.abBankAccount.findFirst({ where: { id: accountId, tenantId } });
  if (!account) return;
  // Best-effort itemRemove — we still clear local state if Plaid says no.
  if (account.accessTokenEnc) {
    try {
      const accessToken = decryptToken(account.accessTokenEnc);
      const client = getPlaidClient();
      await client.itemRemove({ access_token: accessToken });
    } catch {
      // ignore — Plaid may already have invalidated the item
    }
  }
  await db.abBankAccount.update({
    where: { id: accountId },
    data: { connected: false, accessTokenEnc: null, cursorToken: null },
  });
  await db.abEvent.create({
    data: {
      tenantId,
      eventType: 'plaid.account_disconnected',
      actor: 'system',
      action: { accountId },
    },
  });
}
