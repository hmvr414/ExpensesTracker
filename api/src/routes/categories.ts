import { Router, Request, Response } from 'express';
import { z } from 'zod';
import pool from '../db';

const router = Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  color: z.string().regex(HEX_COLOR, 'color must be a valid hex string (e.g. #ff0000)').optional(),
  icon: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1, 'name must not be empty').optional(),
  color: z.string().regex(HEX_COLOR, 'color must be a valid hex string (e.g. #ff0000)').optional(),
  icon: z.string().optional(),
});

router.get('/', async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.color, c.icon, c.created_at,
            COUNT(m.id)::int AS movement_count
     FROM categories c
     LEFT JOIN movements m ON m.category_id = c.id
     GROUP BY c.id
     ORDER BY c.name ASC`
  );
  res.json(result.rows);
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || 'body'] = issue.message;
    }
    res.status(400).json({ error: 'Validation failed', details });
    return;
  }

  const { name, color, icon } = parsed.data;

  try {
    const result = await pool.query<{ id: number; name: string; color: string | null; icon: string | null; created_at: string }>(
      `INSERT INTO categories (name, color, icon) VALUES ($1, $2, $3) RETURNING *`,
      [name, color ?? null, icon ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `Category name '${name}' already exists` });
      return;
    }
    throw err;
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || 'body'] = issue.message;
    }
    res.status(400).json({ error: 'Validation failed', details });
    return;
  }

  const existing = await pool.query(`SELECT id FROM categories WHERE id = $1`, [id]);
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Category ${id} not found` });
    return;
  }

  const { name, color, icon } = parsed.data;

  if (name !== undefined) {
    const conflict = await pool.query(
      `SELECT id FROM categories WHERE name = $1 AND id != $2`,
      [name, id]
    );
    if ((conflict.rowCount ?? 0) > 0) {
      res.status(409).json({ error: `Category name '${name}' already exists` });
      return;
    }
  }

  const result = await pool.query(
    `UPDATE categories
     SET name      = COALESCE($1, name),
         color     = COALESCE($2, color),
         icon      = COALESCE($3, icon)
     WHERE id = $4
     RETURNING *`,
    [name ?? null, color ?? null, icon ?? null, id]
  );
  res.json(result.rows[0]);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const existing = await pool.query(`SELECT id FROM categories WHERE id = $1`, [id]);
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Category ${id} not found` });
    return;
  }

  const inUse = await pool.query(
    `SELECT id FROM movements WHERE category_id = $1 LIMIT 1`,
    [id]
  );
  if ((inUse.rowCount ?? 0) > 0) {
    res.status(409).json({ error: `Category ${id} is referenced by movements and cannot be deleted` });
    return;
  }

  await pool.query(`DELETE FROM categories WHERE id = $1`, [id]);
  res.status(204).send();
});

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  );
}

export default router;
