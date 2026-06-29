ALTER TABLE "chunks"
ADD COLUMN "search_vector" tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("content", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("heading_text", '')), 'B') ||
  setweight(to_tsvector('english', coalesce("metadata" -> 'documentMetadata' ->> 'title', '')), 'C')
) STORED;--> statement-breakpoint
-- Create GIN index fir fast full-text search
CREATE INDEX "chunks_search_vector_idx" ON "chunks" USING gin ("search_vector");