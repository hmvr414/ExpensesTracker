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

describe('POST /api/import/extract — locale-aware amount parsing', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let mockCreate: jest.Mock;
  let mockRunTesseract: jest.MockedFunction<typeof runTesseract>;
  let mockSuggestCategory: jest.MockedFunction<typeof suggestCategory>;
  let uploadDir: string;

  function aiResponse(
    movements: unknown[],
    language?: string
  ): { choices: Array<{ message: { content: string } }> } {
    const body: Record<string, unknown> = { movements };
    if (language !== undefined) body.language = language;
    return {
      choices: [{ message: { content: JSON.stringify(body) } }],
    };
  }

  async function extract(): Promise<request.Response> {
    return request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__impa_receipt.jpg',
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
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-amount-test-'));
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
    mockRunTesseract.mockResolvedValue(
      'DAVIbank: compra por $40.313 en OPENROUTER, INC con tarjeta Visa'
    );

    mockSuggestCategory = suggestCategory as jest.MockedFunction<typeof suggestCategory>;
    mockSuggestCategory.mockResolvedValue({ categoryId: null });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__impa_%'`);
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('instructs the model to return rawAmountText per movement and a top-level language field', async () => {
    mockCreate.mockResolvedValue(aiResponse([]));

    const res = await extract();

    expect(res.status).toBe(200);
    const prompt = sentPrompt();
    expect(prompt).toContain('rawAmountText');
    expect(prompt).toContain('language');
    // Separator disambiguation cues
    expect(prompt).toMatch(/thousands/i);
    expect(prompt).toContain('COP');
  });

  it('returns the model language as a top-level field in the response', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 10, date: '2026-06-01', rawAmountText: '10' }], 'es')
    );

    const res = await extract();

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('es');
  });

  it('returns language null when the model omits it', async () => {
    mockCreate.mockResolvedValue(aiResponse([]));

    const res = await extract();

    expect(res.body.language).toBeNull();
  });

  it('sets amountSuspect false when the parser agrees with the model amount', async () => {
    mockCreate.mockResolvedValue(
      aiResponse(
        [{ amount: 40313, date: '2026-06-01', store: 'X', rawAmountText: '40,313' }],
        'es'
      )
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(40313);
    expect(mv.amountSuspect).toBe(false);
    expect(mv.rawAmountText).toBe('40,313');
  });

  it('prefers the deterministic parse and flags amountSuspect when model and parser disagree', async () => {
    // Model misread '40,313' as forty point three one three
    mockCreate.mockResolvedValue(
      aiResponse(
        [{ amount: 40.313, date: '2026-06-01', store: 'X', rawAmountText: '40,313' }],
        'es'
      )
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(40313);
    expect(mv.amountSuspect).toBe(true);
    expect(mv.rawAmountText).toBe('40,313');
  });

  it('strips currency decoration in rawAmountText before comparing', async () => {
    mockCreate.mockResolvedValue(
      aiResponse(
        [{ amount: 40.313, date: '2026-06-01', rawAmountText: '$ 40.313 COP' }],
        'es'
      )
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(40313);
    expect(mv.amountSuspect).toBe(true);
  });

  it('keeps the model amount with amountSuspect false when rawAmountText is missing', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 12.5, date: '2026-06-01', store: 'Cafe' }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(12.5);
    expect(mv.amountSuspect).toBe(false);
    expect(mv.rawAmountText).toBeNull();
  });

  it('keeps the model amount with amountSuspect false when rawAmountText is unparseable', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 12.5, date: '2026-06-01', rawAmountText: 'total' }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(12.5);
    expect(mv.amountSuspect).toBe(false);
  });

  it('tolerates sub-cent rounding differences between model and parser', async () => {
    mockCreate.mockResolvedValue(
      aiResponse([{ amount: 1234.56, date: '2026-06-01', rawAmountText: '1.234,56' }])
    );

    const res = await extract();

    const mv = res.body.movements[0];
    expect(mv.amount).toBe(1234.56);
    expect(mv.amountSuspect).toBe(false);
  });
});
