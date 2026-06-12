import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';

jest.mock('../helpers/gmailClient', () => {
  const actual = jest.requireActual('../helpers/gmailClient');
  return { ...actual, getGmailClient: jest.fn() };
});

import { createApp } from '../app';
import { resetPool } from '../db';
import { getGmailClient, GmailError } from '../helpers/gmailClient';

const mockGetGmailClient = getGmailClient as jest.MockedFunction<typeof getGmailClient>;

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

let pool: Pool;
let app: ReturnType<typeof createApp>;

const mockList = jest.fn();
const mockGet = jest.fn();

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
  await pool.query('DELETE FROM gmail_imported_messages');
  await pool.query('DELETE FROM gmail_senders');
  await pool.end();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await pool.query('DELETE FROM gmail_imported_messages');
  await pool.query('DELETE FROM gmail_senders');
  mockGetGmailClient.mockResolvedValue({
    users: { messages: { list: mockList, get: mockGet } },
  } as never);
  mockList.mockResolvedValue({ data: { messages: [], nextPageToken: null } });
});

async function seedSender(email: string, subjectContains: string | null = null) {
  await pool.query(
    `INSERT INTO gmail_senders (email, subject_contains) VALUES ($1, $2)`,
    [email, subjectContains]
  );
}

function gmailMessage(id: string, headers: Record<string, string> = {}) {
  return {
    data: {
      id,
      threadId: `thread-${id}`,
      snippet: `snippet of ${id}`,
      payload: {
        headers: [
          { name: 'From', value: headers.from ?? 'Bank <alertas@davibank.com>' },
          { name: 'Subject', value: headers.subject ?? 'Alerta de compra' },
          { name: 'Date', value: headers.date ?? 'Mon, 1 Jun 2026 10:00:00 -0500' },
        ],
      },
    },
  };
}

describe('GET /api/gmail/messages — query construction', () => {
  it('builds an OR group per sender, with subject:"..." only for senders that have subject_contains', async () => {
    await seedSender('alertas@davibank.com', 'Alerta de compra');
    await seedSender('noreply@otherbank.com');

    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(200);

    const q: string = mockList.mock.calls[0][0].q;
    expect(q).toContain('(from:alertas@davibank.com subject:"Alerta de compra")');
    expect(q).toContain('(from:noreply@otherbank.com)');
    expect(q).toContain(' OR ');
  });

  it('adds after:/before: bounds from the from/to params (before is exclusive, to + 1 day)', async () => {
    await seedSender('alertas@davibank.com');

    const res = await request(app).get(
      '/api/gmail/messages?from=2026-05-01&to=2026-05-31'
    );
    expect(res.status).toBe(200);

    const q: string = mockList.mock.calls[0][0].q;
    expect(q).toContain('after:2026/05/01');
    expect(q).toContain('before:2026/06/01');
  });

  it('defaults the range to the last 30 days', async () => {
    await seedSender('alertas@davibank.com');

    await request(app).get('/api/gmail/messages');

    const q: string = mockList.mock.calls[0][0].q;
    expect(q).toMatch(/after:\d{4}\/\d{2}\/\d{2}/);
    expect(q).toMatch(/before:\d{4}\/\d{2}\/\d{2}/);
  });

  it('restricts to a single sender via the sender param, applying its configured subject filter', async () => {
    await seedSender('alertas@davibank.com', 'Alerta de compra');
    await seedSender('noreply@otherbank.com');

    await request(app).get('/api/gmail/messages?sender=alertas@davibank.com');

    const q: string = mockList.mock.calls[0][0].q;
    expect(q).toContain('(from:alertas@davibank.com subject:"Alerta de compra")');
    expect(q).not.toContain('otherbank');
  });

  it('accepts an unconfigured sender param as a plain from: filter', async () => {
    const res = await request(app).get('/api/gmail/messages?sender=adhoc@somewhere.com');
    expect(res.status).toBe(200);

    const q: string = mockList.mock.calls[0][0].q;
    expect(q).toContain('(from:adhoc@somewhere.com)');
  });

  it('ANDs an ad-hoc subject param on top of the per-sender groups', async () => {
    await seedSender('alertas@davibank.com', 'Alerta de compra');
    await seedSender('noreply@otherbank.com');

    await request(app).get('/api/gmail/messages?subject=Pago realizado');

    const q: string = mockList.mock.calls[0][0].q;
    // the ad-hoc phrase applies to the whole OR chain, outside the groups
    expect(q).toMatch(/\(.*OR.*\) subject:"Pago realizado"/);
  });

  it('quotes multi-word phrases and strips embedded double quotes', async () => {
    await seedSender('alertas@davibank.com', 'Alerta "de" compra');

    await request(app).get('/api/gmail/messages?subject=say "hi" now');

    const q: string = mockList.mock.calls[0][0].q;
    expect(q).toContain('subject:"Alerta de compra"');
    expect(q).toContain('subject:"say hi now"');
  });

  it('responds 400 when no senders are configured and no sender param is given', async () => {
    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sender/i);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('responds 400 on an invalid from date', async () => {
    await seedSender('alertas@davibank.com');
    const res = await request(app).get('/api/gmail/messages?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.from).toBeDefined();
  });
});

describe('GET /api/gmail/messages — results', () => {
  beforeEach(() => seedSender('alertas@davibank.com'));

  it('returns id, threadId, from, subject, date, and snippet from metadata fetches', async () => {
    mockList.mockResolvedValue({
      data: { messages: [{ id: 'm1', threadId: 'thread-m1' }], nextPageToken: null },
    });
    mockGet.mockResolvedValue(gmailMessage('m1'));

    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toEqual({
      id: 'm1',
      threadId: 'thread-m1',
      from: 'Bank <alertas@davibank.com>',
      subject: 'Alerta de compra',
      date: 'Mon, 1 Jun 2026 10:00:00 -0500',
      snippet: 'snippet of m1',
      alreadyImported: false,
    });
    expect(mockGet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', format: 'metadata' })
    );
  });

  it('marks alreadyImported true when a gmail_imported_messages row exists (even with null movement_id)', async () => {
    await pool.query(
      `INSERT INTO gmail_imported_messages (gmail_message_id, movement_id) VALUES ('m1', NULL)`
    );
    mockList.mockResolvedValue({
      data: {
        messages: [
          { id: 'm1', threadId: 't1' },
          { id: 'm2', threadId: 't2' },
        ],
        nextPageToken: null,
      },
    });
    mockGet
      .mockResolvedValueOnce(gmailMessage('m1'))
      .mockResolvedValueOnce(gmailMessage('m2'));

    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages[0].alreadyImported).toBe(true);
    expect(res.body.messages[1].alreadyImported).toBe(false);
  });

  it('passes the incoming pageToken to Gmail and returns nextPageToken', async () => {
    mockList.mockResolvedValue({
      data: { messages: [{ id: 'm9', threadId: 't9' }], nextPageToken: 'token-next' },
    });
    mockGet.mockResolvedValue(gmailMessage('m9'));

    const res = await request(app).get('/api/gmail/messages?pageToken=token-prev');
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: 'token-prev' })
    );
    expect(res.body.nextPageToken).toBe('token-next');
  });

  it('returns an empty list and null nextPageToken when Gmail finds nothing', async () => {
    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], nextPageToken: null });
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('GET /api/gmail/messages — auth failure mapping', () => {
  beforeEach(() => seedSender('alertas@davibank.com'));

  it('maps GMAIL_NOT_CONNECTED to 401 GMAIL_RECONNECT_REQUIRED', async () => {
    mockGetGmailClient.mockRejectedValue(
      new GmailError('GMAIL_NOT_CONNECTED', 'No Gmail account is connected')
    );
    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('GMAIL_RECONNECT_REQUIRED');
    expect(res.body.error).toBeDefined();
  });

  it('maps GMAIL_AUTH_EXPIRED to 401 GMAIL_RECONNECT_REQUIRED', async () => {
    mockGetGmailClient.mockRejectedValue(
      new GmailError('GMAIL_AUTH_EXPIRED', 'expired')
    );
    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('GMAIL_RECONNECT_REQUIRED');
  });

  it('maps a Google 401 during listing to 401 GMAIL_RECONNECT_REQUIRED', async () => {
    const googleError = Object.assign(new Error('Invalid Credentials'), {
      response: { status: 401 },
    });
    mockList.mockRejectedValue(googleError);
    const res = await request(app).get('/api/gmail/messages');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('GMAIL_RECONNECT_REQUIRED');
  });
});
