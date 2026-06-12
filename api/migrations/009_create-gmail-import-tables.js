/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('gmail_senders', {
    id: 'id',
    email: { type: 'text', notNull: true, unique: true },
    label: { type: 'text' },
    subject_contains: { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // One row per imported movement; an email with several movements gets
  // several rows. movement_id must survive movement deletion as NULL (the
  // email stays marked imported), so the pair cannot be a real primary key —
  // a unique index (NULLS DISTINCT) enforces the same shape while letting
  // ON DELETE SET NULL orphan any number of rows per message.
  pgm.createTable('gmail_imported_messages', {
    gmail_message_id: { type: 'text', notNull: true },
    movement_id: {
      type: 'integer',
      references: '"movements"',
      onDelete: 'SET NULL',
    },
    imported_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('gmail_imported_messages', ['gmail_message_id', 'movement_id'], {
    unique: true,
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('gmail_imported_messages');
  pgm.dropTable('gmail_senders');
};
