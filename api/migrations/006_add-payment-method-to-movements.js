/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('movements', {
    payment_method_id: {
      type: 'integer',
      references: '"payment_methods"',
      onDelete: 'SET NULL',
    },
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('movements', 'payment_method_id');
};
