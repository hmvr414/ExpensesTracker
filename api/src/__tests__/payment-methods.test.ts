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

describe('GET /api/payment-methods', () => {
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

  it('returns 200 with an array of payment methods', async () => {
    const res = await request(app).get('/api/payment-methods');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('includes the seeded Cash method', async () => {
    const res = await request(app).get('/api/payment-methods');
    const cash = res.body.find((m: { name: string }) => m.name === 'Cash');
    expect(cash).toBeDefined();
    expect(cash.kind).toBe('cash');
  });

  it('orders methods by name', async () => {
    const res = await request(app).get('/api/payment-methods');
    const names: string[] = res.body.map((m: { name: string }) => m.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('includes movement_count on each method', async () => {
    const res = await request(app).get('/api/payment-methods');
    for (const method of res.body) {
      expect(typeof method.movement_count).toBe('number');
    }
  });
});

describe('POST /api/payment-methods', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('creates a card with brand, variant, and last4', async () => {
    const res = await request(app)
      .post('/api/payment-methods')
      .send({
        name: '__test_visa_platinum__',
        kind: 'card',
        brand: 'visa',
        variant: 'platinum',
        last4: '1234',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('__test_visa_platinum__');
    expect(res.body.kind).toBe('card');
    expect(res.body.brand).toBe('visa');
    expect(res.body.variant).toBe('platinum');
    expect(res.body.last4).toBe('1234');
  });

  it('creates a method with only name and kind', async () => {
    const res = await request(app)
      .post('/api/payment-methods')
      .send({ name: '__test_transfer__', kind: 'bank_transfer' });
    expect(res.status).toBe(201);
    expect(res.body.brand).toBeNull();
    expect(res.body.variant).toBeNull();
    expect(res.body.last4).toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/payment-methods')
      .send({ kind: 'card' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
  });

  it('returns 400 when kind is missing', async () => {
    const res = await request(app)
      .post('/api/payment-methods')
      .send({ name: '__test_no_kind__' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 for an invalid kind value', async () => {
    const res = await request(app)
      .post('/api/payment-methods')
      .send({ name: '__test_bad_kind__', kind: 'crypto' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 for an invalid brand value', async () => {
    const res = await request(app)
      .post('/api/payment-methods')
      .send({ name: '__test_bad_brand__', kind: 'card', brand: 'discover' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 when last4 is not exactly 4 digits', async () => {
    for (const bad of ['123', '12345', 'abcd', '12a4']) {
      const res = await request(app)
        .post('/api/payment-methods')
        .send({ name: `__test_last4_${bad}__`, kind: 'card', last4: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    }
  });

  it('returns 409 when name already exists', async () => {
    await request(app)
      .post('/api/payment-methods')
      .send({ name: '__test_dup__', kind: 'card' });
    const res = await request(app)
      .post('/api/payment-methods')
      .send({ name: '__test_dup__', kind: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });
});

describe('PUT /api/payment-methods/:id', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let methodId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
    const res = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind, brand) VALUES ('__test_update__', 'card', 'visa') RETURNING id`
    );
    methodId = res.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('updates name, brand, variant, and last4', async () => {
    const res = await request(app)
      .put(`/api/payment-methods/${methodId}`)
      .send({ name: '__test_updated__', brand: 'mastercard', variant: 'black', last4: '9876' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('__test_updated__');
    expect(res.body.brand).toBe('mastercard');
    expect(res.body.variant).toBe('black');
    expect(res.body.last4).toBe('9876');
  });

  it('supports partial updates leaving other fields intact', async () => {
    const res = await request(app)
      .put(`/api/payment-methods/${methodId}`)
      .send({ variant: 'gold' });
    expect(res.status).toBe(200);
    expect(res.body.variant).toBe('gold');
    expect(res.body.name).toBe('__test_updated__');
    expect(res.body.brand).toBe('mastercard');
  });

  it('returns 404 for a non-existent method', async () => {
    const res = await request(app)
      .put('/api/payment-methods/99999')
      .send({ name: '__test_ghost__' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for an invalid kind', async () => {
    const res = await request(app)
      .put(`/api/payment-methods/${methodId}`)
      .send({ kind: 'crypto' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 for an invalid last4', async () => {
    const res = await request(app)
      .put(`/api/payment-methods/${methodId}`)
      .send({ last4: '12' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 409 when updating to a name that already exists', async () => {
    const res = await request(app)
      .put(`/api/payment-methods/${methodId}`)
      .send({ name: 'Cash' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });

  it('allows keeping its own name (no self-collision)', async () => {
    const res = await request(app)
      .put(`/api/payment-methods/${methodId}`)
      .send({ name: '__test_updated__', variant: 'classic' });
    expect(res.status).toBe(200);
    expect(res.body.variant).toBe('classic');
  });
});

describe('DELETE /api/payment-methods/:id', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM movements WHERE description = '__test_pm_del_mv__'`);
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('deletes an unreferenced method and returns 204', async () => {
    const ins = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind) VALUES ('__test_del_ok__', 'card') RETURNING id`
    );
    const id = ins.rows[0].id;
    const res = await request(app).delete(`/api/payment-methods/${id}`);
    expect(res.status).toBe(204);
    const check = await pool.query(`SELECT id FROM payment_methods WHERE id = $1`, [id]);
    expect(check.rowCount).toBe(0);
  });

  it('returns 409 when movements reference the method', async () => {
    const pmIns = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind) VALUES ('__test_del_blocked__', 'card') RETURNING id`
    );
    const pmId = pmIns.rows[0].id;
    await pool.query(
      `INSERT INTO movements (amount, date, description, payment_method_id) VALUES (10.00, CURRENT_DATE, '__test_pm_del_mv__', $1)`,
      [pmId]
    );
    const res = await request(app).delete(`/api/payment-methods/${pmId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });

  it('returns 404 for a non-existent method', async () => {
    const res = await request(app).delete('/api/payment-methods/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('movements.payment_method_id FK behavior', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM movements WHERE description = '__test_pm_fk_mv__'`);
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__test_%'`);
    await pool.end();
  });

  it('sets payment_method_id to NULL when the method row is deleted directly', async () => {
    const pmIns = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind) VALUES ('__test_fk_setnull__', 'card') RETURNING id`
    );
    const pmId = pmIns.rows[0].id;
    const mvIns = await pool.query<{ id: number }>(
      `INSERT INTO movements (amount, date, description, payment_method_id) VALUES (5.00, CURRENT_DATE, '__test_pm_fk_mv__', $1) RETURNING id`,
      [pmId]
    );
    const mvId = mvIns.rows[0].id;
    await pool.query(`DELETE FROM payment_methods WHERE id = $1`, [pmId]);
    const check = await pool.query<{ payment_method_id: number | null }>(
      `SELECT payment_method_id FROM movements WHERE id = $1`,
      [mvId]
    );
    expect(check.rows[0].payment_method_id).toBeNull();
  });
});
