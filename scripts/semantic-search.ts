import postgres from 'postgres'
import { createVoyage } from '@ai-sdk/voyage'
import { embed } from 'ai'

const question = process.argv.slice(2).join(' ').trim()
console.log("question:", question)

if (!question) {
  console.error('Usage: bun run semantic-search -- "your question here"')
  process.exit(1)
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

if (!process.env.VOYAGE_API_KEY) {
  console.error('VOYAGE_API_KEY is not set')
  process.exit(1)
}

const sql = postgres(databaseUrl)
const voyage = createVoyage()
const embeddingModel = voyage.textEmbeddingModel('voyage-large-2')

async function main() {
  try {
    const { embedding } = await embed({
      model: embeddingModel,
      value: question
    })

    const queryVector = `[${embedding.join(',')}]`

    const rows = await sql`
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
        c.created_at,
        c.updated_at,
        -- Converts raw distance to a similarity score (0–1 range, higher = more similar).  <=> operator returns the 
        -- cosine distance between vectors, so we subtract from 1 to get similarity.
        1 - (c.embedding <=> ${queryVector}::vector) as similarity
      from chunks c
      where c.embedding is not null
      order by similarity desc
      limit 5
    `

    const DIVIDER = '─'.repeat(72)

    console.log(`\nTop ${rows.length} results for: "${question}"\n${DIVIDER}`)

    rows.forEach((row, i) => {
      const pct = (Number(row.similarity) * 100).toFixed(2)
      const relevant_meta = JSON.parse(row.metadata)
      const heading = row.heading_text
        ? ` › ${row.heading_level ? '#'.repeat(row.heading_level) + ' ' : ''}${row.heading_text}`
        : ''

      console.log(`\n#${i + 1}  [similarity: ${pct}%]`)
      console.log(`    Document : ${relevant_meta.documentMetadata.title}`)
      console.log(`    Source   : ${relevant_meta.source}`)
      console.log(`    Chunk    : #${row.chunk_index}  (id: ${row.id})`)
      console.log(`\n Chunk content:    ${row.content.replace(/\n/g, '\n    ')}`)
      console.log(`\n${DIVIDER}`)
    })

  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error("There was an error while querying the db:", error)
  process.exit(1)
})