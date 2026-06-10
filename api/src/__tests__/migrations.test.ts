import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

describe('Database migrations', () => {
  let pool: Pool;

  beforeAll(() => {
    execSync(`node-pg-migrate up --migrations-dir migrations`, {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('categories table', () => {
    it('exists with required columns', async () => {
      const res = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'categories' ORDER BY ordinal_position`
      );
      const cols = res.rows.map(r => r.column_name);
      expect(cols).toEqual(
        expect.arrayContaining(['id', 'name', 'color', 'icon', 'created_at'])
      );
    });

    it('enforces name uniqueness', async () => {
      await pool.query(`DELETE FROM categories WHERE name = '__test_unique__'`);
      await pool.query(
        `INSERT INTO categories (name, color) VALUES ('__test_unique__', '#000000')`
      );
      await expect(
        pool.query(
          `INSERT INTO categories (name, color) VALUES ('__test_unique__', '#111111')`
        )
      ).rejects.toThrow();
      await pool.query(`DELETE FROM categories WHERE name = '__test_unique__'`);
    });

    it('has a default created_at', async () => {
      const res = await pool.query<{ column_default: string }>(
        `SELECT column_default FROM information_schema.columns
         WHERE table_name = 'categories' AND column_name = 'created_at'`
      );
      expect(res.rows[0].column_default).toBeTruthy();
    });
  });

  describe('movements table', () => {
    it('exists with required columns', async () => {
      const res = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'movements' ORDER BY ordinal_position`
      );
      const cols = res.rows.map(r => r.column_name);
      expect(cols).toEqual(
        expect.arrayContaining([
          'id', 'amount', 'date', 'description', 'store',
          'category_id', 'created_at', 'updated_at',
        ])
      );
    });

    it('uses numeric(12,2) for amount', async () => {
      const res = await pool.query<{ data_type: string; numeric_precision: number; numeric_scale: number }>(
        `SELECT data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_name = 'movements' AND column_name = 'amount'`
      );
      expect(res.rows[0].data_type).toBe('numeric');
      expect(res.rows[0].numeric_precision).toBe(12);
      expect(res.rows[0].numeric_scale).toBe(2);
    });

    it('has a nullable category_id FK to categories', async () => {
      const res = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'movements' AND column_name = 'category_id'`
      );
      expect(res.rows[0].is_nullable).toBe('YES');

      const fkRes = await pool.query(
        `SELECT tc.constraint_type
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         WHERE tc.table_name = 'movements'
           AND kcu.column_name = 'category_id'
           AND tc.constraint_type = 'FOREIGN KEY'`
      );
      expect(fkRes.rowCount).toBeGreaterThan(0);
    });
  });

  describe('attachments table', () => {
    it('exists with required columns', async () => {
      const res = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'attachments' ORDER BY ordinal_position`
      );
      const cols = res.rows.map(r => r.column_name);
      expect(cols).toEqual(
        expect.arrayContaining([
          'id', 'movement_id', 'file_name', 'file_path', 'mime_type', 'created_at',
        ])
      );
    });

    it('has a nullable movement_id FK to movements', async () => {
      const res = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'attachments' AND column_name = 'movement_id'`
      );
      expect(res.rows[0].is_nullable).toBe('YES');

      const fkRes = await pool.query(
        `SELECT tc.constraint_type
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         WHERE tc.table_name = 'attachments'
           AND kcu.column_name = 'movement_id'
           AND tc.constraint_type = 'FOREIGN KEY'`
      );
      expect(fkRes.rowCount).toBeGreaterThan(0);
    });
  });

  describe('seed data', () => {
    const expectedCategories = [
      'Food', 'Transport', 'Entertainment', 'Health',
      'Utilities', 'Shopping', 'Other',
    ];

    it('inserts all default categories', async () => {
      const res = await pool.query<{ name: string }>(
        `SELECT name FROM categories WHERE name = ANY($1)`,
        [expectedCategories]
      );
      const found = res.rows.map(r => r.name);
      for (const cat of expectedCategories) {
        expect(found).toContain(cat);
      }
    });

    it('each default category has a distinct color', async () => {
      const res = await pool.query<{ color: string }>(
        `SELECT color FROM categories WHERE name = ANY($1)`,
        [expectedCategories]
      );
      const colors = res.rows.map(r => r.color).filter(Boolean);
      const unique = new Set(colors);
      expect(unique.size).toBe(colors.length);
    });
  });
});
