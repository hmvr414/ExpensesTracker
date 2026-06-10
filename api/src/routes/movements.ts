import { Router, Request, Response } from 'express';
import { promises as fs } from 'fs';
import { z } from 'zod';
import db from '../db';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  amount: z.number().positive('amount must be a positive number'),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD').optional(),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
});

const updateSchema = z.object({
  amount: z.number().positive('amount must be a positive number').optional(),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD').optional(),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
});

function validationError(err: z.ZodError, res: Response): void {
  const details: Record<string, string> = {};
  for (const issue of err.issues) {
    details[issue.path.join('.') || 'body'] = issue.message;
  }
  res.status(400).json({ error: 'Validation failed', details });
}

router.get('/', async (req: Request, res: Response) => {
  const { from, to, category_id, store, search } = req.query;
  const pageNum = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const offset = (pageNum - 1) * limitNum;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (from) conditions.push(`m.date >= $${params.push(from)}`);
  if (to) conditions.push(`m.date <= $${params.push(to)}`);
  if (category_id) conditions.push(`m.category_id = $${params.push(parseInt(category_id as string, 10))}`);
  if (store) conditions.push(`m.store ILIKE $${params.push(`%${store}%`)}`);
  if (search) {
    const idx = params.push(`%${search}%`);
    conditions.push(`(m.description ILIKE $${idx} OR m.store ILIKE $${idx})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM movements m ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const limitIdx = params.push(limitNum);
  const offsetIdx = params.push(offset);

  const result = await db.query(
    `SELECT m.*,
            c.name AS category_name, c.color AS category_color,
            COALESCE(json_agg(a ORDER BY a.created_at) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM movements m
     LEFT JOIN categories c ON c.id = m.category_id
     LEFT JOIN attachments a ON a.movement_id = m.id
     ${where}
     GROUP BY m.id, c.name, c.color
     ORDER BY m.date DESC, m.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  res.json({ data: result.rows, total, page: pageNum, limit: limitNum });
});

router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const result = await db.query(
    `SELECT m.*,
            c.name AS category_name, c.color AS category_color,
            COALESCE(json_agg(a ORDER BY a.created_at) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM movements m
     LEFT JOIN categories c ON c.id = m.category_id
     LEFT JOIN attachments a ON a.movement_id = m.id
     WHERE m.id = $1
     GROUP BY m.id, c.name, c.color`,
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

  const { amount, date, description, store, category_id } = parsed.data;
  const dateValue = date ?? new Date().toISOString().split('T')[0];

  if (category_id != null) {
    const cat = await db.query(`SELECT id FROM categories WHERE id = $1`, [category_id]);
    if (cat.rowCount === 0) {
      res.status(400).json({ error: 'Validation failed', details: { category_id: `Category ${category_id} not found` } });
      return;
    }
  }

  const result = await db.query(
    `INSERT INTO movements (amount, date, description, store, category_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [amount, dateValue, description ?? null, store ?? null, category_id ?? null]
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

  const { amount, date, description, store, category_id } = parsed.data;

  if (category_id != null) {
    const cat = await db.query(`SELECT id FROM categories WHERE id = $1`, [category_id]);
    if (cat.rowCount === 0) {
      res.status(400).json({ error: 'Validation failed', details: { category_id: `Category ${category_id} not found` } });
      return;
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (amount !== undefined) { sets.push(`amount = $${values.push(amount)}`); }
  if (date !== undefined) { sets.push(`date = $${values.push(date)}`); }
  if (description !== undefined) { sets.push(`description = $${values.push(description)}`); }
  if (store !== undefined) { sets.push(`store = $${values.push(store)}`); }
  if ('category_id' in parsed.data) { sets.push(`category_id = $${values.push(category_id ?? null)}`); }
  sets.push('updated_at = now()');

  if (sets.length === 1) {
    const row = await db.query(`SELECT * FROM movements WHERE id = $1`, [id]);
    res.json(row.rows[0]);
    return;
  }

  values.push(id);
  const result = await db.query(
    `UPDATE movements SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
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
