import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { google } from 'googleapis';
import pool, { getPool } from '../db';
import {
  createOAuth2Client,
  getConnection,
  getGmailClient,
  GmailError,
} from '../helpers/gmailClient';
import { retryPendingMessage, runGmailPollTick } from '../jobs/gmailPoller';

const router = Router();

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

const senderCreateSchema = z.object({
  email: z.string().email('email must be valid').transform((email) => email.toLowerCase()),
  label: z.string().min(1, 'label must not be empty').max(60, 'label must be at most 60 characters').optional(),
  subject_contains: z
    .string()
    .min(1, 'subject_contains must not be empty')
    .max(100, 'subject_contains must be at most 100 characters')
    .optional(),
});

const senderUpdateSchema = z.object({
  label: z
    .string()
    .min(1, 'label must not be empty')
    .max(60, 'label must be at most 60 characters')
    .nullable()
    .optional(),
  subject_contains: z
    .string()
    .min(1, 'subject_contains must not be empty')
    .max(100, 'subject_contains must be at most 100 characters')
    .nullable()
    .optional(),
});

const messagesQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  sender: z.string().email('sender must be a valid email').transform((email) => email.toLowerCase()).optional(),
  subject: z.string().min(1, 'subject must not be empty').optional(),
  pageToken: z.string().min(1, 'pageToken must not be empty').optional(),
});

type SenderRow = {
  id: number;
  email: string;
  label: string | null;
  subject_contains: string | null;
  created_at: Date;
};

// Where the browser lands after the OAuth round-trip. In production the API
// serves the SPA itself, so a relative path works; in development the client
// runs on the Vite dev server.
function clientSettingsUrl(query: string): string {
  const base =
    process.env.CLIENT_URL ??
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
  return `${base}/settings/gmail?${query}`;
}

function missingEnvVar(...keys: string[]): string | null {
  for (const key of keys) {
    if (!process.env[key]) return key;
  }
  return null;
}

function validationDetails(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    details[issue.path.join('.') || 'body'] = issue.message;
  }
  return details;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  );
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseDateParam(value: string | undefined, name: string): { date?: Date; error?: string } {
  if (!value) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: `${name} must be an ISO date (YYYY-MM-DD)` };
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return { error: `${name} must be a valid ISO date (YYYY-MM-DD)` };
  }
  return { date };
}

function gmailDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '/');
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function quotePhrase(value: string): string {
  return value.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function senderGroup(sender: Pick<SenderRow, 'email' | 'subject_contains'>): string {
  const subject = sender.subject_contains ? ` subject:"${quotePhrase(sender.subject_contains)}"` : '';
  return `(from:${sender.email}${subject})`;
}

function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string
): string | null {
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function isReconnectError(err: unknown): boolean {
  if (err instanceof GmailError) {
    return err.code === 'GMAIL_NOT_CONNECTED' || err.code === 'GMAIL_AUTH_EXPIRED';
  }
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { response?: { status?: number }; code?: number | string };
    return maybe.response?.status === 401 || maybe.code === 401 || maybe.code === '401';
  }
  return false;
}

async function fetchSenders(): Promise<SenderRow[]> {
  const result = await pool.query<SenderRow>(
    `SELECT id, email, label, subject_contains, created_at
     FROM gmail_senders
     ORDER BY email ASC`
  );
  return result.rows;
}

router.get('/auth-url', (_req: Request, res: Response) => {
  const missing = missingEnvVar('GOOGLE_CLIENT_ID', 'GOOGLE_REDIRECT_URI');
  if (missing) {
    res.status(500).json({
      error: `Gmail integration is not configured: the ${missing} environment variable is not set`,
    });
    return;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID as string,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI as string,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  res.json({ url: `${GOOGLE_AUTH_BASE}?${params.toString()}` });
});

router.get('/oauth/callback', async (req: Request, res: Response) => {
  const fail = (reason: string) =>
    res.redirect(clientSettingsUrl(`gmail=error&reason=${encodeURIComponent(reason)}`));

  const code = typeof req.query.code === 'string' ? req.query.code : null;
  if (!code) {
    fail('missing_code');
    return;
  }
  if (missingEnvVar('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI')) {
    fail('not_configured');
    return;
  }

  try {
    const oauth2 = createOAuth2Client();
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.access_token) {
      fail('no_access_token');
      return;
    }
    if (!tokens.refresh_token) {
      // Should not happen with prompt=consent, but never store a connection
      // that cannot survive the first expiry.
      fail('no_refresh_token');
      return;
    }

    oauth2.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    if (!email) {
      fail('no_profile_email');
      return;
    }

    const expiry = tokens.expiry_date
      ? new Date(tokens.expiry_date)
      : new Date(Date.now() + 3600_000);

    // Single-row table: connecting again replaces the existing row.
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM gmail_connection');
      await client.query(
        `INSERT INTO gmail_connection (google_email, access_token, refresh_token, token_expiry)
         VALUES ($1, $2, $3, $4)`,
        [email, tokens.access_token, tokens.refresh_token, expiry]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.redirect(clientSettingsUrl('gmail=connected'));
  } catch {
    fail('token_exchange_failed');
  }
});

router.get('/status', async (_req: Request, res: Response) => {
  const row = await getConnection();
  if (!row) {
    res.json({ connected: false, email: null, connectedAt: null });
    return;
  }
  res.json({
    connected: true,
    email: row.google_email,
    connectedAt: new Date(row.connected_at).toISOString(),
    lastPolledAt: row.last_polled_at ? new Date(row.last_polled_at).toISOString() : null,
    needsReconnect: row.needs_reconnect,
  });
});

router.get('/senders', async (_req: Request, res: Response) => {
  res.json(await fetchSenders());
});

router.post('/senders', async (req: Request, res: Response) => {
  const parsed = senderCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: validationDetails(parsed.error) });
    return;
  }

  const { email, label, subject_contains } = parsed.data;
  try {
    const result = await pool.query<SenderRow>(
      `INSERT INTO gmail_senders (email, label, subject_contains)
       VALUES ($1, $2, $3)
       RETURNING id, email, label, subject_contains, created_at`,
      [email, label ?? null, subject_contains ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: `Gmail sender '${email}' already exists` });
      return;
    }
    throw err;
  }
});

router.put('/senders/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const parsed = senderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: validationDetails(parsed.error) });
    return;
  }

  const existing = await pool.query<SenderRow>(
    `SELECT id, email, label, subject_contains, created_at FROM gmail_senders WHERE id = $1`,
    [id]
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Gmail sender ${id} not found` });
    return;
  }

  const current = existing.rows[0];
  const data = parsed.data;
  const label = hasOwn(data, 'label') ? data.label ?? null : current.label;
  const subjectContains = hasOwn(data, 'subject_contains')
    ? data.subject_contains ?? null
    : current.subject_contains;

  const result = await pool.query<SenderRow>(
    `UPDATE gmail_senders
     SET label = $1, subject_contains = $2
     WHERE id = $3
     RETURNING id, email, label, subject_contains, created_at`,
    [label, subjectContains, id]
  );
  res.json(result.rows[0]);
});

router.delete('/senders/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const result = await pool.query('DELETE FROM gmail_senders WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: `Gmail sender ${id} not found` });
    return;
  }
  res.status(204).send();
});

router.get('/messages', async (req: Request, res: Response) => {
  const parsed = messagesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: validationDetails(parsed.error) });
    return;
  }

  const fromParsed = parseDateParam(parsed.data.from, 'from');
  if (fromParsed.error) {
    res.status(400).json({ error: 'Validation failed', details: { from: fromParsed.error } });
    return;
  }
  const toParsed = parseDateParam(parsed.data.to, 'to');
  if (toParsed.error) {
    res.status(400).json({ error: 'Validation failed', details: { to: toParsed.error } });
    return;
  }

  const today = new Date();
  const toDate = toParsed.date ?? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const fromDate = fromParsed.date ?? addDays(toDate, -30);

  const allSenders = await fetchSenders();
  let querySenders: Array<Pick<SenderRow, 'email' | 'subject_contains'>>;
  if (parsed.data.sender) {
    const configured = allSenders.find((sender) => sender.email === parsed.data.sender);
    querySenders = [
      configured ?? { email: parsed.data.sender, subject_contains: null },
    ];
  } else {
    if (allSenders.length === 0) {
      res.status(400).json({ error: 'Configure at least one Gmail sender or pass a sender query parameter' });
      return;
    }
    querySenders = allSenders;
  }

  const senderQuery =
    querySenders.length === 1
      ? senderGroup(querySenders[0])
      : `(${querySenders.map(senderGroup).join(' OR ')})`;
  const parts = [
    senderQuery,
  ];
  if (parsed.data.subject) {
    parts.push(`subject:"${quotePhrase(parsed.data.subject)}"`);
  }
  parts.push(`after:${gmailDate(fromDate)}`, `before:${gmailDate(addDays(toDate, 1))}`);
  const q = parts.join(' ');

  try {
    const gmail = await getGmailClient();
    const listResult = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 25,
      pageToken: parsed.data.pageToken,
    });
    const listed = listResult.data.messages ?? [];
    const ids = listed.map((message) => message.id).filter((id): id is string => Boolean(id));

    const imported = ids.length
      ? await pool.query<{ gmail_message_id: string }>(
          `SELECT DISTINCT gmail_message_id
           FROM gmail_imported_messages
           WHERE gmail_message_id = ANY($1)`,
          [ids]
        )
      : { rows: [] };
    const importedIds = new Set(imported.rows.map((row) => row.gmail_message_id));

    const messages = await Promise.all(
      ids.map(async (id) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = detail.data.payload?.headers;
        return {
          id: detail.data.id ?? id,
          threadId: detail.data.threadId ?? listed.find((message) => message.id === id)?.threadId ?? null,
          from: headerValue(headers, 'From'),
          subject: headerValue(headers, 'Subject'),
          date: headerValue(headers, 'Date'),
          snippet: detail.data.snippet ?? '',
          alreadyImported: importedIds.has(id),
        };
      })
    );

    res.json({ messages, nextPageToken: listResult.data.nextPageToken ?? null });
  } catch (err) {
    if (isReconnectError(err)) {
      res.status(401).json({
        error: 'Reconnect Gmail to continue importing messages',
        code: 'GMAIL_RECONNECT_REQUIRED',
      });
      return;
    }
    throw err;
  }
});

router.delete('/connection', async (_req: Request, res: Response) => {
  const row = await getConnection();
  if (row) {
    try {
      await createOAuth2Client().revokeToken(row.refresh_token);
    } catch {
      // Best-effort: Google being unreachable must not block disconnecting.
    }
    await pool.query('DELETE FROM gmail_connection WHERE id = $1', [row.id]);
  }
  res.status(204).send();
});

router.get('/pending', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (!['pending', 'error', 'dismissed'].includes(status)) {
    res.status(400).json({ error: 'Validation failed', details: { status: 'status must be pending, error, or dismissed' } });
    return;
  }
  const result = await pool.query(
    `SELECT gmail_message_id AS "messageId",
            from_address AS "from",
            subject,
            email_date AS "date",
            movements,
            status,
            error,
            detected_at AS "detectedAt",
            extracted_at AS "extractedAt"
     FROM gmail_pending_imports
     WHERE status = $1
     ORDER BY email_date DESC NULLS LAST, detected_at DESC`,
    [status]
  );
  res.json({ emails: result.rows });
});

router.get('/pending/count', async (_req: Request, res: Response) => {
  const result = await pool.query<{ emails: string; movements: string }>(
    `SELECT COUNT(*)::int AS emails,
            COALESCE(SUM(jsonb_array_length(movements)), 0)::int AS movements
     FROM gmail_pending_imports
     WHERE status = 'pending'`
  );
  res.json(result.rows[0] ?? { emails: 0, movements: 0 });
});

router.post('/pending/:messageId/dismiss', async (req: Request, res: Response) => {
  const result = await pool.query(
    `UPDATE gmail_pending_imports
     SET status = 'dismissed'
     WHERE gmail_message_id = $1
     RETURNING gmail_message_id`,
    [req.params.messageId]
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: `Pending Gmail message ${req.params.messageId} not found` });
    return;
  }
  res.status(204).send();
});

router.post('/pending/:messageId/retry', async (req: Request, res: Response) => {
  const existing = await pool.query(
    `SELECT gmail_message_id FROM gmail_pending_imports WHERE gmail_message_id = $1 AND status = 'error'`,
    [req.params.messageId]
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: `Errored Gmail message ${req.params.messageId} not found` });
    return;
  }

  try {
    const result = await retryPendingMessage(req.params.messageId);
    res.json(result);
  } catch (err) {
    if (isReconnectError(err)) {
      res.status(401).json({
        error: 'Reconnect Gmail to continue importing messages',
        code: 'GMAIL_RECONNECT_REQUIRED',
      });
      return;
    }
    throw err;
  }
});

router.post('/poll-now', async (_req: Request, res: Response) => {
  try {
    res.json(await runGmailPollTick());
  } catch (err) {
    if (isReconnectError(err)) {
      res.status(401).json({
        error: 'Reconnect Gmail to continue importing messages',
        code: 'GMAIL_RECONNECT_REQUIRED',
      });
      return;
    }
    throw err;
  }
});

export default router;
