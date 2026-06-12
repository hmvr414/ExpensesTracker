import { gmail_v1 } from 'googleapis';
import pool from '../db';
import { extractMovementsFromText } from '../helpers/extractMovements';
import { getGmailClient, GmailError } from '../helpers/gmailClient';
import { GmailPayloadPart, textWithContext } from '../helpers/gmailMessageText';

type SenderRow = {
  email: string;
  subject_contains: string | null;
};

type PollResult = {
  newEmails: number;
  errors: number;
};

let timer: NodeJS.Timeout | null = null;

function quotePhrase(value: string): string {
  return value.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function gmailDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '/');
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function senderGroup(sender: SenderRow): string {
  const subject = sender.subject_contains ? ` subject:"${quotePhrase(sender.subject_contains)}"` : '';
  return `(from:${sender.email}${subject})`;
}

function isReconnectError(err: unknown): boolean {
  if (err instanceof GmailError) {
    return err.code === 'GMAIL_AUTH_EXPIRED' || err.code === 'GMAIL_NOT_CONNECTED';
  }
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { response?: { status?: number }; code?: number | string };
    return maybe.response?.status === 401 || maybe.code === 401 || maybe.code === '401';
  }
  return false;
}

async function fetchCandidateIds(gmail: gmail_v1.Gmail, senders: SenderRow[], after: Date): Promise<string[]> {
  const senderQuery =
    senders.length === 1
      ? senderGroup(senders[0])
      : `(${senders.map(senderGroup).join(' OR ')})`;
  const q = `${senderQuery} after:${gmailDate(after)} before:${gmailDate(addDays(new Date(), 1))}`;
  const listed = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 25,
  });
  return (listed.data.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));
}

async function unprocessedIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await pool.query<{ gmail_message_id: string }>(
    `SELECT gmail_message_id FROM gmail_imported_messages WHERE gmail_message_id = ANY($1)
     UNION
     SELECT gmail_message_id FROM gmail_pending_imports WHERE gmail_message_id = ANY($1)`,
    [ids]
  );
  const skipped = new Set(result.rows.map((row) => row.gmail_message_id));
  return ids.filter((id) => !skipped.has(id));
}

async function processMessage(gmail: gmail_v1.Gmail, id: string): Promise<'pending' | 'error'> {
  try {
    const detail = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const payload = detail.data.payload as GmailPayloadPart | undefined;
    const { rawText, subject, from, date } = textWithContext(payload);
    const extraction = await extractMovementsFromText(rawText);
    const movements = extraction.movements.map((movement) => ({
      ...movement,
      gmailMessageId: id,
      source: 'gmail' as const,
    }));
    const status = extraction.error ? 'error' : 'pending';
    await pool.query(
      `INSERT INTO gmail_pending_imports
         (gmail_message_id, from_address, subject, email_date, movements, status, error, extracted_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
       ON CONFLICT (gmail_message_id) DO UPDATE
       SET from_address = EXCLUDED.from_address,
           subject = EXCLUDED.subject,
           email_date = EXCLUDED.email_date,
           movements = EXCLUDED.movements,
           status = EXCLUDED.status,
           error = EXCLUDED.error,
           extracted_at = EXCLUDED.extracted_at`,
      [
        id,
        from,
        subject,
        date && !Number.isNaN(new Date(date).getTime()) ? new Date(date) : null,
        JSON.stringify(movements),
        status,
        extraction.error ?? null,
      ]
    );
    return status;
  } catch (err) {
    if (isReconnectError(err)) throw err;
    await pool.query(
      `INSERT INTO gmail_pending_imports
         (gmail_message_id, movements, status, error, extracted_at)
       VALUES ($1, '[]'::jsonb, 'error', $2, NOW())
       ON CONFLICT (gmail_message_id) DO UPDATE
       SET movements = '[]'::jsonb,
           status = 'error',
           error = EXCLUDED.error,
           extracted_at = EXCLUDED.extracted_at`,
      [id, 'Email extraction failed']
    );
    return 'error';
  }
}

export async function runGmailPollTick(): Promise<PollResult> {
  const connection = await pool.query<{ id: number; last_polled_at: Date | null; needs_reconnect: boolean }>(
    `SELECT id, last_polled_at, needs_reconnect
     FROM gmail_connection
     ORDER BY id
     LIMIT 1`
  );
  const row = connection.rows[0];
  if (!row || row.needs_reconnect) {
    return { newEmails: 0, errors: 0 };
  }

  const senders = await pool.query<SenderRow>(
    `SELECT email, subject_contains FROM gmail_senders ORDER BY email ASC`
  );
  if (senders.rows.length === 0) {
    return { newEmails: 0, errors: 0 };
  }

  let gmail: gmail_v1.Gmail;
  try {
    gmail = await getGmailClient();
  } catch (err) {
    if (isReconnectError(err)) {
      await pool.query('UPDATE gmail_connection SET needs_reconnect = true WHERE id = $1', [row.id]);
      return { newEmails: 0, errors: 1 };
    }
    throw err;
  }

  const thirtyDaysAgo = addDays(new Date(), -30);
  const overlapStart = row.last_polled_at ? addDays(new Date(row.last_polled_at), -1) : thirtyDaysAgo;
  const searchAfter = overlapStart > thirtyDaysAgo ? overlapStart : thirtyDaysAgo;

  let ids: string[];
  try {
    ids = await unprocessedIds(await fetchCandidateIds(gmail, senders.rows, searchAfter));
  } catch (err) {
    if (isReconnectError(err)) {
      await pool.query('UPDATE gmail_connection SET needs_reconnect = true WHERE id = $1', [row.id]);
      return { newEmails: 0, errors: 1 };
    }
    throw err;
  }

  let newEmails = 0;
  let errors = 0;
  for (const id of ids) {
    let status: 'pending' | 'error';
    try {
      status = await processMessage(gmail, id);
    } catch (err) {
      if (isReconnectError(err)) {
        await pool.query('UPDATE gmail_connection SET needs_reconnect = true WHERE id = $1', [row.id]);
        return { newEmails, errors: errors + 1 };
      }
      throw err;
    }
    if (status === 'error') errors += 1;
    newEmails += 1;
  }

  await pool.query('UPDATE gmail_connection SET last_polled_at = NOW() WHERE id = $1', [row.id]);
  return { newEmails, errors };
}

export async function retryPendingMessage(messageId: string): Promise<PollResult> {
  let gmail: gmail_v1.Gmail;
  try {
    gmail = await getGmailClient();
  } catch (err) {
    if (isReconnectError(err)) {
      await pool.query('UPDATE gmail_connection SET needs_reconnect = true');
      return { newEmails: 0, errors: 1 };
    }
    throw err;
  }
  try {
    const status = await processMessage(gmail, messageId);
    return { newEmails: status === 'pending' ? 1 : 0, errors: status === 'error' ? 1 : 0 };
  } catch (err) {
    if (isReconnectError(err)) {
      await pool.query('UPDATE gmail_connection SET needs_reconnect = true');
      return { newEmails: 0, errors: 1 };
    }
    throw err;
  }
}

export function startGmailPoller(): void {
  if (process.env.NODE_ENV === 'test' || timer) return;
  const minutes = Number(process.env.GMAIL_POLL_INTERVAL_MINUTES ?? '60');
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  setTimeout(() => {
    void runGmailPollTick().catch((err) => console.error('[gmail-poller] startup tick failed', err));
  }, 5_000).unref();
  timer = setInterval(() => {
    void runGmailPollTick().catch((err) => console.error('[gmail-poller] tick failed', err));
  }, minutes * 60_000);
  timer.unref();
}

export function stopGmailPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
