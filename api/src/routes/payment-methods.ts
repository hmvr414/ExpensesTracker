import { Router, Request, Response } from 'express';
import { z } from 'zod';
import pool from '../db';

const router = Router();

const KIND_VALUES = ['card', 'cash', 'bank_transfer', 'other'] as const;
const BRAND_VALUES = ['visa', 'mastercard', 'amex', 'other'] as const;
const LAST4 = /^\d{4}$/;

const createSchema = z.object({
  name: z.string().min(1, 'name is required'),
  kind: z.enum(KIND_VALUES, { message: `kind must be one of: ${KIND_VALUES.join(', ')}` }),
  brand: z.enum(BRAND_VALUES, { message: `brand must be one of: ${BRAND_VALUES.join(', ')}` }).optional(),
  variant: z.string().optional(),
  last4: z.string().regex(LAST4, 'last4 must be exactly 4 digits').optional(),
});

const updateSchema = z.object({
  name: z.string().min(1, 'name must not be empty').optional(),
  kind: z.enum(KIND_VALUES, { message: `kind must be one of: ${KIND_VALUES.join(', ')}` }).optional(),
  brand: z.enum(BRAND_VALUES, { message: `brand must be one of: ${BRAND_VALUES.join(', ')}` }).optional(),
  variant: z.string().optional(),
  last4: z.string().regex(LAST4, 'last4 must be exactly 4 digits').optional(),
});

router.get('/', async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.kind, p.brand, p.variant, p.last4, p.created_at,
            COUNT(m.id)::int AS movement_count
     FROM payment_methods p
     LEFT JOIN movements m ON m.payment_method_id = p.id
     GROUP BY p.id
     ORDER BY p.name ASC`
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

  const { name, kind, brand, variant, last4 } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO payment_methods (name, kind, brand, variant, last4)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, kind, brand ?? null, variant ?? null, last4 ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `Payment method name '${name}' already exists` });
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

  const existing = await pool.query(`SELECT id FROM payment_methods WHERE id = $1`, [id]);
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Payment method ${id} not found` });
    return;
  }

  const { name, kind, brand, variant, last4 } = parsed.data;

  if (name !== undefined) {
    const conflict = await pool.query(
      `SELECT id FROM payment_methods WHERE name = $1 AND id != $2`,
      [name, id]
    );
    if ((conflict.rowCount ?? 0) > 0) {
      res.status(409).json({ error: `Payment method name '${name}' already exists` });
      return;
    }
  }

  const result = await pool.query(
    `UPDATE payment_methods
     SET name    = COALESCE($1, name),
         kind    = COALESCE($2, kind),
         brand   = COALESCE($3, brand),
         variant = COALESCE($4, variant),
         last4   = COALESCE($5, last4)
     WHERE id = $6
     RETURNING *`,
    [name ?? null, kind ?? null, brand ?? null, variant ?? null, last4 ?? null, id]
  );
  res.json(result.rows[0]);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const existing = await pool.query(`SELECT id FROM payment_methods WHERE id = $1`, [id]);
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Payment method ${id} not found` });
    return;
  }

  const inUse = await pool.query(
    `SELECT id FROM movements WHERE payment_method_id = $1 LIMIT 1`,
    [id]
  );
  if ((inUse.rowCount ?? 0) > 0) {
    res.status(409).json({ error: `Payment method ${id} is referenced by movements and cannot be deleted` });
    return;
  }

  await pool.query(`DELETE FROM payment_methods WHERE id = $1`, [id]);
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
