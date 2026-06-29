import { searchSimilarChunks, type HybridSearchOptions, type RetrievalMode, type SimilarChunk } from './semantic-search.ts'

export interface RagHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

interface OpenAIInputText {
  type: 'input_text'
  text: string
}

interface OpenAIResponsePayload {
  output_text?: string
  output?: Array<{ content?: Array<{ text?: string }> }>
}

export interface RagRuntimeConfigOptions {
  topK?: number
  minSimilarity?: number
  retrievalMode?: RetrievalMode
  hybridRrfK?: number
  hybridVectorCandidateK?: number
  hybridBm25CandidateK?: number
  model?: string
  apiKey?: string
}

export interface RagRuntimeConfig {
  topK: number
  minSimilarity: number
  retrievalMode: RetrievalMode
  hybrid: Required<HybridSearchOptions>
  openAiModel: string
  openAiApiKey: string
}

export interface PrepareRagPromptOptions {
  question: string
  topK: number
  minSimilarity: number
  retrievalMode: RetrievalMode
  hybrid: Required<HybridSearchOptions>
  history?: RagHistoryMessage[]
}

export interface PrepareRagPromptResult {
  question: string
  retrievedChunks: SimilarChunk[]
  filteredChunks: SimilarChunk[]
  xmlContext: string | null
  prompt: string | null
}

const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K ?? 5)
const DEFAULT_MIN_SIMILARITY = Number(process.env.RAG_MIN_SIMILARITY ?? 0.7)
const DEFAULT_HYBRID_RRF_K = Number(process.env.RAG_HYBRID_RRF_K ?? 60)
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'

export const defaultRagSystemPolicy = [
  'You are an MDN documentation assistant that answers with retrieved context only.',
  'Use only the provided XML context and conversation history to answer.',
  'If the answer is not in the context, clearly say what is missing.',
  'Keep the answer concise and practical for developers.',
  'When making factual claims, cite supporting chunks as [Source N].',
  'Use markdown formatting for readability.',
  'Stick to the provided context as closely as possible and do NOT add any other information'
  // 'Always include a link to referenced context document (it is a url)'
].join(' ')

export function getRagRuntimeConfig(options: RagRuntimeConfigOptions = {}): RagRuntimeConfig {
  const topK = options.topK ?? DEFAULT_TOP_K
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const retrievalMode = (options.retrievalMode ?? process.env.RAG_RETRIEVAL_MODE ?? 'semantic').trim().toLowerCase()
  const hybridRrfK = options.hybridRrfK ?? DEFAULT_HYBRID_RRF_K
  const hybridVectorCandidateK = options.hybridVectorCandidateK ?? Number(process.env.RAG_HYBRID_VECTOR_CANDIDATES ?? Math.max(topK, topK * 4))
  const hybridBm25CandidateK = options.hybridBm25CandidateK ?? Number(process.env.RAG_HYBRID_BM25_CANDIDATES ?? Math.max(topK, topK * 4))
  const openAiModel = options.model ?? DEFAULT_OPENAI_MODEL
  const openAiApiKey = options.apiKey ?? process.env.OPENAI_API_KEY

  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not set')
  }

  if (!Number.isFinite(topK) || topK < 1) {
    throw new Error('RAG_TOP_K must be a positive number')
  }

  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new Error('RAG_MIN_SIMILARITY must be a number between 0 and 1')
  }

  if (retrievalMode !== 'semantic' && retrievalMode !== 'hybrid') {
    throw new Error('RAG_RETRIEVAL_MODE must be either "semantic" or "hybrid"')
  }

  if (!Number.isFinite(hybridRrfK) || hybridRrfK <= 0) {
    throw new Error('RAG_HYBRID_RRF_K must be a positive number')
  }

  if (!Number.isFinite(hybridVectorCandidateK) || hybridVectorCandidateK <= 0) {
    throw new Error('RAG_HYBRID_VECTOR_CANDIDATES must be a positive number')
  }

  if (!Number.isFinite(hybridBm25CandidateK) || hybridBm25CandidateK <= 0) {
    throw new Error('RAG_HYBRID_BM25_CANDIDATES must be a positive number')
  }

  return {
    topK,
    minSimilarity,
    retrievalMode,
    hybrid: {
      rrfK: hybridRrfK,
      vectorCandidateK: hybridVectorCandidateK,
      bm25CandidateK: hybridBm25CandidateK
    },
    openAiModel,
    openAiApiKey
  }
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

export function buildXmlContext(chunks: SimilarChunk[]): string {
  const documentsXml = chunks
    .map((chunk, index) => {
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

export function buildHistoryXml(history: RagHistoryMessage[]): string {
  if (history.length === 0) {
    return '<conversation_history />'
  }

  const historyXml = history
    .slice(-8)
    .map(turn => `  <turn role="${turn.role}">${escapeXml(turn.content)}</turn>`)
    .join('\n')

  return `<conversation_history>\n${historyXml}\n</conversation_history>`
}

export async function prepareRagPrompt(options: PrepareRagPromptOptions): Promise<PrepareRagPromptResult> {
  const question = options.question.trim()
  if (!question) {
    throw new Error('Question is required')
  }

  const retrievalOptions = {
    question,
    topK: options.topK,
    retrievalMode: options.retrievalMode,
    hybrid: options.hybrid
  }
  const retrievedChunks = await searchSimilarChunks(retrievalOptions)
  const filteredChunks = retrievedChunks.filter(chunk => chunk.similarity >= options.minSimilarity)

  if (filteredChunks.length === 0) {
    return {
      question,
      retrievedChunks,
      filteredChunks,
      xmlContext: null,
      prompt: null
    }
  }

  const xmlContext = buildXmlContext(filteredChunks)
  const prompt = [
    `<question>${escapeXml(question)}</question>`,
    buildHistoryXml(options.history ?? []),
    xmlContext
  ].join('\n\n')

  return {
    question,
    retrievedChunks,
    filteredChunks,
    xmlContext,
    prompt
  }
}

function buildOpenAiInput(prompt: string, systemPolicy: string) {
  const systemPrompt: OpenAIInputText = {
    type: 'input_text',
    text: systemPolicy
  }

  const userPrompt: OpenAIInputText = {
    type: 'input_text',
    text: prompt
  }

  return [
    {
      role: 'system',
      content: [systemPrompt]
    },
    {
      role: 'user',
      content: [userPrompt]
    }
  ]
}

export interface OpenAIRequestOptions {
  model?: string
  apiKey?: string
  systemPolicy?: string
  stream?: boolean
  signal?: AbortSignal
}

export async function createOpenAiResponse(prompt: string, options: OpenAIRequestOptions = {}): Promise<Response> {
  const model = options.model ?? DEFAULT_OPENAI_MODEL
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  const systemPolicy = options.systemPolicy ?? defaultRagSystemPolicy

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set')
  }

  return await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    signal: options.signal,
    body: JSON.stringify({
      model,
      temperature: 0.2,
      stream: options.stream ?? false,
      input: buildOpenAiInput(prompt, systemPolicy)
    })
  })
}

export async function getAnswerFromOpenAI(prompt: string, options: OpenAIRequestOptions = {}): Promise<string> {
  const response = await createOpenAiResponse(prompt, options)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI error (${response.status}): ${errorText}`)
  }

  const payload = await response.json() as OpenAIResponsePayload
  const answer = payload.output_text?.trim() ?? payload.output?.[0]?.content?.[0]?.text?.trim()

  if (!answer) {
    throw new Error('OpenAI response did not include output text')
  }

  return answer
}
