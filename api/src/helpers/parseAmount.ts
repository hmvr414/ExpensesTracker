/**
 * Deterministic normalizer for amount strings as they appear on receipts.
 *
 * Rules (in order):
 * - Currency symbols, currency codes, and whitespace are stripped first.
 * - When both '.' and ',' are present, the last separator is the decimal
 *   separator ('1.234,56' → 1234.56, '1,234.56' → 1234.56).
 * - A separator that appears more than once is a thousands separator
 *   ('1,234,567' → 1234567).
 * - A single separator followed by exactly 3 digits is a thousands separator
 *   ('40,313' → 40313) — in Spanish/COP receipts both ',' and '.' commonly
 *   group thousands and COP amounts rarely carry decimals; with only one
 *   separator there is no other decimal evidence, so this holds regardless of
 *   the locale hint. Exception: an integer part of '0' (or empty) can only be
 *   a decimal ('0.125' → 0.125).
 * - A single separator followed by 1–2 (or 4+) digits is a decimal separator
 *   ('40,31' → 40.31).
 *
 * Returns null when no numeric value can be extracted.
 */
export function parseAmount(rawText: string, _localeHint?: string): number | null {
  if (!rawText) return null;

  // Strip everything that is not a digit or a separator: currency symbols
  // ($, €, £, ¥), currency codes (COP, USD, EUR, ...), and whitespace.
  const cleaned = rawText.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  let normalized: string;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: the last one is the decimal separator.
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    normalized = cleaned.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = cleaned.split(sep);
    const fraction = parts[parts.length - 1];
    const integer = parts.slice(0, -1).join('');
    if (parts.length > 2) {
      // Same separator repeated: thousands groups.
      normalized = parts.join('');
    } else if (fraction.length === 3 && integer !== '' && integer !== '0') {
      // Exactly 3 trailing digits with no other decimal evidence: thousands.
      normalized = integer + fraction;
    } else {
      normalized = `${integer || '0'}.${fraction}`;
    }
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
