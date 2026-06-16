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

describe('GET /api/movements — multi-category & flexible filtering', () => {
  const { getPool, getApp } = setupSuite();
  const STORE = '__test_feat1_store__';
  let catA: number;
  let catB: number;

  beforeAll(async () => {
    const pool = getPool();
    const a = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_feat1_a__', '#111111') RETURNING id`
    );
    catA = a.rows[0].id;
    const b = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_feat1_b__', '#222222') RETURNING id`
    );
    catB = b.rows[0].id;
    // catA: 10 (02-01), 20 (02-02); catB: 30 (02-03); uncategorized: 40 (02-04)
    await pool.query(
      `INSERT INTO movements (amount, date, store, category_id) VALUES
         (10, '2024-02-01', $1, $2),
         (20, '2024-02-02', $1, $2),
         (30, '2024-02-03', $1, $3),
         (40, '2024-02-04', $1, NULL)`,
      [STORE, catA, catB]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM movements WHERE store = $1`, [STORE]);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_feat1_%'`);
    await pool.end();
  });

  const ids = (body: { data: { id: number }[] }) => body.data.map((m) => m.id);

  it('repeated category_id produces an ANY/IN filter over multiple categories', async () => {
    const res = await request(getApp()).get(
      `/api/movements?store=${STORE}&category_id=${catA}&category_id=${catB}`
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.totalAmount).toBe(60);
    for (const m of res.body.data) {
      expect([catA, catB]).toContain(m.category_id);
    }
  });

  it('comma-separated category_id produces the same filter', async () => {
    const res = await request(getApp()).get(
      `/api/movements?store=${STORE}&category_id=${catA},${catB}`
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.totalAmount).toBe(60);
  });

  it('single category_id stays backward-compatible', async () => {
    const res = await request(getApp()).get(`/api/movements?store=${STORE}&category_id=${catA}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.totalAmount).toBe(30);
    for (const m of res.body.data) {
      expect(m.category_id).toBe(catA);
    }
  });

  it('uncategorized=true alone filters to category_id IS NULL', async () => {
    const res = await request(getApp()).get(`/api/movements?store=${STORE}&uncategorized=true`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.totalAmount).toBe(40);
    expect(res.body.data[0].category_id).toBeNull();
  });

  it('uncategorized combined with ids widens to (ANY OR IS NULL)', async () => {
    const res = await request(getApp()).get(
      `/api/movements?store=${STORE}&category_id=${catA}&uncategorized=true`
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // catA's two + the null one
    expect(res.body.totalAmount).toBe(70);
  });

  it('totalAmount is the full-set sum, independent of limit/page', async () => {
    const res = await request(getApp()).get(`/api/movements?store=${STORE}&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.data.length).toBe(2);
    expect(res.body.totalAmount).toBe(100); // 10+20+30+40

    const res2 = await request(getApp()).get(`/api/movements?store=${STORE}&limit=2&page=2`);
    expect(res2.body.totalAmount).toBe(100);
  });

  it('category filter composes with from/to', async () => {
    const res = await request(getApp()).get(
      `/api/movements?store=${STORE}&category_id=${catA},${catB}&from=2024-02-01&to=2024-02-02`
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.totalAmount).toBe(30);
  });

  it('invalid category tokens are ignored rather than 400-ing', async () => {
    const res = await request(getApp()).get(
      `/api/movements?store=${STORE}&category_id=abc,${catA},-5,0`
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // resolves to just catA
    expect(ids(res.body)).toHaveLength(2);
  });

  it('all-invalid category tokens leave the result unfiltered by category', async () => {
    const res = await request(getApp()).get(`/api/movements?store=${STORE}&category_id=abc,-1,0`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  it('limit can go up to 200 and clamps above that', async () => {
    const res = await request(getApp()).get(`/api/movements?limit=200`);
    expect(res.body.limit).toBe(200);
    const res2 = await request(getApp()).get(`/api/movements?limit=500`);
    expect(res2.body.limit).toBe(200);
  });

  it('totalAmount is a number on the unfiltered list', async () => {
    const res = await request(getApp()).get('/api/movements');
    expect(typeof res.body.totalAmount).toBe('number');
  });
});

describe('GET /api/movements/series', () => {
  const { getPool, getApp } = setupSuite();
  const STORE = '__test_series_store__';
  let catA: number;
  let catB: number;
  let pmA: number;

  beforeAll(async () => {
    const pool = getPool();
    const a = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_series_a__', '#111111') RETURNING id`
    );
    catA = a.rows[0].id;
    const b = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_series_b__', '#222222') RETURNING id`
    );
    catB = b.rows[0].id;
    const pm = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind) VALUES ('__test_series_pm__', 'cash') RETURNING id`
    );
    pmA = pm.rows[0].id;
    // current window 2024-03-01..2024-03-05:
    //   03-01 -> 10 catA pmA, 03-02 -> 20 catA, 03-05 -> 30 catB pmA
    // previous window 2024-02-25..2024-02-29:
    //   02-26 -> 40 uncategorized
    await pool.query(
      `INSERT INTO movements (amount, date, store, category_id, payment_method_id) VALUES
         (10, '2024-03-01', $1, $2, $4),
         (20, '2024-03-02', $1, $2, NULL),
         (30, '2024-03-05', $1, $3, $4),
         (40, '2024-02-26', $1, NULL, NULL)`,
      [STORE, catA, catB, pmA]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM movements WHERE store = $1`, [STORE]);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_series_%'`);
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__test_series_%'`);
    await pool.end();
  });

  it('400s when from or to is missing', async () => {
    expect((await request(getApp()).get('/api/movements/series?from=2024-03-01')).status).toBe(400);
    expect((await request(getApp()).get('/api/movements/series?to=2024-03-05')).status).toBe(400);
    expect((await request(getApp()).get('/api/movements/series')).status).toBe(400);
  });

  it('400s on malformed dates', async () => {
    const res = await request(getApp()).get('/api/movements/series?from=2024-13-40&to=2024-03-05');
    expect(res.status).toBe(400);
  });

  it('400s when from > to', async () => {
    const res = await request(getApp()).get('/api/movements/series?from=2024-03-05&to=2024-03-01');
    expect(res.status).toBe(400);
  });

  it('returns a daily, zero-filled series for a sub-3-month range', async () => {
    const res = await request(getApp()).get(
      `/api/movements/series?store=${STORE}&from=2024-03-01&to=2024-03-05`
    );
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe('day');
    expect(res.body.data).toHaveLength(5); // 03-01 .. 03-05 inclusive
    const byLabel = Object.fromEntries(
      res.body.data.map((p: { label: string; total: number }) => [p.label, p.total])
    );
    expect(byLabel['2024-03-01']).toBe(10);
    expect(byLabel['2024-03-02']).toBe(20);
    expect(byLabel['2024-03-03']).toBe(0); // zero-filled gap
    expect(byLabel['2024-03-04']).toBe(0);
    expect(byLabel['2024-03-05']).toBe(30);
    expect(res.body.comparison.currentTotal).toBe(60);
  });

  it('chooses granularity from the range span', async () => {
    const g = async (from: string, to: string) =>
      (await request(getApp()).get(`/api/movements/series?from=${from}&to=${to}`)).body.granularity;
    expect(await g('2024-01-01', '2024-01-02')).toBe('hour'); // span 1 day
    expect(await g('2024-01-01', '2024-04-02')).toBe('day'); // span 92 days
    expect(await g('2024-01-01', '2025-06-01')).toBe('week'); // span < 730 days
    expect(await g('2022-01-01', '2025-01-01')).toBe('month'); // span > 730 days
  });

  it('applies the category filter to the series totals', async () => {
    const res = await request(getApp()).get(
      `/api/movements/series?store=${STORE}&from=2024-03-01&to=2024-03-05&category_id=${catA}`
    );
    expect(res.status).toBe(200);
    expect(res.body.comparison.currentTotal).toBe(30); // 10 + 20, catB's 30 excluded
  });

  it('applies the payment-method filter to the series totals', async () => {
    const res = await request(getApp()).get(
      `/api/movements/series?store=${STORE}&from=2024-03-01&to=2024-03-05&payment_method_id=${pmA}`
    );
    expect(res.status).toBe(200);
    expect(res.body.comparison.currentTotal).toBe(40); // 10 + 30, the pm-less 20 excluded
  });

  it('reports a positive previous-period delta when spend rose', async () => {
    const res = await request(getApp()).get(
      `/api/movements/series?store=${STORE}&from=2024-03-01&to=2024-03-05`
    );
    expect(res.status).toBe(200);
    // current 60 vs previous window (02-25..02-29) which holds the 40 movement
    expect(res.body.comparison.previousTotal).toBe(40);
    expect(res.body.comparison.currentTotal).toBe(60);
    expect(res.body.comparison.deltaPct).toBeCloseTo(50);
  });

  it('returns null deltaPct when the previous period had zero spend', async () => {
    const res = await request(getApp()).get(
      `/api/movements/series?store=${STORE}&from=2024-03-01&to=2024-03-05&category_id=${catB}`
    );
    expect(res.status).toBe(200);
    expect(res.body.comparison.previousTotal).toBe(0); // catB has nothing in the prior window
    expect(res.body.comparison.currentTotal).toBe(30);
    expect(res.body.comparison.deltaPct).toBeNull();
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
