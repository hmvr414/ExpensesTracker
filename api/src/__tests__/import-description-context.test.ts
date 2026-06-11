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

describe('POST /api/import/extract — description rules, history and store context', () => {
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
      choices: [
        { message: { content: JSON.stringify({ movements, language: 'es' }) } },
      ],
    };
  }

  async function extract(): Promise<request.Response> {
    return request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__idc_receipt.jpg',
        contentType: 'image/jpeg',
      });
  }

  function sentPrompt(): string {
    const args = mockCreate.mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    return args.messages[0].content;
  }

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-desc-test-'));
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

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    mockRunTesseract = runTesseract as jest.MockedFunction<typeof runTesseract>;
    mockRunTesseract.mockResolvedValue(
      'DAVIbank: compra en __IDC_EXITO con tarjeta Visa por $40.313'
    );

    mockSuggestCategory = suggestCategory as jest.MockedFunction<typeof suggestCategory>;
    mockSuggestCategory.mockResolvedValue({ categoryId: null, suggestedNewCategory: null });

    await pool.query(`DELETE FROM store_context WHERE store LIKE '%idc%'`);
    await pool.query(`DELETE FROM movements WHERE store LIKE '%IDC%' OR store LIKE '%idc%'`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__idc_%'`);
    await pool.query(`DELETE FROM store_context WHERE store LIKE '%idc%'`);
    await pool.query(`DELETE FROM movements WHERE store LIKE '%IDC%' OR store LIKE '%idc%'`);
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  async function seedStoreHistory(): Promise<void> {
    for (const desc of ['Weekly groceries', 'Office snacks']) {
      await pool.query(
        `INSERT INTO movements (amount, date, description, store, created_at, updated_at)
         VALUES (10, '2026-01-01', $1, '__IDC_EXITO', NOW(), NOW())`,
        [desc]
      );
    }
  }

  it('states explicit description rules in the extraction prompt', async () => {
    mockCreate.mockResolvedValue(aiResponse([]));

    const res = await extract();

    expect(res.status).toBe(200);
    const prompt = sentPrompt();
    expect(prompt).toMatch(/description rules/i);
    expect(prompt).toMatch(/NEVER the payment instrument/i);
    // The forbidden vocabulary list is spelled out
    expect(prompt).toContain('efectivo');
    expect(prompt).toContain('mastercard');
    // Bank notification emails get their own rule
    expect(prompt).toMatch(/bank notification/i);
  });

  it("includes the user's previous descriptions for stores found in the OCR text", async () => {
    await seedStoreHistory();
    mockCreate.mockResolvedValue(aiResponse([]));

    await extract();

    const prompt = sentPrompt();
    expect(prompt).toMatch(/previously wrote/i);
    expect(prompt).toContain('Weekly groceries');
    expect(prompt).toContain('Office snacks');
  });

  it('includes the cached store context summary for stores found in the OCR text', async () => {
    await pool.query(
      `INSERT INTO store_context (store, summary, fetched_at)
       VALUES ('__idc_exito', 'Supermarket chain in Colombia.', NOW())`
    );
    mockCreate.mockResolvedValue(aiResponse([]));

    await extract();

    expect(sentPrompt()).toContain('Supermarket chain in Colombia.');
  });

  it('omits history sections when no known store appears in the OCR text', async () => {
    mockRunTesseract.mockResolvedValue('Some receipt from an unknown place');
    mockCreate.mockResolvedValue(aiResponse([]));

    await extract();

    expect(sentPrompt()).not.toMatch(/previously wrote/i);
  });

  it('replaces a payment-vocabulary description with the cleaned store name', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 40313,
          rawAmountText: '40,313',
          date: '2026-06-01',
          store: 'OPENROUTER, INC',
          description: 'Compra con tarjeta Visa Platinum',
        },
      ])
    );

    const res = await extract();

    expect(res.status).toBe(200);
    expect(res.body.movements[0].description).toBe('Openrouter');
  });

  it('keeps a clean description unchanged', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 20,
          rawAmountText: '20',
          date: '2026-06-01',
          store: 'OPENROUTER, INC',
          description: 'API credits monthly subscription',
        },
      ])
    );

    const res = await extract();

    expect(res.body.movements[0].description).toBe('API credits monthly subscription');
  });

  it('passes the sanitized description to the category suggester', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 40313,
          rawAmountText: '40,313',
          date: '2026-06-01',
          store: 'OPENROUTER, INC',
          description: 'Compra con tarjeta Visa Platinum',
        },
      ])
    );

    await extract();

    expect(mockSuggestCategory).toHaveBeenCalledWith('OPENROUTER, INC', 'Openrouter');
  });

  it('leaves movements without a description untouched', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: 20, rawAmountText: '20', date: '2026-06-01', store: 'Cafe' },
      ])
    );

    const res = await extract();

    expect(res.body.movements[0].description).toBeUndefined();
  });
});
