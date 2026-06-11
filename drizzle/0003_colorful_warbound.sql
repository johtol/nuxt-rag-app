CREATE TYPE "public"."message_type" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_chunk_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"character_count" integer,
	"word_count" integer,
	"heading_text" text,
	"heading_level" integer,
	"heading_line_number" integer,
	"metadata" jsonb,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" real,
	"snippet" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"type" "message_type" NOT NULL,
	"content" text NOT NULL,
	"is_streaming" boolean DEFAULT false NOT NULL,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"latency_ms" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "file_path" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "total_chunks" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sidebar" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_sources" ADD CONSTRAINT "message_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_sources" ADD CONSTRAINT "message_sources_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_external_chunk_id_unique_idx" ON "chunks" USING btree ("external_chunk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_chunk_index_unique_idx" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "message_sources_message_rank_idx" ON "message_sources" USING btree ("message_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "message_sources_message_chunk_unique_idx" ON "message_sources" USING btree ("message_id","chunk_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_role_idx" ON "messages" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_source_unique_idx" ON "documents" USING btree ("source");--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source");--> statement-breakpoint
CREATE INDEX "documents_slug_idx" ON "documents" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "content";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "chunk_index";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "embedding";