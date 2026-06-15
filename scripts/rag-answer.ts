import { searchSimilarChunks, type SimilarChunk } from './semantic-search.ts'

interface OpenAIInputText {
  type: 'input_text'
  text: string
}

interface OpenAIResponsePayload {
  output_text?: string
  output?: Array<{ content?: Array<{ text?: string }> }>
}

const question = process.argv.slice(2).join(' ').trim()
const topK = Number(process.env.RAG_TOP_K ?? 5)
const minSimilarity = Number(process.env.RAG_MIN_SIMILARITY ?? 0.6)
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
const ragSystemPolicy = [
  'You are a RAG assistant that answers questions based on the provided context.',
  'Use only the provided XML context to answer.',
  'If the answer is not in the context, say that clearly and suggest what is missing.',
  'Answer concisely, accurately and cite which documents you are referencing from the context.',
  'Add citations as [Source N] when making claims.',
  'Use markdown formatting for readability'
].join(' ')

if (!question) {
  console.error('Usage: bun run rag:ask -- "your question here"')
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

/**
 * Escapes XML-reserved characters so raw chunk text and metadata can be safely
 * embedded inside XML tags in the prompt context.
 */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Serializes retrieved chunks into an XML block with explicit fields.
 *
 * This structure helps the model reason over source attributes consistently
 * (document index, title, section, similarity, source URL, and content).
 */
function buildXmlContext(chunks: SimilarChunk[]): string {
  const documentsXml = chunks
    .map((chunk, index) => {
      const title = chunk.metadata.documentMetadata?.title ?? `Document ${chunk.documentId}`
      const section = chunk.headingText ?? 'No heading'
      const sourceUrl = chunk.metadata.source ?? 'N/A'
      const similarityPct = (chunk.similarity * 100).toFixed(2)

      return [
        `  <document index="${index + 1}">`,
        `    <chunk_id>${escapeXml(chunk.id)}</chunk_id>`,
        `    <chunk_index>${chunk.chunkIndex}</chunk_index>`,
        `    <title>${escapeXml(title)}</title>`,
        `    <section>${escapeXml(section)}</section>`,
        `    <similarity score="${chunk.similarity.toFixed(6)}">${similarityPct}%</similarity>`,
        `    <source_url>${escapeXml(sourceUrl)}</source_url>`,
        `    <content>${escapeXml(chunk.content)}</content>`,
        '  </document>',
      ].join('\n')
    })
    .join('\n')

  return `<documents>\n${documentsXml}\n</documents>`
}

/**
 * Sends the grounded prompt to the OpenAI Responses API and returns plain text
 * output, with fallback handling for different response payload shapes.
 */
async function getAnswerFromOpenAI(prompt: string): Promise<string> {
  const systemPrompt: OpenAIInputText = {
    type: 'input_text',
    // Keep all policy/rules in one place to avoid contradictory prompt instructions.
    text: ragSystemPolicy,
  }

  const userPrompt: OpenAIInputText = {
    type: 'input_text',
    text: prompt,
  }

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
          content: [systemPrompt],
        },
        {
          role: 'user',
          content: [userPrompt],
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI error (${response.status}): ${errorText}`)
  }

  const payload = await response.json() as OpenAIResponsePayload
  const answer = payload.output_text?.trim() ?? payload.output?.[0]?.content?.[0]?.text?.trim()

  if (!answer) {
    throw new Error('OpenAI response did not include output_text')
  }

  return answer
}

/**
 * Orchestrates the RAG flow:
 * 1) retrieve semantically similar chunks,
 * 2) filter by similarity threshold,
 * 3) build XML context,
 * 4) ask the LLM and print answer plus source trace.
 */
async function main() {
  // Step 1: Reuse semantic-search.ts for embedding + vector retrieval.
  const retrievedChunks = await searchSimilarChunks({ question, topK })

  if (retrievedChunks.length === 0) {
    console.log('No indexed chunks were found. Seed your DB before running RAG queries.')
    return
  }

  // Step 2: Apply threshold filtering before prompting the model.
  const filteredChunks = retrievedChunks.filter((chunk) => chunk.similarity >= minSimilarity)

  if (filteredChunks.length === 0) {
    console.log(
      `No chunks met the similarity threshold (${minSimilarity}). Try lowering RAG_MIN_SIMILARITY or rephrasing your question.`
    )
    return
  }

  // Step 3: Build XML context so each source field is explicit for the model.
  const xmlContext = buildXmlContext(filteredChunks)
  const prompt = [
    `<question>${escapeXml(question)}</question>`,
    '',
    xmlContext,
  ].join('\n')

  // Step 4: Generate answer and print traceable sources.
  const answer = await getAnswerFromOpenAI(prompt)

  console.log(`\nQuestion: ${question}\n`)
  console.log('Answer:')
  console.log(answer)
  console.log('\nRetrieved context:')

  filteredChunks.forEach((chunk, index) => {
    const title = chunk.metadata.documentMetadata?.title ?? `Document ${chunk.documentId}`
    const similarity = (chunk.similarity * 100).toFixed(2)

    console.log(`- [Source ${index + 1}] ${title} (${similarity}%)`)
    console.log(`  ${chunk.metadata.source ?? 'N/A'}`)
  })
}

main().catch((error) => {
  console.error('There was an error while running the RAG query:', error)
  process.exit(1)
})
