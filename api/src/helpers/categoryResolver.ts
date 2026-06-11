import type { Pool, PoolClient } from 'pg';

// Mirrors the preset palette offered by the client category screen.
export const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
  '#6b7280', '#1e293b',
];

export interface ResolvedCategory {
  id: number;
  name: string;
  color: string | null;
  created: boolean;
}

interface CategoryRow {
  id: number;
  name: string;
  color: string | null;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  );
}

/**
 * Find a category by name case-insensitively, or create it with an
 * auto-assigned color from the preset palette (preferring colors not
 * already in use). Run inside the caller's transaction by passing the
 * transaction client.
 */
export async function resolveCategoryByName(
  client: Queryable,
  name: string
): Promise<ResolvedCategory> {
  const existing = await client.query<CategoryRow>(
    `SELECT id, name, color FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name]
  );
  if (existing.rows.length > 0) {
    return { ...existing.rows[0], created: false };
  }

  const used = await client.query<{ color: string }>(
    `SELECT color FROM categories WHERE color IS NOT NULL`
  );
  const usedSet = new Set(used.rows.map(r => r.color.toLowerCase()));
  const color =
    PRESET_COLORS.find(c => !usedSet.has(c)) ??
    PRESET_COLORS[usedSet.size % PRESET_COLORS.length];

  try {
    const inserted = await client.query<CategoryRow>(
      `INSERT INTO categories (name, color) VALUES ($1, $2) RETURNING id, name, color`,
      [name, color]
    );
    return { ...inserted.rows[0], created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await client.query<CategoryRow>(
        `SELECT id, name, color FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [name]
      );
      if (raced.rows.length > 0) {
        return { ...raced.rows[0], created: false };
      }
    }
    throw err;
  }
}
