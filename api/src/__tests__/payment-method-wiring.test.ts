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

describe('payment method wiring', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let categoryId: number;
  let visaId: number;
  let cashId: number;

  beforeAll(async () => {
    execSync('node-pg-migrate up --migrations-dir migrations', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();

    const cat = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__pmw_cat__', '#123456') RETURNING id`
    );
    categoryId = cat.rows[0].id;

    const visa = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind, brand, variant, last4)
       VALUES ('__pmw_visa__', 'card', 'visa', 'platinum', '1234') RETURNING id`
    );
    visaId = visa.rows[0].id;

    const cash = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind) VALUES ('__pmw_cash__', 'cash') RETURNING id`
    );
    cashId = cash.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM movements WHERE description LIKE '__pmw_%'`);
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__pmw_%'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__pmw_%'`);
    await pool.end();
  });

  // ─── GET /api/movements + GET /:id include payment_method ───────────────────

  describe('payment_method object on movement reads', () => {
    let withPmId: number;
    let withoutPmId: number;

    beforeAll(async () => {
      const a = await pool.query<{ id: number }>(
        `INSERT INTO movements (amount, date, description, payment_method_id)
         VALUES (10, '2024-02-01', '__pmw_read_with__', $1) RETURNING id`,
        [visaId]
      );
      withPmId = a.rows[0].id;
      const b = await pool.query<{ id: number }>(
        `INSERT INTO movements (amount, date, description)
         VALUES (20, '2024-02-02', '__pmw_read_without__') RETURNING id`
      );
      withoutPmId = b.rows[0].id;
    });

    it('GET /:id returns the payment_method object with id, name, kind, brand, variant', async () => {
      const res = await request(app).get(`/api/movements/${withPmId}`);
      expect(res.status).toBe(200);
      expect(res.body.payment_method).toEqual({
        id: visaId,
        name: '__pmw_visa__',
        kind: 'card',
        brand: 'visa',
        variant: 'platinum',
      });
    });

    it('GET /:id returns payment_method null when the movement has none', async () => {
      const res = await request(app).get(`/api/movements/${withoutPmId}`);
      expect(res.status).toBe(200);
      expect(res.body.payment_method).toBeNull();
    });

    it('GET / includes payment_method on every movement (object or null)', async () => {
      const res = await request(app).get('/api/movements?search=__pmw_read_');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      for (const mv of res.body.data) {
        expect('payment_method' in mv).toBe(true);
      }
      const withPm = res.body.data.find((m: { id: number }) => m.id === withPmId);
      const withoutPm = res.body.data.find((m: { id: number }) => m.id === withoutPmId);
      expect(withPm.payment_method.name).toBe('__pmw_visa__');
      expect(withoutPm.payment_method).toBeNull();
    });
  });

  // ─── POST /api/movements with payment_method_id ─────────────────────────────

  describe('POST /api/movements payment_method_id', () => {
    it('creates a movement with a valid payment_method_id', async () => {
      const res = await request(app)
        .post('/api/movements')
        .send({ amount: 15, date: '2024-02-03', description: '__pmw_post_ok__', payment_method_id: visaId });
      expect(res.status).toBe(201);
      expect(res.body.payment_method_id).toBe(visaId);
    });

    it('accepts an explicit null payment_method_id', async () => {
      const res = await request(app)
        .post('/api/movements')
        .send({ amount: 15, date: '2024-02-03', description: '__pmw_post_null__', payment_method_id: null });
      expect(res.status).toBe(201);
      expect(res.body.payment_method_id).toBeNull();
    });

    it('rejects a non-existent payment_method_id with 400', async () => {
      const res = await request(app)
        .post('/api/movements')
        .send({ amount: 15, date: '2024-02-03', description: '__pmw_post_bad__', payment_method_id: 999999 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details.payment_method_id).toBeDefined();
    });

    it('rejects a non-integer payment_method_id with 400', async () => {
      const res = await request(app)
        .post('/api/movements')
        .send({ amount: 15, date: '2024-02-03', description: '__pmw_post_str__', payment_method_id: 'visa' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  // ─── PUT /api/movements/:id with payment_method_id ──────────────────────────

  describe('PUT /api/movements/:id payment_method_id', () => {
    let movementId: number;

    beforeEach(async () => {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO movements (amount, date, description, payment_method_id)
         VALUES (30, '2024-02-04', '__pmw_put__', $1) RETURNING id`,
        [visaId]
      );
      movementId = r.rows[0].id;
    });

    it('updates the payment_method_id', async () => {
      const res = await request(app)
        .put(`/api/movements/${movementId}`)
        .send({ payment_method_id: cashId });
      expect(res.status).toBe(200);
      expect(res.body.payment_method_id).toBe(cashId);
    });

    it('clears the payment_method_id with an explicit null', async () => {
      const res = await request(app)
        .put(`/api/movements/${movementId}`)
        .send({ payment_method_id: null });
      expect(res.status).toBe(200);
      expect(res.body.payment_method_id).toBeNull();
    });

    it('leaves payment_method_id untouched when the field is omitted', async () => {
      const res = await request(app)
        .put(`/api/movements/${movementId}`)
        .send({ amount: 31 });
      expect(res.status).toBe(200);
      expect(res.body.payment_method_id).toBe(visaId);
    });

    it('rejects a non-existent payment_method_id with 400', async () => {
      const res = await request(app)
        .put(`/api/movements/${movementId}`)
        .send({ payment_method_id: 999999 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details.payment_method_id).toBeDefined();
    });
  });

  // ─── GET /api/movements?payment_method_id= filter ────────────────────────────

  describe('payment_method_id filter on GET /api/movements', () => {
    beforeAll(async () => {
      await pool.query(
        `INSERT INTO movements (amount, date, description, store, payment_method_id) VALUES
          (11, '2024-03-01', '__pmw_filter_1__', '__pmw_store__', $1),
          (12, '2024-03-02', '__pmw_filter_2__', '__pmw_store__', $2),
          (13, '2024-03-03', '__pmw_filter_3__', '__pmw_store__', NULL)`,
        [visaId, cashId]
      );
    });

    it('returns only movements paid with the given method', async () => {
      const res = await request(app).get(`/api/movements?payment_method_id=${visaId}&store=__pmw_store__`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].description).toBe('__pmw_filter_1__');
    });

    it('chains with other filters (date range)', async () => {
      const res = await request(app).get(
        `/api/movements?payment_method_id=${cashId}&from=2024-03-01&to=2024-03-31&store=__pmw_store__`
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].description).toBe('__pmw_filter_2__');
    });
  });

  // ─── dashboard paymentMethodBreakdown ────────────────────────────────────────

  describe('GET /api/dashboard paymentMethodBreakdown', () => {
    beforeAll(async () => {
      // Isolated window: March 2026 — visa 300, cash 100, none 100 → grand total 500
      await pool.query(
        `INSERT INTO movements (amount, date, description, payment_method_id) VALUES
          (100, '2026-03-05', '__pmw_dash_1__', $1),
          (200, '2026-03-10', '__pmw_dash_2__', $1),
          (100, '2026-03-15', '__pmw_dash_3__', $2),
          (100, '2026-03-20', '__pmw_dash_4__', NULL)`,
        [visaId, cashId]
      );
    });

    it('returns paymentMethodBreakdown with totals and percentages for the period', async () => {
      const res = await request(app).get('/api/dashboard?period=month&anchor=2026-03-15');
      expect(res.status).toBe(200);
      const breakdown: Array<{ paymentMethodId: number; name: string; kind: string; total: number; percentage: number }> =
        res.body.paymentMethodBreakdown;
      expect(Array.isArray(breakdown)).toBe(true);

      const visa = breakdown.find(b => b.paymentMethodId === visaId);
      const cash = breakdown.find(b => b.paymentMethodId === cashId);
      expect(visa).toBeDefined();
      expect(visa!.name).toBe('__pmw_visa__');
      expect(visa!.kind).toBe('card');
      expect(visa!.total).toBeCloseTo(300);
      expect(visa!.percentage).toBeCloseTo((300 / 500) * 100, 0);
      expect(cash).toBeDefined();
      expect(cash!.total).toBeCloseTo(100);
    });

    it('returns an empty paymentMethodBreakdown when no movements have a method', async () => {
      const res = await request(app).get('/api/dashboard?period=month&anchor=2099-07-15');
      expect(res.status).toBe(200);
      expect(res.body.paymentMethodBreakdown).toEqual([]);
    });
  });

  // ─── POST /api/import/confirm payment_method_id ──────────────────────────────

  describe('POST /api/import/confirm payment_method_id', () => {
    it('persists payment_method_id on bulk-inserted movements', async () => {
      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            { amount: 50, date: '2024-04-01', description: '__pmw_conf_1__', payment_method_id: visaId },
            { amount: 60, date: '2024-04-02', description: '__pmw_conf_2__' },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(2);

      const saved = await pool.query<{ description: string; payment_method_id: number | null }>(
        `SELECT description, payment_method_id FROM movements WHERE description LIKE '__pmw_conf_%' ORDER BY description`
      );
      expect(saved.rows[0].payment_method_id).toBe(visaId);
      expect(saved.rows[1].payment_method_id).toBeNull();
    });

    it('rejects a non-existent payment_method_id without persisting anything', async () => {
      const countBefore = (await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM movements`)).rows[0].c;

      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            { amount: 50, date: '2024-04-03', description: '__pmw_conf_bad__', payment_method_id: 999999 },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details['movements.0.payment_method_id']).toBeDefined();

      const countAfter = (await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM movements`)).rows[0].c;
      expect(countAfter).toBe(countBefore);
    });

    it('returns store and payment_method_id on each created row for the import summary', async () => {
      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            {
              amount: 80,
              date: '2024-04-05',
              description: '__pmw_conf_summary__',
              store: 'ACME',
              payment_method_id: visaId,
            },
            { amount: 90, date: '2024-04-06', description: '__pmw_conf_summary_2__' },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.created[0]).toMatchObject({
        store: 'ACME',
        payment_method_id: visaId,
      });
      expect(res.body.created[1]).toMatchObject({
        store: null,
        payment_method_id: null,
      });
    });

    it('accepts an explicit null payment_method_id', async () => {
      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            { amount: 70, date: '2024-04-04', description: '__pmw_conf_null__', payment_method_id: null },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.count).toBe(1);
    });
  });
});
