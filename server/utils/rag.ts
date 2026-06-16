import { searchSimilarChunks, type SimilarChunk } from '../../scripts/semantic-search'

export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface RagSource {
  id: string
  title: string
  content: string
  url: string
  slug: string | null
  headingText: string | null
  similarity: number
  section: string
}

export interface GenerateRagAnswerOptions {
  question: string
  history?: ChatHistoryMessage[]
}

export interface GenerateRagAnswerResult {
  answer: string
  sources: RagSource[]
  usedContext: boolean
}

interface OpenAIInputText {
  type: 'input_text'
  text: string
}

interface OpenAIResponsePayload {
  output_text?: string
  output?: Array<{ content?: Array<{ text?: string }> }>
}

const ragSystemPolicy = [
  'You are an MDN documentation assistant that answers with retrieved context only.',
  'Use only the provided XML context and conversation history to answer.',
  'If the answer is not in the context, clearly say what is missing.',
  'Keep the answer concise and practical for developers.',
  'When making factual claims, cite supporting chunks as [Source N].',
  'Use markdown formatting for readability.'
].join(' ')

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

function buildXmlContext(chunks: SimilarChunk[]): string {
  const documentsXml = chunks
    .map((chunk, index) => {
      // Prefer canonical document values from relational fields, then metadata fallback.
      const title = chunk.documentTitle ?? chunk.metadata.documentMetadata?.title ?? `Document ${chunk.documentId}`
      const section = chunk.headingText ?? 'No heading'
      const sourceUrl = chunk.documentSource ?? chunk.metadata.source ?? 'N/A'
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
        '  </document>'
      ].join('\n')
    })
    .join('\n')

  return `<documents>\n${documentsXml}\n</documents>`
}

function buildHistoryXml(history: ChatHistoryMessage[]): string {
  if (history.length === 0) {
    return '<conversation_history />'
  }

  const historyXml = history
    // Keep recent turns only so prompt size stays bounded.
    .slice(-8)
    .map((turn) => {
      return `  <turn role="${turn.role}">${escapeXml(turn.content)}</turn>`
    })
    .join('\n')

  return `<conversation_history>\n${historyXml}\n</conversation_history>`
}

async function getAnswerFromOpenAI(prompt: string, openAiModel: string, openAiApiKey: string): Promise<string> {
  const systemPrompt: OpenAIInputText = {
    type: 'input_text',
    text: ragSystemPolicy
  }

  const userPrompt: OpenAIInputText = {
    type: 'input_text',
    text: prompt
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openAiApiKey}`
    },
    body: JSON.stringify({
      model: openAiModel,
      temperature: 0.2,
      input: [
        {
          role: 'system',
          content: [systemPrompt]
        },
        {
          role: 'user',
          content: [userPrompt]
        }
      ]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI error (${response.status}): ${errorText}`)
  }

  const payload = (await response.json()) as OpenAIResponsePayload
  const answer = payload.output_text?.trim() ?? payload.output?.[0]?.content?.[0]?.text?.trim()

  if (!answer) {
    throw new Error('OpenAI response did not include output text')
  }

  return answer
}

function mapSources(chunks: SimilarChunk[]): RagSource[] {
  return chunks.map(chunk => ({
    id: chunk.id,
    title: chunk.documentTitle ?? chunk.metadata.documentMetadata?.title ?? `Document ${chunk.documentId}`,
    content: chunk.content,
    // Exposed in UI as a clickable source link.
    url: chunk.documentSource ?? chunk.metadata.source ?? 'N/A',
    slug: chunk.documentSlug ?? null,
    headingText: chunk.headingText ?? null,
    similarity: chunk.similarity,
    section: chunk.headingText ?? 'No heading'
  }))
}

export async function generateRagAnswer(options: GenerateRagAnswerOptions): Promise<GenerateRagAnswerResult> {
  const question = options.question.trim()
  if (!question) {
    throw new Error('Question is required')
  }

  const topK = Number(process.env.RAG_TOP_K ?? 5)
  const minSimilarity = Number(process.env.RAG_MIN_SIMILARITY ?? 0.6)
  const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
  const openAiApiKey = process.env.OPENAI_API_KEY

  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not set')
  }

  if (!Number.isFinite(topK) || topK < 1) {
    throw new Error('RAG_TOP_K must be a positive number')
  }

  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new Error('RAG_MIN_SIMILARITY must be a number between 0 and 1')
  }

  const retrievedChunks = await searchSimilarChunks({ question, topK })
  const filteredChunks = retrievedChunks.filter(chunk => chunk.similarity >= minSimilarity)

  if (filteredChunks.length === 0) {
    return {
      answer: `I couldn't find sufficiently relevant MDN context for that question (threshold: ${minSimilarity}). Try rephrasing with more specific terms.`,
      sources: [],
      usedContext: false
    }
  }

  const prompt = [
    `<question>${escapeXml(question)}</question>`,
    buildHistoryXml(options.history ?? []),
    buildXmlContext(filteredChunks)
  ].join('\n\n')

  const answer = await getAnswerFromOpenAI(prompt, openAiModel, openAiApiKey)

  return {
    answer,
    sources: mapSources(filteredChunks),
    usedContext: true
  }
}
