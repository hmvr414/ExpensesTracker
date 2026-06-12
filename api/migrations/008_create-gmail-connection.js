/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Single-row table (single-user app): connecting again replaces the
  // existing row.
  pgm.createTable('gmail_connection', {
    id: 'id',
    google_email: { type: 'text', notNull: true },
    access_token: { type: 'text', notNull: true },
    refresh_token: { type: 'text', notNull: true },
    token_expiry: { type: 'timestamptz', notNull: true },
    connected_at: {
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
  pgm.dropTable('gmail_connection');
};
