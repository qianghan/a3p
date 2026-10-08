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
 * back), and nested writes (`lines: { create }`) are not stored.
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

function isOperatorObject(cond: Record<string, unknown>): boolean {
  const keys = Object.keys(cond);
  return keys.length > 0 && keys.every((k) => OPS.has(k));
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

function matchesField(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (!isPlainObject(cond)) return value !== null && value !== undefined && equal(value, cond);
  if (!isOperatorObject(cond)) {
    // Relation filter: a nested where evaluated against the embedded object.
    return isPlainObject(value) && matchesWhere(value, cond);
  }
  const insensitive = cond.mode === 'insensitive';
  const text = (v: unknown) => (insensitive ? String(v).toLowerCase() : String(v));
  const present = value !== null && value !== undefined;
  for (const [op, arg] of Object.entries(cond)) {
    if (arg === undefined) continue;
    switch (op) {
      case 'mode':
        break;
      case 'equals':
        if (!matchesField(value, arg)) return false;
        break;
      case 'in':
        if (!present || !(arg as unknown[]).some((x) => equal(value, x))) return false;
        break;
      case 'notIn':
        if (!present || (arg as unknown[]).some((x) => equal(value, x))) return false;
        break;
      case 'not':
        // Postgres: `col <> x` is never true when col IS NULL.
        if (arg === null) {
          if (!present) return false;
          break;
        }
        if (!present) return false;
        if (matchesField(value, arg)) return false;
        break;
      case 'lt':
        if (!present || compare(value, arg) >= 0) return false;
        break;
      case 'lte':
        if (!present || compare(value, arg) > 0) return false;
        break;
      case 'gt':
        if (!present || compare(value, arg) <= 0) return false;
        break;
      case 'gte':
        if (!present || compare(value, arg) < 0) return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || !text(value).includes(text(arg))) return false;
        break;
      case 'startsWith':
        if (typeof value !== 'string' || !text(value).startsWith(text(arg))) return false;
        break;
      case 'endsWith':
        if (typeof value !== 'string' || !text(value).endsWith(text(arg))) return false;
        break;
      case 'some':
        if (!Array.isArray(value) || !value.some((r) => matchesWhere(r as Row, arg as Where))) return false;
        break;
      case 'every':
        if (!Array.isArray(value) || !value.every((r) => matchesWhere(r as Row, arg as Where))) return false;
        break;
      case 'none':
        if (Array.isArray(value) && value.some((r) => matchesWhere(r as Row, arg as Where))) return false;
        break;
      case 'is':
        if (arg === null ? present : !(isPlainObject(value) && matchesWhere(value, arg as Where))) return false;
        break;
      case 'isNot':
        if (arg === null ? !present : isPlainObject(value) && matchesWhere(value, arg as Where)) return false;
        break;
      default:
        throw new Error(`mem-db: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Where): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Where[];
      if (!list.every((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      const list = (Array.isArray(cond) ? cond : [cond]) as Where[];
      if (list.some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (!(key in row) && isPlainObject(cond) && !isOperatorObject(cond) && key.includes('_')) {
      // Compound unique selector, e.g. { tenantId_key: { tenantId, key } }.
      if (!matchesWhere(row, cond)) return false;
      continue;
    }
    if (!matchesField(row[key], cond)) return false;
  }
  return true;
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

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && ('increment' in v || 'decrement' in v || 'set' in v)) {
      if ('set' in v) row[k] = clone(v.set);
      if ('increment' in v) row[k] = (Number(row[k]) || 0) + Number(v.increment);
      if ('decrement' in v) row[k] = (Number(row[k]) || 0) - Number(v.decrement);
      continue;
    }
    if (isPlainObject(v) && ('create' in v || 'connect' in v || 'connectOrCreate' in v)) continue;
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
