/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('categories', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    color: { type: 'text' },
    icon: { type: 'text' },
    created_at: {
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
  pgm.dropTable('categories');
};
