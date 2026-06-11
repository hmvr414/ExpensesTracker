/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('payment_methods', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    kind: {
      type: 'text',
      notNull: true,
      check: "kind IN ('card', 'cash', 'bank_transfer', 'other')",
    },
    brand: { type: 'text' },
    variant: { type: 'text' },
    last4: { type: 'char(4)' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.sql(
    `INSERT INTO payment_methods (name, kind) VALUES ('Cash', 'cash') ON CONFLICT (name) DO NOTHING`
  );
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('payment_methods');
};
