import { generateRagAnswer, type ChatHistoryMessage } from '../utils/rag'

interface ChatRequestBody {
  message?: unknown
  history?: unknown
}

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

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as ChatRequestBody
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  if (!message) {
    throw createError({
      statusCode: 400,
      statusMessage: 'The `message` field is required.'
    })
  }

  try {
    return await generateRagAnswer({
      question: message,
      history: parseHistory(body.history)
    })
  } catch (error) {
    const statusMessage = error instanceof Error ? error.message : 'Unknown server error'

    throw createError({
      statusCode: 500,
      statusMessage: `Failed to generate RAG answer: ${statusMessage}`
    })
  }
})
