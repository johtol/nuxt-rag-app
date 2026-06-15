import postgres from 'postgres'
import { createVoyage } from '@ai-sdk/voyage'
import { embed } from 'ai'

const question = process.argv.slice(2).join(' ').trim()
const topK = Number(process.env.RAG_TOP_K ?? 5)
const minSimilarity = Number(process.env.RAG_MIN_SIMILARITY ?? 0.6)
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'

if (!question) {
  console.error('Usage: bun run rag:ask -- "your question here"')
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

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set')
  process.exit(1)
}

if (!Number.isFinite(topK) || topK < 1) {
  console.error('RAG_TOP_K must be a positive number')
  process.exit(1)
}

if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
  console.error('RAG_MIN_SIMILARITY must be a number between 0 and 1')
  process.exit(1)
}

const sql = postgres(databaseUrl)
const voyage = createVoyage()
const embeddingModel = voyage.textEmbeddingModel('voyage-large-2')

function parseMetadata(metadata: unknown) {
  if (!metadata) {
    return {}
  }

  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata)
    } catch {
      return {}
    }
  }

  if (typeof metadata === 'object') {
    return metadata as Record<string, unknown>
  }

  return {}
}

async function getAnswerFromOpenAI(prompt: string) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: openAiModel,
      temperature: 0.2,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'You are a RAG assistant. Use only the provided context to answer. If the answer is not in the context, say that clearly and suggest what is missing.',
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI error (${response.status}): ${errorText}`)
  }

  const payload = await response.json() as {
    output_text?: string
    output?: Array<{ content?: Array<{ text?: string }> }>
  }
  const answer = payload.output_text?.trim() ?? payload.output?.[0]?.content?.[0]?.text?.trim()

  if (!answer) {
    throw new Error('OpenAI response did not include output_text')
  }

  return answer
}

async function main() {
  try {
    // Step 1: Embed the user question so we can do vector similarity search.
    const { embedding } = await embed({
      model: embeddingModel,
      value: question,
    })

    const queryVector = `[${embedding.join(',')}]`

    // Step 2: Retrieve the top-K nearest chunks from pgvector.
    const rows = await sql`
      select
        c.id,
        c.document_id,
        c.chunk_index,
        c.content,
        c.heading_text,
        c.heading_level,
        c.metadata,
        1 - (c.embedding <=> ${queryVector}::vector) as similarity
      from chunks c
      where c.embedding is not null
      order by similarity desc
      limit ${topK}
    `

    if (rows.length === 0) {
      console.log('No indexed chunks were found. Seed your DB before running RAG queries.')
      return
    }

    // Step 3: Keep only chunks above a configurable similarity floor.
    // This avoids grounding the LLM on weakly-related context.
    const filteredRows = rows.filter((row) => Number(row.similarity) >= minSimilarity)

    if (filteredRows.length === 0) {
      console.log(
        `No chunks met the similarity threshold (${minSimilarity}). Try lowering RAG_MIN_SIMILARITY or rephrasing your question.`
      )
      return
    }

    // Step 4: Build a structured context block that includes source metadata.
    const context = filteredRows
      .map((row, index) => {
        const metadata = parseMetadata(row.metadata) as {
          source?: string
          documentMetadata?: { title?: string }
        }
        const title = metadata.documentMetadata?.title ?? `Document ${row.document_id}`
        const heading = row.heading_text
          ? `${row.heading_level ? '#'.repeat(row.heading_level) + ' ' : ''}${row.heading_text}`
          : 'No heading'
        const similarity = (Number(row.similarity) * 100).toFixed(2)

        return [
          `[Source ${index + 1}]`,
          `Title: ${title}`,
          `Heading: ${heading}`,
          `Source URL: ${metadata.source ?? 'N/A'}`,
          `Similarity: ${similarity}%`,
          `Chunk: ${row.content}`,
        ].join('\n')
      })
      .join('\n\n')

    const prompt = [
      `Question: ${question}`,
      '',
      'Context documents:',
      context,
      '',
      'Instructions:',
      '- Answer concisely and accurately using the context only.',
      '- If uncertain or missing context, say so explicitly.',
      '- Add citations as [Source N] when making claims.',
    ].join('\n')

    // Step 5: Ask the model with the grounded prompt and print the answer + sources.
    const answer = await getAnswerFromOpenAI(prompt)

    console.log(`\nQuestion: ${question}\n`)
    console.log('Answer:')
    console.log(answer)
    console.log('\nRetrieved context:')

    filteredRows.forEach((row, index) => {
      const metadata = parseMetadata(row.metadata) as {
        source?: string
        documentMetadata?: { title?: string }
      }
      const title = metadata.documentMetadata?.title ?? `Document ${row.document_id}`
      const similarity = (Number(row.similarity) * 100).toFixed(2)

      console.log(`- [Source ${index + 1}] ${title} (${similarity}%)`)
      console.log(`  ${metadata.source ?? 'N/A'}`)
    })
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('There was an error while running the RAG query:', error)
  process.exit(1)
})


