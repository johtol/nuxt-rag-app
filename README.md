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
   ```

   Drizzle is configured with:

   - Config: `drizzle.config.ts`
   - Schema: `server/db/schema.ts`
   - DB client: `server/utils/db.ts`
   - Migration helper: `scripts/migrate.mjs` (wraps drizzle-kit to handle PostgreSQL NOTICE messages)

   Use `DATABASE_URL` in your `.env` file (see `.env.example`).

4. **Seed Database**: Process and store your documents:

   ```bash
   bun run db:seed
   ```

5. **Chunk Docs**: Process and store your documents (optional - chunks.json saved to repo):

   ```bash
   bun run chunk-docs
   ```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
