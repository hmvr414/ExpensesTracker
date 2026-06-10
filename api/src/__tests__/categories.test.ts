import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import { createApp } from '../app';
import { resetPool } from '../db';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

describe('GET /api/categories', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    execSync('node-pg-migrate up --migrations-dir migrations', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns 200 with an array of categories', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('includes seeded categories ordered by name', async () => {
    const res = await request(app).get('/api/categories');
    const names: string[] = res.body.map((c: { name: string }) => c.name);
    expect(names).toContain('Food');
    expect(names).toContain('Transport');
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('includes movement_count on each category', async () => {
    const res = await request(app).get('/api/categories');
    for (const cat of res.body) {
      expect(typeof cat.movement_count).toBe('number');
    }
  });
});

describe('POST /api/categories', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('creates a category with name and color', async () => {
    const res = await request(app)
      .post('/api/categories')
      .send({ name: '__test_create__', color: '#ff0000' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('__test_create__');
    expect(res.body.color).toBe('#ff0000');
    expect(res.body.id).toBeDefined();
  });

  it('creates a category without optional color', async () => {
    const res = await request(app)
      .post('/api/categories')
      .send({ name: '__test_no_color__' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('__test_no_color__');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/categories')
      .send({ color: '#ff0000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when color is an invalid hex', async () => {
    const res = await request(app)
      .post('/api/categories')
      .send({ name: '__test_bad_color__', color: 'notahex' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 409 when name already exists', async () => {
    await request(app)
      .post('/api/categories')
      .send({ name: '__test_dup__' });
    const res = await request(app)
      .post('/api/categories')
      .send({ name: '__test_dup__' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });
});

describe('PUT /api/categories/:id', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let categoryId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
    const res = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_update__', '#123456') RETURNING id`
    );
    categoryId = res.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('updates name and color', async () => {
    const res = await request(app)
      .put(`/api/categories/${categoryId}`)
      .send({ name: '__test_updated__', color: '#abcdef' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('__test_updated__');
    expect(res.body.color).toBe('#abcdef');
  });

  it('returns 404 for non-existent category', async () => {
    const res = await request(app)
      .put('/api/categories/99999')
      .send({ name: '__test_ghost__' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for invalid hex color', async () => {
    const res = await request(app)
      .put(`/api/categories/${categoryId}`)
      .send({ color: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 409 when updating to a name that already exists', async () => {
    const res = await request(app)
      .put(`/api/categories/${categoryId}`)
      .send({ name: 'Food' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });
});

describe('DELETE /api/categories/:id', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM movements WHERE description = '__test_del_mv__'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('deletes a category with no movements and returns 204', async () => {
    const ins = await pool.query<{ id: number }>(
      `INSERT INTO categories (name) VALUES ('__test_del_ok__') RETURNING id`
    );
    const id = ins.rows[0].id;
    const res = await request(app).delete(`/api/categories/${id}`);
    expect(res.status).toBe(204);
    const check = await pool.query(`SELECT id FROM categories WHERE id = $1`, [id]);
    expect(check.rowCount).toBe(0);
  });

  it('returns 409 when movements reference the category', async () => {
    const catIns = await pool.query<{ id: number }>(
      `INSERT INTO categories (name) VALUES ('__test_del_blocked__') RETURNING id`
    );
    const catId = catIns.rows[0].id;
    await pool.query(
      `INSERT INTO movements (amount, date, category_id, description) VALUES (10.00, CURRENT_DATE, $1, '__test_del_mv__')`,
      [catId]
    );
    const res = await request(app).delete(`/api/categories/${catId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });

  it('returns 404 for non-existent category', async () => {
    const res = await request(app).delete('/api/categories/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
