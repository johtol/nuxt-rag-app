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
    bun run db:generate
    bun run db:migrate
    bun run db:seed
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

4. **Optional: Re-seed or chunk new docs**:

    ```bash
    # If you update chunks.json, re-run seed
    bun run db:seed
    ```

## Ask Questions with RAG

Use the script below to retrieve similar chunks and ask an LLM using that context:

```bash
bun run rag:ask -- "What is a JavaScript closure?"
```

Optional environment variables:

- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `RAG_TOP_K` (default: `5`)
- `RAG_MIN_SIMILARITY` (default: `0.6`, range `0` to `1`)

The retrieval flow first gets top-K chunks by vector similarity, then applies `RAG_MIN_SIMILARITY` so only relevant chunks are sent to the LLM.
Retrieved chunks are serialized into XML tags (`document`, `title`, `section`, `similarity`, `source_url`, `content`) before prompting the model.


Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
