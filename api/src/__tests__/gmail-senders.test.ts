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
  await pool.query('DELETE FROM gmail_senders');
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM gmail_senders');
});

async function seedSender(overrides: Partial<{
  email: string;
  label: string | null;
  subject_contains: string | null;
}> = {}) {
  const row = {
    email: 'alertas@davibank.com',
    label: 'DAVIbank alerts',
    subject_contains: 'Alerta de compra',
    ...overrides,
  };
  const result = await pool.query(
    `INSERT INTO gmail_senders (email, label, subject_contains)
     VALUES ($1, $2, $3) RETURNING *`,
    [row.email, row.label, row.subject_contains]
  );
  return result.rows[0];
}

describe('GET /api/gmail/senders', () => {
  it('returns an empty array when no senders are configured', async () => {
    const res = await request(app).get('/api/gmail/senders');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all senders ordered by email', async () => {
    await seedSender({ email: 'z@bank.com', label: null, subject_contains: null });
    await seedSender({ email: 'a@bank.com' });
    const res = await request(app).get('/api/gmail/senders');
    expect(res.status).toBe(200);
    expect(res.body.map((s: { email: string }) => s.email)).toEqual([
      'a@bank.com',
      'z@bank.com',
    ]);
    expect(res.body[0].label).toBe('DAVIbank alerts');
    expect(res.body[0].subject_contains).toBe('Alerta de compra');
  });
});

describe('POST /api/gmail/senders', () => {
  it('creates a sender and returns 201 with the row', async () => {
    const res = await request(app).post('/api/gmail/senders').send({
      email: 'alertas@davibank.com',
      label: 'DAVIbank alerts',
      subject_contains: 'Alerta de compra',
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('alertas@davibank.com');
    expect(res.body.label).toBe('DAVIbank alerts');
    expect(res.body.subject_contains).toBe('Alerta de compra');
    expect(res.body.id).toBeDefined();
  });

  it('lowercases the email before insert', async () => {
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'Alertas@DAVIbank.COM' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('alertas@davibank.com');
  });

  it('creates a sender with only an email (label and subject optional)', async () => {
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'alerts@bank.com' });
    expect(res.status).toBe(201);
    expect(res.body.label).toBeNull();
    expect(res.body.subject_contains).toBeNull();
  });

  it('rejects an invalid email with 400 and the standard error shape', async () => {
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.email).toBeDefined();
  });

  it('rejects a missing email with 400', async () => {
    const res = await request(app).post('/api/gmail/senders').send({});
    expect(res.status).toBe(400);
    expect(res.body.details.email).toBeDefined();
  });

  it('rejects a label longer than 60 chars', async () => {
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'a@b.com', label: 'x'.repeat(61) });
    expect(res.status).toBe(400);
    expect(res.body.details.label).toBeDefined();
  });

  it('rejects an empty label', async () => {
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'a@b.com', label: '' });
    expect(res.status).toBe(400);
    expect(res.body.details.label).toBeDefined();
  });

  it('rejects a subject_contains longer than 100 chars', async () => {
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'a@b.com', subject_contains: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.details.subject_contains).toBeDefined();
  });

  it('responds 409 on duplicate email (case-insensitive via lowercasing)', async () => {
    await seedSender({ email: 'alertas@davibank.com' });
    const res = await request(app)
      .post('/api/gmail/senders')
      .send({ email: 'ALERTAS@davibank.com' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('alertas@davibank.com');
  });
});

describe('PUT /api/gmail/senders/:id', () => {
  it('partially updates the label keeping subject_contains', async () => {
    const sender = await seedSender();
    const res = await request(app)
      .put(`/api/gmail/senders/${sender.id}`)
      .send({ label: 'New label' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('New label');
    expect(res.body.subject_contains).toBe('Alerta de compra');
  });

  it('clears subject_contains with an explicit null', async () => {
    const sender = await seedSender();
    const res = await request(app)
      .put(`/api/gmail/senders/${sender.id}`)
      .send({ subject_contains: null });
    expect(res.status).toBe(200);
    expect(res.body.subject_contains).toBeNull();
    expect(res.body.label).toBe('DAVIbank alerts');
  });

  it('rejects out-of-range values with 400', async () => {
    const sender = await seedSender();
    const res = await request(app)
      .put(`/api/gmail/senders/${sender.id}`)
      .send({ subject_contains: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.details.subject_contains).toBeDefined();
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .put('/api/gmail/senders/99999')
      .send({ label: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('DELETE /api/gmail/senders/:id', () => {
  it('hard-deletes the sender and returns 204', async () => {
    const sender = await seedSender();
    const res = await request(app).delete(`/api/gmail/senders/${sender.id}`);
    expect(res.status).toBe(204);
    const rows = await pool.query('SELECT * FROM gmail_senders');
    expect(rows.rowCount).toBe(0);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).delete('/api/gmail/senders/99999');
    expect(res.status).toBe(404);
  });
});
