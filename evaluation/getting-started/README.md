# getting-started evaluation

Basic Promptfoo example to validate local evaluation wiring.

## What it tests

- Two translation prompt templates
- Two OpenAI providers (`gpt-5.5`, `gpt-5.4-mini`)
- Deterministic assertions (`contains`, `icontains`)

## Run

From repository root:

```bash
promptfoo eval -c evaluation/getting-started/promptfooconfig.yaml
```

## Requirements

- `OPENAI_API_KEY` set in your environment
