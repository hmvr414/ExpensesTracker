import { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

// reset for tests that change DATABASE_URL between suites
export function resetPool(): void {
  _pool = null;
}

const db = {
  query<T extends QueryResultRow = QueryResultRow>(
    queryText: string | QueryConfig,
    values?: unknown[]
  ): Promise<QueryResult<T>> {
    return getPool().query<T>(queryText as string, values);
  },
};

export default db;
