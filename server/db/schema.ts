import { integer, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';

export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  source: text('source'),
  chunkIndex: integer('chunk_index'),
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert