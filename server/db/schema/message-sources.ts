import { index, integer, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { chunks } from './chunks';
import { messages } from './messages';

export const messageSources = pgTable(
  'message_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .references(() => messages.id, { onDelete: 'cascade' })
      .notNull(),
    chunkId: uuid('chunk_id')
      .references(() => chunks.id, { onDelete: 'cascade' })
      .notNull(),
    rank: integer('rank').notNull(),
    score: real('score'),
    snippet: text('snippet'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    messageRankIdx: index('message_sources_message_rank_idx').on(table.messageId, table.rank),
    messageChunkUniqueIdx: uniqueIndex('message_sources_message_chunk_unique_idx').on(table.messageId, table.chunkId),
  })
);

export type MessageSource = typeof messageSources.$inferSelect;
export type NewMessageSource = typeof messageSources.$inferInsert;

