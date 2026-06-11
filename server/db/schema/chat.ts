import { index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { documents } from './documents';

export const messageRoleEnum = pgEnum('message_role', ['system', 'user', 'assistant', 'tool']);
export const messageStatusEnum = pgEnum('message_status', ['streaming', 'done', 'error']);

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id'),
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .references(() => conversations.id, { onDelete: 'cascade' })
      .notNull(),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    status: messageStatusEnum('status').default('done').notNull(),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    latencyMs: integer('latency_ms'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    conversationCreatedAtIdx: index('messages_conversation_created_at_idx').on(table.conversationId, table.createdAt),
    roleIdx: index('messages_role_idx').on(table.role),
  })
);

export const messageSources = pgTable(
  'message_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .references(() => messages.id, { onDelete: 'cascade' })
      .notNull(),
    documentId: uuid('document_id')
      .references(() => documents.id, { onDelete: 'cascade' })
      .notNull(),
    rank: integer('rank').notNull(),
    score: real('score'),
    snippet: text('snippet'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    messageRankIdx: index('message_sources_message_rank_idx').on(table.messageId, table.rank),
    messageDocumentUniqueIdx: uniqueIndex('message_sources_message_document_unique_idx').on(
      table.messageId,
      table.documentId
    ),
  })
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageSource = typeof messageSources.$inferSelect;
export type NewMessageSource = typeof messageSources.$inferInsert;

