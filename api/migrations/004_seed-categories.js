const DEFAULT_CATEGORIES = [
  { name: 'Food', color: '#EF4444' },
  { name: 'Transport', color: '#3B82F6' },
  { name: 'Entertainment', color: '#8B5CF6' },
  { name: 'Health', color: '#10B981' },
  { name: 'Utilities', color: '#F59E0B' },
  { name: 'Shopping', color: '#EC4899' },
  { name: 'Other', color: '#6B7280' },
];

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  for (const cat of DEFAULT_CATEGORIES) {
    pgm.sql(
      `INSERT INTO categories (name, color) VALUES ('${cat.name}', '${cat.color}') ON CONFLICT (name) DO NOTHING`
    );
  }
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  const names = DEFAULT_CATEGORIES.map(c => `'${c.name}'`).join(', ');
  pgm.sql(`DELETE FROM categories WHERE name IN (${names})`);
};
