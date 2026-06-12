/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('gmail_pending_imports', {
    gmail_message_id: { type: 'text', primaryKey: true },
    from_address: { type: 'text' },
    subject: { type: 'text' },
    email_date: { type: 'timestamptz' },
    movements: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('pending', 'error', 'dismissed')",
    },
    error: { type: 'text' },
    detected_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    extracted_at: { type: 'timestamptz' },
  });

  pgm.addColumns('gmail_connection', {
    last_polled_at: { type: 'timestamptz' },
    needs_reconnect: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });

  pgm.createIndex('gmail_pending_imports', ['status', 'email_date']);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('gmail_pending_imports', ['status', 'email_date']);
  pgm.dropColumns('gmail_connection', ['last_polled_at', 'needs_reconnect']);
  pgm.dropTable('gmail_pending_imports');
};
