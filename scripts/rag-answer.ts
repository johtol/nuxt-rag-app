import { pathToFileURL } from 'node:url'
import type { RetrievalMode } from './semantic-search.ts'
import {
  getAnswerFromOpenAI,
  getRagRuntimeConfig,
  prepareRagPrompt,
  escapeXml,
  buildXmlContext
} from './rag-core.ts'

export { getAnswerFromOpenAI, escapeXml, buildXmlContext }

export interface RunRagAnswerOptions {
  question: string
  topK?: number
  minSimilarity?: number
  retrievalMode?: RetrievalMode
  hybridRrfK?: number
  hybridVectorCandidateK?: number
  hybridBm25CandidateK?: number
  model?: string
  apiKey?: string
}

export interface RunRagAnswerResult {
  question: string
  answer: string
  retrievedChunks: Awaited<ReturnType<typeof prepareRagPrompt>>['retrievedChunks']
  filteredChunks: Awaited<ReturnType<typeof prepareRagPrompt>>['filteredChunks']
  xmlContext: string
  prompt: string
}

/**
 * Runs the full RAG pipeline for a question and returns a reproducible output
 * payload that can be reused by scripts and evaluation providers.
 */
export async function runRagAnswer(options: RunRagAnswerOptions): Promise<RunRagAnswerResult> {
  const ragConfig = getRagRuntimeConfig({
    topK: options.topK,
    minSimilarity: options.minSimilarity,
    retrievalMode: options.retrievalMode,
    hybridRrfK: options.hybridRrfK,
    hybridVectorCandidateK: options.hybridVectorCandidateK,
    hybridBm25CandidateK: options.hybridBm25CandidateK,
    model: options.model,
    apiKey: options.apiKey
  })
  const prepared = await prepareRagPrompt({
    question: options.question,
    topK: ragConfig.topK,
    minSimilarity: ragConfig.minSimilarity,
    retrievalMode: ragConfig.retrievalMode,
    hybrid: ragConfig.hybrid
  })

  if (prepared.retrievedChunks.length === 0) {
    throw new Error('No indexed chunks were found. Seed your DB before running RAG queries.')
  }

  if (!prepared.prompt || !prepared.xmlContext) {
    throw new Error(
      `No chunks met the similarity threshold (${ragConfig.minSimilarity}). Try lowering RAG_MIN_SIMILARITY or rephrasing your question.`
    )
  }

  const answer = await getAnswerFromOpenAI(prepared.prompt, {
    model: ragConfig.openAiModel,
    apiKey: ragConfig.openAiApiKey
  })

  return {
    question: prepared.question,
    answer,
    retrievedChunks: prepared.retrievedChunks,
    filteredChunks: prepared.filteredChunks,
    xmlContext: prepared.xmlContext,
    prompt: prepared.prompt
  }
}

/**
 * Orchestrates the RAG flow:
 * 1) retrieve semantically similar chunks,
 * 2) filter by similarity threshold,
 * 3) build XML context,
 * 4) ask the LLM and print answer plus source trace.
 */
async function main() {
  const question = process.argv.slice(2).join(' ').trim()

  if (!question) {
    console.error('Usage: bun run rag:ask -- "your question here"')
    process.exit(1)
  }

  const {
    answer,
    filteredChunks
  } = await runRagAnswer({ question })

  console.log(`\nQuestion: ${question}\n`)
  console.log('OpenAI Answer:')
  console.log(answer)
  console.log('\nRetrieved context:')

  filteredChunks.forEach((chunk, index) => {
    // Printed trace is intentionally compact so each source is easy to scan in terminals.
    const title = chunk.documentTitle ?? chunk.metadata.documentMetadata?.title ?? `Document ${chunk.documentId}`
    const source = chunk.documentSource ?? chunk.metadata.source ?? 'N/A'
    const similarity = Math.round(chunk.similarity * 100)
    const normalizedContent = chunk.content.replace(/\s+/g, ' ').trim()
    const contextPreview = normalizedContent.length > 100
      ? `${normalizedContent.slice(0, 100)}...`
      : normalizedContent || 'N/A'
    const lineRange = chunk.startLine !== null && chunk.endLine !== null
      ? `${chunk.startLine}-${chunk.endLine}`
      : 'N/A'

    console.log(`[Source ${index + 1}]:`)
    console.log(`  Document: ${title}`)
    console.log(`  Source: ${source}`)
    console.log(`  Similarity: ${similarity}%`)
    console.log(`  Context: ${contextPreview}`)
    console.log(`  Line-Range: ${lineRange}`)
    console.log(`  Chunk-ID: ${chunk.externalChunkId}`)
    console.log('')
  })
}

const isDirectExecution = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectExecution) {
  main().catch((error) => {
    console.error('There was an error while running the RAG query:', error)
    process.exit(1)
  })
}
