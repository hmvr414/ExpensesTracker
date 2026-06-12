import OpenAI from 'openai';
import db from '../db';
import { suggestCategory, SuggestResult } from './suggest';
import { parseAmount } from './parseAmount';
import { sanitizeDescription } from './descriptionSanitizer';
import { getRecentStoreDescriptions } from './storeContext';

export interface ExtractedMovement {
  amount: number;
  rawAmountText?: string | null;
  date: string;
  time?: string | null;
  description?: string;
  store?: string;
  paymentMethodId?: number | null;
  detectedPaymentLabel?: string | null;
  detectedBrand?: string | null;
  detectedVariant?: string | null;
}

export interface MovementWithSuggestion extends Omit<ExtractedMovement, 'paymentMethodId' | 'detectedPaymentLabel' | 'detectedBrand' | 'detectedVariant' | 'rawAmountText'> {
  rawAmountText: string | null;
  amountSuspect: boolean;
  possibleDuplicate: boolean;
  duplicateOf: DuplicateSummary | null;
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

interface DuplicateSummary {
  id: number | null;
  date: string;
  time: string | null;
  description: string | null;
}

export interface ExtractMovementsResult {
  language: string | null;
  movements: MovementWithSuggestion[];
  error?: string;
}

const CANONICAL_BRANDS = ['visa', 'mastercard', 'amex', 'other'] as const;
const AI_TIMEOUT_MS = 10_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TWENTY_FOUR_HOUR_TIME = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const TWELVE_HOUR_TIME = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*([ap])\.?\s*m\.?$/i;

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

function normalizeExtractedTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b([ap])\s*\.\s*m\s*\.?$/i, '$1m');

  const twelve = cleaned.match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*([ap])m$/i);
  if (twelve) {
    let hour = Number(twelve[1]);
    if (hour < 1 || hour > 12) return null;
    if (twelve[3].toLowerCase() === 'p' && hour !== 12) hour += 12;
    if (twelve[3].toLowerCase() === 'a' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${twelve[2]}`;
  }

  const spacedTwelve = cleaned.match(TWELVE_HOUR_TIME);
  if (spacedTwelve) {
    let hour = Number(spacedTwelve[1]);
    if (hour < 1 || hour > 12) return null;
    if (spacedTwelve[3].toLowerCase() === 'p' && hour !== 12) hour += 12;
    if (spacedTwelve[3].toLowerCase() === 'a' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${spacedTwelve[2]}`;
  }

  const twentyFour = cleaned.match(TWENTY_FOUR_HOUR_TIME);
  if (!twentyFour) return null;
  return `${String(Number(twentyFour[1])).padStart(2, '0')}:${twentyFour[2]}`;
}

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
    time: normalizeExtractedTime(m.time),
    description: typeof m.description === 'string' ? m.description : undefined,
    store: typeof m.store === 'string' ? m.store : undefined,
    paymentMethodId: typeof m.paymentMethodId === 'number' ? m.paymentMethodId : null,
    detectedPaymentLabel: typeof m.detectedPaymentLabel === 'string' ? m.detectedPaymentLabel : null,
    detectedBrand: typeof m.detectedBrand === 'string' ? m.detectedBrand : null,
    detectedVariant: typeof m.detectedVariant === 'string' ? m.detectedVariant : null,
  };
}

async function buildStoreContextLines(rawText: string): Promise<string[]> {
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

function buildPrompt(rawText: string, paymentMethods: PaymentMethodRow[], storeContextLines: string[]): string {
  return [
    'Extract expense movements from the following OCR text from a receipt, financial document, or bank notification email.',
    '',
    'Text:',
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
    '- language: string — the language the text is written in, as a two-letter code ("es" for Spanish, "en" for English)',
    '',
    'Each movements item must have:',
    '- amount: number (positive) — the normalized amount as a plain JSON number',
    '- rawAmountText: string — the amount string exactly as it appears on the receipt or notification, including separators and currency decoration (e.g. "40,313" or "$ 1.234,56 COP")',
    '- date: string (ISO YYYY-MM-DD format, use today if not found)',
    '- time: string or null — wall-clock time shown on the receipt/notification, normalized to 24-hour "HH:MM", or null when no time is shown',
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
    'Time normalization rules:',
    '- Extract the purchase time when it appears in the text; otherwise set time to null.',
    '- Normalize Spanish/English time formats to 24-hour "HH:MM": "14:32" stays "14:32"; "2:32 PM" becomes "14:32"; "02:32 p. m." becomes "14:32".',
    '',
    'Return { "movements": [] } if no expenses can be identified.',
  ].join('\n');
}

function normalizeStoreKey(store: string | null | undefined): string | null {
  const normalized = store?.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized ? normalized : null;
}

function duplicateMatches(candidate: { time?: string | null }, existing: { time: string | null }): boolean {
  return !(candidate.time != null && existing.time != null && candidate.time !== existing.time);
}

async function annotateDuplicates<T extends MovementWithSuggestion>(movements: T[]): Promise<T[]> {
  const seen: Array<{
    storeKey: string;
    amount: number;
    date: string;
    time: string | null;
    description: string | null;
  }> = [];

  const annotated: T[] = [];
  for (const movement of movements) {
    const storeKey = normalizeStoreKey(movement.store);
    let duplicateOf: DuplicateSummary | null = null;

    if (storeKey != null) {
      const existing = await db.query<DuplicateSummary>(
        `SELECT id, date::text, to_char(time, 'HH24:MI') AS time, description
         FROM movements
         WHERE lower(trim(store)) = $1
           AND amount = $2
           AND date = $3
         ORDER BY created_at DESC
         LIMIT 10`,
        [storeKey, movement.amount, movement.date]
      );
      duplicateOf =
        existing.rows.find((row) => duplicateMatches(movement, row)) ?? null;

      if (duplicateOf == null) {
        const batchDuplicate = seen.find(
          (row) =>
            row.storeKey === storeKey &&
            row.amount === movement.amount &&
            row.date === movement.date &&
            duplicateMatches(movement, row)
        );
        if (batchDuplicate) {
          duplicateOf = {
            id: null,
            date: batchDuplicate.date,
            time: batchDuplicate.time,
            description: batchDuplicate.description,
          };
        }
      }
    }

    const next = {
      ...movement,
      possibleDuplicate: duplicateOf != null,
      duplicateOf,
    };
    annotated.push(next);

    if (storeKey != null) {
      seen.push({
        storeKey,
        amount: movement.amount,
        date: movement.date,
        time: movement.time ?? null,
        description: movement.description ?? null,
      });
    }
  }

  return annotated;
}

export async function extractMovementsFromText(rawText: string): Promise<ExtractMovementsResult> {
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
    const storeContextLines = await buildStoreContextLines(rawText);
    const prompt = buildPrompt(rawText, paymentMethods, storeContextLines);

    const completion = await Promise.race([
      client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('AI extraction timeout')), AI_TIMEOUT_MS).unref();
      }),
    ]);

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return { language: null, movements: [] };
    }

    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped) as { movements?: unknown[]; language?: string };
    const today = new Date().toISOString().split('T')[0];
    const rawMovements = (Array.isArray(parsed.movements) ? parsed.movements : [])
      .map(raw => normalizeRawMovement(raw, today))
      .filter((m): m is NonNullable<typeof m> => m != null);
    const language = typeof parsed.language === 'string' ? parsed.language : null;
    const localeHint = language ?? undefined;

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

    const movements = await Promise.all(
      rawMovements.map(async (m) => {
        const description = sanitizeDescription(m.description, m.store) ?? undefined;
        const suggestion = await getSuggestion(m.store, description);
        const matched = m.paymentMethodId != null
          ? paymentMethodsById.get(m.paymentMethodId)
          : undefined;

        const rawAmountText = m.rawAmountText ?? null;
        const parsedAmount = rawAmountText != null ? parseAmount(rawAmountText, localeHint) : null;
        const amountSuspect =
          m.amountRecovered ||
          (parsedAmount != null && Math.abs(parsedAmount - m.amount) >= 0.005);
        const amount = parsedAmount != null && amountSuspect ? parsedAmount : m.amount;

        const {
          paymentMethodId: _id,
          detectedPaymentLabel,
          detectedBrand,
          detectedVariant,
          rawAmountText: _raw,
          amountRecovered: _recovered,
          ...rest
        } = m;
        return {
          ...rest,
          description,
          amount,
          rawAmountText,
          amountSuspect,
          possibleDuplicate: false,
          duplicateOf: null,
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

    return { language, movements: await annotateDuplicates(movements) };
  } catch {
    return { language: null, movements: [], error: 'AI extraction failed' };
  }
}
