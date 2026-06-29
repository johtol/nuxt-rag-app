import promptfoo from 'promptfoo'
import type { ApiProvider, ProviderResponse } from 'promptfoo'
import { runRagAnswer } from '../../scripts/rag-answer'

export default class RagFaithfulnessProvider implements ApiProvider {
  id(): string {
    return 'rag-faithfulness-provider'
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const question = prompt.trim()
    const cacheKey = `rag-faithfulness:${question}`

    // 1) Load the shared promptfoo cache instance. The cache helps us avoid redundant retrieval + generation calls.
    const cache = await promptfoo.cache.getCache()

    // 2) Reuse a cached response when this exact prompt was already evaluated.
    const cachedResult = ((await cache.get(cacheKey)) as ProviderResponse) || undefined

    if (cachedResult) return cachedResult

    // 3) Reuse the same RAG pipeline from scripts/rag-answer.ts for reproducible evaluation behavior.
    const result = await runRagAnswer({
      question,
      topK: Number(process.env.RAG_TOP_K ?? 5),
      minSimilarity: Number(process.env.RAG_MIN_SIMILARITY ?? 0.6),
      retrievalMode: (process.env.RAG_RETRIEVAL_MODE ?? 'semantic').trim().toLowerCase() === 'hybrid' ? 'hybrid' : 'semantic',
      hybridRrfK: Number(process.env.RAG_HYBRID_RRF_K ?? 60),
      hybridVectorCandidateK: Number(process.env.RAG_HYBRID_VECTOR_CANDIDATES ?? 20),
      hybridBm25CandidateK: Number(process.env.RAG_HYBRID_BM25_CANDIDATES ?? 20),
      model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
    })

    // 4) Expose answer + context so promptfoo can run context-faithfulness assertions.
    const formattedResult: ProviderResponse = {
      output: {
        answer: result.answer,
        context: result.xmlContext
      }
    }

    // 5) Cache the response for one hour to avoid repeated retrieval and generation calls.
    await cache.set(cacheKey, formattedResult, { ttl: 3600 })

    // 6) Return fresh output for promptfoo transforms.
    return formattedResult
  }
}
