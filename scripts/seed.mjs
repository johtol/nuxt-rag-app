import postgres from 'postgres'

/**
 * Database seed script
 * 
 * Reads chunks.json and seeds the database with:
 * - Unique documents (deduplicated by source)
 * - Document chunks (with full metadata including heading context)
 * 
 * Run: bun run db:seed
 */

import { readFile } from 'node:fs/promises'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[✗] DATABASE_URL is not set')
  process.exit(1)
}

const sql = postgres(databaseUrl)

async function seed() {
  console.log('[i] Reading chunks.json...')
  const chunksJson = JSON.parse(await readFile('chunks.json', 'utf8'))

  const chunksList = chunksJson.chunks
  console.log(`[i] Found ${chunksList.length} chunks`)

  // Deduplicate documents by source
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

  console.log('[i] Inserting documents...')
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
          slug: doc.slug,
          sidebar: doc.sidebar
        })},
        now(),
        now()
      )
      returning id
    `

    docMap.set(doc.source, result[0].id)
  }

  console.log('[i] Inserting chunks...')
  let insertedCount = 0

  for (const chunk of chunksList) {
    const { id: externalChunkId, content, metadata } = chunk
    const { chunkIndex, startLine, endLine, characterCount, wordCount, headingContext, source } = metadata

    const documentId = docMap.get(source)
    if (!documentId) {
      console.warn(`[!] Could not find document ID for source: ${source}`)
      continue
    }

    try {
      await sql`
        insert into chunks (
          external_chunk_id, document_id, chunk_index, content, start_line, end_line,
          character_count, word_count, heading_text, heading_level, heading_line_number,
          metadata, created_at, updated_at
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
          now(),
          now()
        )
      `

      insertedCount += 1
      if (insertedCount % 100 === 0) {
        console.log(`[i] Inserted ${insertedCount}/${chunksList.length} chunks...`)
      }
    } catch (error) {
      console.error(`[✗] Failed to insert chunk ${externalChunkId}:`, error.message)
      throw error
    }
  }

  console.log('[✓] Database seeded successfully')
  console.log(`  - Documents: ${uniqueDocs.size}`)
  console.log(`  - Chunks: ${insertedCount}`)

  await sql.end()
}

seed().catch(error => {
  console.error('[✗] Seed failed:', error.message)
  process.exit(1)
})

