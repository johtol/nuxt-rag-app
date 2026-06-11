import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: text('source').notNull(),
    filePath: text('file_path'),
    slug: text('slug'),
    title: text('title').notNull(),
    totalChunks: integer('total_chunks'),
    pageType: text('page_type'),
    sidebar: text('sidebar'),
    checksum: text('checksum'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceUniqueIdx: uniqueIndex('documents_source_unique_idx').on(table.source),
    sourceIdx: index('documents_source_idx').on(table.source),
    slugIdx: index('documents_slug_idx').on(table.slug),
  })
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
