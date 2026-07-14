import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptToken as encryptTokenForFixture } from './agentbook-bank-token';

vi.mock('server-only', () => ({}));

process.env.BANK_TOKEN_ENCRYPTION_KEY = '1111111111111111111111111111111111111111111111111111111111111111';

// decryptToken (from the real, unmocked ./agentbook-bank-token) performs a
// genuine AES-256-GCM auth-tag check, so accessTokenEnc fixtures must be
// real ciphertext produced by encryptToken with the same key above — an
// arbitrary base64-looking string fails GCM authentication and throws.
const FAKE_ENCRYPTED_TOKEN = encryptTokenForFixture('access-sandbox-fake-token-for-tests');

const accountFindFirst = vi.fn();
const accountFindUnique = vi.fn();
const accountCreate = vi.fn();
const accountUpdate = vi.fn();
const transactionUpsert = vi.fn();
const transactionUpdateMany = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalAccount: {
      findFirst: (...a: unknown[]) => accountFindFirst(...a),
      findUnique: (...a: unknown[]) => accountFindUnique(...a),
      create: (...a: unknown[]) => accountCreate(...a),
      update: (...a: unknown[]) => accountUpdate(...a),
    },
    abPersonalTransaction: {
      upsert: (...a: unknown[]) => transactionUpsert(...a),
      updateMany: (...a: unknown[]) => transactionUpdateMany(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const mockTransactionsSync = vi.fn();
const mockAccountsGet = vi.fn();
const mockItemPublicTokenExchange = vi.fn();
const mockLinkTokenCreate = vi.fn();
const mockItemRemove = vi.fn();

vi.mock('plaid', () => ({
  Configuration: vi.fn(),
  // NOTE: the implementation passed to mockImplementation must be a
  // `function`, not an arrow function — this vitest/@vitest/spy version
  // throws "is not a constructor" when `new PlaidApi(...)` is called on a
  // mock whose implementation is an arrow function (arrow functions are
  // non-constructible per spec, and @vitest/spy's `new Mock()` path
  // enforces that at runtime). A `function` that explicitly returns an
  // object works because JS's `new` semantics use a constructor's
  // returned object as the instance when one is returned.
  PlaidApi: vi.fn().mockImplementation(function PlaidApiMock() {
    return {
      linkTokenCreate: (...a: unknown[]) => mockLinkTokenCreate(...a),
      itemPublicTokenExchange: (...a: unknown[]) => mockItemPublicTokenExchange(...a),
      accountsGet: (...a: unknown[]) => mockAccountsGet(...a),
      transactionsSync: (...a: unknown[]) => mockTransactionsSync(...a),
      itemRemove: (...a: unknown[]) => mockItemRemove(...a),
    };
  }),
  PlaidEnvironments: { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' },
  Products: { Transactions: 'transactions' },
  CountryCode: { Us: 'US', Ca: 'CA' },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLAID_CLIENT_ID = 'test-client-id';
  process.env.PLAID_SECRET = 'test-secret';
  process.env.PLAID_ENV = 'sandbox';
  accountUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
});

describe('createLinkToken', () => {
  it('returns the linkToken + expiration from Plaid', async () => {
    mockLinkTokenCreate.mockResolvedValue({ data: { link_token: 'link-abc', expiration: '2026-01-01T00:00:00Z' } });
    const { createLinkToken } = await import('./agentbook-personal-plaid');

    const result = await createLinkToken('tenant-1');

    expect(result).toEqual({ linkToken: 'link-abc', expiration: '2026-01-01T00:00:00Z' });
    expect(mockLinkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: { client_user_id: 'tenant-1' } }),
    );
  });
});

describe('syncTransactionsForAccount — sign-convention flip', () => {
  it('negates Plaid\'s outflow-positive amount into AbPersonalTransaction\'s inflow-positive convention', async () => {
    accountFindUnique.mockResolvedValue({
      id: 'acct-1', tenantId: 'tenant-1', connected: true, accessTokenEnc: FAKE_ENCRYPTED_TOKEN,
      plaidAccountId: 'plaid-acct-1', cursorToken: null,
    });
    mockTransactionsSync.mockResolvedValue({
      data: {
        // Plaid's real `amount` field is decimal dollars (5 = $5.00), not
        // cents — this fixture was originally `amount: 500`, which the
        // task description's own framing ("a $5 outflow") contradicted
        // once checked against Plaid's actual API contract and this
        // codebase's cents convention (see agentbook-personal-plaid.ts's
        // `Math.round(t.amount * 100)`, mirroring the sibling
        // agentbook-plaid.ts and AbPersonalTransaction's manual-entry
        // route, which both scale dollars -> cents by *100). `amount: 5`
        // is the correct Plaid-shaped input for a $5 outflow.
        added: [{ transaction_id: 'txn-1', amount: 5, date: '2026-01-15', name: 'Coffee Shop', merchant_name: 'Blue Bottle', pending: false, personal_finance_category: { primary: 'FOOD_AND_DRINK' } }],
        modified: [], removed: [], next_cursor: 'cursor-1', has_more: false,
      },
    });
    mockAccountsGet.mockResolvedValue({ data: { accounts: [{ account_id: 'plaid-acct-1', balances: { current: 100 } }] } });
    transactionUpsert.mockResolvedValue({});

    const { syncTransactionsForAccount } = await import('./agentbook-personal-plaid');
    await syncTransactionsForAccount('acct-1');

    expect(transactionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { plaidTransactionId: 'txn-1' },
        create: expect.objectContaining({ amountCents: -500, merchantName: 'Blue Bottle', category: 'FOOD_AND_DRINK' }),
      }),
    );
  });

  it('does not call any matcher-equivalent function — personal sync has no matching step', async () => {
    accountFindUnique.mockResolvedValue({
      id: 'acct-2', tenantId: 'tenant-1', connected: true, accessTokenEnc: FAKE_ENCRYPTED_TOKEN,
      plaidAccountId: 'plaid-acct-2', cursorToken: null,
    });
    mockTransactionsSync.mockResolvedValue({ data: { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false } });
    mockAccountsGet.mockResolvedValue({ data: { accounts: [] } });

    const { syncTransactionsForAccount } = await import('./agentbook-personal-plaid');
    const result = await syncTransactionsForAccount('acct-2');

    expect(result).toEqual({ added: 0, modified: 0, removed: 0, cursor: 'c', hasMore: false });
  });

  it('returns a zeroed result without calling Plaid when the account is not connected', async () => {
    accountFindUnique.mockResolvedValue({ id: 'acct-3', connected: false, accessTokenEnc: null });

    const { syncTransactionsForAccount } = await import('./agentbook-personal-plaid');
    const result = await syncTransactionsForAccount('acct-3');

    expect(result).toEqual({ added: 0, modified: 0, removed: 0, cursor: null, hasMore: false });
    expect(mockTransactionsSync).not.toHaveBeenCalled();
  });
});

describe('sanitizePlaidError', () => {
  it('extracts the Plaid error_code without leaking the raw message', async () => {
    const { sanitizePlaidError } = await import('./agentbook-personal-plaid');
    const err = { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    expect(sanitizePlaidError(err)).toBe('Plaid error: ITEM_LOGIN_REQUIRED');
  });

  it('falls back to a generic message for a non-Plaid-shaped error', async () => {
    const { sanitizePlaidError } = await import('./agentbook-personal-plaid');
    expect(sanitizePlaidError(new Error('some raw axios config leak'))).toBe('Bank operation failed. Please try again later.');
  });
});

describe('disconnectAccount', () => {
  it('clears the encrypted token + cursor and flips connected to false', async () => {
    accountFindFirst.mockResolvedValue({ id: 'acct-4', tenantId: 'tenant-1', accessTokenEnc: null });

    const { disconnectAccount } = await import('./agentbook-personal-plaid');
    await disconnectAccount('acct-4', 'tenant-1');

    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: 'acct-4' },
      data: { connected: false, accessTokenEnc: null, cursorToken: null },
    });
  });
});
