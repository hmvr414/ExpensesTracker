/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('store_context', {
    // Normalized lowercase store name
    store: { type: 'text', primaryKey: true },
    // One-sentence summary of what the merchant sells; empty string when the
    // web lookup failed or found nothing (the row still marks the store as
    // searched so it is never searched again).
    summary: { type: 'text' },
    fetched_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('store_context');
};
