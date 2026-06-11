import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import OpenAI from 'openai';
import { createApp } from '../app';
import { resetPool } from '../db';
import { PRESET_COLORS } from '../helpers/categoryResolver';
import { runTesseract } from '../helpers/ocr';

jest.mock('openai');
jest.mock('../helpers/ocr');

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

describe('new_category_name find-or-create', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCreate: jest.Mock<any, any>;
  let mockRunTesseract: jest.MockedFunction<typeof runTesseract>;
  let uploadDir: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM movements WHERE store LIKE '__nc%' OR description LIKE '__nc%'`
    );
    await pool.query(`DELETE FROM categories WHERE name ILIKE '__nc%'`);
  }

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-cat-test-'));
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
    await cleanup();
  });

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );
    mockRunTesseract = runTesseract as jest.MockedFunction<typeof runTesseract>;
    mockRunTesseract.mockResolvedValue('receipt text');
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  describe('POST /api/movements', () => {
    it('creates a new category with a palette color and returns it with created: true', async () => {
      const usedBefore = new Set(
        (
          await pool.query<{ color: string }>(
            `SELECT color FROM categories WHERE color IS NOT NULL`
          )
        ).rows.map(r => r.color.toLowerCase())
      );

      const res = await request(app).post('/api/movements').send({
        amount: 12.5,
        store: '__nc OpenRouter',
        new_category_name: '__nc Software',
      });

      expect(res.status).toBe(201);
      expect(res.body.category).toBeDefined();
      expect(res.body.category.name).toBe('__nc Software');
      expect(res.body.category.created).toBe(true);
      expect(res.body.category_id).toBe(res.body.category.id);
      expect(PRESET_COLORS).toContain(res.body.category.color);
      if (usedBefore.size < PRESET_COLORS.length) {
        expect(usedBefore.has(res.body.category.color.toLowerCase())).toBe(false);
      }

      const dbCat = await pool.query(
        `SELECT id, name, color FROM categories WHERE id = $1`,
        [res.body.category.id]
      );
      expect(dbCat.rows[0].name).toBe('__nc Software');
    });

    it('reuses an existing category case-insensitively with created: false', async () => {
      const existing = await pool.query<{ id: number }>(
        `INSERT INTO categories (name, color) VALUES ('__nc Travel', '#123456') RETURNING id`
      );

      const res = await request(app).post('/api/movements').send({
        amount: 99,
        store: '__nc Airline',
        new_category_name: '__NC TRAVEL',
      });

      expect(res.status).toBe(201);
      expect(res.body.category.id).toBe(existing.rows[0].id);
      expect(res.body.category.name).toBe('__nc Travel');
      expect(res.body.category.color).toBe('#123456');
      expect(res.body.category.created).toBe(false);
      expect(res.body.category_id).toBe(existing.rows[0].id);
    });

    it('rejects with 400 when both category_id and new_category_name are provided', async () => {
      const cat = await pool.query<{ id: number }>(
        `SELECT id FROM categories ORDER BY id LIMIT 1`
      );
      const res = await request(app).post('/api/movements').send({
        amount: 10,
        store: '__nc Both',
        category_id: cat.rows[0].id,
        new_category_name: '__nc Whatever',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details.new_category_name).toBeDefined();
    });

    it('rejects new_category_name that is empty or longer than 40 chars', async () => {
      let res = await request(app).post('/api/movements').send({
        amount: 10,
        store: '__nc Empty',
        new_category_name: '   ',
      });
      expect(res.status).toBe(400);

      res = await request(app).post('/api/movements').send({
        amount: 10,
        store: '__nc Long',
        new_category_name: 'x'.repeat(41),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/movements/:id', () => {
    it('resolves new_category_name and updates the movement', async () => {
      const mv = await request(app).post('/api/movements').send({
        amount: 20,
        store: '__nc PutStore',
      });
      expect(mv.status).toBe(201);

      const res = await request(app).put(`/api/movements/${mv.body.id}`).send({
        new_category_name: '__nc Gadgets',
      });

      expect(res.status).toBe(200);
      expect(res.body.category).toBeDefined();
      expect(res.body.category.name).toBe('__nc Gadgets');
      expect(res.body.category.created).toBe(true);
      expect(res.body.category_id).toBe(res.body.category.id);

      const dbMv = await pool.query<{ category_id: number }>(
        `SELECT category_id FROM movements WHERE id = $1`,
        [mv.body.id]
      );
      expect(dbMv.rows[0].category_id).toBe(res.body.category.id);
    });

    it('rejects with 400 when both category_id and new_category_name are provided', async () => {
      const mv = await request(app).post('/api/movements').send({
        amount: 20,
        store: '__nc PutBoth',
      });
      const cat = await pool.query<{ id: number }>(
        `SELECT id FROM categories ORDER BY id LIMIT 1`
      );

      const res = await request(app).put(`/api/movements/${mv.body.id}`).send({
        category_id: cat.rows[0].id,
        new_category_name: '__nc Conflict',
      });

      expect(res.status).toBe(400);
      expect(res.body.details.new_category_name).toBeDefined();
    });
  });

  describe('POST /api/import/confirm', () => {
    it('creates each distinct new category once and links all rows in one transaction', async () => {
      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            {
              amount: 5,
              date: '2026-06-01',
              store: '__nc ConfirmA',
              new_category_name: '__nc Streaming',
            },
            {
              amount: 7,
              date: '2026-06-02',
              store: '__nc ConfirmB',
              new_category_name: '__NC STREAMING',
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.count).toBe(2);
      expect(res.body.resolvedCategories).toHaveLength(1);
      const resolved = res.body.resolvedCategories[0];
      expect(resolved.name).toBe('__nc Streaming');
      expect(resolved.created).toBe(true);
      expect(res.body.created[0].category_id).toBe(resolved.id);
      expect(res.body.created[1].category_id).toBe(resolved.id);

      const cats = await pool.query(
        `SELECT id FROM categories WHERE LOWER(name) = LOWER('__nc Streaming')`
      );
      expect(cats.rows).toHaveLength(1);
    });

    it('accepts a mix of category_id and new_category_name items', async () => {
      const cat = await pool.query<{ id: number }>(
        `INSERT INTO categories (name, color) VALUES ('__nc Mixed', '#654321') RETURNING id`
      );

      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            { amount: 5, date: '2026-06-01', store: '__nc MixA', category_id: cat.rows[0].id },
            { amount: 7, date: '2026-06-02', store: '__nc MixB', new_category_name: '__nc Pets' },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.created[0].category_id).toBe(cat.rows[0].id);
      expect(res.body.resolvedCategories).toHaveLength(1);
      expect(res.body.resolvedCategories[0].name).toBe('__nc Pets');
    });

    it('rejects with 400 when an item carries both category_id and new_category_name', async () => {
      const cat = await pool.query<{ id: number }>(
        `SELECT id FROM categories ORDER BY id LIMIT 1`
      );
      const res = await request(app)
        .post('/api/import/confirm')
        .send({
          movements: [
            {
              amount: 5,
              date: '2026-06-01',
              store: '__nc BothConfirm',
              category_id: cat.rows[0].id,
              new_category_name: '__nc Nope',
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details['movements.0.new_category_name']).toBeDefined();
    });
  });

  describe('POST /api/import/extract — second-pass dedupe', () => {
    it('includes suggestedNewCategory per movement and dedupes identical (store, description) rows', async () => {
      const extractedMovements = [
        { amount: 10, date: '2026-06-10', store: '__nc DupeStore', description: 'same thing' },
        { amount: 11, date: '2026-06-10', store: '__nc DupeStore', description: 'same thing' },
        { amount: 12, date: '2026-06-10', store: '__nc OtherStore', description: 'different' },
      ];

      mockCreate.mockImplementation(
        async (args: { messages: Array<{ content: string }> }) => {
          const prompt = args.messages[0].content;
          if (prompt.includes('Extract expense movements')) {
            return {
              choices: [
                { message: { content: JSON.stringify({ movements: extractedMovements }) } },
              ],
            };
          }
          if (prompt.includes('newCategoryName')) {
            return {
              choices: [
                { message: { content: JSON.stringify({ newCategoryName: 'Software' }) } },
              ],
            };
          }
          return {
            choices: [
              { message: { content: JSON.stringify({ categoryId: null }) } },
            ],
          };
        }
      );

      const res = await request(app)
        .post('/api/import/extract')
        .attach('file', Buffer.from('fake-jpeg'), {
          filename: '__nc_receipt.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      expect(res.body.movements).toHaveLength(3);
      for (const m of res.body.movements) {
        expect(m.categoryId).toBeNull();
        expect(m.suggestedNewCategory).toBe('Software');
      }

      // 1 extraction call + 2 unique first-pass calls + 2 second-pass calls.
      // Without dedupe this would be 7.
      expect(mockCreate).toHaveBeenCalledTimes(5);
    });
  });
});
