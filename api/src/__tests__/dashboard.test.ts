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

describe('GET /api/dashboard', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let catFoodId: number;
  let catTransportId: number;

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

    const cat1 = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__dash_food__', '#ff0000') RETURNING id`
    );
    catFoodId = cat1.rows[0].id;
    const cat2 = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__dash_transport__', '#0000ff') RETURNING id`
    );
    catTransportId = cat2.rows[0].id;

    // June 2025: 100 (food/SuperMart) + 50 (transport/BusStation) + 200 (food/SuperMart) + 30 (no cat, no store) = 380
    // May 2025: 80 (transport/GasPump) — used for previousPeriod assertions
    await pool.query(
      `INSERT INTO movements (amount, date, description, store, category_id) VALUES
        (100.00, '2025-06-05', '__dash_test_1__', 'SuperMart',  $1),
        (50.00,  '2025-06-10', '__dash_test_2__', 'BusStation', $2),
        (200.00, '2025-06-15', '__dash_test_3__', 'SuperMart',  $1),
        (30.00,  '2025-06-20', '__dash_test_4__', NULL,         NULL),
        (80.00,  '2025-05-15', '__dash_test_5__', 'GasPump',   $2)`,
      [catFoodId, catTransportId]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM movements WHERE description LIKE '__dash_%'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__dash_%'`);
    await pool.end();
  });

  // ─── validation ─────────────────────────────────────────────────────────────

  it('returns 400 for an invalid period', async () => {
    const res = await request(app).get('/api/dashboard?period=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid period/i);
  });

  it('returns 400 for a malformed anchor date', async () => {
    const res = await request(app).get('/api/dashboard?period=month&anchor=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid anchor/i);
  });

  // ─── response structure ──────────────────────────────────────────────────────

  it('returns the full expected response shape', async () => {
    const res = await request(app).get('/api/dashboard?period=month&anchor=2025-06-15');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalAmount');
    expect(res.body).toHaveProperty('movementCount');
    expect(res.body).toHaveProperty('categoryBreakdown');
    expect(res.body).toHaveProperty('timeSeries');
    expect(res.body).toHaveProperty('previousPeriod');
    expect(res.body).toHaveProperty('topStore');
    expect(Array.isArray(res.body.categoryBreakdown)).toBe(true);
    expect(Array.isArray(res.body.timeSeries)).toBe(true);
    expect(typeof res.body.previousPeriod).toBe('object');
  });

  // ─── totals ─────────────────────────────────────────────────────────────────

  it('returns correct totalAmount and movementCount for month', async () => {
    const res = await request(app).get('/api/dashboard?period=month&anchor=2025-06-15');
    expect(res.status).toBe(200);
    expect(res.body.totalAmount).toBeCloseTo(380);
    expect(res.body.movementCount).toBe(4);
  });

  it('returns zeros for a month with no movements', async () => {
    // Far-future date guarantees no data exists
    const res = await request(app).get('/api/dashboard?period=month&anchor=2099-03-15');
    expect(res.status).toBe(200);
    expect(res.body.totalAmount).toBe(0);
    expect(res.body.movementCount).toBe(0);
    expect(res.body.categoryBreakdown).toHaveLength(0);
    expect(res.body.topStore).toBeNull();
  });

  // ─── category breakdown ──────────────────────────────────────────────────────

  it('returns categoryBreakdown with totals and percentages', async () => {
    const res = await request(app).get('/api/dashboard?period=month&anchor=2025-06-15');
    expect(res.status).toBe(200);
    const breakdown: Array<{ categoryId: number; name: string; color: string; total: number; percentage: number }> =
      res.body.categoryBreakdown;

    // Food: 100+200=300, Transport: 50; grandTotal=380 (30 has no category)
    const food = breakdown.find(b => b.categoryId === catFoodId);
    const transport = breakdown.find(b => b.categoryId === catTransportId);
    expect(food).toBeDefined();
    expect(food!.total).toBeCloseTo(300);
    expect(food!.percentage).toBeCloseTo((300 / 380) * 100, 0);
    expect(food!.name).toBe('__dash_food__');
    expect(food!.color).toBe('#ff0000');
    expect(transport).toBeDefined();
    expect(transport!.total).toBeCloseTo(50);
  });

  // ─── time series ─────────────────────────────────────────────────────────────

  it('timeSeries for month has one bucket per day with no gaps (June = 30 days)', async () => {
    const res = await request(app).get('/api/dashboard?period=month&anchor=2025-06-15');
    expect(res.status).toBe(200);
    const ts: Array<{ label: string; total: number }> = res.body.timeSeries;
    expect(ts.length).toBe(30);
    for (const entry of ts) {
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.total).toBe('number');
    }
  });

  it('timeSeries for an empty month still returns full bucket list (January = 31 days)', async () => {
    // Use a far-future date to guarantee no test data exists
    const res = await request(app).get('/api/dashboard?period=month&anchor=2099-01-15');
    expect(res.status).toBe(200);
    const ts: Array<{ label: string; total: number }> = res.body.timeSeries;
    expect(ts.length).toBe(31);
    for (const entry of ts) {
      expect(entry.total).toBe(0);
    }
  });

  it('timeSeries for day has 24 hourly buckets labelled HH:00', async () => {
    const res = await request(app).get('/api/dashboard?period=day&anchor=2025-06-05');
    expect(res.status).toBe(200);
    const ts: Array<{ label: string; total: number }> = res.body.timeSeries;
    expect(ts.length).toBe(24);
    expect(ts[0].label).toBe('00:00');
    expect(ts[23].label).toBe('23:00');
  });

  it('timeSeries for week has 7 daily buckets', async () => {
    // anchor=2025-06-11 (Wednesday) → week is Mon Jun 9 – Sun Jun 15
    const res = await request(app).get('/api/dashboard?period=week&anchor=2025-06-11');
    expect(res.status).toBe(200);
    const ts: Array<{ label: string; total: number }> = res.body.timeSeries;
    expect(ts.length).toBe(7);
  });

  it('timeSeries for year has 12 monthly buckets', async () => {
    const res = await request(app).get('/api/dashboard?period=year&anchor=2025-06-15');
    expect(res.status).toBe(200);
    const ts: Array<{ label: string; total: number }> = res.body.timeSeries;
    expect(ts.length).toBe(12);
  });

  it('timeSeries for all has monthly buckets labelled "Mon YYYY"', async () => {
    const res = await request(app).get('/api/dashboard?period=all');
    expect(res.status).toBe(200);
    const ts: Array<{ label: string; total: number }> = res.body.timeSeries;
    // Must include at least May and June 2025 (our test data)
    expect(ts.length).toBeGreaterThanOrEqual(2);
    for (const entry of ts) {
      expect(entry.label).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    }
  });

  // ─── previousPeriod ──────────────────────────────────────────────────────────

  it('previousPeriod for month reflects the prior calendar month', async () => {
    // Current: June 2025 → previous: May 2025 (80.00, 1 movement)
    const res = await request(app).get('/api/dashboard?period=month&anchor=2025-06-15');
    expect(res.status).toBe(200);
    expect(res.body.previousPeriod.totalAmount).toBeCloseTo(80);
    expect(res.body.previousPeriod.movementCount).toBe(1);
  });

  it('previousPeriod for all returns zeros', async () => {
    const res = await request(app).get('/api/dashboard?period=all');
    expect(res.status).toBe(200);
    expect(res.body.previousPeriod.totalAmount).toBe(0);
    expect(res.body.previousPeriod.movementCount).toBe(0);
  });

  // ─── topStore ────────────────────────────────────────────────────────────────

  it('topStore is the store with the highest spend in the period', async () => {
    // June 2025: SuperMart=300, BusStation=50
    const res = await request(app).get('/api/dashboard?period=month&anchor=2025-06-15');
    expect(res.status).toBe(200);
    expect(res.body.topStore).toBe('SuperMart');
  });

  it('topStore is null when no movements have a store in the period', async () => {
    // Far-future date — no test data
    const res = await request(app).get('/api/dashboard?period=month&anchor=2099-12-15');
    expect(res.status).toBe(200);
    expect(res.body.topStore).toBeNull();
  });
});
