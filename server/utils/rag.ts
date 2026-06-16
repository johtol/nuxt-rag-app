import { searchSimilarChunks, type SimilarChunk } from '../../scripts/semantic-search'

// Minimal message shape that the server accepts from the chat UI.
// We keep only role + content because that is all the RAG prompt needs
// to reconstruct recent context for follow-up questions.
export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

// Canonical source information returned to the UI. These fields are chosen so
// the frontend can both render citations and build real MDN links.
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

// Final non-streaming result used by the legacy /api/chat route.
export interface GenerateRagAnswerResult {
  answer: string
  sources: RagSource[]
  usedContext: boolean
}

// Hooks used by the streaming route. The server route decides how to forward
// these pieces to the browser (SSE in our case), while this module stays focused
// on retrieval + model orchestration.
//
// This callback design keeps rag.ts transport-agnostic: it knows nothing about
// HTTP or SSE. The route layer translates each callback into an SSE event.
// See stream.post.ts for the full rationale behind the SSE choice.
export interface StreamRagAnswerHandlers {
  onSources?: (payload: { sources: RagSource[]; usedContext: boolean }) => void | Promise<void>,
  onDelta?: (text: string) => void | Promise<void>,
  onDone?: (answer: string) => void | Promise<void>,
}

// Small helper type matching the Responses API input_text block format.
interface OpenAIInputText {
  type: 'input_text'
  text: string
}

// Shape used by the non-streaming JSON response path.
interface OpenAIResponsePayload {
  output_text?: string
  output?: Array<{ content?: Array<{ text?: string }> }>
}

// Shared result of the retrieval + prompt-building phase.
// Both streaming and non-streaming paths use this so they stay consistent.
interface PreparedRagRequest {
  prompt: string | null
  sources: RagSource[]
  usedContext: boolean
  fallbackAnswer: string | null
  openAiModel: string
  openAiApiKey: string
}

// Minimal shape for streamed OpenAI events that we care about.
// We intentionally ignore many other event types and only react to text deltas
// and explicit error events.
interface OpenAiResponseStreamEvent {
  type?: string
  delta?: string
  error?: {
    message?: string
  }
  message?: string
}

// System instructions for the model. We centralize this string so both the
// non-streaming and streaming code paths apply the exact same answering rules.
const ragSystemPolicy = [
  'You are an MDN documentation assistant that answers with retrieved context only.',
  'Use only the provided XML context and conversation history to answer.',
  'If the answer is not in the context, clearly say what is missing.',
  'Keep the answer concise and practical for developers.',
  'When making factual claims, cite supporting chunks as [Source N].',
  'Use markdown formatting for readability.'
].join(' ')

// The prompt is assembled as XML. Because document chunks and headings can
// contain arbitrary text, we must escape reserved XML characters first.
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

// Serialize retrieved chunks into a structured XML block. This makes the prompt
// explicit and predictable for the model: each chunk has a title, section,
// similarity score, source URL, and content body.
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

// Serialize the last few turns of the conversation so the model can answer
// follow-up questions without losing the immediate thread of the discussion.
// We intentionally cap the number of turns to avoid unbounded prompt growth.
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

// Read and validate all runtime configuration used by the RAG pipeline.
// Keeping this in one place ensures the streaming and non-streaming flows
// behave the same way and fail with the same validation rules.
function getRagConfig() {
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

  return {
    topK,
    minSimilarity,
    openAiModel,
    openAiApiKey
  }
}

// Build the OpenAI Responses API input array. We use a system message for
// grounding rules and a user message containing the composed RAG prompt.
function buildOpenAiInput(prompt: string) {
  const systemPrompt: OpenAIInputText = {
    type: 'input_text',
    text: ragSystemPolicy
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

// Shared preparation step:
// 1) validate the question,
// 2) load configuration,
// 3) retrieve semantically similar chunks,
// 4) filter by similarity threshold,
// 5) build the final prompt and sources list.
//
// This is the most important refactor for streaming because the frontend wants
// sources immediately, before model generation has completed.
async function prepareRagRequest(options: GenerateRagAnswerOptions): Promise<PreparedRagRequest> {
  const question = options.question.trim()
  if (!question) {
    throw new Error('Question is required')
  }

  const { topK, minSimilarity, openAiModel, openAiApiKey } = getRagConfig()
  const retrievedChunks = await searchSimilarChunks({ question, topK })
  const filteredChunks = retrievedChunks.filter(chunk => chunk.similarity >= minSimilarity)

  if (filteredChunks.length === 0) {
    return {
      prompt: null,
      sources: [],
      usedContext: false,
      fallbackAnswer: `I couldn't find sufficiently relevant MDN context for that question (threshold: ${minSimilarity}). Try rephrasing with more specific terms.`,
      openAiModel,
      openAiApiKey
    }
  }

  return {
    prompt: [
      `<question>${escapeXml(question)}</question>`,
      buildHistoryXml(options.history ?? []),
      buildXmlContext(filteredChunks)
    ].join('\n\n'),
    sources: mapSources(filteredChunks),
    usedContext: true,
    fallbackAnswer: null,
    openAiModel,
    openAiApiKey
  }
}

// Low-level helper that sends a request to OpenAI. The `stream` flag lets both
// code paths share the same request construction while differing only in how the
// response body is consumed.
async function createOpenAiResponse(
  prompt: string,
  openAiModel: string,
  openAiApiKey: string,
  options?: {
    stream?: boolean
    signal?: AbortSignal
  }
): Promise<Response> {
  return await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openAiApiKey}`
    },
    signal: options?.signal,
    body: JSON.stringify({
      model: openAiModel,
      temperature: 0.2,
      stream: options?.stream ?? false,
      input: buildOpenAiInput(prompt)
    })
  })
}

// Non-streaming answer generation used by the legacy JSON route.
// We wait for the full response payload, extract the plain-text answer, and
// return it once the model has completely finished.
async function getAnswerFromOpenAI(prompt: string, openAiModel: string, openAiApiKey: string): Promise<string> {
  const response = await createOpenAiResponse(prompt, openAiModel, openAiApiKey)

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

// Convert raw retrieved chunks into the smaller UI-friendly source objects.
// This keeps the frontend independent from the DB/search schema details.
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

// Streaming answer generation used by the SSE endpoint.
// We read the OpenAI response body incrementally, parse SSE blocks, extract
// text deltas, and forward them to the caller while also accumulating the
// complete answer for the final `done` event.
async function streamAnswerFromOpenAI(
  prompt: string,
  openAiModel: string,
  openAiApiKey: string,
  handlers: Pick<StreamRagAnswerHandlers, 'onDelta'>,
  signal?: AbortSignal
): Promise<string> {
  const response = await createOpenAiResponse(prompt, openAiModel, openAiApiKey, {
    stream: true,
    signal
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI error (${response.status}): ${errorText}`)
  }

  if (!response.body) {
    throw new Error('OpenAI streaming response did not include a body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  // Network chunks do not necessarily align with SSE event boundaries.
  // We therefore accumulate text into `buffer`, split by the SSE blank-line
  // separator, and keep the incomplete trailing fragment for the next read.
  async function handleEventBlock(block: string) {
    const dataLines = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())

    if (dataLines.length === 0) {
      return
    }

    const rawData = dataLines.join('\n').trim()
    if (!rawData || rawData === '[DONE]') {
      return
    }

    // OpenAI sends different event types. We only need the text delta events
    // for live UI updates and the error event for propagation.
    const payload = JSON.parse(rawData) as OpenAiResponseStreamEvent
    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      answer += payload.delta
      await handlers.onDelta?.(payload.delta)
      return
    }

    if (payload.type === 'response.error') {
      throw new Error(payload.error?.message ?? payload.message ?? 'OpenAI streaming response returned an error event')
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      await handleEventBlock(block)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) {
    const trailingBlocks = buffer.split(/\r?\n\r?\n/)
    for (const block of trailingBlocks) {
      if (block.trim()) {
        await handleEventBlock(block)
      }
    }
  }

  if (!answer.trim()) {
    throw new Error('OpenAI streaming response did not include output text')
  }

  return answer.trim()
}

// Public non-streaming API.
// This stays available so the app still has a simple request/response path if
// you ever need a fallback endpoint or CLI-style usage.
export async function generateRagAnswer(options: GenerateRagAnswerOptions): Promise<GenerateRagAnswerResult> {
  const preparedRequest = await prepareRagRequest(options)

  if (!preparedRequest.prompt || !preparedRequest.usedContext) {
    return {
      answer: preparedRequest.fallbackAnswer ?? 'No answer could be generated.',
      sources: preparedRequest.sources,
      usedContext: false
    }
  }

  const answer = await getAnswerFromOpenAI(
    preparedRequest.prompt,
    preparedRequest.openAiModel,
    preparedRequest.openAiApiKey
  )

  return {
    answer,
    sources: preparedRequest.sources,
    usedContext: true
  }
}

// Public streaming API.
// Sequence:
// 1) prepare retrieval and sources,
// 2) emit sources as soon as they are known,
// 3) if no relevant context exists, stream a fallback message,
// 4) otherwise stream OpenAI deltas,
// 5) emit the final accumulated answer.
export async function streamRagAnswer(
  options: GenerateRagAnswerOptions,
  handlers: StreamRagAnswerHandlers,
  signal?: AbortSignal
): Promise<void> {
  const preparedRequest = await prepareRagRequest(options)

  await handlers.onSources?.({
    sources: preparedRequest.sources,
    usedContext: preparedRequest.usedContext
  })

  if (!preparedRequest.prompt || !preparedRequest.usedContext) {
    const fallbackAnswer = preparedRequest.fallbackAnswer ?? 'No answer could be generated.'
    await handlers.onDelta?.(fallbackAnswer)
    await handlers.onDone?.(fallbackAnswer)
    return
  }

  const answer = await streamAnswerFromOpenAI(
    preparedRequest.prompt,
    preparedRequest.openAiModel,
    preparedRequest.openAiApiKey,
    handlers,
    signal
  )

  await handlers.onDone?.(answer)
}
