import { fileURLToPath } from 'node:url'
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
  similarity: number | string
}

export interface SimilarChunk {
  id: string
  externalChunkId: string
  documentId: string
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
      value: question,
    })

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
        -- Converts cosine distance to similarity in the 0-1 range.
        1 - (c.embedding <=> ${queryVector}::vector) as similarity
      from chunks c
      where c.embedding is not null
      order by similarity desc
      limit ${topK}
    `

    return rows.map((row) => ({
      id: row.id,
      externalChunkId: row.external_chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      headingText: row.heading_text,
      headingLevel: row.heading_level,
      headingLineNumber: row.heading_line_number,
      metadata: parseChunkMetadata(row.metadata),
      similarity: Number(row.similarity),
    }))
  } finally {
    await sql.end()
  }
}

/**
 * CLI entrypoint for ad-hoc retrieval debugging.
 * Reads a question from argv, fetches top similar chunks, and prints a
 * readable summary with similarity and source metadata.
 */
async function main() {
  const question = process.argv.slice(2).join(' ').trim()

  if (!question) {
    console.error('Usage: bun run semantic-search -- "your question here"')
    process.exit(1)
  }

  const rows = await searchSimilarChunks({ question, topK: 5 })
  const divider = '-'.repeat(72)

  console.log(`\nTop ${rows.length} results for: "${question}"\n${divider}`)

  rows.forEach((row, index) => {
    const pct = (row.similarity * 100).toFixed(2)
    const heading = row.headingText
      ? ` › ${row.headingLevel ? '#'.repeat(row.headingLevel) + ' ' : ''}${row.headingText}`
      : ''

    console.log(`\n#${index + 1}  [similarity: ${pct}%]${heading}`)
    console.log(`    Document : ${row.metadata.documentMetadata?.title ?? `Document ${row.documentId}`}`)
    console.log(`    Source   : ${row.metadata.source ?? 'N/A'}`)
    console.log(`    Chunk    : #${row.chunkIndex}  (id: ${row.id})`)
    console.log(`\n Chunk content:    ${row.content.replace(/\n/g, '\n    ')}`)
    console.log(`\n${divider}`)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('There was an error while querying the db:', error)
    process.exit(1)
  })
}
