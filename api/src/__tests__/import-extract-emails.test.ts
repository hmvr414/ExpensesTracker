import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import OpenAI from 'openai';

jest.mock('openai');
jest.mock('../helpers/suggest');
jest.mock('../helpers/gmailClient', () => {
  const actual = jest.requireActual('../helpers/gmailClient');
  return { ...actual, getGmailClient: jest.fn() };
});

import { createApp } from '../app';
import { resetPool } from '../db';
import { suggestCategory } from '../helpers/suggest';
import { getGmailClient } from '../helpers/gmailClient';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

const mockGetGmailClient = getGmailClient as jest.MockedFunction<typeof getGmailClient>;

jest.setTimeout(30_000);

let pool: Pool;
let app: ReturnType<typeof createApp>;
let mockCreate: jest.Mock;
let mockSuggestCategory: jest.MockedFunction<typeof suggestCategory>;

const mockGet = jest.fn();

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function gmailFullMessage(
  id: string,
  body: { text?: string; html?: string },
  headers: Record<string, string> = {}
) {
  const parts = [];
  if (body.text !== undefined) {
    parts.push({ mimeType: 'text/plain', body: { data: encodeBase64Url(body.text) } });
  }
  if (body.html !== undefined) {
    parts.push({ mimeType: 'text/html', body: { data: encodeBase64Url(body.html) } });
  }

  return {
    data: {
      id,
      payload: {
        headers: [
          { name: 'Subject', value: headers.subject ?? 'Alerta de compra' },
          { name: 'From', value: headers.from ?? 'DAVIbank <alertas@davibank.com>' },
          { name: 'Date', value: headers.date ?? 'Mon, 1 Jun 2026 10:00:00 -0500' },
        ],
        parts,
      },
    },
  };
}

function aiResponse(movements: unknown[], language = 'es') {
  return {
    choices: [{ message: { content: JSON.stringify({ language, movements }) } }],
  };
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
  await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__email_extract_%'`);
  await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__email_extract_%'`);
  await pool.end();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__email_extract_%'`);

  mockCreate = jest.fn();
  (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(
    () =>
      ({
        chat: { completions: { create: mockCreate } },
      }) as unknown as OpenAI
  );

  mockSuggestCategory = suggestCategory as jest.MockedFunction<typeof suggestCategory>;
  mockSuggestCategory.mockResolvedValue({ categoryId: null });

  mockGet.mockReset();
  mockGetGmailClient.mockResolvedValue({
    users: { messages: { get: mockGet } },
  } as never);
});

describe('POST /api/import/extract-emails', () => {
  it('extracts movements from plain-text email bodies and tags them with Gmail metadata', async () => {
    mockGet.mockResolvedValue(
      gmailFullMessage('gmail-1', {
        text: 'Compra con tarjeta Visa por $40.313 en OPENROUTER, INC',
      })
    );
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 40313, date: '2026-06-01', store: 'OPENROUTER, INC' }])
    );

    const res = await request(app)
      .post('/api/import/extract-emails')
      .send({ messageIds: ['gmail-1'] });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('es');
    expect(res.body.emails).toHaveLength(1);
    expect(res.body.emails[0]).toMatchObject({
      messageId: 'gmail-1',
      subject: 'Alerta de compra',
      from: 'DAVIbank <alertas@davibank.com>',
      date: 'Mon, 1 Jun 2026 10:00:00 -0500',
      error: null,
    });
    expect(res.body.emails[0].movements[0]).toMatchObject({
      amount: 40313,
      gmailMessageId: 'gmail-1',
      source: 'gmail',
    });
    expect(mockGet).toHaveBeenCalledWith({ userId: 'me', id: 'gmail-1', format: 'full' });
  });

  it('falls back to sanitized HTML bodies when text/plain is absent', async () => {
    mockGet.mockResolvedValue(
      gmailFullMessage('gmail-html', {
        html: '<html><head><style>.x{}</style></head><body><p>Compra</p><script>bad()</script><strong>$10.000</strong></body></html>',
      })
    );
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 10000, date: '2026-06-01', store: 'HTML Store' }])
    );

    const res = await request(app)
      .post('/api/import/extract-emails')
      .send({ messageIds: ['gmail-html'] });

    expect(res.status).toBe(200);
    expect(res.body.emails[0].movements).toHaveLength(1);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Compra');
    expect(prompt).toContain('$10.000');
    expect(prompt).not.toContain('bad()');
  });

  it('keeps per-email failures isolated inside the batch', async () => {
    mockGet
      .mockRejectedValueOnce(new Error('gmail fetch failed'))
      .mockResolvedValueOnce(gmailFullMessage('gmail-ok', { text: 'Compra $5 en Store' }));
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 5, date: '2026-06-01', store: 'Store' }], 'en')
    );

    const res = await request(app)
      .post('/api/import/extract-emails')
      .send({ messageIds: ['gmail-bad', 'gmail-ok'] });

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('en');
    expect(res.body.emails[0]).toMatchObject({
      messageId: 'gmail-bad',
      movements: [],
      error: 'Email extraction failed',
    });
    expect(res.body.emails[1].movements).toHaveLength(1);
  });

  it('preserves payment detection fallback fields returned by the shared extraction pipeline', async () => {
    mockGet.mockResolvedValue(
      gmailFullMessage('gmail-pm', {
        text: 'Compra con tarjeta Visa Platinum por $20.000 en Tienda',
      })
    );
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 20000,
          date: '2026-06-01',
          store: 'Tienda',
          paymentMethodId: null,
          detectedPaymentLabel: 'Visa Platinum',
          detectedBrand: 'visa',
          detectedVariant: 'platinum',
        },
      ])
    );

    const res = await request(app)
      .post('/api/import/extract-emails')
      .send({ messageIds: ['gmail-pm'] });

    expect(res.status).toBe(200);
    expect(res.body.emails[0].movements[0]).toMatchObject({
      paymentMethodId: null,
      paymentMethodName: null,
      detectedPaymentLabel: 'Visa Platinum',
      detectedBrand: 'visa',
      detectedVariant: 'platinum',
      paymentAiSuggested: false,
    });
  });

  it('validates 1 to 25 unique message ids', async () => {
    const duplicate = await request(app)
      .post('/api/import/extract-emails')
      .send({ messageIds: ['same', 'same'] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.details.messageIds).toBeDefined();

    const tooMany = await request(app)
      .post('/api/import/extract-emails')
      .send({ messageIds: Array.from({ length: 26 }, (_, i) => `m-${i}`) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.details.messageIds).toBeDefined();
  });
});
