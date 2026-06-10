import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

type Period = 'day' | 'week' | 'month' | 'year' | 'all';
type TruncUnit = 'hour' | 'day' | 'month';

interface DateRange {
  from: string | null;
  to: string | null;
  prevFrom: string | null;
  prevTo: string | null;
  truncUnit: TruncUnit;
  seriesFrom: string | null;
  seriesTo: string | null;
  seriesInterval: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function computeRange(period: Period, anchor: Date): DateRange {
  const y = anchor.getUTCFullYear();
  const mo = anchor.getUTCMonth();
  const d = anchor.getUTCDate();

  switch (period) {
    case 'day': {
      const from = toISODate(anchor);
      const prev = toISODate(new Date(Date.UTC(y, mo, d - 1)));
      return {
        from, to: from,
        prevFrom: prev, prevTo: prev,
        truncUnit: 'hour',
        seriesFrom: `${from} 00:00:00`,
        seriesTo: `${from} 23:00:00`,
        seriesInterval: '1 hour',
      };
    }
    case 'week': {
      const daysFromMon = (anchor.getUTCDay() + 6) % 7;
      const monday = new Date(Date.UTC(y, mo, d - daysFromMon));
      const sunday = new Date(Date.UTC(y, mo, d - daysFromMon + 6));
      const prevMonday = new Date(Date.UTC(y, mo, d - daysFromMon - 7));
      const prevSunday = new Date(Date.UTC(y, mo, d - daysFromMon - 1));
      const from = toISODate(monday);
      const to = toISODate(sunday);
      return {
        from, to,
        prevFrom: toISODate(prevMonday), prevTo: toISODate(prevSunday),
        truncUnit: 'day',
        seriesFrom: from, seriesTo: to,
        seriesInterval: '1 day',
      };
    }
    case 'month': {
      const from = `${y}-${pad(mo + 1)}-01`;
      const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const to = `${y}-${pad(mo + 1)}-${pad(lastDay)}`;
      const prevY = mo === 0 ? y - 1 : y;
      const prevMo = mo === 0 ? 11 : mo - 1;
      const prevLastDay = new Date(Date.UTC(prevY, prevMo + 1, 0)).getUTCDate();
      return {
        from, to,
        prevFrom: `${prevY}-${pad(prevMo + 1)}-01`,
        prevTo: `${prevY}-${pad(prevMo + 1)}-${pad(prevLastDay)}`,
        truncUnit: 'day',
        seriesFrom: from, seriesTo: to,
        seriesInterval: '1 day',
      };
    }
    case 'year': {
      const from = `${y}-01-01`;
      const to = `${y}-12-31`;
      return {
        from, to,
        prevFrom: `${y - 1}-01-01`, prevTo: `${y - 1}-12-31`,
        truncUnit: 'month',
        seriesFrom: from, seriesTo: to,
        seriesInterval: '1 month',
      };
    }
    case 'all': {
      return {
        from: null, to: null,
        prevFrom: null, prevTo: null,
        truncUnit: 'month',
        seriesFrom: null, seriesTo: null,
        seriesInterval: '1 month',
      };
    }
  }
}


router.get('/', async (req: Request, res: Response) => {
  const periodParam = (req.query.period as string) ?? 'month';
  const validPeriods: Period[] = ['day', 'week', 'month', 'year', 'all'];
  if (!validPeriods.includes(periodParam as Period)) {
    res.status(400).json({ error: `Invalid period "${periodParam}". Must be one of: ${validPeriods.join(', ')}` });
    return;
  }
  const period = periodParam as Period;

  const anchorParam = req.query.anchor as string | undefined;
  let anchor: Date;
  if (anchorParam) {
    anchor = new Date(anchorParam + 'T00:00:00Z');
    if (isNaN(anchor.getTime())) {
      res.status(400).json({ error: 'Invalid anchor date' });
      return;
    }
  } else {
    const now = new Date();
    anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  const range = computeRange(period, anchor);

  // Build date-filter WHERE fragment
  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];
  if (range.from) filterConditions.push(`m.date >= $${filterParams.push(range.from)}`);
  if (range.to)   filterConditions.push(`m.date <= $${filterParams.push(range.to)}`);
  const dateFilter = filterConditions.length ? `WHERE ${filterConditions.join(' AND ')}` : '';

  // Query 1: totals + category breakdown + top store
  const mainResult = await db.query<{
    total_amount: string;
    movement_count: string;
    top_store: string | null;
    category_breakdown: Array<{
      categoryId: number; name: string; color: string; total: string;
    }> | null;
  }>(`
    WITH period_movements AS (
      SELECT m.amount, m.category_id, m.store,
             c.id AS cat_id, c.name AS cat_name, c.color AS cat_color
      FROM movements m
      LEFT JOIN categories c ON c.id = m.category_id
      ${dateFilter}
    ),
    grand_total AS (
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt FROM period_movements
    ),
    cat_totals AS (
      SELECT cat_id, cat_name, cat_color, SUM(amount) AS cat_total
      FROM period_movements
      WHERE cat_id IS NOT NULL
      GROUP BY cat_id, cat_name, cat_color
    ),
    top_store_cte AS (
      SELECT store
      FROM period_movements
      WHERE store IS NOT NULL
      GROUP BY store
      ORDER BY SUM(amount) DESC
      LIMIT 1
    )
    SELECT
      gt.total AS total_amount,
      gt.cnt   AS movement_count,
      ts.store AS top_store,
      (
        SELECT json_agg(json_build_object(
          'categoryId', ct.cat_id,
          'name',       ct.cat_name,
          'color',      ct.cat_color,
          'total',      ct.cat_total::text
        ) ORDER BY ct.cat_total DESC)
        FROM cat_totals ct
      ) AS category_breakdown
    FROM grand_total gt
    LEFT JOIN top_store_cte ts ON true
  `, filterParams);

  const row = mainResult.rows[0];
  const grandTotal = parseFloat(row.total_amount);
  const movementCount = parseInt(row.movement_count, 10);

  const categoryBreakdown = (row.category_breakdown ?? []).map(cat => ({
    categoryId: cat.categoryId,
    name: cat.name,
    color: cat.color,
    total: parseFloat(cat.total),
    percentage: grandTotal > 0
      ? Math.round((parseFloat(cat.total) / grandTotal) * 10000) / 100
      : 0,
  }));

  // Query 2: time series with empty buckets via generate_series
  const labelFmt = range.truncUnit === 'hour' ? 'HH24:MI'
    : range.truncUnit === 'day' ? 'YYYY-MM-DD'
    : 'Mon YYYY';

  let timeSeriesRows: Array<{ label: string; total: string }>;

  if (period === 'all') {
    const tsResult = await db.query<{ label: string; total: string }>(`
      WITH bounds AS (
        SELECT
          DATE_TRUNC('month', MIN(date)) AS min_b,
          DATE_TRUNC('month', MAX(date)) AS max_b
        FROM movements
      ),
      buckets AS (
        SELECT generate_series(bounds.min_b, bounds.max_b, '1 month'::interval) AS bucket
        FROM bounds
        WHERE bounds.min_b IS NOT NULL
      )
      SELECT
        TO_CHAR(b.bucket, '${labelFmt}') AS label,
        COALESCE(SUM(m.amount), 0)::text AS total
      FROM buckets b
      LEFT JOIN movements m ON DATE_TRUNC('month', m.date::timestamp) = b.bucket
      GROUP BY b.bucket
      ORDER BY b.bucket
    `);
    timeSeriesRows = tsResult.rows;
  } else {
    const tsResult = await db.query<{ label: string; total: string }>(`
      WITH buckets AS (
        SELECT generate_series($1::timestamp, $2::timestamp, '${range.seriesInterval}'::interval) AS bucket
      )
      SELECT
        TO_CHAR(b.bucket, '${labelFmt}') AS label,
        COALESCE(SUM(m.amount), 0)::text AS total
      FROM buckets b
      LEFT JOIN movements m
        ON DATE_TRUNC('${range.truncUnit}', m.date::timestamp) = b.bucket
        AND m.date >= $3 AND m.date <= $4
      GROUP BY b.bucket
      ORDER BY b.bucket
    `, [range.seriesFrom, range.seriesTo, range.from, range.to]);
    timeSeriesRows = tsResult.rows;
  }

  const timeSeries = timeSeriesRows.map(r => ({
    label: r.label.trim(),
    total: parseFloat(r.total),
  }));

  // Query 3: previous period aggregates
  let previousPeriod = { totalAmount: 0, movementCount: 0 };
  if (range.prevFrom && range.prevTo) {
    const prevResult = await db.query<{ total_amount: string; movement_count: string }>(`
      SELECT
        COALESCE(SUM(amount), 0)::text AS total_amount,
        COUNT(*)::text AS movement_count
      FROM movements
      WHERE date >= $1 AND date <= $2
    `, [range.prevFrom, range.prevTo]);
    previousPeriod = {
      totalAmount: parseFloat(prevResult.rows[0].total_amount),
      movementCount: parseInt(prevResult.rows[0].movement_count, 10),
    };
  }

  res.json({
    totalAmount: grandTotal,
    movementCount,
    categoryBreakdown,
    timeSeries,
    previousPeriod,
    topStore: row.top_store,
  });
});

export default router;
