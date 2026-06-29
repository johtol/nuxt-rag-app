import postgres from 'postgres'
import { createVoyage } from '@ai-sdk/voyage'
import { embed } from 'ai'

export interface ChunkDocumentMetadata {
  title?: string
}

export interface ChunkMetadata {
  source?: string
  documentMetadata?: ChunkDocumentMetadata
  [key: string]: unknown
}

interface RawChunkProjection {
  // Mirrors SQL aliases from the retrieval queries below.
  id: string
  external_chunk_id: string
  document_id: string
  chunk_index: number
  content: string
  start_line: number | null
  end_line: number | null
  heading_text: string | null
  heading_level: number | null
  heading_line_number: number | null
  metadata: unknown
  document_title: string | null
  document_source: string | null
  document_slug: string | null
}

interface RawVectorChunkRow extends RawChunkProjection {
  similarity: number | string
}

interface RawBm25ChunkRow extends RawChunkProjection {
  bm25_score: number | string
}

export interface SimilarChunk {
  // Canonical document fields come from the `documents` table join.
  id: string
  externalChunkId: string
  documentId: string
  documentTitle: string | null
  documentSource: string | null
  documentSlug: string | null
  chunkIndex: number
  content: string
  startLine: number | null
  endLine: number | null
  headingText: string | null
  headingLevel: number | null
  headingLineNumber: number | null
  metadata: ChunkMetadata
  scoreBreakdown: {
    vectorSimilarity: number | null
    bm25Score: number | null
    hybridScore: number | null
  }
  similarity: number
}

export type RetrievalMode = 'semantic' | 'hybrid'

export interface HybridSearchOptions {
  rrfK?: number
  vectorCandidateK?: number
  bm25CandidateK?: number
}

export interface SearchSimilarChunksOptions {
  question: string
  topK?: number
  databaseUrl?: string
  retrievalMode?: RetrievalMode
  hybrid?: HybridSearchOptions
}

const DEFAULT_TOP_K = 4
const DEFAULT_RRF_K = 60
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4

/**
 * Normalizes chunk metadata from the database into a typed object.
 * Supports JSON strings and already-parsed objects, and falls back to
 * an empty object if parsing fails.
 */
export function parseChunkMetadata(metadata: unknown): ChunkMetadata {
  if (!metadata) {
    return {}
  }

  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as ChunkMetadata
    } catch {
      return {}
    }
  }

  if (typeof metadata === 'object') {
    return metadata as ChunkMetadata
  }

  return {}
}

function mapRowToSimilarChunk(
  row: RawChunkProjection,
  similarity: number,
  scoreBreakdown: SimilarChunk['scoreBreakdown']
): SimilarChunk {
  return {
    id: row.id,
    externalChunkId: row.external_chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    documentSource: row.document_source,
    documentSlug: row.document_slug,
    chunkIndex: row.chunk_index,
    content: row.content,
    startLine: row.start_line,
    endLine: row.end_line,
    headingText: row.heading_text,
    headingLevel: row.heading_level,
    headingLineNumber: row.heading_line_number,
    metadata: parseChunkMetadata(row.metadata),
    scoreBreakdown,
    similarity
  }
}

function parsePositiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }

  return value
}

function toFiniteNumberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveRetrievalMode(value: string | undefined): RetrievalMode {
  const normalized = (value ?? 'semantic').trim().toLowerCase()

  if (normalized === 'semantic' || normalized === 'hybrid') {
    return normalized
  }

  throw new Error('retrievalMode must be either "semantic" or "hybrid"')
}

/**
 * Runs retrieval for a question:
 * 1) embeds the query with Voyage,
 * 2) performs semantic or hybrid retrieval,
 * 3) maps DB rows into typed `SimilarChunk` records.
 */
export async function searchSimilarChunks(options: SearchSimilarChunksOptions): Promise<SimilarChunk[]> {
  const question = options.question.trim()
  const topK = options.topK ?? DEFAULT_TOP_K
  const retrievalMode = resolveRetrievalMode(options.retrievalMode ?? process.env.RAG_RETRIEVAL_MODE)

  if (!question) {
    throw new Error('Question is required')
  }

  parsePositiveNumber('topK', topK)

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not set')
  }

  const sql = postgres(databaseUrl)
  const voyage = createVoyage()
  const embeddingModel = voyage.textEmbeddingModel('voyage-large-2')

  try {
    const { embedding } = await embed({
      model: embeddingModel,
      value: question
    })

    // pgvector expects a textual vector literal when parameterizing from JS.
    const queryVector = `[${embedding.join(',')}]`

    if (retrievalMode === 'semantic') {
      const rows = await sql<RawVectorChunkRow[]>`
        select
          c.id,
          c.external_chunk_id,
          c.document_id,
          c.chunk_index,
          c.content,
          c.start_line,
          c.end_line,
          c.heading_text,
          c.heading_level,
          c.heading_line_number,
          c.metadata,
          d.title as document_title,
          d.source as document_source,
          d.slug as document_slug,
          -- Converts cosine distance to similarity in the 0-1 range.
          1 - (c.embedding <=> ${queryVector}::vector) as similarity
        from chunks c
        inner join documents d on d.id = c.document_id
        where c.embedding is not null
        order by similarity desc, c.id asc
        limit ${topK}
      `

      return rows.map((row) => {
        const vectorSimilarity = toFiniteNumberOrNull(row.similarity)
        if (vectorSimilarity === null) {
          throw new Error('Vector similarity could not be parsed as a finite number')
        }
        return mapRowToSimilarChunk(row, vectorSimilarity, {
          vectorSimilarity,
          bm25Score: null,
          hybridScore: null
        })
      })
    }

    // Hybrid mode: fetch independent candidate pools from each modality, then fuse.
    const rrfK = parsePositiveNumber(
      'hybrid.rrfK',
      options.hybrid?.rrfK ?? Number(process.env.RAG_HYBRID_RRF_K ?? DEFAULT_RRF_K)
    )
    const fallbackCandidateK = Math.max(topK, Math.ceil(topK * DEFAULT_HYBRID_CANDIDATE_MULTIPLIER))
    const vectorCandidateK = parsePositiveNumber(
      'hybrid.vectorCandidateK',
      options.hybrid?.vectorCandidateK ?? Number(process.env.RAG_HYBRID_VECTOR_CANDIDATES ?? fallbackCandidateK)
    )
    const bm25CandidateK = parsePositiveNumber(
      'hybrid.bm25CandidateK',
      options.hybrid?.bm25CandidateK ?? Number(process.env.RAG_HYBRID_BM25_CANDIDATES ?? fallbackCandidateK)
    )

    // 1) Vector branch: rank by cosine similarity over embeddings.
    const vectorRows = await sql<RawVectorChunkRow[]>`
      select
        c.id,
        c.external_chunk_id,
        c.document_id,
        c.chunk_index,
        c.content,
        c.start_line,
        c.end_line,
        c.heading_text,
        c.heading_level,
        c.heading_line_number,
        c.metadata,
        d.title as document_title,
        d.source as document_source,
        d.slug as document_slug,
        1 - (c.embedding <=> ${queryVector}::vector) as similarity
      from chunks c
      inner join documents d on d.id = c.document_id
      where c.embedding is not null
      order by similarity desc, c.id asc
      limit ${vectorCandidateK}
    `

    // 2) BM25/FTS branch: rank by lexical relevance using the precomputed tsvector index.
    const bm25Rows = await sql<RawBm25ChunkRow[]>`
      with query as (
        select websearch_to_tsquery('english', ${question}) as tsq
      )
      select
        c.id,
        c.external_chunk_id,
        c.document_id,
        c.chunk_index,
        c.content,
        c.start_line,
        c.end_line,
        c.heading_text,
        c.heading_level,
        c.heading_line_number,
        c.metadata,
        d.title as document_title,
        d.source as document_source,
        d.slug as document_slug,
        ts_rank_cd(c.search_vector, query.tsq) as bm25_score
      from chunks c
      inner join documents d on d.id = c.document_id
      cross join query
      where c.search_vector @@ query.tsq
      order by bm25_score desc, c.id asc
      limit ${bm25CandidateK}
    `
    interface FusionEntry {
      row: RawChunkProjection
      vectorRank?: number
      bm25Rank?: number
      vectorSimilarity?: number
      bm25Score?: number
      fusedScore: number
    }

    const fusedById = new Map<string, FusionEntry>()

    // 3) RRF fusion pass (vector): add 1 / (k + rank) contribution for each hit.
    vectorRows.forEach((row, index) => {
      // rrfk: controls smoothing. Lower value: makes differences more pronounced. Top results dominate.
      // High value: flattens distributions, more even distribution across ranks
      const vectorRank = index + 1
      const rrfContribution = 1 / (rrfK + vectorRank)
      const existing = fusedById.get(row.id)
      const entry: FusionEntry = existing ?? {
        row,
        fusedScore: 0
      }

      entry.vectorRank = vectorRank
      entry.vectorSimilarity = toFiniteNumberOrNull(row.similarity) ?? undefined
      entry.fusedScore += rrfContribution
      fusedById.set(row.id, entry)
    })

    // 4) RRF fusion pass (BM25): same formula, accumulated on the same chunk id.
    bm25Rows.forEach((row, index) => {
      const bm25Rank = index + 1
      const rrfContribution = 1 / (rrfK + bm25Rank)
      const existing = fusedById.get(row.id)
      const entry: FusionEntry = existing ?? {
        row,
        fusedScore: 0
      }

      entry.bm25Rank = bm25Rank
      entry.bm25Score = toFiniteNumberOrNull(row.bm25_score) ?? undefined
      entry.fusedScore += rrfContribution
      fusedById.set(row.id, entry)
    })

    const maxFusedScore = (1 / (rrfK + 1)) + (1 / (rrfK + 1))
    // 5) Deterministic ordering: fused score, then vector score, then best rank, then id.
    const fusedRows = [...fusedById.values()]
      .sort((a, b) => {
        if (b.fusedScore !== a.fusedScore) {
          return b.fusedScore - a.fusedScore
        }

        const aVector = a.vectorSimilarity ?? -Infinity
        const bVector = b.vectorSimilarity ?? -Infinity
        if (bVector !== aVector) {
          return bVector - aVector
        }

        const aBestRank = Math.min(a.vectorRank ?? Number.POSITIVE_INFINITY, a.bm25Rank ?? Number.POSITIVE_INFINITY)
        const bBestRank = Math.min(b.vectorRank ?? Number.POSITIVE_INFINITY, b.bm25Rank ?? Number.POSITIVE_INFINITY)
        if (aBestRank !== bBestRank) {
          return aBestRank - bBestRank
        }

        return a.row.id.localeCompare(b.row.id)
      })
      .slice(0, topK)

    const finalChunkIds = fusedRows.map(entry => entry.row.id)
    const finalScoreRows = finalChunkIds.length === 0
      ? []
      : await sql<{
          id: string
          vector_similarity: number | string
          bm25_score: number | string
        }[]>`
        with query as (
          select websearch_to_tsquery('english', ${question}) as tsq
        )
        select
          c.id,
          1 - (c.embedding <=> ${queryVector}::vector) as vector_similarity,
          coalesce(ts_rank_cd(c.search_vector, query.tsq), 0) as bm25_score
        from chunks c
        cross join query
        where c.id in ${sql(finalChunkIds)}
      `
    const finalScoresById = new Map(finalScoreRows.map(row => [
      row.id,
      {
        vectorSimilarity: toFiniteNumberOrNull(row.vector_similarity),
        bm25Score: toFiniteNumberOrNull(row.bm25_score)
      }
    ]))

    // 6) Return the same SimilarChunk contract; score is normalized to [0, 1].
    return fusedRows.map((entry) => {
      const normalizedScore = Math.max(0, Math.min(1, entry.fusedScore / maxFusedScore))
      const finalScores = finalScoresById.get(entry.row.id)
      return mapRowToSimilarChunk(entry.row, normalizedScore, {
        vectorSimilarity: finalScores?.vectorSimilarity ?? entry.vectorSimilarity ?? null,
        bm25Score: finalScores?.bm25Score ?? entry.bm25Score ?? null,
        hybridScore: normalizedScore
      })
    })
  } finally {
    await sql.end()
  }
}
