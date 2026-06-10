import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { execa } from 'execa';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('[✗] DATABASE_URL is not set');
  process.exit(1);
}

async function migrate() {
  const journalPath = resolve(process.cwd(), 'drizzle/meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const expectedMigrationCount = journal.entries.length;

  try {
    await execa('drizzle-kit', ['migrate'], { stdio: 'inherit' });
    console.log('[✓] Migrations applied successfully');
    process.exit(0);
  } catch (error) {
    console.log('[i] drizzle-kit exited with an error, checking actual database state...');

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const [migrationState] = await sql`
        SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations
      `;

      const columnState = await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'documents'
          AND column_name IN ('source', 'chunk_index', 'embedding')
        ORDER BY column_name
      `;

      const appliedColumns = new Set(columnState.map(row => row.column_name));
      const hasExpectedColumns = ['source', 'chunk_index', 'embedding']
        .every(column => appliedColumns.has(column));

      if (migrationState.count === expectedMigrationCount && hasExpectedColumns) {
        console.log('[✓] Migrations applied successfully');
        await sql.end();
        process.exit(0);
      }

      console.error('[✗] Migration verification failed');
      console.error(`Expected ${expectedMigrationCount} applied migrations, found ${migrationState.count}.`);
      console.error(`Verified columns: ${Array.from(appliedColumns).join(', ') || '(none)'}`);
    } catch (dbError) {
      console.error('[✗] Database check failed:', dbError);
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }

    console.error('[✗] Migration failed');
    console.error(error);
    process.exit(1);
  }
}

migrate();

