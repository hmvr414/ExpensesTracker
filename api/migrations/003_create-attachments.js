/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('attachments', {
    id: { type: 'serial', primaryKey: true },
    movement_id: {
      type: 'integer',
      references: '"movements"',
      onDelete: 'SET NULL',
    },
    file_name: { type: 'text', notNull: true },
    file_path: { type: 'text', notNull: true },
    mime_type: { type: 'text', notNull: true },
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
  pgm.dropTable('attachments');
};
