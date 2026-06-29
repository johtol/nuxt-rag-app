import { searchSimilarChunks } from './semantic-search.ts'

// Thin CLI wrapper around the reusable retrieval module.
async function main() {
  const question = process.argv.slice(2).join(' ').trim()
  const retrievalMode = (process.env.RAG_RETRIEVAL_MODE ?? 'semantic').trim().toLowerCase()

  if (!question) {
    console.error('Usage: bun run semantic-search -- "your question here"')
    process.exit(1)
  }

  const rows = await searchSimilarChunks({
    question,
    topK: 4,
    retrievalMode: retrievalMode === 'hybrid' ? 'hybrid' : 'semantic'
  })
  const divider = '-'.repeat(72)

  console.log(`\nTop ${rows.length} results for: "${question}"\n${divider}`)

  rows.forEach((row, index) => {
    console.log("row.scoreBreakDown:", row.scoreBreakdown)
    const pct = (row.similarity * 100).toFixed(2)
    const scoreLabel = retrievalMode === 'hybrid' ? 'hybrid score' : 'similarity'
    const heading = row.headingText
      ? ` > ${row.headingLevel ? '#'.repeat(row.headingLevel) + ' ' : ''}${row.headingText}`
      : ''
    const title = row.documentTitle ?? row.metadata.documentMetadata?.title ?? `Document ${row.documentId}`
    const source = row.documentSource ?? row.metadata.source ?? 'N/A'

    // Keep output human-readable for quick retrieval debugging.
    console.log(`\n#${index + 1}  [${scoreLabel}: ${pct}%]${heading}`)
    console.log(`    Document : ${title}`)
    console.log(`    Source   : ${source}`)
    console.log(`    Chunk    : #${row.chunkIndex}  (id: ${row.id})`)
    console.log(`\n Chunk content:    ${row.content.replace(/\n/g, '\n    ')}`)
    console.log(`\n${divider}`)
  })
}

main().catch((error) => {
  console.error('There was an error while querying the db:', error)
  process.exit(1)
})
