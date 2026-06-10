import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { z } from 'zod';
import OpenAI from 'openai';
import db, { getPool } from '../db';
import { suggestCategory } from '../helpers/suggest';
import { runTesseract } from '../helpers/ocr';

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

interface ExtractedMovement {
  amount: number;
  date: string;
  description?: string;
  store?: string;
}

interface MovementWithSuggestion extends ExtractedMovement {
  categoryId: number | null;
  categoryName?: string;
  color?: string;
  aiSuggested: boolean;
}

const AI_TIMEOUT_MS = 10_000;

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

    let movements: MovementWithSuggestion[] = [];
    let aiError: string | undefined;

    try {
      const client = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY ?? '',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5';

      const prompt = [
        'Extract expense movements from the following OCR text from a receipt or financial document.',
        '',
        'OCR Text:',
        rawText || '(empty)',
        '',
        'Return a JSON object with a "movements" array. Each item must have:',
        '- amount: number (positive)',
        '- date: string (ISO YYYY-MM-DD format, use today if not found)',
        '- description: string (optional)',
        '- store: string (optional, the merchant or store name)',
        '',
        'Return { "movements": [] } if no expenses can be identified.',
      ].join('\n');

      const completion = await Promise.race([
        client.chat.completions.create({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI extraction timeout')), AI_TIMEOUT_MS)
        ),
      ]);

      const content = completion.choices[0]?.message?.content;
      if (content) {
        const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(stripped) as { movements?: ExtractedMovement[] };
        const rawMovements = Array.isArray(parsed.movements) ? parsed.movements : [];

        movements = await Promise.all(
          rawMovements.map(async (m) => {
            const suggestion = await suggestCategory(m.store, m.description);
            return {
              ...m,
              categoryId: suggestion.categoryId,
              categoryName: suggestion.categoryName,
              color: suggestion.color,
              aiSuggested: suggestion.categoryId != null,
            };
          })
        );
      }
    } catch {
      aiError = 'AI extraction failed';
      movements = [];
    }

    const response: {
      attachmentId: number;
      rawText: string;
      movements: MovementWithSuggestion[];
      error?: string;
    } = { attachmentId, rawText, movements };

    if (aiError) {
      response.error = aiError;
    }

    res.json(response);
  });
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const movementItemSchema = z.object({
  amount: z.number().positive('amount must be a positive number'),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD'),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
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
    if (mv.category_id != null) {
      const check = await db.query<{ id: number }>(
        'SELECT id FROM categories WHERE id = $1',
        [mv.category_id]
      );
      if (check.rows.length === 0) {
        itemErrors[`movements.${i}.category_id`] = `Category ${mv.category_id} does not exist`;
      }
    }
  }

  if (Object.keys(itemErrors).length > 0) {
    res.status(400).json({ error: 'Validation failed', details: itemErrors });
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const created: Array<{ id: number; amount: string; date: string; description: string | null }> = [];
    for (const mv of movements) {
      const result = await client.query<{ id: number; amount: string; date: string; description: string | null }>(
        `INSERT INTO movements (amount, date, description, store, category_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING id, amount, date, description`,
        [mv.amount, mv.date, mv.description ?? null, mv.store ?? null, mv.category_id ?? null]
      );
      created.push(result.rows[0]);
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
    res.status(201).json({ created, count: created.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export default router;
