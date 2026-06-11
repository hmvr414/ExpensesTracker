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

describe('POST /api/suggest/category — store history and web context', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let mockCreate: jest.Mock;

  function promptOfCall(index: number): string {
    const args = mockCreate.mock.calls[index][0] as {
      messages: Array<{ content: string }>;
    };
    return args.messages[0].content;
  }

  function categoryPrompts(): string[] {
    return mockCreate.mock.calls
      .filter(call => !(call[0] as { model: string }).model.endsWith(':online'))
      .map(call => (call[0] as { messages: Array<{ content: string }> }).messages[0].content);
  }

  function onlineCalls(): unknown[] {
    return mockCreate.mock.calls.filter(call =>
      (call[0] as { model: string }).model.endsWith(':online')
    );
  }

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
    await pool.query(`DELETE FROM store_context WHERE store LIKE '%sgctx%'`);
    await pool.query(`DELETE FROM movements WHERE store LIKE '%sgctx%'`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM store_context WHERE store LIKE '%sgctx%'`);
    await pool.query(`DELETE FROM movements WHERE store LIKE '%sgctx%'`);
    await pool.end();
  });

  async function seedHistoryAndContext(): Promise<void> {
    const descriptions = ['Weekly groceries', 'Cleaning supplies', 'Fruit and vegetables'];
    for (let i = 0; i < descriptions.length; i++) {
      await pool.query(
        `INSERT INTO movements (amount, date, description, store, created_at, updated_at)
         VALUES (10, '2026-01-01', $1, '__sgctx_Exito', NOW() - ($2 || ' minutes')::interval, NOW())`,
        [descriptions[i], String(10 - i)]
      );
    }
    await pool.query(
      `INSERT INTO store_context (store, summary, fetched_at)
       VALUES ('__sgctx_exito', 'Colombian supermarket chain.', NOW())`
    );
  }

  it('includes prior descriptions and the cached store context in the category prompt', async () => {
    await seedHistoryAndContext();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
    });

    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: '__sgctx_Exito', description: 'milk and eggs' });

    expect(res.status).toBe(200);
    const prompt = categoryPrompts()[0];
    expect(prompt).toMatch(/previously wrote/i);
    expect(prompt).toContain('Weekly groceries');
    expect(prompt).toContain('Cleaning supplies');
    expect(prompt).toContain('Fruit and vegetables');
    expect(prompt).toContain('Colombian supermarket chain.');
    // Cached context means no web search is needed
    expect(onlineCalls()).toHaveLength(0);
  });

  it('passes the same context to the second pass that proposes a new category name', async () => {
    await seedHistoryAndContext();
    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ newCategoryName: 'Groceries' }) } }],
      });

    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: '__sgctx_Exito' });

    expect(res.status).toBe(200);
    expect(res.body.suggestedNewCategory).toBe('Groceries');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const secondPassPrompt = promptOfCall(1);
    expect(secondPassPrompt).toContain('Colombian supermarket chain.');
    expect(secondPassPrompt).toContain('Weekly groceries');
  });

  it('searches the web for an unknown store, injects the summary, and caches it', async () => {
    mockCreate.mockImplementation((args: { model: string }) => {
      if (args.model.endsWith(':online')) {
        return Promise.resolve({
          choices: [{ message: { content: 'Sells handmade candles.' } }],
        });
      }
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ categoryId: null, newCategoryName: 'Candles' }) } }],
      });
    });

    const res = await request(app)
      .post('/api/suggest/category')
      .send({ store: '__sgctx_Novel' });

    expect(res.status).toBe(200);
    expect(onlineCalls()).toHaveLength(1);
    expect(categoryPrompts()[0]).toContain('Sells handmade candles.');

    const row = await pool.query<{ summary: string }>(
      `SELECT summary FROM store_context WHERE store = '__sgctx_novel'`
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].summary).toBe('Sells handmade candles.');

    // A second suggestion for the same store must NOT search again
    await request(app).post('/api/suggest/category').send({ store: '__sgctx_Novel' });
    expect(onlineCalls()).toHaveLength(1);
  });

  it('works without a store: no history, no web search', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ categoryId: null }) } }],
    });

    const res = await request(app)
      .post('/api/suggest/category')
      .send({ description: 'some expense' });

    expect(res.status).toBe(200);
    expect(onlineCalls()).toHaveLength(0);
    expect(categoryPrompts()[0]).not.toMatch(/previously wrote/i);
  });
});
