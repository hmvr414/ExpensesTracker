import { google, gmail_v1, Auth } from 'googleapis';
import pool from '../db';

export type GmailErrorCode = 'GMAIL_NOT_CONNECTED' | 'GMAIL_AUTH_EXPIRED';

export class GmailError extends Error {
  code: GmailErrorCode;

  constructor(code: GmailErrorCode, message: string) {
    super(message);
    this.name = 'GmailError';
    this.code = code;
  }
}

interface GmailConnectionRow {
  id: number;
  google_email: string;
  access_token: string;
  refresh_token: string;
  token_expiry: Date;
  connected_at: Date;
  last_polled_at: Date | null;
  needs_reconnect: boolean;
}

// Refresh slightly before the real expiry so an in-flight request never
// races a token that dies mid-call.
const EXPIRY_SKEW_MS = 60_000;

export function createOAuth2Client(): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export async function getConnection(): Promise<GmailConnectionRow | null> {
  const result = await pool.query<GmailConnectionRow>(
    'SELECT * FROM gmail_connection ORDER BY id LIMIT 1'
  );
  return result.rows[0] ?? null;
}

export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  const row = await getConnection();
  if (!row) {
    throw new GmailError('GMAIL_NOT_CONNECTED', 'No Gmail account is connected');
  }

  const oauth2 = createOAuth2Client();
  let accessToken = row.access_token;

  if (new Date(row.token_expiry).getTime() - EXPIRY_SKEW_MS <= Date.now()) {
    oauth2.setCredentials({ refresh_token: row.refresh_token });
    let credentials;
    try {
      ({ credentials } = await oauth2.refreshAccessToken());
    } catch {
      throw new GmailError(
        'GMAIL_AUTH_EXPIRED',
        'The Gmail authorization has expired — reconnect the account'
      );
    }
    accessToken = credentials.access_token ?? row.access_token;
    const newExpiry = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : new Date(Date.now() + 3600_000);
    await pool.query(
      'UPDATE gmail_connection SET access_token = $1, token_expiry = $2 WHERE id = $3',
      [accessToken, newExpiry, row.id]
    );
  }

  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: row.refresh_token,
  });
  return google.gmail({ version: 'v1', auth: oauth2 });
}
