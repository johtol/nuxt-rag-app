import postgres from 'postgres'
import { createVoyage } from '@ai-sdk/voyage'
import { embed } from 'ai'

export interface ChunkDocumentMetadata {
  title?: string
}

export interface ChunkMetadata {
  source?: string
  documentMetadata?: ChunkDocumentMetadata
  [key: string]: unknown
}

interface RawChunkRow {
  // Mirrors SQL aliases from the retrieval query below.
  id: string
  external_chunk_id: string
  document_id: string
  chunk_index: number
  content: string
  start_line: number | null
  end_line: number | null
  heading_text: string | null
  heading_level: number | null
  heading_line_number: number | null
  metadata: unknown
  document_title: string | null
  document_source: string | null
  document_slug: string | null
  similarity: number | string
}

export interface SimilarChunk {
  // Canonical document fields come from the `documents` table join.
  id: string
  externalChunkId: string
  documentId: string
  documentTitle: string | null
  documentSource: string | null
  documentSlug: string | null
  chunkIndex: number
  content: string
  startLine: number | null
  endLine: number | null
  headingText: string | null
  headingLevel: number | null
  headingLineNumber: number | null
  metadata: ChunkMetadata
  similarity: number
}

export interface SearchSimilarChunksOptions {
  question: string
  topK?: number
  databaseUrl?: string
}

/**
 * Normalizes chunk metadata from the database into a typed object.
 * Supports JSON strings and already-parsed objects, and falls back to
 * an empty object if parsing fails.
 */
export function parseChunkMetadata(metadata: unknown): ChunkMetadata {
  if (!metadata) {
    return {}
  }

  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as ChunkMetadata
    } catch {
      return {}
    }
  }

  if (typeof metadata === 'object') {
    return metadata as ChunkMetadata
  }

  return {}
}

/**
 * Runs semantic retrieval for a question:
 * 1) embeds the query with Voyage,
 * 2) performs pgvector similarity search,
 * 3) maps DB rows into typed `SimilarChunk` records.
 */
export async function searchSimilarChunks(options: SearchSimilarChunksOptions): Promise<SimilarChunk[]> {
  const question = options.question.trim()
  const topK = options.topK ?? 5

  if (!question) {
    throw new Error('Question is required')
  }

  if (!Number.isFinite(topK) || topK < 1) {
    throw new Error('topK must be a positive number')
  }

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not set')
  }

  const sql = postgres(databaseUrl)
  const voyage = createVoyage()
  const embeddingModel = voyage.textEmbeddingModel('voyage-large-2')

  try {
     const { embedding } = await embed({
       model: embeddingModel,
       value: question
     })

     // pgvector expects a textual vector literal when parameterizing from JS.
     const queryVector = `[${embedding.join(',')}]`
     const rows = await sql<RawChunkRow[]>`
       select
         c.id,
         c.external_chunk_id,
         c.document_id,
         c.chunk_index,
         c.content,
         c.start_line,
         c.end_line,
         c.heading_text,
         c.heading_level,
         c.heading_line_number,
         c.metadata,
         d.title as document_title,
         d.source as document_source,
         d.slug as document_slug,
         -- Converts cosine distance to similarity in the 0-1 range.
         1 - (c.embedding <=> ${queryVector}::vector) as similarity
       from chunks c
       -- Pull canonical title/source from parent document relation.
       inner join documents d on d.id = c.document_id
       where c.embedding is not null
       order by similarity desc
       limit ${topK}
     `

     return rows.map(row => ({
       id: row.id,
       externalChunkId: row.external_chunk_id,
       documentId: row.document_id,
       documentTitle: row.document_title,
       documentSource: row.document_source,
       documentSlug: row.document_slug,
       chunkIndex: row.chunk_index,
       content: row.content,
       startLine: row.start_line,
       endLine: row.end_line,
       headingText: row.heading_text,
       headingLevel: row.heading_level,
       headingLineNumber: row.heading_line_number,
       metadata: parseChunkMetadata(row.metadata),
       similarity: Number(row.similarity)
     }))
  } finally {
    await sql.end()
  }
}
