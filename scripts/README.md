# Scripts

Utility scripts for database management, document seeding, and RAG query execution.

---

## Available Scripts

### `migrate.mjs`

Applies pending Drizzle ORM SQL migrations to the database.

Reads `drizzle/meta/_journal.json` to determine the ordered list of migrations, then applies only those not yet recorded in `drizzle.__drizzle_migrations`. Each migration runs inside a transaction — if any statement fails, it rolls back and exits. Already-applied migrations are verified via SHA-256 hash to catch file drift.

**Run:**

```bash
bun run db:migrate
```

**Options:** None — controlled entirely by environment variables.

**Environment variables:**

| Variable       | Required | Description                    |
| -------------- | -------- | ------------------------------ |
| `DATABASE_URL` | ✅       | PostgreSQL connection string   |

**Output:**

```
[✓] No pending migrations
# or
[i] Applying 0003_colorful_warbound.sql (2 statements)
[✓] Migrations applied successfully
```

---

### `migrate.sh`

Wrapper around `drizzle-kit migrate` that suppresses false-positive exit code `1` caused by Postgres `NOTICE` messages.

Verifies actual success by checking whether the `drizzle.__drizzle_migrations` table exists in the DB after execution.

**Run:**

```bash
bash scripts/migrate.sh
```

**Options:** None.

**Environment variables:**

| Variable       | Required | Description                  |
| -------------- | -------- | ---------------------------- |
| `DATABASE_URL` | ✅       | PostgreSQL connection string |

**Output:**

```
[✓] Migrations applied successfully (exit code 1 from NOTICE messages - ignored)
```

---

### `seed.mjs`

Seeds the database from `chunks.json` — the output of the document chunking pipeline.

Steps performed:
1. Reads `chunks.json` from the project root.
2. Deduplicates documents by `source` path and upserts them into the `documents` table.
3. Generates embeddings for every chunk in batches of 50 using Voyage AI (`voyage-large-2`).
4. Upserts chunks (with embeddings) into the `chunks` table. Existing rows are updated in place.

**Run:**

```bash
bun run db:seed
```

**Options:**

| Variable              | Default | Description                             |
| --------------------- | ------- | --------------------------------------- |
| `EMBEDDING_BATCH_SIZE`| `50`    | Number of chunks embedded per API call (hardcoded constant — edit to change) |

**Environment variables:**

| Variable        | Required | Description                    |
| --------------- | -------- | ------------------------------ |
| `DATABASE_URL`  | ✅       | PostgreSQL connection string   |
| `VOYAGE_API_KEY`| ✅       | Voyage AI API key for embedding |

**Output:**

```
[i] Reading chunks.json...
[i] Found 312 chunks
[i] Found 24 unique documents
[i] Upserting documents...
[i] Generating embeddings for chunks...
[i] Embedding batch 1–50 of 312...
...
[✓] Embeddings generated
[i] Upserting chunks...
[✓] Database seeded successfully
  - Documents: 24
  - Chunks: 312
```

---

### `semantic-search.ts`

Runs a standalone retrieval search against the indexed chunks.

Embeds the query using Voyage AI, then retrieves chunks using either:
- semantic vector search (`RAG_RETRIEVAL_MODE=semantic`, default), or
- hybrid BM25 + vector retrieval with RRF fusion (`RAG_RETRIEVAL_MODE=hybrid`).

Prints a formatted list of top matching chunks with score, document, source, heading, and content.

> Hybrid mode requires running `bun run db:migrate` so the BM25 `search_vector` column/index exists.

**Run:**

```bash
bun run semantic-search -- "your question here"
```

**Options:**

| Variable                        | Default    | Description                                   |
| ------------------------------- | ---------- | --------------------------------------------- |
| `RAG_TOP_K`                     | `5`        | Number of top results to retrieve             |
| `RAG_RETRIEVAL_MODE`            | `semantic` | Retrieval mode: `semantic` or `hybrid`        |
| `RAG_HYBRID_RRF_K`              | `60`       | RRF constant used when hybrid mode is enabled |
| `RAG_HYBRID_VECTOR_CANDIDATES`  | `20`       | Vector candidates considered before fusion    |
| `RAG_HYBRID_BM25_CANDIDATES`    | `20`       | BM25 candidates considered before fusion      |

**Environment variables:**

| Variable        | Required | Description                    |
| --------------- | -------- | ------------------------------ |
| `DATABASE_URL`  | ✅       | PostgreSQL connection string   |
| `VOYAGE_API_KEY`| ✅       | Voyage AI API key for embedding |

**Output:**

```
Top 5 results for: "What is a closure?"
------------------------------------------------------------------------
#1  [similarity: 88.15%] › ## Closures
    Document : Closures
    Source   : mdn-docs/closures/index.md
    Chunk    : #3  (id: abc-123)

 Chunk content:    A closure is the combination of a function ...

------------------------------------------------------------------------
```

---

### `rag-answer.ts`

Full RAG pipeline: retrieves the most relevant chunks and asks an OpenAI model to answer the question grounded in that context.

Steps performed:
1. Embeds the question via `searchSimilarChunks` (reused from `semantic-search.ts`).
2. Filters retrieved chunks by minimum similarity threshold.
3. Serialises filtered chunks as an XML context block (`<documents>` → `<document>` → `<title>`, `<section>`, `<similarity>`, `<source_url>`, `<content>`).
4. Sends a two-message prompt to OpenAI (system policy + user question + XML context).
5. Prints the model answer followed by a chunk-level source trace.

**Run:**

```bash
bun run rag:ask -- "your question here"
```

**Options:**

| Variable             | Default       | Description                                              |
| -------------------- | ------------- | -------------------------------------------------------- |
| `OPENAI_MODEL`       | `gpt-4.1-mini`| OpenAI model to use for answer generation                |
| `RAG_TOP_K`                   | `5`           | Number of chunks fetched before filtering                  |
| `RAG_MIN_SIMILARITY`          | `0.6`         | Minimum score (0–1) to pass a chunk to the LLM            |
| `RAG_RETRIEVAL_MODE`          | `semantic`    | Retrieval mode: `semantic` or `hybrid`                    |
| `RAG_HYBRID_RRF_K`            | `60`          | RRF constant used when hybrid mode is enabled             |
| `RAG_HYBRID_VECTOR_CANDIDATES`| `20`          | Vector candidates considered before hybrid fusion          |
| `RAG_HYBRID_BM25_CANDIDATES`  | `20`          | BM25 candidates considered before hybrid fusion            |

**Environment variables:**

| Variable        | Required | Description                    |
| --------------- | -------- | ------------------------------ |
| `DATABASE_URL`  | ✅       | PostgreSQL connection string   |
| `VOYAGE_API_KEY`| ✅       | Voyage AI API key for embedding |
| `OPENAI_API_KEY`| ✅       | OpenAI API key                 |

**Output:**

```
Question: What is a JavaScript closure?

Answer:
A closure is a function that retains access to variables from its enclosing
scope even after the outer function has returned [Source 1][Source 2].

Retrieved context:
[Source 1]:
  Document: Closures
  Source: mdn-docs/closures/index.md
  Similarity: 88%
  Context: A closure is the combination of a funct...
  Line-Range: 12-45
  Chunk-ID: mdn-docs/closures/index.md_chunk_3

[Source 2]:
  Document: Functions
  Source: mdn-docs/functions/index.md
  Similarity: 85%
  Context: Function scope and the concept of closu...
  Line-Range: 102-134
  Chunk-ID: mdn-docs/functions/index.md_chunk_7
```

---

## Exposed Functions

The following functions are exported from `semantic-search.ts` for use in the main application or other scripts.

### `searchSimilarChunks(options: SearchSimilarChunksOptions): Promise<SimilarChunk[]>`

Embeds a question with Voyage AI and retrieves the top-K most similar chunks from the database using pgvector cosine similarity. Returns a typed array of `SimilarChunk` records.

```typescript
import { searchSimilarChunks } from './scripts/semantic-search.ts'

const chunks = await searchSimilarChunks({
  question: 'What is a closure?',
  topK: 5,             // optional, default 5
  databaseUrl: '...',  // optional, falls back to DATABASE_URL env var
})
```

---

### `parseChunkMetadata(metadata: unknown): ChunkMetadata`

Normalises raw metadata from the database (JSON string or object) into a typed `ChunkMetadata` object. Falls back to `{}` on parse failure.

```typescript
import { parseChunkMetadata } from './scripts/semantic-search.ts'

const meta = parseChunkMetadata(row.metadata)
console.log(meta.documentMetadata?.title)
```

---

## Exported Types

| Type                       | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `SimilarChunk`             | A retrieved chunk with similarity score and metadata |
| `ChunkMetadata`            | Typed representation of per-chunk metadata        |
| `ChunkDocumentMetadata`    | Nested document-level metadata (title, etc.)      |
| `SearchSimilarChunksOptions` | Options accepted by `searchSimilarChunks`       |
