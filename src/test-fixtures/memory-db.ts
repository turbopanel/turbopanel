/**
 * An in-memory drizzle-shaped `Db` double for host-free tests.
 *
 * Interprets the subset of the query builder the billing code uses —
 * `insert … onConflictDo{Nothing,Update} … returning`, `select … from …
 * {inner,left}Join … where … groupBy … orderBy … limit`, `update … set …
 * where`, `delete … where` — against plain arrays of rows keyed by JS
 * property name. `where` clauses are evaluated by walking the drizzle SQL
 * tree: `eq`, `and`, `isNull`, `isNotNull`, `inArray`, a raw `<=` against a
 * `::timestamptz` param, and the `->>'key' =` json predicate. `set` values
 * that are SQL understand `coalesce(...)` and `+ make_interval(secs => n)`.
 *
 * Anything outside that subset throws, so a test that drifts into an
 * unsupported shape fails loudly instead of silently returning nothing.
 * Tables not registered fall through to an optional `fallback` db (a mock
 * auth db, for sessions).
 */

import { Column, getTableColumns, getTableName, Param, SQL, StringChunk } from 'drizzle-orm'
import type { Db } from '../db.ts'

type Row = Record<string, unknown>
type Table = Parameters<typeof getTableColumns>[0]

type Token =
  | { kind: 'str'; value: string }
  | { kind: 'col'; column: Column }
  | { kind: 'param'; value: unknown }
  | { kind: 'list'; values: unknown[] }

// ---------------------------------------------------------------------------
// SQL tree → token list
// ---------------------------------------------------------------------------

function flatten(node: unknown, out: Token[]): void {
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) flatten(chunk, out)
    return
  }
  if (node instanceof StringChunk) {
    out.push({ kind: 'str', value: node.value.join('') })
    return
  }
  if (node instanceof Column) {
    out.push({ kind: 'col', column: node })
    return
  }
  if (node instanceof Param) {
    out.push({ kind: 'param', value: node.value })
    return
  }
  if (Array.isArray(node)) {
    const values = node.map((item) => (item instanceof Param ? item.value : item))
    out.push({ kind: 'list', values })
    return
  }
  // A raw value interpolated into a `sql` template.
  out.push({ kind: 'param', value: node })
}

/** Merge adjacent string tokens and drop empties. */
function tokens(node: unknown): Token[] {
  const raw: Token[] = []
  flatten(node, raw)
  const out: Token[] = []
  for (const token of raw) {
    if (token.kind === 'str') {
      if (token.value.length === 0) continue
      const last = out.at(-1)
      if (last?.kind === 'str') {
        last.value += token.value
        continue
      }
    }
    out.push({ ...token })
  }
  return out
}

function isStr(token: Token | undefined, value: string): boolean {
  return token?.kind === 'str' && token.value === value
}

/** Render a token as text, with `<col>` / `?` placeholders, for shape matching. */
function tokenText(token: Token): string {
  if (token.kind === 'str') return token.value
  return token.kind === 'col' ? '<col>' : '?'
}

function firstColumn(list: Token[]): Column | undefined {
  for (const token of list) {
    if (token.kind === 'col') return token.column
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Row context and column access
// ---------------------------------------------------------------------------

type RowContext = Map<Table, Row | null>

function columnKey(column: Column): { table: Table; key: string } {
  const table = column.table as unknown as Table
  const columns = getTableColumns(table)
  for (const [key, candidate] of Object.entries(columns)) {
    if (candidate === column) return { table, key }
  }
  throw new Error(`memory-db: column ${column.name} not found on ${getTableName(table)}`)
}

function readColumn(ctx: RowContext, column: Column): unknown {
  const { table, key } = columnKey(column)
  const row = ctx.get(table)
  return row ? (row[key] ?? null) : null
}

function singleRow(table: Table, row: Row): RowContext {
  return new Map([[table, row]])
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** ISO timestamps compare by instant; everything else compares as-is. */
function comparable(value: unknown): number {
  if (typeof value === 'string') {
    const instant = Date.parse(value)
    if (Number.isFinite(instant)) return instant
  }
  return value as number
}

function compareValues(a: unknown, b: unknown): number {
  const left = comparable(a)
  const right = comparable(b)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

// ---------------------------------------------------------------------------
// `where` evaluation
// ---------------------------------------------------------------------------

/** One evaluated predicate: whether it held, and how many tokens it consumed. */
type Atom = Readonly<{ ok: boolean; width: number }>

const ORDERINGS: ReadonlyMap<string, (c: number) => boolean> = new Map([
  [' <= ', (c: number) => c <= 0],
  [' < ', (c: number) => c < 0],
  [' >= ', (c: number) => c >= 0],
  [' > ', (c: number) => c > 0],
])

const JSON_PREDICATE = /^->>'([^']+)' = $/

function operandValue(token: Token, ctx: RowContext): unknown {
  if (token.kind === 'col') return readColumn(ctx, token.column)
  return token.kind === 'param' ? token.value : null
}

function evaluateIn(left: unknown, right: Token | undefined): Atom {
  if (right?.kind !== 'list') throw new Error('memory-db: in without list')
  return { ok: right.values.some((value) => sameValue(value, left)), width: 3 }
}

function evaluateJsonPredicate(left: unknown, key: string, right: Token | undefined): Atom {
  const inner = left && typeof left === 'object' ? (left as Row)[key] : undefined
  const ok = right?.kind === 'param' && sameValue(inner, right.value)
  return { ok, width: 3 }
}

function evaluateComparison(
  text: string,
  left: unknown,
  right: Token | undefined,
  ctx: RowContext,
): Atom {
  if (!right) throw new Error('memory-db: comparison without operand')
  const rightValue = operandValue(right, ctx)
  if (text === ' = ') return { ok: sameValue(left, rightValue), width: 3 }
  if (left == null || rightValue == null) return { ok: false, width: 3 }
  const holds = ORDERINGS.get(text)!
  return { ok: holds(compareValues(left, rightValue)), width: 3 }
}

/** Evaluate the predicate whose column sits at `list[i]`. */
function evaluateAtom(list: Token[], i: number, column: Column, ctx: RowContext): Atom {
  const op = list[i + 1]
  if (op?.kind !== 'str') throw new Error('memory-db: column without operator')
  const left = readColumn(ctx, column)
  const text = op.value
  if (text.startsWith(' is not null')) return { ok: left != null, width: 2 }
  if (text.startsWith(' is null')) return { ok: left == null, width: 2 }
  if (text.startsWith(' in ')) return evaluateIn(left, list[i + 2])
  const jsonMatch = JSON_PREDICATE.exec(text)
  if (jsonMatch) return evaluateJsonPredicate(left, jsonMatch[1]!, list[i + 2])
  if (text === ' = ' || ORDERINGS.has(text)) {
    return evaluateComparison(text, left, list[i + 2], ctx)
  }
  throw new Error(`memory-db: unsupported where operator ${JSON.stringify(text)}`)
}

/** Evaluate a where clause: every atom in the tree, conjoined. */
function evaluateWhere(where: unknown, ctx: RowContext): boolean {
  if (where === undefined) return true
  const list = tokens(where)
  let i = 0
  while (i < list.length) {
    const token = list[i]!
    if (token.kind !== 'col') {
      i += 1
      continue
    }
    const atom = evaluateAtom(list, i, token.column, ctx)
    if (!atom.ok) return false
    i += atom.width
  }
  return true
}

// ---------------------------------------------------------------------------
// `set` expressions
// ---------------------------------------------------------------------------

const SET_KEYWORDS = /(coalesce\(|make_interval\(secs => |\(|\)|,|\+|::timestamptz)/

/** Re-tokenize string chunks into keyword pieces. */
function setPieces(node: SQL): Token[] {
  const pieces: Token[] = []
  for (const token of tokens(node)) {
    if (token.kind !== 'str') {
      pieces.push(token)
      continue
    }
    const parts = token.value
      .split(SET_KEYWORDS)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    for (const part of parts) pieces.push({ kind: 'str', value: part })
  }
  return pieces
}

/** Evaluate a `set` value that is SQL (`coalesce`, `+ make_interval`). */
function evaluateSetExpression(node: unknown, row: Row, table: Table): unknown {
  if (!(node instanceof SQL)) return node
  const pieces = setPieces(node)
  let pos = 0
  const peek = () => pieces[pos]
  const takeStr = (expected: string) => {
    if (!isStr(pieces[pos], expected)) {
      throw new Error(`memory-db: expected ${expected} in set expression`)
    }
    pos += 1
  }
  const ctx = singleRow(table, row)
  const term = (): unknown => {
    const token = peek()
    if (!token) throw new Error('memory-db: unexpected end of set expression')
    if (token.kind === 'col') {
      pos += 1
      return readColumn(ctx, token.column)
    }
    if (token.kind === 'param') {
      pos += 1
      return token.value
    }
    if (isStr(token, 'coalesce(')) {
      pos += 1
      const args: unknown[] = [expr()]
      while (isStr(peek(), ',')) {
        pos += 1
        args.push(expr())
      }
      takeStr(')')
      return args.find((value) => value != null) ?? null
    }
    throw new Error(`memory-db: unsupported set token ${JSON.stringify(token)}`)
  }
  const expr = (): unknown => {
    let value = term()
    for (;;) {
      const next = peek()
      if (isStr(next, '::timestamptz')) {
        pos += 1
        continue
      }
      if (isStr(next, '+')) {
        pos += 1
        takeStr('make_interval(secs =>')
        const secs = term()
        takeStr(')')
        if (typeof value === 'string' && typeof secs === 'number') {
          value = new Date(Date.parse(value) + secs * 1000).toISOString()
        }
        continue
      }
      return value
    }
  }
  return expr()
}

function applySet(row: Row, values: Row, table: Table): void {
  for (const [key, value] of Object.entries(values)) {
    row[key] = evaluateSetExpression(value, row, table)
  }
}

// ---------------------------------------------------------------------------
// Rows in, rows out
// ---------------------------------------------------------------------------

function applyInsertDefaults(table: Table, values: Row, now: string): Row {
  const row: Row = { ...values }
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (row[key] !== undefined) continue
    if (key === 'id') row.id = crypto.randomUUID()
    else if (key === 'createdAt' || key === 'updatedAt') row[key] = now
    else if (column.hasDefault && typeof column.default !== 'object') {
      row[key] = column.default ?? null
    } else row[key] = null
  }
  return row
}

function project(fields: Row | undefined, ctx: RowContext, primary: Table): Row {
  if (!fields) return { ...ctx.get(primary) }
  const out: Row = {}
  for (const [key, field] of Object.entries(fields)) {
    if (field instanceof Column) out[key] = readColumn(ctx, field)
    else out[key] = field
  }
  return out
}

type Thenable<T> = {
  then: <R1, R2>(
    onF?: (v: T) => R1 | PromiseLike<R1>,
    onR?: (r: unknown) => R2 | PromiseLike<R2>,
  ) => Promise<R1 | R2>
}

/**
 * A drizzle `QueryPromise` double: the query runs only when awaited, so a
 * builder can keep accepting `.where()` / `.returning()` after construction.
 */
function lazyQuery<T>(run: () => Promise<T>): Thenable<T> {
  const then: Thenable<T>['then'] = (onF, onR) => run().then(onF, onR)
  return { then } // NOSONAR typescript:S7739 — deliberately thenable: mirrors drizzle's lazy QueryPromise
}

/** A lazy query that also accepts `.returning(fields)`. */
function returningQuery(run: (returning?: Row) => Promise<Row[]>) {
  return Object.assign(lazyQuery(() => run()), {
    returning: (fields?: Row) => run(fields),
  })
}

// ---------------------------------------------------------------------------
// The store and its four statement builders
// ---------------------------------------------------------------------------

type FallbackDb = Record<string, (...args: unknown[]) => unknown>

type Store = Readonly<{
  tables: Map<Table, Row[]>
  ops: string[]
  now: () => string
  fallback: FallbackDb | undefined
}>

function rowsOf(store: Store, table: Table): Row[] {
  const rows = store.tables.get(table)
  if (!rows) throw new Error(`memory-db: table ${getTableName(table)} not registered`)
  return rows
}

type ConflictSpec = Readonly<{ target: Column | Column[] | undefined; set?: Row; nothing: boolean }>

function conflictKeys(target: Column | Column[] | undefined): string[] {
  if (target === undefined) return []
  const targets = Array.isArray(target) ? target : [target]
  return targets.map((column) => columnKey(column).key)
}

function findConflict(rows: Row[], keys: string[], fresh: Row): Row | undefined {
  if (keys.length === 0) return undefined
  return rows.find((row) => keys.every((key) => sameValue(row[key], fresh[key])))
}

function insertInto(store: Store, table: Table) {
  const name = getTableName(table)
  return {
    values(values: Row) {
      let conflict: ConflictSpec | null = null
      const run = async (returning?: Row): Promise<Row[]> => {
        const rows = rowsOf(store, table)
        const fresh = applyInsertDefaults(table, values, store.now())
        const spec = conflict
        const existing = spec ? findConflict(rows, conflictKeys(spec.target), fresh) : undefined
        if (spec && existing) {
          if (spec.nothing) {
            store.ops.push(`insert-conflict:${name}`)
            return []
          }
          applySet(existing, spec.set ?? {}, table)
          store.ops.push(`update:${name}`)
          return [project(returning, singleRow(table, existing), table)]
        }
        rows.push(fresh)
        store.ops.push(`insert:${name}`)
        return [project(returning, singleRow(table, fresh), table)]
      }
      return Object.assign(returningQuery(run), {
        onConflictDoNothing(cfg: { target?: Column | Column[] } = {}) {
          conflict = { target: cfg.target, nothing: true }
          return returningQuery(run)
        },
        onConflictDoUpdate(cfg: { target: Column | Column[]; set: Row }) {
          conflict = { target: cfg.target, set: cfg.set, nothing: false }
          return returningQuery(run)
        },
      })
    },
  }
}

type Join = Readonly<{ table: Table; on: unknown; kind: 'inner' | 'left' }>

/** Expand each context by the rows of `join.table` its `on` clause admits. */
function applyJoin(store: Store, contexts: RowContext[], join: Join): RowContext[] {
  const next: RowContext[] = []
  for (const ctx of contexts) {
    const matches = rowsOf(store, join.table).filter((candidate) => {
      const trial = new Map(ctx)
      trial.set(join.table, candidate)
      return evaluateWhere(join.on, trial)
    })
    if (matches.length === 0 && join.kind === 'left') {
      const trial = new Map(ctx)
      trial.set(join.table, null)
      next.push(trial)
    }
    for (const match of matches) {
      const trial = new Map(ctx)
      trial.set(join.table, match)
      next.push(trial)
    }
  }
  return next
}

function evaluateAggregate(field: SQL, bucket: RowContext[]): unknown {
  const list = tokens(field)
  const text = list.map(tokenText).join('')
  if (text.startsWith('count(*)')) return bucket.length
  if (text.startsWith('count(<col>)')) {
    const column = firstColumn(list)!
    return bucket.filter((ctx) => readColumn(ctx, column) != null).length
  }
  throw new Error(`memory-db: unsupported aggregate ${text}`)
}

function projectGroup(fields: Row, bucket: RowContext[]): Row {
  const first = bucket[0]!
  const row: Row = {}
  for (const [key, field] of Object.entries(fields)) {
    if (field instanceof Column) row[key] = readColumn(first, field)
    else if (field instanceof SQL) row[key] = evaluateAggregate(field, bucket)
    else row[key] = field
  }
  return row
}

function aggregate(fields: Row, groupBy: Column[], contexts: RowContext[]): Row[] {
  const groups = new Map<string, RowContext[]>()
  for (const ctx of contexts) {
    const key = JSON.stringify(groupBy.map((column) => readColumn(ctx, column)))
    const bucket = groups.get(key) ?? []
    bucket.push(ctx)
    groups.set(key, bucket)
  }
  return [...groups.values()].map((bucket) => projectGroup(fields, bucket))
}

function hasAggregate(fields: Row | undefined): boolean {
  return fields !== undefined && Object.values(fields).some((f) => f instanceof SQL)
}

type OrderKey = Readonly<{ column: Column; descending: boolean }>

function parseOrderBy(entries: unknown[]): OrderKey[] {
  return entries.map((entry) => {
    const list = tokens(entry)
    const column = firstColumn(list)
    if (!column) throw new Error('memory-db: orderBy without column')
    const descending = list.some((t) => t.kind === 'str' && t.value.includes('desc'))
    return { column, descending }
  })
}

/** Nulls sort last in either direction. */
function compareContexts(a: RowContext, b: RowContext, keys: OrderKey[]): number {
  for (const { column, descending } of keys) {
    const av = readColumn(a, column) as string | number | null
    const bv = readColumn(b, column) as string | number | null
    if (av === bv) continue
    if (av == null) return 1
    if (bv == null) return -1
    const c = av < bv ? -1 : 1
    return descending ? -c : c
  }
  return 0
}

/** The original index of each context, in sorted order. */
function sortedOrder(contexts: RowContext[], keys: OrderKey[]): number[] {
  const indexed = contexts.map((ctx, index) => ({ ctx, index }))
  indexed.sort((a, b) => compareContexts(a.ctx, b.ctx, keys))
  return indexed.map(({ index }) => index)
}

type SelectQuery = {
  fields: Row | undefined
  joins: Join[]
  where: unknown
  groupBy: Column[]
  orderBy: unknown[]
  limit: number | undefined
}

function runSelect(store: Store, table: Table, query: Readonly<SelectQuery>): Row[] {
  const { fields, groupBy, orderBy, limit } = query
  let contexts = rowsOf(store, table).map((row) => singleRow(table, row))
  for (const join of query.joins) contexts = applyJoin(store, contexts, join)
  contexts = contexts.filter((ctx) => evaluateWhere(query.where, ctx))
  const grouped = groupBy.length > 0 || hasAggregate(fields)
  let out = grouped
    ? aggregate(fields ?? {}, groupBy, contexts)
    : contexts.map((ctx) => project(fields, ctx, table))
  if (orderBy.length > 0 && !grouped) {
    const order = sortedOrder(contexts, parseOrderBy(orderBy))
    out = order.map((index) => out[index]!)
  }
  if (limit !== undefined) out = out.slice(0, limit)
  store.ops.push(`select:${getTableName(table)}`)
  return out
}

function selectFrom(store: Store, fields: Row | undefined, table: Table) {
  const query: SelectQuery = {
    fields,
    joins: [],
    where: undefined,
    groupBy: [],
    orderBy: [],
    limit: undefined,
  }
  const builder = Object.assign(lazyQuery(async () => runSelect(store, table, query)), {
    innerJoin(other: Table, on: unknown) {
      query.joins.push({ table: other, on, kind: 'inner' })
      return builder
    },
    leftJoin(other: Table, on: unknown) {
      query.joins.push({ table: other, on, kind: 'left' })
      return builder
    },
    where(cond: unknown) {
      query.where = cond
      return builder
    },
    groupBy(...columns: Column[]) {
      query.groupBy = columns
      return builder
    },
    orderBy(...entries: unknown[]) {
      query.orderBy = entries
      return builder
    },
    limit(n: number) {
      query.limit = n
      return builder
    },
  })
  return builder
}

function select(store: Store, fields?: Row) {
  return {
    from(table: Table) {
      if (store.tables.has(table)) return selectFrom(store, fields, table)
      if (!store.fallback) throw new Error(`memory-db: table ${getTableName(table)} not registered`)
      const fallbackSelect = store.fallback.select as (f?: Row) => { from: (t: Table) => unknown }
      return fallbackSelect(fields).from(table)
    },
  }
}

/** A `where`-able statement: `run` receives the clause and the optional `returning` fields. */
function whereQuery(run: (where: unknown, returning?: Row) => Promise<Row[]>) {
  let where: unknown
  const builder = Object.assign(returningQuery((returning) => run(where, returning)), {
    where(cond: unknown) {
      where = cond
      return builder
    },
  })
  return builder
}

function update(store: Store, table: Table) {
  const name = getTableName(table)
  return {
    set(values: Row) {
      return whereQuery(async (where, returning) => {
        const out: Row[] = []
        for (const row of rowsOf(store, table)) {
          if (!evaluateWhere(where, singleRow(table, row))) continue
          applySet(row, values, table)
          out.push(project(returning, singleRow(table, row), table))
        }
        store.ops.push(`update:${name}`)
        return out
      })
    },
  }
}

function deleteFrom(store: Store, table: Table) {
  const name = getTableName(table)
  return whereQuery(async (where, returning) => {
    const rows = rowsOf(store, table)
    const kept: Row[] = []
    const out: Row[] = []
    for (const row of rows) {
      if (evaluateWhere(where, singleRow(table, row))) {
        out.push(project(returning, singleRow(table, row), table))
      } else kept.push(row)
    }
    rows.splice(0, rows.length, ...kept)
    store.ops.push(`delete:${name}`)
    return out
  })
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type MemoryDb = Db & {
  tables: Map<Table, Row[]>
  rows<T extends Row = Row>(table: Table): T[]
  ops: string[]
}

type MemoryTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type MemoryDbOpts = Readonly<{
  fallback?: Db
  now?: () => string
}>

export function createMemoryDb(seed: Iterable<[Table, Row[]]>, opts: MemoryDbOpts = {}): MemoryDb {
  const tables = new Map<Table, Row[]>()
  for (const [table, rows] of seed) tables.set(table, rows.map((row) => ({ ...row })))
  const store: Store = {
    tables,
    ops: [],
    now: opts.now ?? (() => new Date().toISOString()),
    fallback: opts.fallback as unknown as FallbackDb | undefined,
  }

  const db = {
    tables,
    ops: store.ops,
    rows: <T extends Row = Row>(table: Table) => rowsOf(store, table) as T[],
    insert: (table: Table) => insertInto(store, table),
    select: (fields?: Row) => select(store, fields),
    update: (table: Table) => update(store, table),
    delete: (table: Table) => deleteFrom(store, table),
    execute: (...args: unknown[]) => {
      if (!store.fallback?.execute) throw new Error('memory-db: execute not supported')
      return store.fallback.execute(...args)
    },
    /**
     * `db.transaction(fn)`: every registered table is snapshotted, `fn` runs
     * against **this same object** (so a test that traced `insert`/`delete`
     * on it still sees the writes), and a throw restores every table before
     * rethrowing — the rollback a failure-injection test asserts on. Nested
     * transactions are not modelled: the inner call runs against the outer
     * snapshot the way a Postgres savepoint-less nesting would.
     */
    transaction: async <T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> => {
      const snapshot = new Map<Table, Row[]>()
      for (const [table, rows] of tables) snapshot.set(table, rows.map((row) => ({ ...row })))
      store.ops.push('begin')
      try {
        const result = await fn(db as unknown as MemoryTx)
        store.ops.push('commit')
        return result
      } catch (err) {
        for (const [table, rows] of snapshot) {
          const live = tables.get(table)
          if (live) live.splice(0, live.length, ...rows)
        }
        store.ops.push('rollback')
        throw err
      }
    },
  }
  return db as unknown as MemoryDb
}
