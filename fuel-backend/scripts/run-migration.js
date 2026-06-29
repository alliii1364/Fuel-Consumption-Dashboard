/* eslint-disable */
// Lightweight SQL migration runner. Reads a .sql file, splits on `;` and
// executes each statement against the DB configured in .env.
// Usage: node scripts/run-migration.js migrations/001_dispatch.sql
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const file = process.argv[2] || 'migrations/001_dispatch.sql';
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  // Strip line comments, then split into statements.
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false,
    connectTimeout: 10000,
  });

  console.log(`Running ${statements.length} statement(s) from ${file}...`);
  for (const stmt of statements) {
    const label = stmt.slice(0, 60).replace(/\s+/g, ' ');
    await conn.query(stmt);
    console.log('  OK:', label, '...');
  }
  await conn.end();
  console.log('Migration complete.');
}

main().catch((e) => {
  console.error('Migration FAILED:', e.message);
  process.exit(1);
});
