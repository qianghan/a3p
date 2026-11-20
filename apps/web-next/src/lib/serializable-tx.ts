/**
 * A Serializable transaction, retried (bounded, jittered) when Postgres
 * aborts it for a serialization conflict (Prisma P2034). Exhaustion throws
 * the caller's error (a retryable 409), never a 500.
 *
 * Shared by purchases (bills) and payroll draft generation.
 */
export const SERIALIZATION_ATTEMPTS = 3;
export const isSerializationFailure = (e: unknown) => (e as { code?: string })?.code === 'P2034';

/** Any Prisma-like client: only $transaction(fn, { isolationLevel }) is used. */
type TxRunner = { $transaction: (...args: never[]) => Promise<unknown> };

export async function serializableTx<D extends TxRunner, T>(db: D, fn: (tx: D) => Promise<T>, onExhausted: () => Error): Promise<T> {
  const run = db.$transaction as unknown as (f: (tx: D) => Promise<T>, o: { isolationLevel: 'Serializable' }) => Promise<T>;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run.call(db, fn, { isolationLevel: 'Serializable' });
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
      if (attempt >= SERIALIZATION_ATTEMPTS) throw onExhausted();
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 * attempt)));
    }
  }
}
