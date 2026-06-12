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
    if (pool) {
      await pool.query(`DELETE FROM movements WHERE description LIKE '__imp_%'`);
      await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__imp_%'`);
      await pool.end();
    }
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

  it('200: normalizes extracted times and drops malformed times without rejecting movements', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              movements: [
                { amount: 10, date: '2024-06-01', store: 'A', time: '14:32' },
                { amount: 11, date: '2024-06-01', store: 'B', time: '2:32 PM' },
                { amount: 12, date: '2024-06-01', store: 'C', time: '02:32 p. m.' },
                { amount: 13, date: '2024-06-01', store: 'D', time: null },
                { amount: 14, date: '2024-06-01', store: 'E', time: '99:99' },
              ],
            }),
          },
        },
      ],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_times.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements.map((m: { time: string | null }) => m.time)).toEqual([
      '14:32',
      '14:32',
      '14:32',
      null,
      null,
    ]);
  });

  it('200: flags possible duplicates against existing movements and suppresses them when times differ', async () => {
    await pool.query(
      `INSERT INTO movements (amount, date, time, description, store)
       VALUES
        (25, '2024-06-01', '14:32', '__imp_existing_same_time__', 'ACME Store'),
        (30, '2024-06-01', '09:00', '__imp_existing_different_time__', 'Coffee Bar')`
    );
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              movements: [
                { amount: 25, date: '2024-06-01', store: 'acme store', time: '14:32' },
                { amount: 30, date: '2024-06-01', store: 'Coffee Bar', time: '10:00' },
              ],
            }),
          },
        },
      ],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_existing_duplicates.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements[0]).toMatchObject({
      possibleDuplicate: true,
      duplicateOf: {
        date: '2024-06-01',
        time: '14:32',
        description: '__imp_existing_same_time__',
      },
    });
    expect(res.body.movements[0].duplicateOf.id).toEqual(expect.any(Number));
    expect(res.body.movements[1].possibleDuplicate).toBe(false);
    expect(res.body.movements[1].duplicateOf).toBeNull();
  });

  it('200: flags later duplicates within the same extraction batch', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              movements: [
                { amount: 18, date: '2024-06-01', store: 'Batch Store', time: '08:00' },
                { amount: 18, date: '2024-06-01', store: 'batch store', time: '08:00' },
              ],
            }),
          },
        },
      ],
    });

    const res = await request(app)
      .post('/api/import/extract')
      .attach('file', Buffer.from('fake-jpeg'), {
        filename: '__imp_batch_duplicates.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.movements[0].possibleDuplicate).toBe(false);
    expect(res.body.movements[1]).toMatchObject({
      possibleDuplicate: true,
      duplicateOf: {
        id: null,
        date: '2024-06-01',
        time: '08:00',
        description: null,
      },
    });
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
    await pool.query(`DELETE FROM gmail_imported_messages WHERE gmail_message_id LIKE '__conf_%'`);
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

  it('201: writes gmail imported-message log rows in the same transaction', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 32.10,
            date: '2024-06-03',
            description: '__conf_gmail_logged',
            gmail_message_id: '__conf_gmail_logged_msg',
          },
        ],
      });

    expect(res.status).toBe(201);
    const createdId = res.body.created[0].id;

    const rows = await pool.query<{ gmail_message_id: string; movement_id: number }>(
      `SELECT gmail_message_id, movement_id
       FROM gmail_imported_messages
       WHERE gmail_message_id = $1`,
      ['__conf_gmail_logged_msg']
    );
    expect(rows.rows).toEqual([
      { gmail_message_id: '__conf_gmail_logged_msg', movement_id: createdId },
    ]);
  });

  it('400: rolls back gmail imported-message log rows when another item is invalid', async () => {
    const before = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM gmail_imported_messages
       WHERE gmail_message_id = $1`,
      ['__conf_gmail_rollback_msg']
    );

    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 11,
            date: '2024-06-03',
            description: '__conf_gmail_rollback_good',
            gmail_message_id: '__conf_gmail_rollback_msg',
          },
          {
            amount: 12,
            date: '2024-06-03',
            description: '__conf_gmail_rollback_bad',
            category_id: 999999,
          },
        ],
      });

    expect(res.status).toBe(400);

    const after = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM gmail_imported_messages
       WHERE gmail_message_id = $1`,
      ['__conf_gmail_rollback_msg']
    );
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it('409: rejects re-confirming a previously imported gmail message id without persisting', async () => {
    const first = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 20,
            date: '2024-06-04',
            description: '__conf_gmail_original',
            gmail_message_id: '__conf_gmail_dupe_msg',
          },
        ],
      });
    expect(first.status).toBe(201);

    const countBefore = (await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM movements WHERE description = $1`,
      ['__conf_gmail_duplicate_attempt']
    )).rows[0].c;

    const duplicate = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 20,
            date: '2024-06-04',
            description: '__conf_gmail_duplicate_attempt',
            gmail_message_id: '__conf_gmail_dupe_msg',
          },
        ],
      });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: 'One or more Gmail messages were already imported',
      details: { alreadyImported: ['__conf_gmail_dupe_msg'] },
    });

    const countAfter = (await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM movements WHERE description = $1`,
      ['__conf_gmail_duplicate_attempt']
    )).rows[0].c;
    expect(countAfter).toBe(countBefore);
  });

  it('201: allows multiple movements from the same gmail message in one confirm batch', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 4,
            date: '2024-06-05',
            description: '__conf_gmail_multi_a',
            gmail_message_id: '__conf_gmail_multi_msg',
          },
          {
            amount: 5,
            date: '2024-06-05',
            description: '__conf_gmail_multi_b',
            gmail_message_id: '__conf_gmail_multi_msg',
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);

    const rows = await pool.query<{ movement_id: number }>(
      `SELECT movement_id
       FROM gmail_imported_messages
       WHERE gmail_message_id = $1
       ORDER BY movement_id`,
      ['__conf_gmail_multi_msg']
    );
    expect(rows.rows.map((row) => row.movement_id)).toEqual(
      res.body.created.map((movement: { id: number }) => movement.id).sort((a: number, b: number) => a - b)
    );
  });

  it('keeps the imported mark when the movement is deleted', async () => {
    const res = await request(app)
      .post('/api/import/confirm')
      .send({
        movements: [
          {
            amount: 8,
            date: '2024-06-06',
            description: '__conf_gmail_delete_preserve',
            gmail_message_id: '__conf_gmail_delete_msg',
          },
        ],
      });
    expect(res.status).toBe(201);

    await pool.query('DELETE FROM movements WHERE id = $1', [res.body.created[0].id]);

    const rows = await pool.query<{ movement_id: number | null }>(
      `SELECT movement_id
       FROM gmail_imported_messages
       WHERE gmail_message_id = $1`,
      ['__conf_gmail_delete_msg']
    );
    expect(rows.rows).toEqual([{ movement_id: null }]);
  });
});
