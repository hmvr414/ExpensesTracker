import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { z } from 'zod';
import db, { getPool } from '../db';
import { resolveCategoryByName, ResolvedCategory } from '../helpers/categoryResolver';
import { runTesseract } from '../helpers/ocr';
import { extractMovementsFromText, MovementWithSuggestion } from '../helpers/extractMovements';
import { TIME_FIELD, normalizeTime } from '../helpers/timeField';
import { getGmailClient, GmailError } from '../helpers/gmailClient';
import { GmailPayloadPart, textWithContext } from '../helpers/gmailMessageText';

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

function getUploadDir(): string {
  return process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const month = new Date().toISOString().slice(0, 7);
    const dest = path.join(getUploadDir(), month);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    const unique = `${base}-${Date.now()}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ISO_BARE = `to_char(date, 'YYYY-MM-DD') AS date`;

const router = Router();

router.post('/extract', (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'File size exceeds the 10 MB limit' });
      } else {
        res.status(400).json({ error: err.message });
      }
      return;
    }
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const { file } = req;

    let attachmentId: number;
    try {
      const result = await db.query<{ id: number }>(
        `INSERT INTO attachments (movement_id, file_name, file_path, mime_type)
         VALUES (NULL, $1, $2, $3)
         RETURNING id`,
        [file.originalname, file.path, file.mimetype]
      );
      attachmentId = result.rows[0].id;
    } catch (dbErr) {
      try { await fsp.unlink(file.path); } catch { /* ignore */ }
      throw dbErr;
    }

    let rawText = '';
    try {
      rawText = await runTesseract(file.path);
    } catch (ocrErr: unknown) {
      const code = (ocrErr as { code?: string }).code;
      if (code === 'TESSERACT_NOT_FOUND') {
        res.status(500).json({ error: 'tesseract is not installed or not in PATH' });
        return;
      }
      // Other OCR failures: continue with empty rawText
    }

    const extraction = await extractMovementsFromText(rawText);
    const movements = extraction.movements;
    const language = extraction.language;
    const aiError = extraction.error;

    const response: {
      attachmentId: number;
      rawText: string;
      language: string | null;
      movements: MovementWithSuggestion[];
      error?: string;
    } = { attachmentId, rawText, language, movements };

    if (aiError) {
      response.error = aiError;
    }

    res.json(response);
  });
});

const extractEmailsBodySchema = z.object({
  messageIds: z
    .array(z.string().trim().min(1, 'message id must not be empty'))
    .min(1, 'messageIds must contain at least one id')
    .max(25, 'messageIds must contain at most 25 ids')
    .refine((ids) => new Set(ids).size === ids.length, 'messageIds must be unique'),
});

function validationDetails(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    details[issue.path.join('.') || 'body'] = issue.message;
  }
  return details;
}

function isGmailReconnectError(err: unknown): boolean {
  if (err instanceof GmailError) {
    return err.code === 'GMAIL_NOT_CONNECTED' || err.code === 'GMAIL_AUTH_EXPIRED';
  }
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { response?: { status?: number }; code?: number | string };
    return maybe.response?.status === 401 || maybe.code === 401 || maybe.code === '401';
  }
  return false;
}

router.post('/extract-emails', async (req: Request, res: Response) => {
  const parsed = extractEmailsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: validationDetails(parsed.error) });
    return;
  }

  let gmail: Awaited<ReturnType<typeof getGmailClient>>;
  try {
    gmail = await getGmailClient();
  } catch (err) {
    if (isGmailReconnectError(err)) {
      res.status(401).json({
        error: 'Reconnect Gmail to continue importing messages',
        code: 'GMAIL_RECONNECT_REQUIRED',
      });
      return;
    }
    throw err;
  }

  let batchLanguage: string | null = null;
  const emails = [];

  for (const messageId of parsed.data.messageIds) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const payload = detail.data.payload as GmailPayloadPart | undefined;
      const { rawText, subject, from, date } = textWithContext(payload);

      const extraction = await extractMovementsFromText(rawText);
      if (batchLanguage == null && extraction.language != null) {
        batchLanguage = extraction.language;
      }
      emails.push({
        messageId,
        subject,
        from,
        date,
        movements: extraction.movements.map((movement) => ({
          ...movement,
          gmailMessageId: messageId,
          source: 'gmail' as const,
        })),
        error: extraction.error ?? null,
      });
    } catch {
      emails.push({
        messageId,
        subject: null,
        from: null,
        date: null,
        movements: [],
        error: 'Email extraction failed',
      });
    }
  }

  res.json({ emails, language: batchLanguage });
});

const movementItemSchema = z.object({
  amount: z.number().positive('amount must be a positive number'),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD'),
  time: TIME_FIELD.optional(),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  payment_method_id: z.number().int().positive().nullable().optional(),
  gmail_message_id: z.string().trim().min(1, 'gmail_message_id must not be empty').optional(),
  new_category_name: z
    .string()
    .trim()
    .min(1, 'new_category_name must not be empty')
    .max(40, 'new_category_name must be at most 40 characters')
    .optional(),
});

const confirmBodySchema = z.object({
  attachmentId: z.number().int().positive().optional(),
  movements: z.array(movementItemSchema),
});

function validationError(err: z.ZodError, res: Response): void {
  const details: Record<string, string> = {};
  for (const issue of err.issues) {
    details[issue.path.join('.') || 'body'] = issue.message;
  }
  res.status(400).json({ error: 'Validation failed', details });
}

router.post('/confirm', async (req: Request, res: Response) => {
  const parseResult = confirmBodySchema.safeParse(req.body);
  if (!parseResult.success) {
    validationError(parseResult.error, res);
    return;
  }

  const { attachmentId, movements } = parseResult.data;

  // Check category_id existence for each item before persisting anything
  const itemErrors: Record<string, string> = {};
  for (let i = 0; i < movements.length; i++) {
    const mv = movements[i];
    if (mv.new_category_name !== undefined && mv.category_id != null) {
      itemErrors[`movements.${i}.new_category_name`] =
        'Provide either category_id or new_category_name, not both';
    }
    if (mv.category_id != null) {
      const check = await db.query<{ id: number }>(
        'SELECT id FROM categories WHERE id = $1',
        [mv.category_id]
      );
      if (check.rows.length === 0) {
        itemErrors[`movements.${i}.category_id`] = `Category ${mv.category_id} does not exist`;
      }
    }
    if (mv.payment_method_id != null) {
      const check = await db.query<{ id: number }>(
        'SELECT id FROM payment_methods WHERE id = $1',
        [mv.payment_method_id]
      );
      if (check.rows.length === 0) {
        itemErrors[`movements.${i}.payment_method_id`] = `Payment method ${mv.payment_method_id} does not exist`;
      }
    }
  }

  if (Object.keys(itemErrors).length > 0) {
    res.status(400).json({ error: 'Validation failed', details: itemErrors });
    return;
  }

  const gmailMessageIds = [
    ...new Set(
      movements
        .map((movement) => movement.gmail_message_id)
        .filter((id): id is string => id !== undefined)
    ),
  ];
  if (gmailMessageIds.length > 0) {
    const imported = await db.query<{ gmail_message_id: string }>(
      `SELECT DISTINCT gmail_message_id
       FROM gmail_imported_messages
       WHERE gmail_message_id = ANY($1)
       ORDER BY gmail_message_id`,
      [gmailMessageIds]
    );
    if (imported.rows.length > 0) {
      res.status(409).json({
        error: 'One or more Gmail messages were already imported',
        details: { alreadyImported: imported.rows.map((row) => row.gmail_message_id) },
      });
      return;
    }
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const created: Array<{
      id: number;
      amount: string;
      date: string;
      description: string | null;
      store: string | null;
      category_id: number | null;
      payment_method_id: number | null;
    }> = [];
    // Resolve each distinct new_category_name once per batch so repeated
    // rows share the same find-or-create result (and its created flag).
    const resolvedByName = new Map<string, ResolvedCategory>();
    for (const mv of movements) {
      let categoryId = mv.category_id ?? null;
      if (mv.new_category_name !== undefined) {
        const key = mv.new_category_name.toLowerCase();
        let resolved = resolvedByName.get(key);
        if (!resolved) {
          resolved = await resolveCategoryByName(client, mv.new_category_name);
          resolvedByName.set(key, resolved);
        }
        categoryId = resolved.id;
      }
      const result = await client.query<(typeof created)[number]>(
        `INSERT INTO movements (amount, date, time, description, store, category_id, payment_method_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING id, amount, ${DATE_ISO_BARE}, description, store, category_id, payment_method_id`,
        [mv.amount, mv.date, normalizeTime(mv.time), mv.description ?? null, mv.store ?? null, categoryId, mv.payment_method_id ?? null]
      );
      const createdMovement = result.rows[0];
      created.push(createdMovement);

      if (mv.gmail_message_id !== undefined) {
        await client.query(
          `INSERT INTO gmail_imported_messages (gmail_message_id, movement_id)
           VALUES ($1, $2)`,
          [mv.gmail_message_id, createdMovement.id]
        );
      }
    }

    if (gmailMessageIds.length > 0) {
      await client.query(
        `DELETE FROM gmail_pending_imports
         WHERE gmail_message_id = ANY($1)`,
        [gmailMessageIds]
      );
    }

    if (attachmentId != null && created.length > 0) {
      const attachCheck = await client.query<{ id: number }>(
        'SELECT id FROM attachments WHERE id = $1',
        [attachmentId]
      );
      if (attachCheck.rows.length > 0) {
        await client.query(
          'UPDATE attachments SET movement_id = $1 WHERE id = $2',
          [created[0].id, attachmentId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({
      created,
      count: created.length,
      resolvedCategories: [...resolvedByName.values()],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === '23505' &&
      gmailMessageIds.length > 0
    ) {
      res.status(409).json({
        error: 'One or more Gmail messages were already imported',
        details: { alreadyImported: gmailMessageIds },
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

export default router;
