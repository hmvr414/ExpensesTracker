import { sanitizeDescription, cleanStoreName } from '../helpers/descriptionSanitizer';

describe('cleanStoreName', () => {
  it('title-cases the store and strips punctuation', () => {
    expect(cleanStoreName('EXITO COLOMBIA')).toBe('Exito Colombia');
  });

  it('drops corporate suffixes', () => {
    expect(cleanStoreName('OPENROUTER, INC')).toBe('Openrouter');
    expect(cleanStoreName('ACME LLC')).toBe('Acme');
  });

  it('keeps the name when it is only a corporate suffix', () => {
    expect(cleanStoreName('INC')).toBe('Inc');
  });

  it('returns null for empty or missing store', () => {
    expect(cleanStoreName('')).toBeNull();
    expect(cleanStoreName('   ')).toBeNull();
    expect(cleanStoreName(undefined)).toBeNull();
    expect(cleanStoreName(null)).toBeNull();
  });
});

describe('sanitizeDescription', () => {
  it('keeps a normal description unchanged', () => {
    expect(sanitizeDescription('Weekly groceries', 'EXITO')).toBe('Weekly groceries');
  });

  it('trims surrounding whitespace on kept descriptions', () => {
    expect(sanitizeDescription('  API credits  ', 'OPENROUTER, INC')).toBe('API credits');
  });

  it('replaces a predominantly payment-vocabulary description with the cleaned store name', () => {
    expect(
      sanitizeDescription('Compra con tarjeta Visa Platinum', 'OPENROUTER, INC')
    ).toBe('Openrouter');
  });

  it('strips a bare card brand description', () => {
    expect(sanitizeDescription('Visa', 'EXITO')).toBe('Exito');
  });

  it('handles Spanish payment vocabulary accent-insensitively', () => {
    expect(sanitizeDescription('Pago con tarjeta de crédito', 'EXITO')).toBe('Exito');
    expect(sanitizeDescription('Compra debito', 'EXITO')).toBe('Exito');
  });

  it('strips bank-notification boilerplate descriptions', () => {
    expect(
      sanitizeDescription('Notificación de compra con tarjeta', 'PANADERIA LA 70')
    ).toBe('Panaderia La 70');
  });

  it('ignores numbers and stopwords when judging predominance', () => {
    expect(sanitizeDescription('Compra tarjeta Visa 1234', 'EXITO')).toBe('Exito');
  });

  it('keeps descriptions where payment words are not the majority', () => {
    // 'gold' is forbidden but 'ring' carries the meaning — a tie is kept
    expect(sanitizeDescription('Gold ring', 'Jewelry Store')).toBe('Gold ring');
  });

  it('is case-insensitive on forbidden terms', () => {
    expect(sanitizeDescription('COMPRA TARJETA VISA', 'EXITO')).toBe('Exito');
  });

  it('returns null when a payment description has no store to fall back to', () => {
    expect(sanitizeDescription('Visa Platinum', undefined)).toBeNull();
    expect(sanitizeDescription('Visa Platinum', '')).toBeNull();
  });

  it('returns null for absent or empty descriptions', () => {
    expect(sanitizeDescription(undefined, 'EXITO')).toBeNull();
    expect(sanitizeDescription(null, 'EXITO')).toBeNull();
    expect(sanitizeDescription('   ', 'EXITO')).toBeNull();
  });
});
