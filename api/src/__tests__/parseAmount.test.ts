import { parseAmount } from '../helpers/parseAmount';

describe('parseAmount', () => {
  it("parses '40,313' as COP thousands → 40313", () => {
    expect(parseAmount('40,313', 'es')).toBe(40313);
  });

  it("parses '40.313' as Spanish thousands → 40313", () => {
    expect(parseAmount('40.313', 'es')).toBe(40313);
  });

  it("parses '1.234,56' (European format) → 1234.56", () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
  });

  it("parses '1,234.56' (US format) → 1234.56", () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
  });

  it("parses '40,31' (1–2 digits after separator) as decimal → 40.31", () => {
    expect(parseAmount('40,31')).toBe(40.31);
  });

  it("strips currency symbols and codes: '$ 40.313 COP' → 40313", () => {
    expect(parseAmount('$ 40.313 COP', 'es')).toBe(40313);
  });

  it("parses plain '40313' → 40313", () => {
    expect(parseAmount('40313')).toBe(40313);
  });

  it('treats a single separator followed by exactly 3 digits as thousands even without a locale hint', () => {
    expect(parseAmount('40,313')).toBe(40313);
  });

  it("parses '40.5' as a decimal → 40.5", () => {
    expect(parseAmount('40.5')).toBe(40.5);
  });

  it('treats repeated separators of the same kind as thousands groups', () => {
    expect(parseAmount('1,234,567')).toBe(1234567);
    expect(parseAmount('1.234.567')).toBe(1234567);
  });

  it('keeps a leading-zero integer part as a decimal even with 3 trailing digits', () => {
    expect(parseAmount('0.125')).toBe(0.125);
  });

  it('strips USD/EUR codes and the € symbol', () => {
    expect(parseAmount('USD 1,234.56')).toBe(1234.56);
    expect(parseAmount('1.234,56 €')).toBe(1234.56);
    expect(parseAmount('EUR 99')).toBe(99);
  });

  it('returns null for text with no digits', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('total')).toBeNull();
    expect(parseAmount('$')).toBeNull();
  });

  it('returns null for null-ish / whitespace input', () => {
    expect(parseAmount('   ')).toBeNull();
  });
});
