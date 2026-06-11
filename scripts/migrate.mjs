import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import postgres from 'postgres'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('[✗] DATABASE_URL is not set')
  process.exit(1)
}

const migrationsDir = resolve(process.cwd(), 'drizzle')
const journalPath = resolve(process.cwd(), 'drizzle/meta/_journal.json')

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function splitStatements(sqlText) {
  return sqlText
    .split('--> statement-breakpoint')
    .map(part => part.trim())
    .filter(Boolean)
}

async function migrate() {
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)

  const sql = postgres(databaseUrl, { max: 1 })

  try {
    // Keep drizzle migration bookkeeping compatible with drizzle-kit.
    await sql`create schema if not exists drizzle`
    await sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `

    const applied = await sql`
      select id, hash, created_at
      from drizzle.__drizzle_migrations
      order by id
    `

    if (applied.length > entries.length) {
      throw new Error(
        `Database has ${applied.length} applied migrations, but journal has only ${entries.length} entries.`
      )
    }

    for (let i = 0; i < applied.length; i += 1) {
      const entry = entries[i]
      const appliedRow = applied[i]
      const migrationPath = resolve(migrationsDir, `${entry.tag}.sql`)
      const exists = await fileExists(migrationPath)

      if (!exists) {
        console.warn(`[!] Historical migration file missing locally: ${entry.tag}.sql (already applied in DB)`)
        continue
      }

      const localSql = await readFile(migrationPath, 'utf8')
      const localHash = sha256(localSql)
      if (localHash !== appliedRow.hash) {
        throw new Error(
          `Hash mismatch for already-applied migration ${entry.tag}.sql. Local file differs from database history.`
        )
      }
    }

    const pending = entries.slice(applied.length)
    if (pending.length === 0) {
      console.log('[✓] No pending migrations')
      return
    }

    for (const entry of pending) {
      const migrationPath = resolve(migrationsDir, `${entry.tag}.sql`)
      if (!(await fileExists(migrationPath))) {
        throw new Error(`Missing pending migration file: ${entry.tag}.sql`)
      }

      const migrationSql = await readFile(migrationPath, 'utf8')
      const statements = splitStatements(migrationSql)

      console.log(`[i] Applying ${entry.tag}.sql (${statements.length} statements)`)

      await sql`begin`
      try {
        for (const statement of statements) {
          await sql.unsafe(statement)
        }

        await sql`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${sha256(migrationSql)}, ${BigInt(entry.when)})
        `

        await sql`commit`
      } catch (error) {
        await sql`rollback`
        throw new Error(`Failed in ${entry.tag}.sql: ${error.message}`)
      }
    }

    console.log('[✓] Migrations applied successfully')
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {})
  }
}

migrate().catch(error => {
  console.error('[✗] Migration failed')
  console.error(error)
  process.exit(1)
})

