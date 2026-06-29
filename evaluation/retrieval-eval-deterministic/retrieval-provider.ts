import promptfoo from 'promptfoo'
import type { ApiProvider, ProviderResponse } from 'promptfoo'
import { searchSimilarChunks } from '../../scripts/semantic-search'

export default class RetrievalProvider implements ApiProvider {
  id(): string {
    return 'retrieval-provider'
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    // 1) Load the shared promptfoo cache instance. The cache help us avoid redundant retrieval calls for the same prompt.
    const cache = await promptfoo.cache.getCache()

    // 2) Reuse a cached response when this exact prompt was already evaluated.
    const cachedResult = ((await cache.get(prompt)) as ProviderResponse) || undefined

    if (cachedResult) return cachedResult

    // 3) Run semantic retrieval with the expected options object shape.
    const retrievalMode = (process.env.RAG_RETRIEVAL_MODE ?? 'semantic').trim().toLowerCase() === 'hybrid'
      ? 'hybrid'
      : 'semantic'
    const results = await searchSimilarChunks({
      question: prompt,
      topK: 5,
      retrievalMode,
      hybrid: {
        rrfK: Number(process.env.RAG_HYBRID_RRF_K ?? 60),
        vectorCandidateK: Number(process.env.RAG_HYBRID_VECTOR_CANDIDATES ?? 20),
        bm25CandidateK: Number(process.env.RAG_HYBRID_BM25_CANDIDATES ?? 20)
      }
    })

    // 4) Return the retrieved chunks in promptfoo's ProviderResponse format.
    const formattedResult: ProviderResponse = { output: results }

    // 5) Cache the response for one hour to avoid repeated DB + embedding calls.
    await cache.set(prompt, formattedResult, { ttl: 3600 })

    // 6) Return fresh retrieval output.
    return formattedResult
  }
}
