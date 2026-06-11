// Defense-in-depth for AI-extracted descriptions: a description must say what
// was purchased or what the merchant sells, never the payment instrument.
// When a description is predominantly payment vocabulary it is replaced with
// a cleaned store name (or dropped when there is no store).

const FORBIDDEN_TERMS = new Set([
  // Card brands and tiers
  'visa',
  'mastercard',
  'amex',
  'american',
  'express',
  'platinum',
  'black',
  'gold',
  'classic',
  // Payment instruments and actions (Spanish + English)
  'tarjeta',
  'card',
  'cash',
  'efectivo',
  'debito',
  'credito',
  'debit',
  'credit',
  'transaction',
  'transaccion',
  'compra',
  'purchase',
  'pago',
  'payment',
  'paid',
  // Bank-notification boilerplate
  'notificacion',
  'notification',
  'alerta',
  'alert',
  'banco',
  'bank',
]);

// Connector words that carry no meaning either way
const STOPWORDS = new Set([
  'a', 'an', 'the', 'at', 'of', 'on', 'in', 'for', 'with', 'to', 'your', 'was', 'and', 'or', 'by',
  'de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'por', 'para', 'su', 'un', 'una', 'y', 'o', 'fue',
]);

const CORPORATE_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'sa', 'sas', 'cia']);

function normalizeToken(token: string): string {
  // NFD then strip combining marks so 'crédito' matches 'credito'
  return token
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 0);
}

function titleCase(token: string): string {
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

export function cleanStoreName(store: string | null | undefined): string | null {
  if (store == null) return null;
  const tokens = tokenize(store);
  if (tokens.length === 0) return null;
  const withoutSuffixes = tokens.filter(t => !CORPORATE_SUFFIXES.has(normalizeToken(t)));
  const kept = withoutSuffixes.length > 0 ? withoutSuffixes : tokens;
  return kept.map(titleCase).join(' ');
}

export function sanitizeDescription(
  description: string | null | undefined,
  store: string | null | undefined
): string | null {
  if (description == null) return null;
  const trimmed = description.trim();
  if (trimmed === '') return null;

  let forbidden = 0;
  let meaningful = 0;
  for (const token of tokenize(trimmed)) {
    const normalized = normalizeToken(token);
    if (STOPWORDS.has(normalized) || /^\d+$/.test(normalized)) continue;
    if (FORBIDDEN_TERMS.has(normalized)) forbidden++;
    else meaningful++;
  }

  const predominantlyPayment = forbidden > 0 && forbidden > meaningful;
  if (!predominantlyPayment) return trimmed;

  return cleanStoreName(store);
}
