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

function setupSuite() {
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

  return { getPool: () => pool, getApp: () => app };
}

describe('GET /api/movements', () => {
  const { getPool, getApp } = setupSuite();
  let categoryId: number;
  let movementId: number;

  beforeAll(async () => {
    const pool = getPool();
    const cat = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_mv_list_cat__', '#aabbcc') RETURNING id`
    );
    categoryId = cat.rows[0].id;
    const mv = await pool.query<{ id: number }>(
      `INSERT INTO movements (amount, date, description, store, category_id)
       VALUES (42.50, '2024-01-15', 'test desc', 'test store', $1) RETURNING id`,
      [categoryId]
    );
    movementId = mv.rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM movements WHERE description LIKE '__test_%'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('returns 200 with data, total, page, and limit', async () => {
    const res = await request(getApp()).get('/api/movements');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.limit).toBe('number');
  });

  it('each movement includes an attachments array', async () => {
    const res = await request(getApp()).get('/api/movements');
    expect(res.status).toBe(200);
    for (const mv of res.body.data) {
      expect(Array.isArray(mv.attachments)).toBe(true);
    }
  });

  it('filters by category_id', async () => {
    const res = await request(getApp()).get(`/api/movements?category_id=${categoryId}`);
    expect(res.status).toBe(200);
    for (const mv of res.body.data) {
      expect(mv.category_id).toBe(categoryId);
    }
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by store (case-insensitive partial match)', async () => {
    const res = await request(getApp()).get('/api/movements?store=test+store');
    expect(res.status).toBe(200);
    expect(res.body.data.some((m: { id: number }) => m.id === movementId)).toBe(true);
  });

  it('filters by date range', async () => {
    const res = await request(getApp()).get('/api/movements?from=2024-01-01&to=2024-01-31');
    expect(res.status).toBe(200);
    expect(res.body.data.some((m: { id: number }) => m.id === movementId)).toBe(true);
  });

  it('search matches description and store', async () => {
    const res = await request(getApp()).get('/api/movements?search=test+desc');
    expect(res.status).toBe(200);
    expect(res.body.data.some((m: { id: number }) => m.id === movementId)).toBe(true);
  });

  it('respects pagination params', async () => {
    const res = await request(getApp()).get('/api/movements?page=1&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
  });
});

describe('GET /api/movements/:id', () => {
  const { getPool, getApp } = setupSuite();
  let movementId: number;

  beforeAll(async () => {
    const pool = getPool();
    const mv = await pool.query<{ id: number }>(
      `INSERT INTO movements (amount, date, description) VALUES (10.00, '2024-03-01', '__test_single__') RETURNING id`
    );
    movementId = mv.rows[0].id;
    await pool.query(
      `INSERT INTO attachments (movement_id, file_name, file_path, mime_type)
       VALUES ($1, 'test.jpg', '/tmp/test.jpg', 'image/jpeg')`,
      [movementId]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM attachments WHERE file_name = 'test.jpg'`);
    await pool.query(`DELETE FROM movements WHERE description = '__test_single__'`);
    await pool.end();
  });

  it('returns 200 with the movement and its attachments', async () => {
    const res = await request(getApp()).get(`/api/movements/${movementId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(movementId);
    expect(Array.isArray(res.body.attachments)).toBe(true);
    expect(res.body.attachments.length).toBe(1);
    expect(res.body.attachments[0].file_name).toBe('test.jpg');
  });

  it('returns 404 for a non-existent movement', async () => {
    const res = await request(getApp()).get('/api/movements/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/movements', () => {
  const { getPool, getApp } = setupSuite();
  let categoryId: number;

  beforeAll(async () => {
    const pool = getPool();
    const cat = await pool.query<{ id: number }>(
      `INSERT INTO categories (name) VALUES ('__test_mv_post_cat__') RETURNING id`
    );
    categoryId = cat.rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM movements WHERE description LIKE '__test_%' OR store LIKE '__test_%'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('creates a movement with all fields', async () => {
    const res = await request(getApp())
      .post('/api/movements')
      .send({ amount: 19.99, date: '2024-06-01', description: '__test_full__', store: '__test_store__', category_id: categoryId });
    expect(res.status).toBe(201);
    expect(parseFloat(res.body.amount)).toBe(19.99);
    expect(res.body.date).toContain('2024-06-01');
    expect(res.body.description).toBe('__test_full__');
    expect(res.body.category_id).toBe(categoryId);
    expect(res.body.id).toBeDefined();
  });

  it('creates a movement with only amount (date defaults to today)', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await request(getApp())
      .post('/api/movements')
      .send({ amount: 5.00 });
    expect(res.status).toBe(201);
    expect(res.body.date).toContain(today);
  });

  it('returns 400 when amount is missing', async () => {
    const res = await request(getApp())
      .post('/api/movements')
      .send({ date: '2024-06-01', description: '__test_no_amount__' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when amount is not positive', async () => {
    const res = await request(getApp())
      .post('/api/movements')
      .send({ amount: -10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when amount is zero', async () => {
    const res = await request(getApp())
      .post('/api/movements')
      .send({ amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when date is invalid', async () => {
    const res = await request(getApp())
      .post('/api/movements')
      .send({ amount: 10, date: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when category_id does not exist', async () => {
    const res = await request(getApp())
      .post('/api/movements')
      .send({ amount: 10, category_id: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('PUT /api/movements/:id', () => {
  const { getPool, getApp } = setupSuite();
  let movementId: number;
  let categoryId: number;

  beforeAll(async () => {
    const pool = getPool();
    const cat = await pool.query<{ id: number }>(
      `INSERT INTO categories (name) VALUES ('__test_mv_put_cat__') RETURNING id`
    );
    categoryId = cat.rows[0].id;
    const mv = await pool.query<{ id: number }>(
      `INSERT INTO movements (amount, date, description) VALUES (50.00, '2024-01-01', '__test_put__') RETURNING id`
    );
    movementId = mv.rows[0].id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM movements WHERE description LIKE '__test_%'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('updates amount and date', async () => {
    const res = await request(getApp())
      .put(`/api/movements/${movementId}`)
      .send({ amount: 99.99, date: '2024-12-25' });
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.amount)).toBe(99.99);
    expect(res.body.date).toContain('2024-12-25');
  });

  it('updates category_id', async () => {
    const res = await request(getApp())
      .put(`/api/movements/${movementId}`)
      .send({ category_id: categoryId });
    expect(res.status).toBe(200);
    expect(res.body.category_id).toBe(categoryId);
  });

  it('can set category_id to null', async () => {
    const res = await request(getApp())
      .put(`/api/movements/${movementId}`)
      .send({ category_id: null });
    expect(res.status).toBe(200);
    expect(res.body.category_id).toBeNull();
  });

  it('returns 404 for non-existent movement', async () => {
    const res = await request(getApp())
      .put('/api/movements/99999')
      .send({ amount: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when amount is not positive', async () => {
    const res = await request(getApp())
      .put(`/api/movements/${movementId}`)
      .send({ amount: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when date is invalid', async () => {
    const res = await request(getApp())
      .put(`/api/movements/${movementId}`)
      .send({ date: 'bad-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('DELETE /api/movements/:id', () => {
  const { getPool, getApp } = setupSuite();

  afterAll(async () => {
    await getPool().end();
  });

  it('deletes a movement and its attachment records, returns 204', async () => {
    const pool = getPool();
    const mv = await pool.query<{ id: number }>(
      `INSERT INTO movements (amount, date, description) VALUES (77.00, '2024-05-01', '__test_delete__') RETURNING id`
    );
    const mvId = mv.rows[0].id;
    await pool.query(
      `INSERT INTO attachments (movement_id, file_name, file_path, mime_type)
       VALUES ($1, 'todel.jpg', '/tmp/nonexistent_todel.jpg', 'image/jpeg')`,
      [mvId]
    );

    const res = await request(getApp()).delete(`/api/movements/${mvId}`);
    expect(res.status).toBe(204);

    const check = await pool.query(`SELECT id FROM movements WHERE id = $1`, [mvId]);
    expect(check.rowCount).toBe(0);

    const attCheck = await pool.query(`SELECT id FROM attachments WHERE movement_id = $1`, [mvId]);
    expect(attCheck.rowCount).toBe(0);
  });

  it('returns 404 for non-existent movement', async () => {
    const res = await request(getApp()).delete('/api/movements/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
