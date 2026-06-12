import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import OpenAI from 'openai';
import { createApp } from '../app';
import { resetPool } from '../db';

jest.mock('openai');

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

describe('POST /api/suggest/category', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCreate: jest.Mock<any, any>;

  // Stores referenced in this suite. Pre-seeding empty store_context rows
  // marks them as already searched, so the web-enrichment pass never fires
  // and the per-test OpenAI call counts stay deterministic.
  const SUITE_STORES = [
    'SomeRandomStore',
    'McDonalds',
    'SlowStore',
    'BrokenStore',
    'SomeStore',
    'OPENROUTER, INC',
    'SlowSecondPass',
    'EmptyName',
    'LongName',
  ];

  beforeAll(async () => {
    execSync('node-pg-migrate up --migrations-dir migrations', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();

    for (const store of SUITE_STORES) {
      await pool.query(
        `INSERT INTO store_context (store, summary, fetched_at)
         VALUES (LOWER($1), '', NOW())
         ON CONFLICT (store) DO NOTHING`,
        [store]
      );
    }
  });

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM store_context WHERE store = ANY($1)`,
      [SUITE_STORES.map(s => s.toLowerCase())]
    );
    await pool.end();
  });

  it('returns 400 when both store and description are absent', async () => {
    const res = await request(app).post('/api/suggest/category').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns standard validation error shape when both fields are absent', async () => {
    const res = await request(app).post('/api/suggest/category').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
    expect(typeof res.body.details).toBe('object');
    const detailValues = Object.values(res.body.details as Record<string, string>);
    expect(detailValues.length).toBeGreaterThan(0);
    detailValues.forEach(v => expect(typeof v).toBe('string'));
  });

  it('returns 400 when body is missing entirely', async () => {
    const res = await request(app)
      .post('/api/suggest/category')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns { categoryId: null } when AI returns null', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ categoryId: null, reason: 'no match' }) } }],
    });
    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: 'SomeRandomStore' });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBeNull();
  });

  it('returns full category data when AI matches a category', async () => {
    const catResult = await pool.query<{ id: number; name: string; color: string }>(
      `SELECT id, name, color FROM categories WHERE name = 'Food' LIMIT 1`
    );
    const cat = catResult.rows[0];

    mockCreate.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ categoryId: cat.id, reason: 'restaurant' }) } },
      ],
    });

    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: 'McDonalds', description: 'hamburger' });

    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBe(cat.id);
    expect(res.body.categoryName).toBe(cat.name);
    expect(res.body.color).toBe(cat.color);
  });

  it('returns { categoryId: null } on timeout', async () => {
    mockCreate.mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 10_000))
    );
    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: 'SlowStore' });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBeNull();
  }, 5000);

  it('returns { categoryId: null } on unparseable JSON from AI', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'this is not json' } }],
    });
    const res = await request(app)
      .post('/api/suggest/category')
      .send({ description: 'some expense' });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBeNull();
  });

  it('returns { categoryId: null } when AI call throws', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));
    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: 'BrokenStore' });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBeNull();
  });

  it('works with only description provided', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ categoryId: null, reason: 'unclear' }) } }],
    });
    const res = await request(app)
      .post('/api/suggest/category')
      .send({ description: 'bought some medicine' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('categoryId');
  });

  it('uses deterministic keywords for clear parking expenses', async () => {
    const transport = await pool.query<{ id: number; color: string }>(
      `SELECT id, color FROM categories WHERE name = 'Transport' LIMIT 1`
    );

    const res = await request(app)
      .post('/api/suggest/category')
      .send({
        store: 'Titan Plaza Parking',
        description: 'Titan Plaza Bicycle Parking',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      categoryId: transport.rows[0].id,
      categoryName: 'Transport',
      color: transport.rows[0].color,
      suggestedNewCategory: null,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns { categoryId: null } when AI returns an unknown categoryId', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ categoryId: 999999, reason: 'phantom' }) } },
      ],
    });
    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: 'SomeStore' });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBeNull();
  });

  describe('second pass — suggestedNewCategory', () => {
    it('makes a second pass and returns suggestedNewCategory when the first pass yields null', async () => {
      mockCreate
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ categoryId: null, reason: 'no match' }) } }],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ newCategoryName: 'Software' }) } }],
        });

      const res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'OPENROUTER, INC', description: 'API credits' });

      expect(res.status).toBe(200);
      expect(res.body.categoryId).toBeNull();
      expect(res.body.suggestedNewCategory).toBe('Software');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('does not make a second pass when the first pass matches a category', async () => {
      const catResult = await pool.query<{ id: number }>(
        `SELECT id FROM categories WHERE name = 'Food' LIMIT 1`
      );
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: JSON.stringify({ categoryId: catResult.rows[0].id }) } },
        ],
      });

      const res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'McDonalds' });

      expect(res.status).toBe(200);
      expect(res.body.categoryId).toBe(catResult.rows[0].id);
      expect(res.body.suggestedNewCategory).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('returns suggestedNewCategory null when the second pass throws', async () => {
      mockCreate
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
        })
        .mockRejectedValueOnce(new Error('network error'));

      const res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'BrokenStore' });

      expect(res.status).toBe(200);
      expect(res.body.categoryId).toBeNull();
      expect(res.body.suggestedNewCategory).toBeNull();
    });

    it('returns suggestedNewCategory null when the second pass times out', async () => {
      mockCreate
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
        })
        .mockImplementationOnce(
          () => new Promise(resolve => setTimeout(resolve, 10_000))
        );

      const res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'SlowSecondPass' });

      expect(res.status).toBe(200);
      expect(res.body.suggestedNewCategory).toBeNull();
    }, 5000);

    it('does not make a second pass when the first pass errors out', async () => {
      mockCreate.mockRejectedValue(new Error('network error'));

      const res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'BrokenStore' });

      expect(res.status).toBe(200);
      expect(res.body.categoryId).toBeNull();
      expect(res.body.suggestedNewCategory).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid second-pass names (empty or over 40 chars)', async () => {
      mockCreate
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ newCategoryName: '   ' }) } }],
        });

      let res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'EmptyName' });
      expect(res.body.suggestedNewCategory).toBeNull();

      mockCreate
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ newCategoryName: 'x'.repeat(41) }) } }],
        });

      res = await request(app)
        .post('/api/suggest/category')
        .send({ store: 'LongName' });
      expect(res.body.suggestedNewCategory).toBeNull();
    });
  });
});
