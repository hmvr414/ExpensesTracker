import { Router, Request, Response } from 'express';
import { promises as fs } from 'fs';
import { z } from 'zod';
import db, { getPool } from '../db';
import { resolveCategoryByName } from '../helpers/categoryResolver';
import { TIME_FIELD, normalizeTime } from '../helpers/timeField';
import { chooseGranularity, timeSeriesFormat } from '../helpers/timeSeries';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const NEW_CATEGORY_NAME = z
  .string()
  .trim()
  .min(1, 'new_category_name must not be empty')
  .max(40, 'new_category_name must be at most 40 characters');

const createSchema = z.object({
  amount: z.number().positive('amount must be a positive number'),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD').optional(),
  time: TIME_FIELD.optional(),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  payment_method_id: z.number().int().positive().nullable().optional(),
  new_category_name: NEW_CATEGORY_NAME.optional(),
});

const updateSchema = z.object({
  amount: z.number().positive('amount must be a positive number').optional(),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD').optional(),
  time: TIME_FIELD.optional(),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  payment_method_id: z.number().int().positive().nullable().optional(),
  new_category_name: NEW_CATEGORY_NAME.optional(),
});

function bothCategoryFieldsError(res: Response): void {
  res.status(400).json({
    error: 'Validation failed',
    details: {
      new_category_name: 'Provide either category_id or new_category_name, not both',
    },
  });
}

async function paymentMethodExists(id: number): Promise<boolean> {
  const result = await db.query(`SELECT id FROM payment_methods WHERE id = $1`, [id]);
  return result.rowCount !== 0;
}

const PAYMENT_METHOD_JSON = `
  CASE WHEN pm.id IS NULL THEN NULL
       ELSE json_build_object('id', pm.id, 'name', pm.name, 'kind', pm.kind,
                              'brand', pm.brand, 'variant', pm.variant)
  END AS payment_method`;

// Appended after a wildcard select so the aliases override raw pg date/time
// serialization. The API exposes date as YYYY-MM-DD and time as HH:MM.
const DATE_ISO = `to_char(m.date, 'YYYY-MM-DD') AS date`;
const DATE_ISO_BARE = `to_char(date, 'YYYY-MM-DD') AS date`;
const TIME_HHMM = `to_char(m.time, 'HH24:MI') AS time`;
const TIME_HHMM_BARE = `to_char(time, 'HH24:MI') AS time`;

// Parses the `category_id` query param in all accepted forms — a single value,
// repeated params (`category_id=3&category_id=7`), and comma-separated
// (`category_id=3,7`) — into a deduplicated list of positive ints. Non-numeric
// and non-positive tokens are silently dropped rather than rejected.
function parseCategoryIds(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const ids: number[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const token of value.split(',')) {
      const trimmed = token.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const n = parseInt(trimmed, 10);
      if (n > 0 && !ids.includes(n)) ids.push(n);
    }
  }
  return ids;
}

// Builds the non-date filter SQL fragments (category / uncategorized / payment
// method / store / search) shared by the list and series endpoints so the chart
// always reflects exactly the rows the table shows. Appends bind values to
// `params` (mutated) and returns the matching `m.`-qualified conditions. Callers
// add their own date predicates (the list uses from/to; series uses its bounds).
function buildMovementFilters(query: Request['query'], params: unknown[]): string[] {
  const conditions: string[] = [];
  const { store, search, payment_method_id } = query;
  const categoryIds = parseCategoryIds(query.category_id);
  const uncategorized = query.uncategorized === 'true';

  if (categoryIds.length && uncategorized) {
    conditions.push(`(m.category_id = ANY($${params.push(categoryIds)}) OR m.category_id IS NULL)`);
  } else if (categoryIds.length) {
    conditions.push(`m.category_id = ANY($${params.push(categoryIds)})`);
  } else if (uncategorized) {
    conditions.push(`m.category_id IS NULL`);
  }
  if (payment_method_id) {
    conditions.push(`m.payment_method_id = $${params.push(parseInt(payment_method_id as string, 10))}`);
  }
  if (store) conditions.push(`m.store ILIKE $${params.push(`%${store}%`)}`);
  if (search) {
    const idx = params.push(`%${search}%`);
    conditions.push(`(m.description ILIKE $${idx} OR m.store ILIKE $${idx})`);
  }
  return conditions;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

function isValidISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  return !isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

function validationError(err: z.ZodError, res: Response): void {
  const details: Record<string, string> = {};
  for (const issue of err.issues) {
    details[issue.path.join('.') || 'body'] = issue.message;
  }
  res.status(400).json({ error: 'Validation failed', details });
}

router.get('/', async (req: Request, res: Response) => {
  const { from, to } = req.query;
  const pageNum = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const offset = (pageNum - 1) * limitNum;

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (from) conditions.push(`m.date >= $${params.push(from)}`);
  if (to) conditions.push(`m.date <= $${params.push(to)}`);
  conditions.push(...buildMovementFilters(req.query, params));

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query<{ total: string; total_amount: number }>(
    `SELECT COUNT(*)::text AS total, COALESCE(SUM(m.amount), 0)::float8 AS total_amount
     FROM movements m ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);
  const totalAmount = countResult.rows[0].total_amount;

  const limitIdx = params.push(limitNum);
  const offsetIdx = params.push(offset);

  const result = await db.query(
    `SELECT m.*, ${DATE_ISO}, ${TIME_HHMM},
            c.name AS category_name, c.color AS category_color,
            ${PAYMENT_METHOD_JSON},
            COALESCE(json_agg(a ORDER BY a.created_at) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM movements m
     LEFT JOIN categories c ON c.id = m.category_id
     LEFT JOIN payment_methods pm ON pm.id = m.payment_method_id
     LEFT JOIN attachments a ON a.movement_id = m.id
     ${where}
     GROUP BY m.id, c.name, c.color, pm.id
     ORDER BY m.date DESC, m.time DESC NULLS LAST, m.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  res.json({ data: result.rows, total, totalAmount, page: pageNum, limit: limitNum });
});

// Filter-aware, zero-filled spend time series over an explicit [from, to] range.
// Accepts the same filter params as the list endpoint; bucket granularity adapts
// to the span (see helpers/timeSeries). Declared before `/:id` so the literal
// path wins over the param route.
router.get('/series', async (req: Request, res: Response) => {
  const { from, to } = req.query;
  if (!isValidISODate(from) || !isValidISODate(to)) {
    res.status(400).json({ error: 'from and to are required ISO dates (YYYY-MM-DD)' });
    return;
  }
  if (from > to) {
    res.status(400).json({ error: 'from must be on or before to' });
    return;
  }

  const fmt = timeSeriesFormat(chooseGranularity(from, to));

  // $1 = from, $2 = to, then the shared (non-date) filters.
  const params: unknown[] = [from, to];
  const filters = buildMovementFilters(req.query, params);
  const filterSql = filters.length ? `AND ${filters.join(' AND ')}` : '';

  // Hourly buckets resolve to the movement's date+time; coarser buckets use the
  // date alone. Bounds are generated over DATE_TRUNC'd ends so partial first/last
  // buckets still appear.
  const bucketExpr =
    fmt.truncUnit === 'hour'
      ? `DATE_TRUNC('hour', (m.date + COALESCE(m.time, '00:00'::time))::timestamp)`
      : `DATE_TRUNC('${fmt.truncUnit}', m.date::timestamp)`;
  const lowerBound =
    fmt.truncUnit === 'hour'
      ? `$1::timestamp`
      : `DATE_TRUNC('${fmt.truncUnit}', $1::timestamp)`;
  const upperBound =
    fmt.truncUnit === 'hour'
      ? `$2::timestamp + interval '23 hour'`
      : `DATE_TRUNC('${fmt.truncUnit}', $2::timestamp)`;

  const seriesResult = await db.query<{ label: string; total: number }>(
    `WITH buckets AS (
       SELECT generate_series(${lowerBound}, ${upperBound}, '${fmt.interval}'::interval) AS bucket
     )
     SELECT TO_CHAR(b.bucket, '${fmt.labelFormat}') AS label,
            COALESCE(SUM(m.amount), 0)::float8 AS total
     FROM buckets b
     LEFT JOIN movements m
       ON ${bucketExpr} = b.bucket
       AND m.date >= $1 AND m.date <= $2
       ${filterSql}
     GROUP BY b.bucket
     ORDER BY b.bucket`,
    params
  );

  const data = seriesResult.rows.map((r) => ({ label: r.label.trim(), total: r.total }));
  const currentTotal = data.reduce((sum, p) => sum + p.total, 0);

  // Equal-length window immediately preceding [from, to], same filters applied.
  const windowDays =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const prevFrom = addDays(from, -windowDays);
  const prevTo = addDays(from, -1);

  const prevParams: unknown[] = [prevFrom, prevTo];
  const prevFilters = buildMovementFilters(req.query, prevParams);
  const prevFilterSql = prevFilters.length ? `AND ${prevFilters.join(' AND ')}` : '';
  const prevResult = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(m.amount), 0)::float8 AS total
     FROM movements m
     WHERE m.date >= $1 AND m.date <= $2 ${prevFilterSql}`,
    prevParams
  );
  const previousTotal = prevResult.rows[0].total;
  const deltaPct =
    previousTotal === 0
      ? null
      : Math.round(((currentTotal - previousTotal) / previousTotal) * 10000) / 100;

  res.json({
    granularity: fmt.granularity,
    data,
    comparison: { previousTotal, currentTotal, deltaPct },
  });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const result = await db.query(
    `SELECT m.*, ${DATE_ISO}, ${TIME_HHMM},
            c.name AS category_name, c.color AS category_color,
            ${PAYMENT_METHOD_JSON},
            COALESCE(json_agg(a ORDER BY a.created_at) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM movements m
     LEFT JOIN categories c ON c.id = m.category_id
     LEFT JOIN payment_methods pm ON pm.id = m.payment_method_id
     LEFT JOIN attachments a ON a.movement_id = m.id
     WHERE m.id = $1
     GROUP BY m.id, c.name, c.color, pm.id`,
    [id]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: `Movement ${id} not found` });
    return;
  }

  res.json(result.rows[0]);
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    validationError(parsed.error, res);
    return;
  }

  const { amount, date, time, description, store, category_id, payment_method_id, new_category_name } = parsed.data;
  const dateValue = date ?? new Date().toISOString().split('T')[0];
  const timeValue = normalizeTime(time);

  if (new_category_name !== undefined && category_id != null) {
    bothCategoryFieldsError(res);
    return;
  }

  if (category_id != null) {
    const cat = await db.query(`SELECT id FROM categories WHERE id = $1`, [category_id]);
    if (cat.rowCount === 0) {
      res.status(400).json({ error: 'Validation failed', details: { category_id: `Category ${category_id} not found` } });
      return;
    }
  }

  if (payment_method_id != null && !(await paymentMethodExists(payment_method_id))) {
    res.status(400).json({ error: 'Validation failed', details: { payment_method_id: `Payment method ${payment_method_id} not found` } });
    return;
  }

  if (new_category_name !== undefined) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const resolved = await resolveCategoryByName(client, new_category_name);
      const result = await client.query(
        `INSERT INTO movements (amount, date, time, description, store, category_id, payment_method_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *, ${DATE_ISO_BARE}, ${TIME_HHMM_BARE}`,
        [amount, dateValue, timeValue, description ?? null, store ?? null, resolved.id, payment_method_id ?? null]
      );
      await client.query('COMMIT');
      res.status(201).json({ ...result.rows[0], category: resolved });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  const result = await db.query(
    `INSERT INTO movements (amount, date, time, description, store, category_id, payment_method_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *, ${DATE_ISO_BARE}, ${TIME_HHMM_BARE}`,
    [amount, dateValue, timeValue, description ?? null, store ?? null, category_id ?? null, payment_method_id ?? null]
  );

  res.status(201).json(result.rows[0]);
});

router.put('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const existing = await db.query(`SELECT id FROM movements WHERE id = $1`, [id]);
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Movement ${id} not found` });
    return;
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    validationError(parsed.error, res);
    return;
  }

  const { amount, date, time, description, store, category_id, payment_method_id, new_category_name } = parsed.data;

  if (new_category_name !== undefined && category_id != null) {
    bothCategoryFieldsError(res);
    return;
  }

  if (category_id != null) {
    const cat = await db.query(`SELECT id FROM categories WHERE id = $1`, [category_id]);
    if (cat.rowCount === 0) {
      res.status(400).json({ error: 'Validation failed', details: { category_id: `Category ${category_id} not found` } });
      return;
    }
  }

  if (payment_method_id != null && !(await paymentMethodExists(payment_method_id))) {
    res.status(400).json({ error: 'Validation failed', details: { payment_method_id: `Payment method ${payment_method_id} not found` } });
    return;
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (amount !== undefined) { sets.push(`amount = $${values.push(amount)}`); }
  if (date !== undefined) { sets.push(`date = $${values.push(date)}`); }
  if ('time' in parsed.data) { sets.push(`time = $${values.push(normalizeTime(time))}`); }
  if (description !== undefined) { sets.push(`description = $${values.push(description)}`); }
  if (store !== undefined) { sets.push(`store = $${values.push(store)}`); }
  if ('category_id' in parsed.data && new_category_name === undefined) { sets.push(`category_id = $${values.push(category_id ?? null)}`); }
  if ('payment_method_id' in parsed.data) { sets.push(`payment_method_id = $${values.push(payment_method_id ?? null)}`); }

  if (new_category_name !== undefined) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const resolved = await resolveCategoryByName(client, new_category_name);
      sets.push(`category_id = $${values.push(resolved.id)}`);
      sets.push('updated_at = now()');
      values.push(id);
      const result = await client.query(
        `UPDATE movements SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *, ${DATE_ISO_BARE}, ${TIME_HHMM_BARE}`,
        values
      );
      await client.query('COMMIT');
      res.json({ ...result.rows[0], category: resolved });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  sets.push('updated_at = now()');

  if (sets.length === 1) {
    const row = await db.query(`SELECT *, ${DATE_ISO_BARE}, ${TIME_HHMM_BARE} FROM movements WHERE id = $1`, [id]);
    res.json(row.rows[0]);
    return;
  }

  values.push(id);
  const result = await db.query(
    `UPDATE movements SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *, ${DATE_ISO_BARE}, ${TIME_HHMM_BARE}`,
    values
  );

  res.json(result.rows[0]);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const existing = await db.query(`SELECT id FROM movements WHERE id = $1`, [id]);
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Movement ${id} not found` });
    return;
  }

  const attachments = await db.query<{ file_path: string }>(
    `SELECT file_path FROM attachments WHERE movement_id = $1`,
    [id]
  );

  await db.query(`DELETE FROM attachments WHERE movement_id = $1`, [id]);
  await db.query(`DELETE FROM movements WHERE id = $1`, [id]);

  for (const { file_path } of attachments.rows) {
    try {
      await fs.unlink(file_path);
    } catch {
      // ignore missing files
    }
  }

  res.status(204).send();
});

export default router;
