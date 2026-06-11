import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { z } from 'zod';
import OpenAI from 'openai';
import db, { getPool } from '../db';
import { suggestCategory, SuggestResult } from '../helpers/suggest';
import { resolveCategoryByName, ResolvedCategory } from '../helpers/categoryResolver';
import { runTesseract } from '../helpers/ocr';
import { parseAmount } from '../helpers/parseAmount';
import { sanitizeDescription } from '../helpers/descriptionSanitizer';
import { getRecentStoreDescriptions } from '../helpers/storeContext';

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
  rawAmountText?: string | null;
  date: string;
  description?: string;
  store?: string;
  paymentMethodId?: number | null;
  detectedPaymentLabel?: string | null;
  detectedBrand?: string | null;
  detectedVariant?: string | null;
}

interface MovementWithSuggestion extends Omit<ExtractedMovement, 'paymentMethodId' | 'detectedPaymentLabel' | 'detectedBrand' | 'detectedVariant' | 'rawAmountText'> {
  rawAmountText: string | null;
  amountSuspect: boolean;
  categoryId: number | null;
  categoryName?: string;
  color?: string;
  suggestedNewCategory: string | null;
  aiSuggested: boolean;
  paymentMethodId: number | null;
  paymentMethodName: string | null;
  detectedPaymentLabel: string | null;
  detectedBrand: string | null;
  detectedVariant: string | null;
  paymentAiSuggested: boolean;
}

interface PaymentMethodRow {
  id: number;
  name: string;
  kind: string;
  brand: string | null;
  variant: string | null;
}

const CANONICAL_BRANDS = ['visa', 'mastercard', 'amex', 'other'] as const;

function normalizeBrand(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, '');
  if (cleaned === '') return null;
  if ((CANONICAL_BRANDS as readonly string[]).includes(cleaned)) return cleaned;
  if (cleaned.includes('visa')) return 'visa';
  if (cleaned.includes('master')) return 'mastercard';
  if (cleaned.includes('amex') || cleaned.includes('americanexpress')) return 'amex';
  return 'other';
}

const AI_TIMEOUT_MS = 10_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The model's JSON is untrusted input: coerce or drop malformed rows so a
// bad amount or date can't flow through the suggestion and confirm pipeline.
// A row survives only with a positive numeric amount — recovered from
// rawAmountText (or a stringified amount) via parseAmount when the model
// returned garbage, in which case the row is flagged for review.
function normalizeRawMovement(
  raw: unknown,
  today: string
): (ExtractedMovement & { amountRecovered: boolean }) | null {
  if (typeof raw !== 'object' || raw == null) return null;
  const m = raw as Record<string, unknown>;

  const rawAmountText = typeof m.rawAmountText === 'string' ? m.rawAmountText : null;
  let amount =
    typeof m.amount === 'number' && Number.isFinite(m.amount) && m.amount > 0 ? m.amount : null;
  let amountRecovered = false;
  if (amount == null) {
    const recovered =
      (rawAmountText != null ? parseAmount(rawAmountText) : null) ??
      (typeof m.amount === 'string' ? parseAmount(m.amount) : null);
    if (recovered == null || recovered <= 0) return null;
    amount = recovered;
    amountRecovered = true;
  }

  return {
    amount,
    amountRecovered,
    rawAmountText,
    date: typeof m.date === 'string' && ISO_DATE.test(m.date) ? m.date : today,
    description: typeof m.description === 'string' ? m.description : undefined,
    store: typeof m.store === 'string' ? m.store : undefined,
    paymentMethodId: typeof m.paymentMethodId === 'number' ? m.paymentMethodId : null,
    detectedPaymentLabel: typeof m.detectedPaymentLabel === 'string' ? m.detectedPaymentLabel : null,
    detectedBrand: typeof m.detectedBrand === 'string' ? m.detectedBrand : null,
    detectedVariant: typeof m.detectedVariant === 'string' ? m.detectedVariant : null,
  };
}

// Known stores whose names appear in the OCR text contribute the user's own
// recent descriptions and any cached web summary to the extraction prompt,
// steering the model toward consistent, meaningful descriptions.
async function buildOcrStoreContextLines(rawText: string): Promise<string[]> {
  const lowerText = rawText.toLowerCase();
  if (lowerText.trim() === '') return [];
  const lines: string[] = [];
  try {
    const storeRows = await db.query<{ store: string }>(
      `SELECT DISTINCT store FROM movements WHERE store IS NOT NULL AND TRIM(store) <> ''`
    );
    const matchedStores = storeRows.rows
      .map(r => r.store.trim())
      .filter(s => s.length >= 3 && lowerText.includes(s.toLowerCase()))
      .slice(0, 3);
    for (const store of matchedStores) {
      const descriptions = await getRecentStoreDescriptions(store);
      if (descriptions.length > 0) {
        lines.push(
          `Descriptions this user previously wrote for ${store} (prefer consistency with their wording):`,
          ...descriptions.map(d => `- ${d}`),
          ''
        );
      }
    }

    const contextRows = await db.query<{ store: string; summary: string }>(
      `SELECT store, summary FROM store_context WHERE summary IS NOT NULL AND TRIM(summary) <> ''`
    );
    for (const row of contextRows.rows) {
      if (row.store.length >= 3 && lowerText.includes(row.store)) {
        lines.push(
          `Store context for ${row.store} (what this merchant sells): ${row.summary}`,
          ''
        );
      }
    }
  } catch {
    // Context is best-effort; extraction proceeds without it.
  }
  return lines;
}

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
    let language: string | null = null;
    let aiError: string | undefined;

    try {
      const pmResult = await db.query<PaymentMethodRow>(
        'SELECT id, name, kind, brand, variant FROM payment_methods ORDER BY name ASC'
      );
      const paymentMethods = pmResult.rows;
      const paymentMethodsById = new Map(paymentMethods.map(pm => [pm.id, pm]));

      const client = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY ?? '',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5';

      const storeContextLines = await buildOcrStoreContextLines(rawText);

      const prompt = [
        'Extract expense movements from the following OCR text from a receipt or financial document.',
        '',
        'OCR Text:',
        rawText || '(empty)',
        '',
        ...storeContextLines,
        "The user's registered payment methods:",
        JSON.stringify(
          paymentMethods.map(pm => ({
            id: pm.id, name: pm.name, kind: pm.kind, brand: pm.brand, variant: pm.variant,
          })),
          null,
          2
        ),
        '',
        'Return a JSON object with a "movements" array and a top-level "language" field.',
        '- language: string — the language the receipt text is written in, as a two-letter code ("es" for Spanish, "en" for English)',
        '',
        'Each movements item must have:',
        '- amount: number (positive) — the normalized amount as a plain JSON number',
        '- rawAmountText: string — the amount string exactly as it appears on the receipt, including separators and currency decoration (e.g. "40,313" or "$ 1.234,56 COP")',
        '- date: string (ISO YYYY-MM-DD format, use today if not found)',
        '- description: string (optional)',
        '- store: string (optional, the merchant or store name)',
        '- paymentMethodId: number or null — the id of the registered payment method the text identifies as used for the payment, or null',
        '- detectedPaymentLabel: string or null — only when the text clearly mentions a card or payment method but NO registered method matches: the raw detected string (e.g. "Visa Platinum")',
        '- detectedBrand: string or null — parsed card brand from the detected label (visa, mastercard, amex, other)',
        '- detectedVariant: string or null — parsed card tier/variant from the detected label (e.g. platinum, black, gold, classic)',
        '',
        'Description rules:',
        '- The description must say what was purchased or what the merchant sells — NEVER the payment instrument used to pay.',
        '- Forbidden in descriptions: card and payment vocabulary — "visa", "mastercard", "amex", "platinum", "black", "gold", "tarjeta", "card", "cash", "efectivo", "débito", "crédito", "transaction", "compra" — and bank-notification boilerplate.',
        "- For bank notification emails (e.g. DAVIbank purchase alerts), the description must describe the merchant's product or service, not the notification itself.",
        '',
        'Payment method matching rules:',
        '- Match the payment text against the registered methods on brand and variant even when the registered name differs (e.g. "tarjeta Visa Platinum" in a bank notification matches a registered card with brand visa and variant platinum regardless of its name).',
        '- When a registered method matches, set paymentMethodId and leave detectedPaymentLabel, detectedBrand and detectedVariant null.',
        '- When the text mentions a card but no registered method matches, set paymentMethodId null and fill detectedPaymentLabel, detectedBrand and detectedVariant.',
        '- When the text has no payment signal at all, set all four fields to null.',
        '- The text may be in Spanish or English. Spanish bank notification vocabulary: "tarjeta" (card), "compra" (purchase), "débito" (debit), "crédito" (credit), "efectivo" (cash). English equivalents: card, purchase, debit, credit, cash.',
        '',
        'Amount normalization rules:',
        '- Use receipt cues — language (Spanish vs. English), currency symbols/codes (COP, $, USD, EUR), and digit grouping — to disambiguate "," and ".".',
        '- In Spanish-language receipts both "," and "." are commonly thousands separators, and COP amounts rarely carry decimals: "40,313" on a Spanish bank notification is forty thousand three hundred thirteen, NOT forty point three.',
        '- When both separators appear, the last one is the decimal separator ("1.234,56" is 1234.56; "1,234.56" is 1234.56).',
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
        const parsed = JSON.parse(stripped) as { movements?: unknown[]; language?: string };
        const today = new Date().toISOString().split('T')[0];
        const rawMovements = (Array.isArray(parsed.movements) ? parsed.movements : [])
          .map(raw => normalizeRawMovement(raw, today))
          .filter((m): m is NonNullable<typeof m> => m != null);
        language = typeof parsed.language === 'string' ? parsed.language : null;
        const localeHint = language ?? undefined;

        // Dedupe suggestion calls within this extraction batch so identical
        // (store, description) rows don't trigger duplicate LLM calls.
        const suggestionCache = new Map<string, Promise<SuggestResult>>();
        const getSuggestion = (store?: string, description?: string): Promise<SuggestResult> => {
          const key = `${store ?? ''}\u0000${description ?? ''}`;
          let pending = suggestionCache.get(key);
          if (!pending) {
            pending = suggestCategory(store, description);
            suggestionCache.set(key, pending);
          }
          return pending;
        };

        movements = await Promise.all(
          rawMovements.map(async (m) => {
            // Defense-in-depth: a description that is predominantly payment
            // vocabulary is replaced with a cleaned store name (or dropped).
            const description = sanitizeDescription(m.description, m.store) ?? undefined;

            const suggestion = await getSuggestion(m.store, description);

            // Defend against hallucinated ids: only trust a paymentMethodId
            // that exists in the registered list.
            const matched = m.paymentMethodId != null
              ? paymentMethodsById.get(m.paymentMethodId)
              : undefined;

            // Defend against locale-confused amounts: the deterministic parse
            // of the raw receipt text wins over the model's number when they
            // disagree, and the row is flagged for the UI to verify. Rows
            // whose amount had to be recovered from text are flagged too.
            const rawAmountText = m.rawAmountText ?? null;
            const parsedAmount = rawAmountText != null ? parseAmount(rawAmountText, localeHint) : null;
            const amountSuspect =
              m.amountRecovered ||
              (parsedAmount != null && Math.abs(parsedAmount - m.amount) >= 0.005);
            const amount = parsedAmount != null && amountSuspect ? parsedAmount : m.amount;

            const { paymentMethodId: _id, detectedPaymentLabel, detectedBrand, detectedVariant, rawAmountText: _raw, amountRecovered: _recovered, ...rest } = m;
            return {
              ...rest,
              description,
              amount,
              rawAmountText,
              amountSuspect,
              categoryId: suggestion.categoryId,
              categoryName: suggestion.categoryName,
              color: suggestion.color,
              suggestedNewCategory: suggestion.suggestedNewCategory ?? null,
              aiSuggested: suggestion.categoryId != null,
              paymentMethodId: matched?.id ?? null,
              paymentMethodName: matched?.name ?? null,
              detectedPaymentLabel: matched ? null : detectedPaymentLabel ?? null,
              detectedBrand: matched ? null : normalizeBrand(detectedBrand),
              detectedVariant: matched ? null : detectedVariant ?? null,
              paymentAiSuggested: matched != null,
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

const movementItemSchema = z.object({
  amount: z.number().positive('amount must be a positive number'),
  date: z.string().regex(ISO_DATE, 'date must be ISO format YYYY-MM-DD'),
  description: z.string().optional(),
  store: z.string().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  payment_method_id: z.number().int().positive().nullable().optional(),
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
        `INSERT INTO movements (amount, date, description, store, category_id, payment_method_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         RETURNING id, amount, date, description, store, category_id, payment_method_id`,
        [mv.amount, mv.date, mv.description ?? null, mv.store ?? null, categoryId, mv.payment_method_id ?? null]
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
    res.status(201).json({
      created,
      count: created.length,
      resolvedCategories: [...resolvedByName.values()],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export default router;
