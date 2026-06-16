import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.ts'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

const globalForDb = globalThis as {
  sql?: ReturnType<typeof postgres>
}

const connectionString
  = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5455/example'

const sql
  = globalForDb.sql
    ?? postgres(connectionString, {
      max: 10,
      prepare: false
    })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.sql = sql
}

// expo
export const db = drizzle(sql, {
  schema,
  logger: process.env.NODE_ENV === 'development'
})

// export schema for convenience
export * from './schema'
