# retrieval-eval-deterministic

Deterministic retrieval evaluation for the RAG pipeline.

## What it tests

- Custom provider (`retrieval-provider.ts`) that returns retrieved chunks
- Query-to-chunk matching using `contains-all`
- Stable retrieval behavior for known MDN queries

## Run

From repository root:

```bash
promptfoo eval -c evaluation/retrieval-eval-deterministic/promptfooconfig.yaml
```

## Requirements

- `DATABASE_URL`
- `VOYAGE_API_KEY`
