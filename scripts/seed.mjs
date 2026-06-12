import postgres from 'postgres'
import { createVoyage } from '@ai-sdk/voyage'
import { embedMany } from 'ai'

/**
 * Database seed script
 *
 * Reads chunks.json and seeds the database with:
 * - Unique documents (deduplicated by source)
 * - Document chunks (with full metadata including heading context)
 * - Embeddings for each chunk generated via Voyage AI
 *
 * Run: bun run db:seed
 */

import { readFile } from 'node:fs/promises'

// Initialize Voyage AI client and embedding model once for the whole script.
const voyage = createVoyage()
const embeddingModel = voyage.textEmbeddingModel('voyage-large-2')

const EMBEDDING_BATCH_SIZE = 50

// Database connection URL is required to write documents/chunks.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[✗] DATABASE_URL is not set')
  process.exit(1)
}

// AI SDK's Voyage provider reads this env var for authentication.
if (!process.env.VOYAGE_API_KEY) {
  console.error('[x] VOYAGE_API_KEY environment variable is not set')
  process.exit(1)
}

const sql = postgres(databaseUrl)

// Produce richer diagnostics than only error.message (helpful for SQL constraint failures).
function formatError(error) {
  if (!error || typeof error !== 'object') {
    return String(error)
  }

  const details = []
  if (error.message) details.push(`message=${error.message}`)
  if (error.code) details.push(`code=${error.code}`)
  if (error.detail) details.push(`detail=${error.detail}`)
  if (error.constraint) details.push(`constraint=${error.constraint}`)
  if (error.where) details.push(`where=${error.where}`)

  return details.length > 0 ? details.join(' | ') : JSON.stringify(error)
}

/**
 * Generate embeddings for an array of text chunks using Voyage AI.
 * @param chunksList
 * @returns {Promise<any[]>}
 */
async function generateEmbeddings(chunksList) {
  console.log('[i] Generating embeddings for chunks...')
  // Keep array positions aligned with chunksList indices.
  const embeddings = new Array(chunksList.length)

  try {
    // Embed in batches to avoid payload/rate-limit spikes.
    for (let i = 0; i < chunksList.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunksList.slice(i, i + EMBEDDING_BATCH_SIZE)
      const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, chunksList.length)

      console.log(`[i] Embedding batch ${i + 1}–${batchEnd} of ${chunksList.length}...`)

      const { embeddings: batchEmbeddings } = await embedMany({
        model: embeddingModel,
        values: batch.map((chunk) => {
          return chunk.content
        })
      })

      // Copy each batch embedding into its original global index.
      for (let j = 0; j < batchEmbeddings.length; j++) {
        embeddings[i + j] = batchEmbeddings[j]
      }
    }

    console.log('[✓] Embeddings generated')
    return embeddings
  } catch (error) {
    console.error('[✗] Failed to generate embeddings:', formatError(error))
    throw error
  }
}

async function seed() {
  try {
    // 1) Load source chunks produced by chunking pipeline.
    console.log('[i] Reading chunks.json...')
    const chunksJson = JSON.parse(await readFile('chunks.json', 'utf8'))
    const chunksList = Array.isArray(chunksJson.chunks) ? chunksJson.chunks : []
    console.log(`[i] Found ${chunksList.length} chunks`)

    if (chunksList.length === 0) {
      throw new Error('No chunks found in chunks.json')
    }

    // 2) Build a unique document set from chunk metadata (source acts as identity).
    const uniqueDocs = new Map()

    for (const chunk of chunksList) {
      const { source, filePath, totalChunks, documentMetadata } = chunk.metadata
      if (!uniqueDocs.has(source)) {
        uniqueDocs.set(source, {
          source,
          filePath,
          totalChunks,
          title: documentMetadata.title,
          slug: documentMetadata.slug,
          pageType: documentMetadata['page-type'],
          sidebar: documentMetadata.sidebar
        })
      }
    }

    console.log(`[i] Found ${uniqueDocs.size} unique documents`)
    const docMap = new Map() // source -> id

    // 3) Upsert documents first so chunk rows can reference document IDs.
    console.log('[i] Upserting documents...')
    for (const doc of uniqueDocs.values()) {
      const result = await sql`
        insert into documents (
          source, file_path, title, slug, page_type, sidebar, total_chunks, metadata, created_at, updated_at
        ) values (
          ${doc.source},
          ${doc.filePath},
          ${doc.title},
          ${doc.slug},
          ${doc.pageType},
          ${doc.sidebar},
          ${doc.totalChunks},
          ${JSON.stringify({
            'page-type': doc.pageType,
            'slug': doc.slug,
            'sidebar': doc.sidebar
          })},
          now(),
          now()
        )
        on conflict (source) do update set
          file_path = excluded.file_path,
          title = excluded.title,
          slug = excluded.slug,
          page_type = excluded.page_type,
          sidebar = excluded.sidebar,
          total_chunks = excluded.total_chunks,
          metadata = excluded.metadata,
          updated_at = now()
        returning id
      `

      docMap.set(doc.source, result[0].id)
    }

    // 4) Generate embeddings before chunk upsert.
    const embeddings = await generateEmbeddings(chunksList)

    // 5) Upsert chunks with embedding vectors.
    console.log('[i] Upserting chunks...')
    let insertedCount = 0

    for (let i = 0; i < chunksList.length; i++) {
      const chunk = chunksList[i]
      const { id: externalChunkId, content, metadata } = chunk
      const { chunkIndex, startLine, endLine, characterCount, wordCount, headingContext, source } = metadata

      const documentId = docMap.get(source)
      if (!documentId) {
        console.warn(`[!] Could not find document ID for source: ${source}`)
        continue
      }

      const embedding = embeddings[i]
      if (!embedding) {
        throw new Error(`Missing embedding for chunk index ${i} (${externalChunkId})`)
      }

      // pgvector literal format expected by Postgres: [n1,n2,...]::vector
      const embeddingVector = `[${embedding.join(',')}]`

      await sql`
        insert into chunks (
          external_chunk_id, document_id, chunk_index, content, start_line, end_line,
          character_count, word_count, heading_text, heading_level, heading_line_number,
          metadata, embedding, created_at, updated_at
        ) values (
          ${externalChunkId},
          ${documentId},
          ${chunkIndex},
          ${content},
          ${startLine || null},
          ${endLine || null},
          ${characterCount || null},
          ${wordCount || null},
          ${headingContext?.text || null},
          ${headingContext?.level || null},
          ${headingContext?.lineNumber || null},
          ${JSON.stringify(metadata)},
          ${embeddingVector}::vector,
          now(),
          now()
        )
        on conflict (external_chunk_id) do update set
          document_id = excluded.document_id,
          chunk_index = excluded.chunk_index,
          content = excluded.content,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          character_count = excluded.character_count,
          word_count = excluded.word_count,
          heading_text = excluded.heading_text,
          heading_level = excluded.heading_level,
          heading_line_number = excluded.heading_line_number,
          metadata = excluded.metadata,
          embedding = excluded.embedding,
          updated_at = now()
      `

      insertedCount += 1
      if (insertedCount % 100 === 0) {
        console.log(`[i] Upserted ${insertedCount}/${chunksList.length} chunks...`)
      }
    }

    // 6) Final success summary.
    console.log('[✓] Database seeded successfully')
    console.log(`  - Documents: ${uniqueDocs.size}`)
    console.log(`  - Chunks: ${insertedCount}`)
  } catch (error) {
    // Keep one detailed failure log at seed-level for quick triage.
    console.error('[✗] Seed failed:', formatError(error))
    throw error
  } finally {
    // Always close the DB connection, even after failures.
    await sql.end()
  }
}

seed().catch((error) => {
  console.error('[✗] Seed failed with fatal error:', formatError(error))
  process.exit(1)
})
