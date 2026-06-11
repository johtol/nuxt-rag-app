import { index, integer,boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { conversations } from './conversations';

export const messageTypeEnum = pgEnum('message_type', ['user', 'ai']);
// export const messageStatusEnum = pgEnum('message_status', ['streaming', 'done', 'error']);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .references(() => conversations.id, { onDelete: 'cascade' })
      .notNull(),
    type: messageTypeEnum('type').notNull(),
    content: text('content').notNull(),
    isStreaming: boolean('is_streaming').default(false).notNull(),
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
    roleIdx: index('messages_role_idx').on(table.type),
  })
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageType = (typeof messageTypeEnum)[number];

