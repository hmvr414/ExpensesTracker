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

describe('movement time field', () => {
  const { getPool, getApp } = setupSuite();

  afterAll(async () => {
    const pool = getPool();
    await pool.query(`DELETE FROM movements WHERE description LIKE '__test_time_%'`);
    await pool.end();
  });

  describe('POST /api/movements', () => {
    it('accepts HH:MM and returns it as HH:MM', async () => {
      const res = await request(getApp())
        .post('/api/movements')
        .send({ amount: 10, date: '2024-05-01', description: '__test_time_hm__', time: '14:32' });
      expect(res.status).toBe(201);
      expect(res.body.time).toBe('14:32');
    });

    it('accepts HH:MM:SS and normalizes the response to HH:MM', async () => {
      const res = await request(getApp())
        .post('/api/movements')
        .send({ amount: 10, date: '2024-05-01', description: '__test_time_hms__', time: '09:05:59' });
      expect(res.status).toBe(201);
      expect(res.body.time).toBe('09:05');
    });

    it('stores HH:MM normalized to HH:MM:SS in the database', async () => {
      const res = await request(getApp())
        .post('/api/movements')
        .send({ amount: 10, date: '2024-05-01', description: '__test_time_norm__', time: '14:32' });
      expect(res.status).toBe(201);
      const row = await getPool().query<{ time: string }>(
        `SELECT time::text FROM movements WHERE id = $1`,
        [res.body.id]
      );
      expect(row.rows[0].time).toBe('14:32:00');
    });

    it('defaults time to null when omitted', async () => {
      const res = await request(getApp())
        .post('/api/movements')
        .send({ amount: 10, date: '2024-05-01', description: '__test_time_none__' });
      expect(res.status).toBe(201);
      expect(res.body.time).toBeNull();
    });

    it('accepts explicit null time', async () => {
      const res = await request(getApp())
        .post('/api/movements')
        .send({ amount: 10, date: '2024-05-01', description: '__test_time_null__', time: null });
      expect(res.status).toBe(201);
      expect(res.body.time).toBeNull();
    });

    it.each(['25:00', '9:30', '12:60', '12:30:61', '14h32', 'abc', ''])(
      'rejects malformed time %p with 400 and a details.time message',
      async (bad) => {
        const res = await request(getApp())
          .post('/api/movements')
          .send({ amount: 10, date: '2024-05-01', description: '__test_time_bad__', time: bad });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(res.body.details.time).toBeDefined();
      }
    );
  });

  describe('PUT /api/movements/:id', () => {
    let movementId: number;

    beforeAll(async () => {
      const res = await request(getApp())
        .post('/api/movements')
        .send({ amount: 20, date: '2024-05-02', description: '__test_time_put__', time: '08:00' });
      movementId = res.body.id;
    });

    it('updates the time', async () => {
      const res = await request(getApp())
        .put(`/api/movements/${movementId}`)
        .send({ time: '17:45' });
      expect(res.status).toBe(200);
      expect(res.body.time).toBe('17:45');
    });

    it('clears the time with explicit null', async () => {
      const res = await request(getApp())
        .put(`/api/movements/${movementId}`)
        .send({ time: null });
      expect(res.status).toBe(200);
      expect(res.body.time).toBeNull();
    });

    it('leaves the time untouched when the field is omitted', async () => {
      await request(getApp()).put(`/api/movements/${movementId}`).send({ time: '11:11' });
      const res = await request(getApp())
        .put(`/api/movements/${movementId}`)
        .send({ amount: 21 });
      expect(res.status).toBe(200);
      expect(res.body.time).toBe('11:11');
    });

    it('rejects a malformed time with 400', async () => {
      const res = await request(getApp())
        .put(`/api/movements/${movementId}`)
        .send({ time: '24:00' });
      expect(res.status).toBe(400);
      expect(res.body.details.time).toBeDefined();
    });
  });

  describe('GET endpoints include time as HH:MM or null', () => {
    let timedId: number;
    let untimedId: number;

    beforeAll(async () => {
      const timed = await request(getApp())
        .post('/api/movements')
        .send({ amount: 30, date: '2024-05-03', description: '__test_time_get_a__', time: '13:30:15' });
      timedId = timed.body.id;
      const untimed = await request(getApp())
        .post('/api/movements')
        .send({ amount: 30, date: '2024-05-03', description: '__test_time_get_b__' });
      untimedId = untimed.body.id;
    });

    it('GET /api/movements/:id returns HH:MM', async () => {
      const res = await request(getApp()).get(`/api/movements/${timedId}`);
      expect(res.status).toBe(200);
      expect(res.body.date).toBe('2024-05-03');
      expect(res.body.time).toBe('13:30');
    });

    it('GET /api/movements/:id returns null when unset', async () => {
      const res = await request(getApp()).get(`/api/movements/${untimedId}`);
      expect(res.status).toBe(200);
      expect(res.body.time).toBeNull();
    });

    it('GET /api/movements list rows carry time as HH:MM or null', async () => {
      const res = await request(getApp()).get('/api/movements?search=__test_time_get_');
      expect(res.status).toBe(200);
      const byId = new Map(res.body.data.map((m: { id: number; time: string | null }) => [m.id, m.time]));
      const datesById = new Map(res.body.data.map((m: { id: number; date: string }) => [m.id, m.date]));
      expect(datesById.get(timedId)).toBe('2024-05-03');
      expect(byId.get(timedId)).toBe('13:30');
      expect(byId.get(untimedId)).toBeNull();
    });
  });

  describe('list ordering: date DESC, time DESC NULLS LAST, created_at DESC', () => {
    const ids: Record<string, number> = {};

    beforeAll(async () => {
      // Insert out of chronological order, controlling created_at so the
      // created_at tiebreaker alone cannot produce the expected order.
      const pool = getPool();
      const rows: Array<[string, string, string | null, string]> = [
        ['early', '2024-06-10', '08:00:00', '2024-06-10T10:00:00Z'],
        ['untimed_old', '2024-06-10', null, '2024-06-10T11:00:00Z'],
        ['late', '2024-06-10', '21:15:00', '2024-06-10T09:00:00Z'],
        ['untimed_new', '2024-06-10', null, '2024-06-10T08:00:00Z'],
        ['next_day', '2024-06-11', '01:00:00', '2024-06-10T07:00:00Z'],
      ];
      for (const [key, date, time, createdAt] of rows) {
        const result = await pool.query<{ id: number }>(
          `INSERT INTO movements (amount, date, time, description, created_at)
           VALUES (5, $1, $2, $3, $4) RETURNING id`,
          [date, time, `__test_time_order_${key}__`, createdAt]
        );
        ids[key] = result.rows[0].id;
      }
    });

    it('sorts timed movements chronologically within the day and sinks untimed below', async () => {
      const res = await request(getApp()).get('/api/movements?search=__test_time_order_');
      expect(res.status).toBe(200);
      const order = res.body.data.map((m: { id: number }) => m.id);
      expect(order.indexOf(ids.next_day)).toBe(0);
      expect(order.indexOf(ids.late)).toBeLessThan(order.indexOf(ids.early));
      expect(order.indexOf(ids.early)).toBeLessThan(order.indexOf(ids.untimed_old));
      expect(order.indexOf(ids.early)).toBeLessThan(order.indexOf(ids.untimed_new));
      // untimed rows tie-break by created_at DESC
      expect(order.indexOf(ids.untimed_old)).toBeLessThan(order.indexOf(ids.untimed_new));
    });
  });

  describe('POST /api/import/confirm', () => {
    it('persists time on confirmed movements', async () => {
      const res = await request(getApp())
        .post('/api/import/confirm')
        .send({
          movements: [
            { amount: 12.5, date: '2024-05-04', description: '__test_time_confirm_a__', time: '02:32' },
            { amount: 7, date: '2024-05-04', description: '__test_time_confirm_b__' },
          ],
        });
      expect(res.status).toBe(201);
      const rows = await getPool().query<{ description: string; time: string | null }>(
        `SELECT description, time::text FROM movements
         WHERE description LIKE '__test_time_confirm_%' ORDER BY description`
      );
      expect(rows.rows).toEqual([
        { description: '__test_time_confirm_a__', time: '02:32:00' },
        { description: '__test_time_confirm_b__', time: null },
      ]);
    });

    it('rejects a malformed time on a confirm item', async () => {
      const res = await request(getApp())
        .post('/api/import/confirm')
        .send({
          movements: [{ amount: 12.5, date: '2024-05-04', description: '__test_time_confirm_bad__', time: '99:99' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.details['movements.0.time']).toBeDefined();
    });
  });
});
