import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../infrastructure/database.js';
import { logger } from '../lib/logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

try {
  const sql = await readFile(path.join(root, 'database', 'seed.sql'), 'utf8');
  await pool.query(sql);
  logger.info('Demo tenant i univerzalna konfiguracija su uneseni.');
} finally {
  await pool.end();
}

