import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';

jest.mock('../helpers/gmailClient', () => {
  const actual = jest.requireActual('../helpers/gmailClient');
  return { ...actual, getGmailClient: jest.fn() };
});
jest.mock('../helpers/extractMovements', () => ({
  extractMovementsFromText: jest.fn(),
}));

import { createApp } from '../app';
import { resetPool } from '../db';
import { getGmailClient, GmailError } from '../helpers/gmailClient';
import { extractMovementsFromText } from '../helpers/extractMovements';
import { runGmailPollTick } from '../jobs/gmailPoller';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

const mockGetGmailClient = getGmailClient as jest.MockedFunction<typeof getGmailClient>;
const mockExtract = extractMovementsFromText as jest.MockedFunction<typeof extractMovementsFromText>;

let pool: Pool;
let app: ReturnType<typeof createApp>;

const mockList = jest.fn();
const mockGet = jest.fn();

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function gmailFullMessage(id: string, text = 'Compra $12 en Store') {
  return {
    data: {
      id,
      payload: {
        headers: [
          { name: 'Subject', value: 'Alerta de compra' },
          { name: 'From', value: 'DAVIbank <alertas@davibank.com>' },
          { name: 'Date', value: 'Mon, 1 Jun 2026 10:00:00 -0500' },
        ],
        parts: [{ mimeType: 'text/plain', body: { data: encodeBase64Url(text) } }],
      },
    },
  };
}

async function seedConnection(overrides: { needs_reconnect?: boolean; last_polled_at?: string | null } = {}) {
  await pool.query(
    `INSERT INTO gmail_connection
       (google_email, access_token, refresh_token, token_expiry, needs_reconnect, last_polled_at)
     VALUES ($1, 'access', 'refresh', NOW() + INTERVAL '1 hour', $2, $3)`,
    ['me@example.com', overrides.needs_reconnect ?? false, overrides.last_polled_at ?? null]
  );
}

async function seedSender() {
  await pool.query(
    `INSERT INTO gmail_senders (email, subject_contains)
     VALUES ('alertas@davibank.com', 'Alerta de compra')`
  );
}

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
  if (pool) {
    await pool.query('DELETE FROM gmail_pending_imports');
    await pool.query('DELETE FROM gmail_imported_messages');
    await pool.query('DELETE FROM movements');
    await pool.query('DELETE FROM gmail_senders');
    await pool.query('DELETE FROM gmail_connection');
    await pool.end();
  }
});

beforeEach(async () => {
  jest.clearAllMocks();
  await pool.query('DELETE FROM gmail_pending_imports');
  await pool.query('DELETE FROM gmail_imported_messages');
  await pool.query('DELETE FROM movements');
  await pool.query('DELETE FROM gmail_senders');
  await pool.query('DELETE FROM gmail_connection');
  mockGetGmailClient.mockResolvedValue({
    users: { messages: { list: mockList, get: mockGet } },
  } as never);
  mockList.mockResolvedValue({ data: { messages: [{ id: 'gmail-1' }] } });
  mockGet.mockResolvedValue(gmailFullMessage('gmail-1'));
  mockExtract.mockResolvedValue({
    language: 'es',
    movements: [
      {
        amount: 12,
        rawAmountText: '$12',
        amountSuspect: false,
        date: '2026-06-01',
        time: '10:00',
        store: 'Store',
        possibleDuplicate: false,
        duplicateOf: null,
        categoryId: null,
        suggestedNewCategory: null,
        aiSuggested: false,
        paymentMethodId: null,
        paymentMethodName: null,
        detectedPaymentLabel: null,
        detectedBrand: null,
        detectedVariant: null,
        paymentAiSuggested: false,
      },
    ],
  });
});

describe('background Gmail pending import polling', () => {
  it('does nothing when Gmail is disconnected, reconnect-needed, or no senders are configured', async () => {
    expect(await runGmailPollTick()).toEqual({ newEmails: 0, errors: 0 });
    expect(mockGetGmailClient).not.toHaveBeenCalled();

    await seedConnection({ needs_reconnect: true });
    expect(await runGmailPollTick()).toEqual({ newEmails: 0, errors: 0 });
    expect(mockGetGmailClient).not.toHaveBeenCalled();

    await pool.query('DELETE FROM gmail_connection');
    await seedConnection();
    expect(await runGmailPollTick()).toEqual({ newEmails: 0, errors: 0 });
    expect(mockGetGmailClient).not.toHaveBeenCalled();
  });

  it('searches Gmail with configured sender filters and stores extracted pending movements', async () => {
    await seedConnection();
    await seedSender();

    const result = await runGmailPollTick();

    expect(result).toEqual({ newEmails: 1, errors: 0 });
    expect(mockList.mock.calls[0][0].q).toContain(
      '(from:alertas@davibank.com subject:"Alerta de compra")'
    );
    expect(mockGet).toHaveBeenCalledWith({ userId: 'me', id: 'gmail-1', format: 'full' });
    expect(mockExtract.mock.calls[0][0]).toContain('Subject: Alerta de compra');

    const rows = await pool.query(
      `SELECT gmail_message_id, status, movements, error
       FROM gmail_pending_imports`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].gmail_message_id).toBe('gmail-1');
    expect(rows.rows[0].status).toBe('pending');
    expect(rows.rows[0].error).toBeNull();
    expect(rows.rows[0].movements[0]).toMatchObject({
      gmailMessageId: 'gmail-1',
      source: 'gmail',
      amount: 12,
    });
  });

  it('skips message ids already imported or already present in the pending queue', async () => {
    await seedConnection();
    await seedSender();
    mockList.mockResolvedValue({
      data: { messages: [{ id: 'imported' }, { id: 'pending' }, { id: 'new' }] },
    });
    await pool.query(
      `INSERT INTO gmail_imported_messages (gmail_message_id, movement_id)
       VALUES ('imported', NULL)`
    );
    await pool.query(
      `INSERT INTO gmail_pending_imports (gmail_message_id, movements, status)
       VALUES ('pending', '[]'::jsonb, 'pending')`
    );
    mockGet.mockResolvedValue(gmailFullMessage('new'));

    const result = await runGmailPollTick();

    expect(result).toEqual({ newEmails: 1, errors: 0 });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0].id).toBe('new');
  });

  it('stores extraction failures as error rows and retry re-extracts that exact message', async () => {
    await seedConnection();
    await seedSender();
    mockExtract.mockResolvedValueOnce({ language: null, movements: [], error: 'AI extraction failed' });

    await runGmailPollTick();
    let row = await pool.query(`SELECT status, error FROM gmail_pending_imports WHERE gmail_message_id = 'gmail-1'`);
    expect(row.rows[0]).toMatchObject({ status: 'error', error: 'AI extraction failed' });

    mockExtract.mockResolvedValueOnce({
      language: 'es',
      movements: [
        {
          amount: 99,
          rawAmountText: '$99',
          amountSuspect: false,
          date: '2026-06-01',
          time: null,
          store: 'Retry Store',
          possibleDuplicate: false,
          duplicateOf: null,
          categoryId: null,
          suggestedNewCategory: null,
          aiSuggested: false,
          paymentMethodId: null,
          paymentMethodName: null,
          detectedPaymentLabel: null,
          detectedBrand: null,
          detectedVariant: null,
          paymentAiSuggested: false,
        },
      ],
    });
    const res = await request(app).post('/api/gmail/pending/gmail-1/retry');

    expect(res.status).toBe(200);
    row = await pool.query(`SELECT status, movements, error FROM gmail_pending_imports WHERE gmail_message_id = 'gmail-1'`);
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].error).toBeNull();
    expect(row.rows[0].movements[0].amount).toBe(99);
  });

  it('sets needs_reconnect when Gmail auth has expired', async () => {
    await seedConnection();
    await seedSender();
    mockGetGmailClient.mockRejectedValue(
      new GmailError('GMAIL_AUTH_EXPIRED', 'Reconnect the account')
    );

    const result = await runGmailPollTick();

    expect(result).toEqual({ newEmails: 0, errors: 1 });
    const row = await pool.query(`SELECT needs_reconnect FROM gmail_connection`);
    expect(row.rows[0].needs_reconnect).toBe(true);
  });
});

describe('pending Gmail routes', () => {
  it('lists pending rows, returns pending counts, dismisses rows, and poll-now runs a tick', async () => {
    await seedConnection();
    await seedSender();
    await pool.query(
      `INSERT INTO gmail_pending_imports
         (gmail_message_id, from_address, subject, email_date, movements, status)
       VALUES
         ('p1', 'a@example.com', 'One', '2026-06-01T10:00:00Z', $1::jsonb, 'pending'),
         ('p2', 'b@example.com', 'Two', '2026-06-02T10:00:00Z', '[]'::jsonb, 'error')`,
      [JSON.stringify([{ amount: 1 }, { amount: 2 }])]
    );

    let res = await request(app).get('/api/gmail/pending');
    expect(res.status).toBe(200);
    expect(res.body.emails).toHaveLength(1);
    expect(res.body.emails[0]).toMatchObject({ messageId: 'p1', subject: 'One' });

    res = await request(app).get('/api/gmail/pending/count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emails: 1, movements: 2 });

    res = await request(app).post('/api/gmail/pending/p1/dismiss');
    expect(res.status).toBe(204);
    const dismissed = await pool.query(`SELECT status FROM gmail_pending_imports WHERE gmail_message_id = 'p1'`);
    expect(dismissed.rows[0].status).toBe('dismissed');

    res = await request(app).post('/api/gmail/poll-now');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ newEmails: 1, errors: 0 });
  });

  it('confirming Gmail movements clears matching pending rows inside the import transaction', async () => {
    await pool.query(
      `INSERT INTO gmail_pending_imports (gmail_message_id, movements, status)
       VALUES ('gmail-confirm', '[]'::jsonb, 'pending')`
    );

    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 10,
            date: '2026-06-01',
            store: 'Confirm Store',
            gmail_message_id: 'gmail-confirm',
          },
        ],
      });

    expect(res.status).toBe(201);
    const pending = await pool.query(
      `SELECT * FROM gmail_pending_imports WHERE gmail_message_id = 'gmail-confirm'`
    );
    const imported = await pool.query(
      `SELECT * FROM gmail_imported_messages WHERE gmail_message_id = 'gmail-confirm'`
    );
    expect(pending.rowCount).toBe(0);
    expect(imported.rowCount).toBe(1);
  });
});
