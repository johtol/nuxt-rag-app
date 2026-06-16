# Nuxt Minimal Starter

This is a [Nuxt.js](https://nuxt.com/) project. Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Getting Started

First, make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

Then, run the development server:

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Prerequisites

1. **Environment Variables**: Copy `.env.example` to `.env` and fill in your API keys:

   ```bash
   cp .env.example .env
   ```

2. **API Keys Required**:

   - `VOYAGE_API_KEY`: Get from [Voyage AI](https://www.voyageai.com/)
   - `OPENAI_API_KEY`: Get from [OpenAI](https://platform.openai.com/)

3. **Database**: Make sure PostgreSQL with pgvector extension is running:

    ```bash
    bun run db:up
    bun run db:migrate
    ```
   
    Drizzle is configured with:
        - Config: `drizzle.config.ts`
        - Schema barrel: `server/db/schema.ts`
        - Schema files:
          - `server/db/schema/documents.ts`
          - `server/db/schema/chunks.ts`
          - `server/db/schema/conversations.ts`
          - `server/db/schema/messages.ts`
          - `server/db/schema/message-sources.ts`
        - DB client: `server/utils/db.ts`
        - Migration helper: `scripts/migrate.mjs` (applies pending migrations from journal, tolerates missing historical files)
        - Seed script: `scripts/seed.mjs` (imports documents + chunks from `chunks.json`)  
        Use `DATABASE_URL` in your `.env` file (see `.env.example`).
      
4. **Chunk Docs**: Process and store your documents (optional - `chunks.json` saved to repo):

    ```bash
    bun run chunk-docs
    ```
    
5. **(Optional) Seed Database**: Process and store your documents:
    
    ```bash    
    # If you update chunks.json, re-run seed 
    bun run db:seed
    ```

6. **Semantic Search**: Search for relevant document:
    ```bash
    bun run semantic-search -- "Your search query here"
    ```

7. **RAG Query**: Query the LLM using the retrieved semantically similar chunks as context:
    ```bash
    bun run rag:ask -- "What is a JavaScript closure?"
    ```
   
    The retrieval flow first gets top-K chunks by vector similarity, then applies `RAG_MIN_SIMILARITY` so only relevant chunks are sent to the LLM. Retrieved chunks are serialized into XML tags (`document`, `title`, `section`, `similarity`, `source_url`, `content`) before prompting the model.

8. **MDN Chat UI (connected to RAG backend)**: Start Nuxt and chat from the browser.

   ```bash
   bun run dev
   ```

   Open `http://localhost:3000`, ask a question, and the app will call `POST /api/chat`.
   The endpoint runs semantic retrieval + threshold filtering + grounded OpenAI answering,
   and returns both answer text and retrieved sources for the context panel.

## Evaluation (Promptfoo)

Use the deterministic retrieval evaluation under `evaluation/retrieval-eval-deterministic/`.

1. Run from the evaluation folder:

   ```bash
   cd evaluation/retrieval-eval-deterministic
   npx promptfoo@latest eval --env-file ./../../.env
   ```

2. If `npx` is unavailable in your shell, use:

   ```bash
   bunx promptfoo@latest eval --env-file ./../../.env
   ```

3. The custom provider is `retrieval-provider.ts`. It:
   - checks cache for the same prompt
   - calls semantic retrieval via `searchSimilarChunks({ question: prompt, topK: 5 })`
   - returns the retrieved chunks as provider output
   - caches the result for 1 hour

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
