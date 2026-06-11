import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import OpenAI from 'openai';
import { resetPool } from '../db';
import { getStoreContext, getRecentStoreDescriptions } from '../helpers/storeContext';

jest.mock('openai');

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

describe('store context helper', () => {
  let pool: Pool;
  let mockCreate: jest.Mock;

  beforeAll(() => {
    execSync('node-pg-migrate up --migrations-dir migrations', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
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
    await pool.query(`DELETE FROM store_context WHERE store LIKE '%sctx%'`);
    await pool.query(`DELETE FROM movements WHERE store LIKE '%sctx%'`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM store_context WHERE store LIKE '%sctx%'`);
    await pool.query(`DELETE FROM movements WHERE store LIKE '%sctx%'`);
    await pool.end();
  });

  describe('getStoreContext', () => {
    it('searches the web once for an unknown store and caches the summary', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'Sells AI model APIs.' } }],
      });

      const summary = await getStoreContext('__sctx_NewStore');

      expect(summary).toBe('Sells AI model APIs.');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const args = mockCreate.mock.calls[0][0] as { model: string };
      expect(args.model).toMatch(/:online$/);

      const row = await pool.query<{ store: string; summary: string }>(
        `SELECT store, summary FROM store_context WHERE store = '__sctx_newstore'`
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].summary).toBe('Sells AI model APIs.');
    });

    it('returns the cached summary without a second web call', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'Sells candles.' } }],
      });
      await getStoreContext('__sctx_Candles');
      expect(mockCreate).toHaveBeenCalledTimes(1);

      const again = await getStoreContext('__sctx_Candles');
      expect(again).toBe('Sells candles.');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('normalizes the store key to lowercase so casing variants share a cache entry', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'A bakery.' } }],
      });
      await getStoreContext('__sctx_Bakery');
      const again = await getStoreContext('__SCTX_BAKERY');
      expect(again).toBe('A bakery.');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not search stores that already have movements', async () => {
      await pool.query(
        `INSERT INTO movements (amount, date, store, created_at, updated_at)
         VALUES (10, '2026-01-01', '__sctx_Known', NOW(), NOW())`
      );

      const summary = await getStoreContext('__sctx_Known');

      expect(summary).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
      const row = await pool.query(
        `SELECT 1 FROM store_context WHERE store = '__sctx_known'`
      );
      expect(row.rows).toHaveLength(0);
    });

    it('skips silently on failure and never searches that store again', async () => {
      mockCreate.mockRejectedValue(new Error('network down'));

      const summary = await getStoreContext('__sctx_Broken');
      expect(summary).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);

      const row = await pool.query<{ summary: string }>(
        `SELECT summary FROM store_context WHERE store = '__sctx_broken'`
      );
      expect(row.rows).toHaveLength(1);

      const again = await getStoreContext('__sctx_Broken');
      expect(again).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('treats an "unknown" reply as no summary but still marks the store searched', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'unknown' } }],
      });

      const summary = await getStoreContext('__sctx_Mystery');
      expect(summary).toBeNull();

      const again = await getStoreContext('__sctx_Mystery');
      expect(again).toBeNull();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent lookups for the same store into one web call', async () => {
      mockCreate.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () => resolve({ choices: [{ message: { content: 'A gym.' } }] }),
              50
            )
          )
      );

      const results = await Promise.all([
        getStoreContext('__sctx_Gym'),
        getStoreContext('__sctx_Gym'),
        getStoreContext('__sctx_Gym'),
      ]);

      expect(results).toEqual(['A gym.', 'A gym.', 'A gym.']);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('returns null for missing or blank stores without touching the network', async () => {
      expect(await getStoreContext(undefined)).toBeNull();
      expect(await getStoreContext('')).toBeNull();
      expect(await getStoreContext('   ')).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('getRecentStoreDescriptions', () => {
    it('returns up to 10 most recent distinct descriptions for a store', async () => {
      for (let i = 1; i <= 12; i++) {
        const label = `Desc ${String(i).padStart(2, '0')}`;
        await pool.query(
          `INSERT INTO movements (amount, date, description, store, created_at, updated_at)
           VALUES (1, '2026-01-01', $1, '__sctx_Many', NOW() - ($2 || ' minutes')::interval, NOW())`,
          [label, String(100 - i)]
        );
      }

      const descs = await getRecentStoreDescriptions('__sctx_Many');

      expect(descs).toHaveLength(10);
      expect(descs[0]).toBe('Desc 12');
      expect(descs).not.toContain('Desc 01');
      expect(descs).not.toContain('Desc 02');
    });

    it('deduplicates repeated descriptions', async () => {
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO movements (amount, date, description, store, created_at, updated_at)
           VALUES (1, '2026-01-01', 'Same thing', '__sctx_Dup', NOW(), NOW())`
        );
      }

      const descs = await getRecentStoreDescriptions('__sctx_Dup');
      expect(descs).toEqual(['Same thing']);
    });

    it('matches the store case-insensitively', async () => {
      await pool.query(
        `INSERT INTO movements (amount, date, description, store, created_at, updated_at)
         VALUES (1, '2026-01-01', 'Bread', '__sctx_CaseStore', NOW(), NOW())`
      );

      const descs = await getRecentStoreDescriptions('__SCTX_CASESTORE');
      expect(descs).toEqual(['Bread']);
    });

    it('returns an empty list for missing stores or stores without descriptions', async () => {
      expect(await getRecentStoreDescriptions(undefined)).toEqual([]);
      expect(await getRecentStoreDescriptions('')).toEqual([]);
      expect(await getRecentStoreDescriptions('__sctx_NoSuchStore')).toEqual([]);
    });
  });
});
