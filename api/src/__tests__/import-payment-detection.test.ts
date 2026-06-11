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

describe('POST /api/import/extract — payment method detection', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let mockCreate: jest.Mock;
  let mockRunTesseract: jest.MockedFunction<typeof runTesseract>;
  let mockSuggestCategory: jest.MockedFunction<typeof suggestCategory>;
  let uploadDir: string;
  let visaId: number;
  let cashId: number;

  function aiResponse(movements: unknown[]): { choices: Array<{ message: { content: string } }> } {
    return {
      choices: [{ message: { content: JSON.stringify({ movements }) } }],
    };
  }

  async function extract(): Promise<request.Response> {
    return request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__impm_receipt.jpg',
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
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-pm-test-'));
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

    const visa = await pool.query<{ id: number }>(
      `INSERT INTO payment_methods (name, kind, brand, variant, last4)
       VALUES ('__impm Visa Platinum DAVIbank', 'card', 'visa', 'platinum', '1234')
       RETURNING id`
    );
    visaId = visa.rows[0].id;

    const cash = await pool.query<{ id: number }>(
      `SELECT id FROM payment_methods WHERE kind = 'cash' ORDER BY id LIMIT 1`
    );
    cashId = cash.rows[0].id;
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
    mockRunTesseract.mockResolvedValue(
      'DAVIbank: compra con tarjeta Visa Platinum por $40.313 en OPENROUTER, INC'
    );

    mockSuggestCategory = suggestCategory as jest.MockedFunction<typeof suggestCategory>;
    mockSuggestCategory.mockResolvedValue({ categoryId: null });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__impm_%'`);
    await pool.query(`DELETE FROM payment_methods WHERE name LIKE '__impm %'`);
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('includes the registered payment methods in the extraction prompt', async () => {
    mockCreate.mockResolvedValue(aiResponse([]));

    const res = await extract();

    expect(res.status).toBe(200);
    const prompt = sentPrompt();
    expect(prompt).toContain('__impm Visa Platinum DAVIbank');
    expect(prompt).toContain(`"id": ${visaId}`);
    expect(prompt).toContain('"brand": "visa"');
    expect(prompt).toContain('"variant": "platinum"');
    expect(prompt).toContain(`"id": ${cashId}`);
  });

  it('includes bilingual Spanish/English payment cues in the prompt', async () => {
    mockCreate.mockResolvedValue(aiResponse([]));

    await extract();

    const prompt = sentPrompt();
    for (const cue of ['tarjeta', 'compra', 'débito', 'crédito', 'efectivo']) {
      expect(prompt).toContain(cue);
    }
  });

  it('returns paymentMethodId, paymentMethodName and paymentAiSuggested=true when the model matches a registered method', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 40313,
          date: '2026-06-01',
          store: 'OPENROUTER, INC',
          paymentMethodId: visaId,
        },
      ])
    );

    const res = await extract();

    expect(res.status).toBe(200);
    expect(res.body.movements).toHaveLength(1);
    const mv = res.body.movements[0];
    expect(mv.paymentMethodId).toBe(visaId);
    expect(mv.paymentMethodName).toBe('__impm Visa Platinum DAVIbank');
    expect(mv.paymentAiSuggested).toBe(true);
    expect(mv.detectedPaymentLabel).toBeNull();
    expect(mv.detectedBrand).toBeNull();
    expect(mv.detectedVariant).toBeNull();
  });

  it('nulls out a paymentMethodId that does not match any registered method', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: 10, date: '2026-06-01', store: 'Store', paymentMethodId: 999999 },
      ])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.paymentMethodId).toBeNull();
    expect(mv.paymentMethodName).toBeNull();
    expect(mv.paymentAiSuggested).toBe(false);
  });

  it('passes through detected label/brand/variant when the card is not registered', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 20,
          date: '2026-06-01',
          store: 'Store',
          paymentMethodId: null,
          detectedPaymentLabel: 'Mastercard Black',
          detectedBrand: 'mastercard',
          detectedVariant: 'black',
        },
      ])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.paymentMethodId).toBeNull();
    expect(mv.paymentMethodName).toBeNull();
    expect(mv.paymentAiSuggested).toBe(false);
    expect(mv.detectedPaymentLabel).toBe('Mastercard Black');
    expect(mv.detectedBrand).toBe('mastercard');
    expect(mv.detectedVariant).toBe('black');
  });

  it('normalizes detectedBrand to the canonical enum values', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 1,
          date: '2026-06-01',
          paymentMethodId: null,
          detectedPaymentLabel: 'VISA Gold',
          detectedBrand: 'VISA',
        },
        {
          amount: 2,
          date: '2026-06-01',
          paymentMethodId: null,
          detectedPaymentLabel: 'American Express',
          detectedBrand: 'American Express',
        },
        {
          amount: 3,
          date: '2026-06-01',
          paymentMethodId: null,
          detectedPaymentLabel: 'Master Card Black',
          detectedBrand: 'Master Card',
        },
        {
          amount: 4,
          date: '2026-06-01',
          paymentMethodId: null,
          detectedPaymentLabel: 'Diners Club',
          detectedBrand: 'Diners Club',
        },
      ])
    );

    const res = await extract();

    const brands = res.body.movements.map(
      (m: { detectedBrand: string | null }) => m.detectedBrand
    );
    expect(brands).toEqual(['visa', 'amex', 'mastercard', 'other']);
  });

  it('clears detected fields when a valid paymentMethodId is also returned', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([
        {
          amount: 5,
          date: '2026-06-01',
          paymentMethodId: visaId,
          detectedPaymentLabel: 'Visa Platinum',
          detectedBrand: 'visa',
          detectedVariant: 'platinum',
        },
      ])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.paymentMethodId).toBe(visaId);
    expect(mv.paymentAiSuggested).toBe(true);
    expect(mv.detectedPaymentLabel).toBeNull();
    expect(mv.detectedBrand).toBeNull();
    expect(mv.detectedVariant).toBeNull();
  });

  it('returns all payment fields null when the model reports no payment signal', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 12.5, date: '2026-06-01', store: 'Test Market' }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.paymentMethodId).toBeNull();
    expect(mv.paymentMethodName).toBeNull();
    expect(mv.detectedPaymentLabel).toBeNull();
    expect(mv.detectedBrand).toBeNull();
    expect(mv.detectedVariant).toBeNull();
    expect(mv.paymentAiSuggested).toBe(false);
  });

  it('keeps the existing category suggestion fields alongside the payment fields', async () => {
    mockSuggestCategory.mockResolvedValue({
      categoryId: 1,
      categoryName: 'Food',
      color: '#FF0000',
    });
    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: 9, date: '2026-06-01', store: 'Cafe', paymentMethodId: visaId },
      ])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.categoryId).toBe(1);
    expect(mv.aiSuggested).toBe(true);
    expect(mv.paymentMethodId).toBe(visaId);
    expect(mv.paymentAiSuggested).toBe(true);
  });

  it('does not persist any movement during extraction', async () => {
    const countBefore = (
      await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')
    ).rows[0].c;

    mockCreate.mockResolvedValue(
      aiResponse([
        { amount: 40313, date: '2026-06-01', store: 'X', paymentMethodId: visaId },
      ])
    );

    await extract();

    const countAfter = (
      await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')
    ).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });
});
