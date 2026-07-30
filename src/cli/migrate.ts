import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../infrastructure/database.js';
import { logger } from '../lib/logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const migrationsDirectory = path.join(root, 'database', 'migrations');

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const alreadyApplied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (alreadyApplied.rowCount) continue;
    const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    logger.info('Migracija je primijenjena.', { migracija: file });
  }
} finally {
  await pool.end();
}

