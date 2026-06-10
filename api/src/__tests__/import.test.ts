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

describe('POST /api/import/extract', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let mockCreate: jest.Mock;
  let mockRunTesseract: jest.MockedFunction<typeof runTesseract>;
  let mockSuggestCategory: jest.MockedFunction<typeof suggestCategory>;
  let uploadDir: string;

  beforeAll(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'));
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
    mockRunTesseract.mockResolvedValue('Total: $12.50\nDate: 2024-06-01\nStore: Test Market');

    mockSuggestCategory = suggestCategory as jest.MockedFunction<typeof suggestCategory>;
    mockSuggestCategory.mockResolvedValue({ categoryId: null });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__imp_%'`);
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('400: returns 400 when no file is provided', async () => {
    const res = await request(app)
      .post('/api/import/extract')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('400: rejects unsupported MIME type', async () => {
    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('some text'), {
        filename: '__imp_file.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported/i);
  });

  it('500: returns 500 when tesseract is not installed', async () => {
    const notFoundErr = Object.assign(new Error('tesseract is not installed or not in PATH'), {
      code: 'TESSERACT_NOT_FOUND',
    });
    mockRunTesseract.mockRejectedValue(notFoundErr);

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_receipt.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/tesseract/i);
  });

  it('200: creates attachment row with movement_id = null and returns attachmentId', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ movements: [] }) } }],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_receipt.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.attachmentId).toBe('number');

    const row = await pool.query<{ movement_id: number | null }>(
      `SELECT movement_id FROM attachments WHERE id = $1`,
      [res.body.attachmentId]
    );
    expect(row.rows[0].movement_id).toBeNull();
  });

  it('200: returns rawText from OCR in the response', async () => {
    mockRunTesseract.mockResolvedValue('Supermarket receipt total $25.00');
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ movements: [] }) } }],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_receipt2.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.rawText).toBe('Supermarket receipt total $25.00');
  });

  it('200: returns movements with aiSuggested=true when category is matched', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              movements: [
                { amount: 12.5, date: '2024-06-01', description: 'Lunch', store: 'McDonalds' },
              ],
            }),
          },
        },
      ],
    });
    mockSuggestCategory.mockResolvedValue({
      categoryId: 1,
      categoryName: 'Food',
      color: '#FF0000',
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_receipt3.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements).toHaveLength(1);
    const mv = res.body.movements[0];
    expect(mv.amount).toBe(12.5);
    expect(mv.date).toBe('2024-06-01');
    expect(mv.store).toBe('McDonalds');
    expect(mv.categoryId).toBe(1);
    expect(mv.categoryName).toBe('Food');
    expect(mv.color).toBe('#FF0000');
    expect(mv.aiSuggested).toBe(true);
  });

  it('200: sets aiSuggested=false when no category matches', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              movements: [{ amount: 5.0, date: '2024-06-01', store: 'Unknown Store' }],
            }),
          },
        },
      ],
    });
    mockSuggestCategory.mockResolvedValue({ categoryId: null });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_receipt4.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements[0].aiSuggested).toBe(false);
    expect(res.body.movements[0].categoryId).toBeNull();
  });

  it('200: calls suggestCategory for each movement in parallel', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              movements: [
                { amount: 10, date: '2024-06-01', store: 'A' },
                { amount: 20, date: '2024-06-02', store: 'B' },
                { amount: 30, date: '2024-06-03', store: 'C' },
              ],
            }),
          },
        },
      ],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_multi.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements).toHaveLength(3);
    expect(mockSuggestCategory).toHaveBeenCalledTimes(3);
    expect(mockSuggestCategory).toHaveBeenCalledWith('A', undefined);
    expect(mockSuggestCategory).toHaveBeenCalledWith('B', undefined);
    expect(mockSuggestCategory).toHaveBeenCalledWith('C', undefined);
  });

  it('200: returns movements=[] and error when AI call fails', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_aifail.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements).toEqual([]);
    expect(res.body.error).toBe('AI extraction failed');
    expect(typeof res.body.attachmentId).toBe('number');
  });

  it('200: returns movements=[] and error when AI returns unparseable JSON', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'not valid json at all' } }],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_badjson.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements).toEqual([]);
    expect(res.body.error).toBe('AI extraction failed');
  });

  it('200: falls through with empty rawText when OCR fails (non-ENOENT error)', async () => {
    mockRunTesseract.mockRejectedValue(new Error('tesseract segfault'));
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ movements: [] }) } }],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_ocrfail.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.rawText).toBe('');
    expect(res.body.movements).toEqual([]);
    expect(res.body.error).toBeUndefined();
  });
});

describe('POST /api/import/confirm', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let categoryId: number;
  let attachmentId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();

    const catResult = await pool.query<{ id: number }>('SELECT id FROM categories LIMIT 1');
    categoryId = catResult.rows[0].id;

    const attResult = await pool.query<{ id: number }>(
      `INSERT INTO attachments (movement_id, file_name, file_path, mime_type)
       VALUES (NULL, '__conf_test.jpg', '/tmp/__conf_test.jpg', 'image/jpeg')
       RETURNING id`
    );
    attachmentId = attResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM movements WHERE description LIKE '__conf_%'`);
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__conf_%'`);
    await pool.end();
  });

  it('400: returns 400 when movements field is missing', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('400: returns 400 when movements is not an array', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({ movements: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('400: returns per-item error for negative amount without persisting', async () => {
    const countBefore = (await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')).rows[0].c;

    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [{ amount: -5, date: '2024-01-01', description: '__conf_bad_amount' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();

    const countAfter = (await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });

  it('400: returns per-item error for invalid date format', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [{ amount: 10, date: 'not-a-date', description: '__conf_bad_date' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
  });

  it('400: returns per-item error for non-existent category_id without persisting', async () => {
    const countBefore = (await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')).rows[0].c;

    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [{ amount: 10, date: '2024-01-01', description: '__conf_bad_cat', category_id: 999999 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();

    const countAfter = (await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });

  it('400: does not persist any movement when one item in array is invalid', async () => {
    const countBefore = (await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')).rows[0].c;

    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          { amount: 10, date: '2024-01-01', description: '__conf_good' },
          { amount: -5, date: '2024-01-01', description: '__conf_bad' },
        ],
      });

    expect(res.status).toBe(400);

    const countAfter = (await pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM movements')).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });

  it('201: creates movements and returns { created, count }', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          { amount: 25.50, date: '2024-06-01', description: '__conf_lunch', store: 'Café Central' },
          { amount: 10.00, date: '2024-06-02', description: '__conf_bus' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.created[0].id).toBeDefined();
    expect(parseFloat(res.body.created[0].amount)).toBe(25.50);
    expect(res.body.created[0].date).toMatch(/^2024-06-01/);
    expect(res.body.created[0].description).toBe('__conf_lunch');
  });

  it('201: links attachment to first created movement when attachmentId is valid', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        attachmentId,
        movements: [
          { amount: 15.00, date: '2024-06-01', description: '__conf_attached' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);

    const row = await pool.query<{ movement_id: number }>(
      'SELECT movement_id FROM attachments WHERE id = $1',
      [attachmentId]
    );
    expect(row.rows[0].movement_id).toBe(res.body.created[0].id);
  });

  it('201: skips attachment link when attachmentId is not provided', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [{ amount: 5.00, date: '2024-06-01', description: '__conf_noatt' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
  });

  it('201: skips attachment link and still creates movements when attachmentId is not found', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        attachmentId: 999999,
        movements: [{ amount: 7.00, date: '2024-06-01', description: '__conf_badatt' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    expect(res.body.created[0].id).toBeDefined();
  });

  it('201: correctly stores optional fields (category_id, store)', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 50.00,
            date: '2024-06-01',
            description: '__conf_full',
            store: 'Supermarket',
            category_id: categoryId,
          },
        ],
      });

    expect(res.status).toBe(201);
    const created = res.body.created[0];
    expect(created.id).toBeDefined();

    const row = await pool.query<{ category_id: number; store: string }>(
      'SELECT category_id, store FROM movements WHERE id = $1',
      [created.id]
    );
    expect(row.rows[0].category_id).toBe(categoryId);
    expect(row.rows[0].store).toBe('Supermarket');
  });
});
