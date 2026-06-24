# context-adherence

Faithfulness evaluation for generated RAG answers against retrieved context.

## What it tests

- Custom provider (`provider.ts`) that reuses `scripts/rag-answer.ts` (`runRagAnswer`)
- `context-faithfulness` scoring using:
  - `transform: output.answer`
  - `contextTransform: output.context`
- Deterministic answer checks (e.g. expected MDN URL presence)

## Run

From repository root:

```bash
promptfoo eval -c evaluation/context-adherence/promptfooconfig.yaml
```

## Requirements

- `OPENAI_API_KEY`
- `DATABASE_URL`
- `VOYAGE_API_KEY`
