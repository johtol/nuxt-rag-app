import type { SimilarChunk } from '../../scripts/semantic-search'
import {
  createOpenAiResponse,
  getAnswerFromOpenAI,
  getRagRuntimeConfig,
  prepareRagPrompt
} from '../../scripts/rag-core'

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
  scoreBreakdown: {
    vectorSimilarity: number | null
    bm25Score: number | null
    hybridScore: number | null
  }
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
  onSources?: (payload: { sources: RagSource[], usedContext: boolean }) => void | Promise<void>
  onDelta?: (text: string) => void | Promise<void>
  onDone?: (answer: string) => void | Promise<void>
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
  const ragConfig = getRagRuntimeConfig()
  const preparedPrompt = await prepareRagPrompt({
    question: options.question,
    history: options.history,
    topK: ragConfig.topK,
    minSimilarity: ragConfig.minSimilarity,
    retrievalMode: ragConfig.retrievalMode,
    hybrid: ragConfig.hybrid
  })

  if (preparedPrompt.filteredChunks.length === 0) {
    return {
      prompt: null,
      sources: [],
      usedContext: false,
      fallbackAnswer: `I couldn't find sufficiently relevant MDN context for that question (threshold: ${ragConfig.minSimilarity}). Try rephrasing with more specific terms.`,
      openAiModel: ragConfig.openAiModel,
      openAiApiKey: ragConfig.openAiApiKey
    }
  }

  return {
    prompt: preparedPrompt.prompt,
    sources: mapSources(preparedPrompt.filteredChunks, ragConfig.retrievalMode),
    usedContext: true,
    fallbackAnswer: null,
    openAiModel: ragConfig.openAiModel,
    openAiApiKey: ragConfig.openAiApiKey
  }
}

// Convert raw retrieved chunks into the smaller UI-friendly source objects.
// This keeps the frontend independent from the DB/search schema details.
function mapSources(chunks: SimilarChunk[], retrievalMode: 'semantic' | 'hybrid'): RagSource[] {
  return chunks.map(chunk => ({
    id: chunk.id,
    title: chunk.documentTitle ?? chunk.metadata.documentMetadata?.title ?? `Document ${chunk.documentId}`,
    content: chunk.content,
    // Exposed in UI as a clickable source link.
    url: chunk.documentSource ?? chunk.metadata.source ?? 'N/A',
    slug: chunk.documentSlug ?? null,
    headingText: chunk.headingText ?? null,
    similarity: chunk.similarity,
    scoreBreakdown: {
      vectorSimilarity: chunk.scoreBreakdown.vectorSimilarity,
      bm25Score: chunk.scoreBreakdown.bm25Score,
      hybridScore: retrievalMode === 'hybrid'
        ? chunk.similarity
        : (chunk.scoreBreakdown.hybridScore ?? chunk.similarity)
    },
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
  const response = await createOpenAiResponse(prompt, {
    model: openAiModel,
    apiKey: openAiApiKey,
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
    {
      model: preparedRequest.openAiModel,
      apiKey: preparedRequest.openAiApiKey
    }
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
