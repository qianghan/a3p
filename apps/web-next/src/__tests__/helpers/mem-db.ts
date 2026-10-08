/**
 * In-memory Prisma test double whose reads APPLY the `where` clause.
 *
 * A fixed-array mock returns the same rows whatever filter the code asks for,
 * so a missing `tenantId`, a wrong date window or a NULL-unsafe `not` passes
 * the test and ships (see #427). Every read here evaluates the real `where`
 * object the code under test built, with Postgres semantics where they differ
 * from JavaScript (`NULL <> 'x'` is not true).
 *
 * Relations are modelled by EMBEDDING: seed an expense with `vendor: { name }`,
 * a journal line with `entry: { tenantId, date, lines: [...] }`, an account
 * with `journalLines: [...]`. `include`/`select` are ignored (full rows come
 * back). Nested writes (`lines: { create }`) and unsupported operators (read or
 * write) THROW rather than being silently ignored.
 */
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;
type OrderSpec = Record<string, 'asc' | 'desc'>;
type OrderBy = OrderSpec | OrderSpec[] | undefined;

const OPS = new Set([
  'equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte',
  'contains', 'startsWith', 'endsWith', 'mode', 'some', 'every', 'none', 'is', 'isNot',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

/**
 * Prisma scalar/list operators this double does NOT implement. Naming them lets
 * an unsupported filter fail loudly instead of being mistaken for a relation
 * filter (which would silently evaluate false, and true under NOT).
 */
const UNSUPPORTED_READ_OPS = new Set([
  'has', 'hasSome', 'hasEvery', 'hasNone', 'isEmpty', 'search', 'path',
  'array_contains', 'array_starts_with', 'array_ends_with',
  'string_contains', 'string_starts_with', 'string_ends_with',
  'multiply', 'divide', 'push', 'unset',
]);

/** An object is a field-operator object when it carries at least one real operator key. */
function isOperatorObject(cond: Record<string, unknown>): boolean {
  return Object.keys(cond).some((k) => k !== 'mode' && OPS.has(k));
}

export function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out as T;
  }
  return v;
}

const scalar = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

function compare(a: unknown, b: unknown): number {
  const x = scalar(a);
  const y = scalar(b);
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return (x as number | string) < (y as number | string) ? -1 : 1;
}

const equal = (a: unknown, b: unknown): boolean => scalar(a) === scalar(b);

/**
 * SQL three-valued logic. `null` is UNKNOWN: `col = 'x'` / `col <> 'x'` / `col > 1`
 * on a NULL column are UNKNOWN, NOT(UNKNOWN) is UNKNOWN, and a row is returned
 * only when the whole predicate is TRUE. `col IS NULL` (`field: null`) and
 * `{ not: null }` are two-valued.
 */
type Tri = boolean | null;

const and3 = (vals: Tri[]): Tri => {
  if (vals.some((v) => v === false)) return false;
  return vals.some((v) => v === null) ? null : true;
};
const or3 = (vals: Tri[]): Tri => {
  if (vals.some((v) => v === true)) return true;
  return vals.some((v) => v === null) ? null : false;
};
const not3 = (v: Tri): Tri => (v === null ? null : !v);

function matchesField(value: unknown, cond: unknown): Tri {
  if (cond === undefined) return true;
  const present = value !== null && value !== undefined;
  if (cond === null) return !present;
  if (!isPlainObject(cond)) return present ? equal(value, cond) : null;
  if (!isOperatorObject(cond)) {
    // Relation filter: a nested where evaluated against the embedded object.
    const bad = Object.keys(cond).find((k) => UNSUPPORTED_READ_OPS.has(k));
    if (bad) throw new Error(`mem-db: unsupported operator ${bad}`);
    if (present && !isPlainObject(value)) {
      throw new Error(`mem-db: unsupported operator ${Object.keys(cond).join(',')} (not a relation filter on a scalar column)`);
    }
    return present && evalWhere(value as Row, cond) === true;
  }
  const insensitive = cond.mode === 'insensitive';
  const text = (v: unknown) => (insensitive ? String(v).toLowerCase() : String(v));
  const results: Tri[] = [];
  for (const [op, arg] of Object.entries(cond)) {
    if (arg === undefined) continue;
    switch (op) {
      case 'mode':
        break;
      case 'equals':
        results.push(matchesField(value, arg));
        break;
      case 'in':
        results.push(present ? (arg as unknown[]).some((x) => equal(value, x)) : null);
        break;
      case 'notIn':
        results.push(present ? !(arg as unknown[]).some((x) => equal(value, x)) : null);
        break;
      case 'not':
        // Postgres: `col <> x` is UNKNOWN when col IS NULL; `not: null` is IS NOT NULL.
        results.push(arg === null ? present : not3(matchesField(value, arg)));
        break;
      case 'lt':
        results.push(present ? compare(value, arg) < 0 : null);
        break;
      case 'lte':
        results.push(present ? compare(value, arg) <= 0 : null);
        break;
      case 'gt':
        results.push(present ? compare(value, arg) > 0 : null);
        break;
      case 'gte':
        results.push(present ? compare(value, arg) >= 0 : null);
        break;
      case 'contains':
        results.push(present ? typeof value === 'string' && text(value).includes(text(arg)) : null);
        break;
      case 'startsWith':
        results.push(present ? typeof value === 'string' && text(value).startsWith(text(arg)) : null);
        break;
      case 'endsWith':
        results.push(present ? typeof value === 'string' && text(value).endsWith(text(arg)) : null);
        break;
      case 'some':
        results.push(Array.isArray(value) && value.some((r) => matchesWhere(r as Row, arg as Where)));
        break;
      case 'every':
        results.push(Array.isArray(value) && value.every((r) => matchesWhere(r as Row, arg as Where)));
        break;
      case 'none':
        results.push(!(Array.isArray(value) && value.some((r) => matchesWhere(r as Row, arg as Where))));
        break;
      case 'is':
        results.push(arg === null ? !present : isPlainObject(value) && matchesWhere(value, arg as Where));
        break;
      case 'isNot':
        results.push(arg === null ? present : !(isPlainObject(value) && matchesWhere(value, arg as Where)));
        break;
      default:
        throw new Error(`mem-db: unsupported operator ${op}`);
    }
  }
  return and3(results);
}

/**
 * Evaluates a where clause in three-valued logic. AND/OR follow SQL rules;
 * `NOT: x` is NOT(x) (so `NOT: { col: 'a' }` excludes NULL-col rows, as Postgres
 * does); an array `NOT: [a, b]` means none of them is true, i.e. NOT a AND NOT b.
 * A relation filter that cannot resolve (embedded relation missing/null) is FALSE.
 * Known limit: an unknown operator on a missing/null column that is not in
 * UNSUPPORTED_READ_OPS is indistinguishable from a relation filter and yields FALSE.
 */
function evalWhere(row: Row, where: Where): Tri {
  if (!where) return true;
  const parts: Tri[] = [];
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Where[];
      parts.push(and3(list.map((w) => evalWhere(row, w))));
    } else if (key === 'OR') {
      parts.push(or3((cond as Where[]).map((w) => evalWhere(row, w))));
    } else if (key === 'NOT') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Where[];
      parts.push(and3(list.map((w) => not3(evalWhere(row, w)))));
    } else if (!(key in row) && isPlainObject(cond) && !isOperatorObject(cond) && key.includes('_')) {
      // Compound unique selector, e.g. { tenantId_key: { tenantId, key } }.
      parts.push(evalWhere(row, cond));
    } else {
      parts.push(matchesField(row[key], cond));
    }
  }
  return and3(parts);
}

/** A row matches only when the where clause is TRUE (UNKNOWN does not match). */
export function matchesWhere(row: Row, where: Where): boolean {
  return evalWhere(row, where) === true;
}

function sortRows(rows: Row[], orderBy: OrderBy): Row[] {
  const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [k, dir] of Object.entries(spec)) {
        const c = compare(a[k], b[k]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
    }
    return 0;
  });
}

const SCALAR_WRITE_OPS = new Set(['set', 'increment', 'decrement']);
const UNSUPPORTED_WRITE_OPS = new Set(['multiply', 'divide', 'push', 'unset']);
const NESTED_WRITE_OPS = new Set([
  'create', 'createMany', 'connect', 'connectOrCreate', 'disconnect',
  'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
]);

/** Validates the whole payload first so a rejected write leaves the row untouched. */
function assertWritable(data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || !isPlainObject(v)) continue;
    const keys = Object.keys(v);
    if (keys.some((x) => NESTED_WRITE_OPS.has(x))) {
      throw new Error(`mem-db: nested writes unsupported (field ${k})`);
    }
    if (keys.some((x) => UNSUPPORTED_WRITE_OPS.has(x)) || (keys.some((x) => SCALAR_WRITE_OPS.has(x)) && !keys.every((x) => SCALAR_WRITE_OPS.has(x)))) {
      throw new Error(`mem-db: unsupported write operator on ${k}: ${keys.join(',')}`);
    }
  }
}

function applyData(row: Row, data: Row): void {
  assertWritable(data);
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((x) => SCALAR_WRITE_OPS.has(x))) {
      if ('set' in v) row[k] = clone(v.set);
      if ('increment' in v) row[k] = (Number(row[k]) || 0) + Number(v.increment);
      if ('decrement' in v) row[k] = (Number(row[k]) || 0) - Number(v.decrement);
      continue;
    }
    row[k] = clone(v);
  }
}

export interface WriteLog {
  op: 'create' | 'update' | 'updateMany' | 'upsert' | 'delete' | 'deleteMany';
  args: unknown;
}

export class MemTable {
  rows: Row[] = [];
  writes: WriteLog[] = [];
  unique: string[][] = [];

  private matching(where: Where): Row[] {
    return this.rows.filter((r) => matchesWhere(r, where));
  }

  private assertUnique(candidate: Row): void {
    for (const fields of this.unique) {
      const clash = this.rows.some((r) =>
        fields.every((f) => candidate[f] !== undefined && candidate[f] !== null && equal(r[f], candidate[f])),
      );
      if (clash) {
        throw Object.assign(new Error(`Unique constraint failed on the fields: (${fields.join(',')})`), { code: 'P2002' });
      }
    }
  }

  private fresh(data: Row): Row {
    const now = new Date();
    const row: Row = { id: randomUUID(), createdAt: now, updatedAt: now };
    applyData(row, data);
    this.assertUnique(row);
    this.rows.push(row);
    return row;
  }

  findMany = async (args: { where?: Where; orderBy?: OrderBy; take?: number; skip?: number } = {}): Promise<Row[]> => {
    const skip = args.skip ?? 0;
    const sorted = sortRows(this.matching(args.where), args.orderBy);
    const page = args.take === undefined ? sorted.slice(skip) : sorted.slice(skip, skip + args.take);
    return page.map((r) => clone(r));
  };

  findFirst = async (args: { where?: Where; orderBy?: OrderBy } = {}): Promise<Row | null> =>
    (await this.findMany({ ...args, take: 1 }))[0] ?? null;

  findUnique = async (args: { where: Where }): Promise<Row | null> => this.findFirst(args);

  count = async (args: { where?: Where } = {}): Promise<number> => this.matching(args.where).length;

  aggregate = async (args: { where?: Where; _sum?: Record<string, boolean>; _count?: unknown }) => {
    const rows = this.matching(args.where);
    const out: Record<string, unknown> = {};
    if (args._sum) {
      const sum: Record<string, number | null> = {};
      for (const f of Object.keys(args._sum)) {
        sum[f] = rows.length === 0 ? null : rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);
      }
      out._sum = sum;
    }
    if (args._count) out._count = rows.length;
    return out;
  };

  create = async (args: { data: Row }): Promise<Row> => {
    this.writes.push({ op: 'create', args: clone(args) });
    return clone(this.fresh(args.data));
  };

  update = async (args: { where: Where; data: Row }): Promise<Row> => {
    this.writes.push({ op: 'update', args: clone(args) });
    const row = this.matching(args.where)[0];
    if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
    applyData(row, args.data);
    row.updatedAt = new Date();
    return clone(row);
  };

  updateMany = async (args: { where?: Where; data: Row }): Promise<{ count: number }> => {
    this.writes.push({ op: 'updateMany', args: clone(args) });
    const rows = this.matching(args.where);
    for (const r of rows) {
      applyData(r, args.data);
      r.updatedAt = new Date();
    }
    return { count: rows.length };
  };

  upsert = async (args: { where: Where; create: Row; update: Row }): Promise<Row> => {
    this.writes.push({ op: 'upsert', args: clone(args) });
    const row = this.matching(args.where)[0];
    if (row) {
      applyData(row, args.update);
      row.updatedAt = new Date();
      return clone(row);
    }
    return clone(this.fresh(args.create));
  };

  delete = async (args: { where: Where }): Promise<Row> => {
    this.writes.push({ op: 'delete', args: clone(args) });
    const idx = this.rows.findIndex((r) => matchesWhere(r, args.where));
    if (idx < 0) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
    const [removed] = this.rows.splice(idx, 1);
    return clone(removed);
  };

  deleteMany = async (args: { where?: Where } = {}): Promise<{ count: number }> => {
    this.writes.push({ op: 'deleteMany', args: clone(args) });
    const keep = this.rows.filter((r) => !matchesWhere(r, args.where));
    const count = this.rows.length - keep.length;
    this.rows = keep;
    return { count };
  };
}

export type MemDbSeed = Record<string, Row[]>;
export interface MemDbOptions {
  unique?: Record<string, string[][]>;
}

export type MemDb = {
  reset(seed?: MemDbSeed, options?: MemDbOptions): void;
  table(model: string): MemTable;
  $transaction(arg: unknown): Promise<unknown>;
  [model: string]: unknown;
};

export function createMemDb(): MemDb {
  const tables = new Map<string, MemTable>();
  const table = (model: string): MemTable => {
    let t = tables.get(model);
    if (!t) {
      t = new MemTable();
      tables.set(model, t);
    }
    return t;
  };
  const base = {
    reset(seed: MemDbSeed = {}, options: MemDbOptions = {}) {
      tables.clear();
      for (const [model, rows] of Object.entries(seed)) table(model).rows = rows.map((r) => clone(r));
      for (const [model, keys] of Object.entries(options.unique ?? {})) table(model).unique = keys;
    },
    table,
    async $transaction(arg: unknown): Promise<unknown> {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => Promise<unknown>)(proxy);
    },
  };
  const proxy = new Proxy(base as unknown as MemDb, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return (target as Record<string, unknown>)[prop];
      if (typeof prop === 'string' && /^ab[A-Z]/.test(prop)) return table(prop);
      return undefined;
    },
  });
  return proxy;
}

/** Shared instance for `vi.mock('@naap/database', …)` factories. */
export const memDb = createMemDb();
