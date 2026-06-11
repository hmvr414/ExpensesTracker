import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import OpenAI from 'openai';
import { createApp } from '../app';
import { resetPool } from '../db';
import { suggestCategory } from '../helpers/suggest';

jest.mock('openai');
jest.mock('../helpers/ocr');
jest.mock('../helpers/suggest');

import { runTesseract } from '../helpers/ocr';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

describe('POST /api/import/extract — model response validation', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let mockCreate: jest.Mock;
  let mockRunTesseract: jest.MockedFunction<typeof runTesseract>;
  let mockSuggestCategory: jest.MockedFunction<typeof suggestCategory>;
  let uploadDir: string;

  function aiResponse(movements: unknown[]): {
    choices: Array<{ message: { content: string } }>;
  } {
    return {
      choices: [{ message: { content: JSON.stringify({ movements }) } }],
    };
  }

  async function extract(): Promise<request.Response> {
    return request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imev_receipt.jpg',
        contentType: 'image/jpeg',
      });
  }

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-validation-test-'));
    process.env.UPLOAD_DIR = uploadDir;

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

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    mockRunTesseract = runTesseract as jest.MockedFunction<typeof runTesseract>;
    mockRunTesseract.mockResolvedValue('Receipt total $40.313 COP');

    mockSuggestCategory = suggestCategory as jest.MockedFunction<typeof suggestCategory>;
    mockSuggestCategory.mockResolvedValue({ categoryId: null });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__imev_%'`);
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('recovers the amount from rawAmountText when the model returns it as a string, flagged suspect', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: '40,313', date: '2026-06-01', store: 'X', rawAmountText: '40,313' }])
    );

    const res = await extract();

    expect(res.status).toBe(200);
    expect(res.body.movements).toHaveLength(1);
    const mv = res.body.movements[0];
    expect(mv.amount).toBe(40313);
    expect(mv.amountSuspect).toBe(true);
    expect(mv.rawAmountText).toBe('40,313');
  });

  it('recovers a parseable string amount when rawAmountText is missing, flagged suspect', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: '$ 12.50', date: '2026-06-01', store: 'Cafe' }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(12.5);
    expect(mv.amountSuspect).toBe(true);
  });

  it('drops rows whose amount cannot be recovered', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: 'n/a', date: '2026-06-01', store: 'Bad' },
        { amount: 10, date: '2026-06-01', store: 'Good', rawAmountText: '10' },
      ])
    );

    const res = await extract();

    expect(res.body.movements).toHaveLength(1);
    expect(res.body.movements[0].store).toBe('Good');
  });

  it('drops rows with a non-positive amount and no recoverable text', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: -5, date: '2026-06-01' },
        { amount: 0, date: '2026-06-01' },
      ])
    );

    const res = await extract();

    expect(res.body.movements).toHaveLength(0);
  });

  it('drops movement entries that are not objects', async () => {
    mockCreate.mockResolvedValue(
      aiResponse(['garbage', null, 42, { amount: 10, date: '2026-06-01', rawAmountText: '10' }])
    );

    const res = await extract();

    expect(res.body.movements).toHaveLength(1);
    expect(res.body.movements[0].amount).toBe(10);
  });

  it("falls back to today's date when the model date is missing or malformed", async () => {
    const today = new Date().toISOString().split('T')[0];
    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: 10, rawAmountText: '10' },
        { amount: 20, date: 12345, rawAmountText: '20' },
        { amount: 30, date: 'last tuesday', rawAmountText: '30' },
      ])
    );

    const res = await extract();

    expect(res.body.movements).toHaveLength(3);
    for (const mv of res.body.movements) {
      expect(mv.date).toBe(today);
    }
  });

  it('ignores non-string description and store', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 10, date: '2026-06-01', rawAmountText: '10', description: 99, store: { name: 'X' } }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.description).toBeUndefined();
    expect(mv.store).toBeUndefined();
  });

  it('nulls out a non-numeric paymentMethodId', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 10, date: '2026-06-01', rawAmountText: '10', paymentMethodId: 'visa' }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.paymentMethodId).toBeNull();
    expect(mv.paymentAiSuggested).toBe(false);
  });

  it('keeps a well-formed row untouched and unflagged', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 1234.56,
          date: '2026-06-01',
          description: 'Groceries',
          store: 'ACME',
          rawAmountText: '1.234,56',
        },
      ])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(1234.56);
    expect(mv.amountSuspect).toBe(false);
    expect(mv.date).toBe('2026-06-01');
    expect(mv.description).toBe('Groceries');
    expect(mv.store).toBe('ACME');
  });
});
