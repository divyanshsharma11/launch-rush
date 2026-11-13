// Applies db/migrations/*.sql in name order, each file in its own transaction.
// Every applied file is recorded with a SHA-256 checksum; if an applied file is edited, the run stops
// (fix a schema with a new file instead). Files must not contain BEGIN/COMMIT: the runner owns the transaction.
// Connection settings come from the PG* env vars (see .env.example). Run: npm run migrate
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');
// Any fixed number; only this script uses it, so two runs never apply files at the same time.
const LOCK_KEY = 2026110301;

const client = new pg.Client();
await client.connect();

// BEGIN, take the transaction-level advisory lock (released by COMMIT/ROLLBACK), run work, COMMIT.
async function inLockedTransaction(work) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

try {
  await inLockedTransaction(() => client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    // Line endings normalised so a git CRLF/LF conversion alone is not seen as an edit.
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

    const applied = await inLockedTransaction(async () => {
      const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`${name} was changed after it was applied; add a new migration file instead`);
        }
        return false;
      }
      // No values passed, so pg sends the text as one simple query: a file may hold several statements.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      return true;
    });
    console.log(`${applied ? 'applied' : 'skipped (already applied)'} ${name}`);
  }
} finally {
  await client.end();
}
