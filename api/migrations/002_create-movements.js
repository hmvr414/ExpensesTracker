/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('movements', {
    id: { type: 'serial', primaryKey: true },
    amount: { type: 'numeric(12,2)', notNull: true },
    date: { type: 'date', notNull: true },
    description: { type: 'text' },
    store: { type: 'text' },
    category_id: {
      type: 'integer',
      references: '"categories"',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
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
  pgm.dropTable('movements');
};
