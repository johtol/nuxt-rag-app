import { streamRagAnswer, type ChatHistoryMessage } from '../../utils/rag'

// ─── Why SSE and not a plain text stream or a direct OpenAI proxy? ────────────
//
// This route streams an answer to the browser over a single HTTP connection.
// Three alternatives were considered:
//
//  1. Direct OpenAI proxy
//     The server could pipe OpenAI's response body straight to the browser
//     without re-encoding it. The problem is that an LLM answer is only one
//     of two things this route must send. Sources come from our own Postgres
//     vector search — they have nothing to do with OpenAI — so they cannot be
//     embedded inside a proxied OpenAI stream. A direct proxy would require a
//     separate round-trip for sources, adding latency and client complexity.
//     Proxying OpenAI's stream also couples the browser to OpenAI's private
//     event schema (`response.output_text.delta`), so switching providers would
//     require frontend changes.
//
//  2. Two-request pattern
//     First request retrieves sources (fast, no generation). Second request
//     streams text tokens. This avoids SSE but needs the client to coordinate
//     two concurrent requests, and the second stream still needs some framing
//     protocol for errors and completion signals.
//
//  3. Server-Sent Events (SSE) — chosen approach
//     SSE is a standard browser protocol (Content-Type: text/event-stream) that
//     multiplexes named, structured messages over a single HTTP connection.
//     Named events (`sources`, `delta`, `done`, `error`) let the server send
//     heterogeneous data — structured JSON metadata and plain-text tokens — in
//     the correct order over one stream with no extra round-trips:
//
//       event: sources   ← vector-DB results, arrives before generation starts
//       data: { sources: [...], usedContext: true }
//
//       event: delta     ← one per LLM text token
//       data: { text: "Closures " }
//
//       event: done      ← generation complete, full answer for finalization
//       data: { answer: "Closures allow..." }
//
//       event: error     ← propagated if retrieval or generation fails
//       data: { message: "..." }
//
//     The contract between server and client is stable and LLM-agnostic:
//     if we replace OpenAI tomorrow, the frontend needs zero changes.
// ──────────────────────────────────────────────────────────────────────────────

// Raw request body shape from the browser. Values are `unknown` first so we can
// validate them safely before using them.
interface ChatRequestBody {
  message?: unknown
  history?: unknown
}

// Normalize the optional client-provided history into a safe, bounded array.
// Only valid user/assistant turns with non-empty content are kept.
function parseHistory(value: unknown): ChatHistoryMessage[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is ChatHistoryMessage => {
      if (!item || typeof item !== 'object') {
        return false
      }

      const role = (item as { role?: unknown }).role
      const content = (item as { content?: unknown }).content
      return (role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim().length > 0
    })
    .slice(-12)
}

// Helper to format one Server-Sent Event block.
// Each event is emitted as:
//   event: <name>
//   data: <json>
// followed by a blank line, which marks the end of the SSE message.
function toSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

export default defineEventHandler(async (event) => {
  // Read and validate the incoming POST payload.
  const body = (await readBody(event)) as ChatRequestBody
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  if (!message) {
    throw createError({
      statusCode: 400,
      statusMessage: 'The `message` field is required.'
    })
  }

  // We stream plain text bytes to the browser, so the ReadableStream controller
  // needs encoded Uint8Array chunks rather than raw strings.
  const encoder = new TextEncoder()

  // This controller lets us cancel the upstream OpenAI request when the client
  // closes the browser tab, navigates away, or clears the request.
  const abortController = new AbortController()

  const handleClose = () => {
    abortController.abort()
  }

  // Node request close events are the easiest way to detect the browser side of
  // the connection disappearing while a stream is in progress.
  event.node.req.once('close', handleClose)

  // Create the HTTP response body as a streaming SSE channel.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Local helper so the rest of the route can write string chunks directly.
      const enqueue = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk))
      }

      // Lightweight initial comment so intermediaries and browsers see activity
      // quickly and establish the stream immediately.
      enqueue(': connected\n\n')

      try {
        // Delegate the actual RAG orchestration to `streamRagAnswer` and simply
        // translate its callbacks into our own SSE event contract.
        await streamRagAnswer(
          {
            question: message,
            history: parseHistory(body.history)
          },
          {
            // Sources are available as soon as retrieval finishes, before token
            // generation starts, so the UI can show retrieved context early.
            onSources(payload) {
              enqueue(toSseEvent('sources', payload))
            },

            // Each text delta is forwarded to the browser as its own SSE event.
            onDelta(text) {
              enqueue(toSseEvent('delta', { text }))
            },

            // Once generation completes we also send the fully accumulated text,
            // which is useful for finalization on the client side.
            onDone(answer) {
              enqueue(toSseEvent('done', { answer }))
            }
          },
          abortController.signal
        )
      } catch (error) {
        // If the request was intentionally aborted because the client went away,
        // we silently stop. Otherwise we emit a structured `error` event.
        if (!abortController.signal.aborted) {
          const statusMessage = error instanceof Error ? error.message : 'Unknown server error'
          enqueue(toSseEvent('error', { message: `Failed to generate RAG answer: ${statusMessage}` }))
        }
      } finally {
        // Always remove listeners and close the stream when work finishes.
        event.node.req.off('close', handleClose)
        controller.close()
      }
    },

    // Browser-side cancellation also lands here, so we abort upstream work and
    // detach the close listener to avoid leaks.
    cancel() {
      abortController.abort()
      event.node.req.off('close', handleClose)
    }
  })

  // SSE-specific headers:
  // - text/event-stream tells the browser to treat this as an event stream
  // - no-cache/no-transform reduces buffering by proxies
  // - keep-alive keeps the connection open
  // - X-Accel-Buffering disables buffering on some reverse proxies like nginx
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  })
})
