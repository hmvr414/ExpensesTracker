import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import { createApp } from '../app';
import { resetPool } from '../db';

jest.mock('googleapis', () => {
  const mockGetToken = jest.fn();
  const mockSetCredentials = jest.fn();
  const mockRefreshAccessToken = jest.fn();
  const mockRevokeToken = jest.fn();
  const mockGetProfile = jest.fn();
  const OAuth2 = jest.fn().mockImplementation(() => ({
    getToken: mockGetToken,
    setCredentials: mockSetCredentials,
    refreshAccessToken: mockRefreshAccessToken,
    revokeToken: mockRevokeToken,
  }));
  const gmail = jest.fn().mockImplementation(() => ({
    users: { getProfile: mockGetProfile },
  }));
  return {
    google: { auth: { OAuth2 }, gmail },
    __mocks: {
      mockGetToken,
      mockSetCredentials,
      mockRefreshAccessToken,
      mockRevokeToken,
      mockGetProfile,
      OAuth2,
      gmail,
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mocks } = jest.requireMock('googleapis');
const {
  mockGetToken,
  mockRefreshAccessToken,
  mockRevokeToken,
  mockGetProfile,
  gmail: mockGmailFactory,
} = __mocks;

import { getGmailClient, GmailError } from '../helpers/gmailClient';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];

let pool: Pool;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
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

afterAll(async () => {
  await pool.query('DELETE FROM gmail_connection');
  await pool.end();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await pool.query('DELETE FROM gmail_connection');
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/gmail/oauth/callback';
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

async function seedConnection(overrides: Partial<{
  google_email: string;
  access_token: string;
  refresh_token: string;
  token_expiry: Date;
}> = {}) {
  const row = {
    google_email: 'user@gmail.com',
    access_token: 'stored-access-token',
    refresh_token: 'stored-refresh-token',
    token_expiry: new Date(Date.now() + 3600_000),
    ...overrides,
  };
  const result = await pool.query(
    `INSERT INTO gmail_connection (google_email, access_token, refresh_token, token_expiry)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [row.google_email, row.access_token, row.refresh_token, row.token_expiry]
  );
  return result.rows[0];
}

describe('GET /api/gmail/auth-url', () => {
  it('returns a Google OAuth URL with the gmail.readonly scope, offline access, and consent prompt', async () => {
    const res = await request(app).get('/api/gmail/auth-url');
    expect(res.status).toBe(200);
    expect(typeof res.body.url).toBe('string');
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/gmail/oauth/callback'
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('responds 500 naming GOOGLE_CLIENT_ID when it is missing', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await request(app).get('/api/gmail/auth-url');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('GOOGLE_CLIENT_ID');
  });

  it('responds 500 naming GOOGLE_REDIRECT_URI when it is missing', async () => {
    delete process.env.GOOGLE_REDIRECT_URI;
    const res = await request(app).get('/api/gmail/auth-url');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('GOOGLE_REDIRECT_URI');
  });
});

describe('GET /api/gmail/oauth/callback', () => {
  function mockSuccessfulExchange(email = 'user@gmail.com') {
    mockGetToken.mockResolvedValue({
      tokens: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expiry_date: Date.now() + 3600_000,
      },
    });
    mockGetProfile.mockResolvedValue({ data: { emailAddress: email } });
  }

  it('exchanges the code, stores the connection, and redirects with ?gmail=connected', async () => {
    mockSuccessfulExchange();
    const res = await request(app).get('/api/gmail/oauth/callback?code=auth-code-123');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/gmail?gmail=connected');

    expect(mockGetToken).toHaveBeenCalledWith('auth-code-123');

    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].google_email).toBe('user@gmail.com');
    expect(rows.rows[0].access_token).toBe('new-access-token');
    expect(rows.rows[0].refresh_token).toBe('new-refresh-token');
  });

  it('replaces the existing row when connecting again (single-row table)', async () => {
    await seedConnection({ google_email: 'old@gmail.com' });
    mockSuccessfulExchange('new@gmail.com');

    const res = await request(app).get('/api/gmail/oauth/callback?code=auth-code-456');
    expect(res.status).toBe(302);

    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].google_email).toBe('new@gmail.com');
  });

  it('redirects with ?gmail=error when the code is missing', async () => {
    const res = await request(app).get('/api/gmail/oauth/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('gmail=error');
    expect(res.headers.location).toContain('reason=');
  });

  it('redirects with ?gmail=error when the token exchange fails (never a bare error page)', async () => {
    mockGetToken.mockRejectedValue(new Error('invalid_grant'));
    const res = await request(app).get('/api/gmail/oauth/callback?code=bad-code');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('gmail=error');
    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rowCount).toBe(0);
  });

  it('redirects with ?gmail=error when Google returns no refresh token', async () => {
    mockGetToken.mockResolvedValue({
      tokens: { access_token: 'a', expiry_date: Date.now() + 3600_000 },
    });
    const res = await request(app).get('/api/gmail/oauth/callback?code=code-789');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('gmail=error');
    expect(res.headers.location).toContain('reason=no_refresh_token');
  });
});

describe('GET /api/gmail/status', () => {
  it('reports disconnected when no connection exists', async () => {
    const res = await request(app).get('/api/gmail/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, email: null, connectedAt: null });
  });

  it('reports the connected address and date, never tokens', async () => {
    await seedConnection();
    const res = await request(app).get('/api/gmail/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('user@gmail.com');
    expect(typeof res.body.connectedAt).toBe('string');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('stored-access-token');
    expect(serialized).not.toContain('stored-refresh-token');
  });
});

describe('DELETE /api/gmail/connection', () => {
  it('revokes the token, deletes the row, and returns 204', async () => {
    await seedConnection();
    mockRevokeToken.mockResolvedValue({});

    const res = await request(app).delete('/api/gmail/connection');
    expect(res.status).toBe(204);
    expect(mockRevokeToken).toHaveBeenCalledWith('stored-refresh-token');

    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rowCount).toBe(0);
  });

  it('still deletes the row and returns 204 when revocation fails (best-effort)', async () => {
    await seedConnection();
    mockRevokeToken.mockRejectedValue(new Error('network down'));

    const res = await request(app).delete('/api/gmail/connection');
    expect(res.status).toBe(204);

    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rowCount).toBe(0);
  });

  it('returns 204 when there is no connection', async () => {
    const res = await request(app).delete('/api/gmail/connection');
    expect(res.status).toBe(204);
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });
});

describe('getGmailClient', () => {
  it('throws GMAIL_NOT_CONNECTED when no connection exists', async () => {
    await expect(getGmailClient()).rejects.toMatchObject({ code: 'GMAIL_NOT_CONNECTED' });
    await expect(getGmailClient()).rejects.toBeInstanceOf(GmailError);
  });

  it('returns a gmail client without refreshing when the token is still valid', async () => {
    await seedConnection({ token_expiry: new Date(Date.now() + 3600_000) });

    const client = await getGmailClient();
    expect(client).toBeDefined();
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    expect(mockGmailFactory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v1' })
    );
  });

  it('refreshes an expired token and persists the new access token and expiry', async () => {
    await seedConnection({ token_expiry: new Date(Date.now() - 1000) });
    const newExpiry = Date.now() + 3600_000;
    mockRefreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'refreshed-access-token', expiry_date: newExpiry },
    });

    const client = await getGmailClient();
    expect(client).toBeDefined();
    expect(mockRefreshAccessToken).toHaveBeenCalled();

    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rows[0].access_token).toBe('refreshed-access-token');
    expect(new Date(rows.rows[0].token_expiry).getTime()).toBe(newExpiry);
  });

  it('throws GMAIL_AUTH_EXPIRED when the refresh fails', async () => {
    await seedConnection({ token_expiry: new Date(Date.now() - 1000) });
    mockRefreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(getGmailClient()).rejects.toMatchObject({ code: 'GMAIL_AUTH_EXPIRED' });

    // the stored row is untouched so the user can be told to reconnect
    const rows = await pool.query('SELECT * FROM gmail_connection');
    expect(rows.rowCount).toBe(1);
  });
});
