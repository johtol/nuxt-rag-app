import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core';

import { documents } from './documents';

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    externalChunkId: text('external_chunk_id').notNull(),
    documentId: uuid('document_id')
      .references(() => documents.id, { onDelete: 'cascade' })
      .notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    characterCount: integer('character_count'),
    wordCount: integer('word_count'),
    headingText: text('heading_text'),
    headingLevel: integer('heading_level'),
    headingLineNumber: integer('heading_line_number'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    externalChunkIdUniqueIdx: uniqueIndex('chunks_external_chunk_id_unique_idx').on(table.externalChunkId),
    documentChunkUniqueIdx: uniqueIndex('chunks_document_chunk_index_unique_idx').on(table.documentId, table.chunkIndex),
    documentIdx: index('chunks_document_idx').on(table.documentId),
  })
);

export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

