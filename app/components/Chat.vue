<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

defineOptions({
  name: 'MdnChat'
})

// Source objects attached to assistant answers. These mirror the server-side
// shape so the UI can render citations, the context panel, and export links.
interface ChatSource {
  id: string
  title: string
  content: string
  url: string
  slug: string | null
  headingText: string | null
  similarity: number
  section: string
}

interface Message {
  id: string
  type: 'user' | 'ai'
  content: string
  timestamp: Date
  sources?: ChatSource[]
}

interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

interface MessageSegment {
  type: 'text' | 'code'
  value: string
  language?: string
}

// Simplified browser-side representation of one parsed SSE message.
interface ServerSentEventMessage {
  event: string
  data: string
}

// Main reactive chat state used by the page.
const input = ref('')
const isContextPanelOpen = ref(false)
const isLoading = ref(false)
const requestError = ref('')
const copiedCodeBlockKey = ref('')
const messagesEndRef = ref<HTMLDivElement | null>(null)
const messages = ref<Message[]>([])

// Tracks the current in-flight request so we can abort it when the user clears
// the chat or leaves the page.
const activeRequestController = ref<AbortController | null>(null)
const mdnBaseUrl = 'https://developer.mozilla.org'

// The context sidebar always reflects the newest assistant message, which means
// it updates naturally as soon as streamed sources arrive.
const latestAiSources = computed<ChatSource[]>(() => {
  const latestAiMessage = [...messages.value].reverse().find(message => message.type === 'ai')
  return latestAiMessage?.sources ?? []
})

function createMessageId(prefix: 'user' | 'ai'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Convert the rendered conversation into the compact history payload expected
// by the backend. Empty placeholders are filtered out so a half-streamed answer
// is never echoed back into the next prompt.
function toHistoryPayload(): ChatHistoryMessage[] {
  return messages.value
    .filter(message => message.content.trim().length > 0)
    .map(message => ({
      role: message.type === 'user' ? 'user' : 'assistant',
      content: message.content
    }))
}

async function scrollToBottom() {
  await nextTick()
  messagesEndRef.value?.scrollIntoView({ behavior: 'smooth', block: 'end' })
}

watch(
  () => messages.value.length,
  () => {
    void scrollToBottom()
  }
)

function fillPrompt(value: string) {
  input.value = value
}

// Small message helpers keep the streaming update logic readable.
function getMessageById(messageId: string): Message | undefined {
  return messages.value.find(message => message.id === messageId)
}

function removeMessageById(messageId: string) {
  messages.value = messages.value.filter(message => message.id !== messageId)
}

function updateMessageSources(messageId: string, sources: ChatSource[]) {
  const message = getMessageById(messageId)
  if (message) {
    message.sources = sources
  }
}

function appendMessageContent(messageId: string, contentChunk: string) {
  const message = getMessageById(messageId)
  if (message) {
    message.content += contentChunk
  }
}

function finalizeMessageContent(messageId: string, finalContent: string) {
  const message = getMessageById(messageId)
  if (message && !message.content.trim() && finalContent.trim()) {
    message.content = finalContent
  }
}

// Parse raw text read from the HTTP body into complete SSE events.
// Because network chunks can split events arbitrarily, the trailing incomplete
// fragment is returned as `remaining` and prepended to the next chunk.
//
// Why parse SSE manually instead of using the browser's EventSource API?
// EventSource only supports GET requests and cannot send a JSON body, so it
// cannot carry the message and history. We use a POST fetch stream instead,
// which means we receive raw bytes and must parse the SSE framing ourselves.
// The format we parse is our own stable contract defined in stream.post.ts,
// not OpenAI's internal event schema — so this parser stays correct even if
// the underlying LLM provider changes.
function extractServerSentEvents(buffer: string): { events: ServerSentEventMessage[], remaining: string, } {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const remaining = blocks.pop() ?? ''
  const events: ServerSentEventMessage[] = []

  for (const block of blocks) {
    let event = 'message'
    const dataLines: string[] = []

    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) {
        continue
      }

      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        continue
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    if (dataLines.length > 0) {
      events.push({
        event,
        data: dataLines.join('\n')
      })
    }
  }

  return { events, remaining }
}

// Apply one parsed SSE event to the assistant placeholder currently being
// streamed into the chat transcript.
async function handleStreamEvent(event: ServerSentEventMessage, assistantMessageId: string) {
  const payload = JSON.parse(event.data) as {
    answer?: string
    message?: string
    sources?: ChatSource[]
    text?: string
  }

  if (event.event === 'sources') {
    updateMessageSources(assistantMessageId, payload.sources ?? [])
    await scrollToBottom()
    return
  }

  if (event.event === 'delta') {
    if (payload.text) {
      appendMessageContent(assistantMessageId, payload.text)
      await scrollToBottom()
    }
    return
  }

  if (event.event === 'done') {
    finalizeMessageContent(assistantMessageId, payload.answer ?? '')
    await scrollToBottom()
    return
  }

  if (event.event === 'error') {
    throw new Error(payload.message ?? 'Failed to get an answer from the assistant.')
  }
}

// Lightweight renderer that recognizes fenced code blocks in assistant output
// and splits them into plain-text and code segments for display.
function parseMessageSegments(content: string): MessageSegment[] {
  if (!content) {
    return []
  }

  const codeBlockRegex = /```([\w-]+)?\n([\s\S]*?)```/g
  const segments: MessageSegment[] = []
  let cursor = 0

  for (const match of content.matchAll(codeBlockRegex)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const textSegment = content.slice(cursor, start)

    if (textSegment) {
      segments.push({ type: 'text', value: textSegment })
    }

    segments.push({
      type: 'code',
      value: match[2] ?? '',
      language: (match[1] ?? '').trim() || 'text'
    })

    cursor = end
  }

  const trailingText = content.slice(cursor)
  if (trailingText) {
    segments.push({ type: 'text', value: trailingText })
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', value: content })
  }

  return segments
}

// Copy helper for rendered code blocks.
async function copyCodeToClipboard(code: string, key: string) {
  try {
    await navigator.clipboard.writeText(code)
    copiedCodeBlockKey.value = key
    setTimeout(() => {
      if (copiedCodeBlockKey.value === key) {
        copiedCodeBlockKey.value = ''
      }
    }, 1500)
  } catch {
    copiedCodeBlockKey.value = ''
  }
}

// Reconstruct an MDN anchor from the heading text when we have enough source
// metadata to produce a direct deep link.
function slugifyHeading(heading: string): string {
  // Convert heading to MDN-style anchor: lowercase, spaces to underscores
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, '_')
    .replaceAll(/[^\w_]/g, '')
}

function normalizeSourceUrl(rawUrl: string): string {
  const value = rawUrl.trim()
  if (!value || value === 'N/A') {
    return ''
  }

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  if (value.startsWith('//')) {
    return `https:${value}`
  }

  // Normalize local/seeded paths into MDN web paths.
  const normalizedPath = value
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .replace(/^mdn-docs\//, '')
    .replace(/\/index\.md$/i, '')
    .replace(/\.md$/i, '')

  if (normalizedPath.startsWith('/')) {
    return `${mdnBaseUrl}${normalizedPath}`
  }

  if (normalizedPath.startsWith('en-US/')) {
    return `${mdnBaseUrl}/${normalizedPath}`
  }

  if (normalizedPath.startsWith('docs/')) {
    return `${mdnBaseUrl}/en-US/${normalizedPath}`
  }

  if (normalizedPath.startsWith('Web/')) {
    return `${mdnBaseUrl}/en-US/docs/${normalizedPath}`
  }

  return `${mdnBaseUrl}/en-US/docs/${normalizedPath}`
}

// Centralized link-building logic shared by the template and the export flow.
function getSourceHref(source: ChatSource): string {
  // Centralized so template/export always share identical link logic.

  // If we have both slug and heading, construct the full MDN URL with anchor
  if (source.slug && source.headingText) {
    const anchor = slugifyHeading(source.headingText)
    return `${mdnBaseUrl}/en-US/docs/${source.slug}#${anchor}`
  }

  // Fallback to slug-only URL
  if (source.slug) {
    return `${mdnBaseUrl}/en-US/docs/${source.slug}`
  }

  // Fallback to old URL normalization logic
  return normalizeSourceUrl(source.url)
}

// Main submit flow for the streaming chat UI.
// Sequence:
// 1) snapshot existing history,
// 2) add the user's message,
// 3) add an empty assistant placeholder,
// 4) open the streaming endpoint,
// 5) incrementally apply SSE events to the placeholder.
async function handleSubmit() {
  const question = input.value.trim()
  if (!question || isLoading.value) {
    return
  }

  const history = toHistoryPayload()
  requestError.value = ''
  input.value = ''

  const assistantMessageId = createMessageId('ai')

  messages.value.push({
    id: createMessageId('user'),
    type: 'user',
    content: question,
    timestamp: new Date()
  })

  messages.value.push({
    id: assistantMessageId,
    type: 'ai',
    content: '',
    timestamp: new Date(),
    sources: []
  })

  isLoading.value = true
  const abortController = new AbortController()
  activeRequestController.value = abortController

  try {
    // Native fetch is required here because we need direct access to the
    // streaming response body. `$fetch` resolves only after completion.
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        message: question,
        history
      }),
      signal: abortController.signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || 'Failed to open the streaming response.')
    }

    if (!response.body) {
      throw new Error('Streaming response body is unavailable in this browser.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Read arbitrary network chunks, append them to the buffer, parse all full
    // SSE messages found so far, and keep any incomplete tail for the next read.
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parsed = extractServerSentEvents(buffer)
      buffer = parsed.remaining

      for (const event of parsed.events) {
        await handleStreamEvent(event, assistantMessageId)
      }
    }

    // Flush any remaining decoder state once the stream ends.
    buffer += decoder.decode()
    if (buffer.trim()) {
      const trailingEvents = extractServerSentEvents(`${buffer}\n\n`).events
      for (const event of trailingEvents) {
        await handleStreamEvent(event, assistantMessageId)
      }
    }
  } catch (error) {
    // Abort is an expected control-flow path when the user clears the chat or
    // navigates away, so we do not surface it as a failure.
    if (error instanceof DOMException && error.name === 'AbortError') {
      return
    }

    // If nothing was streamed yet, remove the placeholder bubble so the chat
    // does not keep an empty assistant message around after errors.
    if (!getMessageById(assistantMessageId)?.content.trim()) {
      removeMessageById(assistantMessageId)
    }

    requestError.value = error instanceof Error ? error.message : 'Failed to get an answer from the assistant.'
  } finally {
    // Only clear the controller if this request is still the active one.
    if (activeRequestController.value === abortController) {
      activeRequestController.value = null
    }

    isLoading.value = false
  }
}

// Enter submits; Shift+Enter inserts a newline.
function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void handleSubmit()
  }
}

// Clearing the transcript also aborts any in-flight stream so the server does
// not continue producing tokens for a conversation the user discarded.
function clearChat() {
  activeRequestController.value?.abort()
  messages.value = []
  requestError.value = ''
}

// Defensive cleanup when leaving the page.
onBeforeUnmount(() => {
  activeRequestController.value?.abort()
})

// Export the current conversation to markdown, including source links for each
// assistant message so the transcript remains traceable outside the app.
function exportChat() {
  if (messages.value.length === 0) {
    return
  }

  const lines: string[] = [
    '# MDN Developer Chat Export',
    `Generated at: ${new Date().toISOString()}`,
    ''
  ]

  for (const message of messages.value) {
    lines.push(`## ${message.type === 'user' ? 'User' : 'Assistant'}`)
    lines.push(`Timestamp: ${message.timestamp.toISOString()}`)
    lines.push('')
    lines.push(message.content)
    lines.push('')

    if (message.sources && message.sources.length > 0) {
      lines.push('Sources:')
      message.sources.forEach((source, index) => {
        // Export canonical URL so shared transcripts keep valid links.
        const sourceUrl = getSourceHref(source) || source.url
        lines.push(`${index + 1}. ${source.title} (${Math.round(source.similarity * 100)}%)`)
        lines.push(`   ${sourceUrl}`)
      })
      lines.push('')
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `mdn-chat-${new Date().toISOString().replaceAll(':', '-')}.md`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="flex h-screen bg-[#0f0f23] text-white">
    <div
      class="flex flex-col transition-all duration-300"
      :class="isContextPanelOpen ? 'flex-1' : 'w-full'"
    >
      <header class="border-b border-gray-800 p-4 flex items-center justify-between bg-[#1a1a2e]">
        <div class="flex items-center gap-3">
          <h1 class="text-xl font-semibold text-white">
            MDN Developer Chat
          </h1>
          <span class="text-sm text-gray-400">AI-powered documentation assistant</span>
        </div>

        <div class="flex items-center gap-2">
          <button
            :aria-label="isContextPanelOpen ? 'Close context panel' : 'Open context panel'"
            class="p-2 rounded-lg hover:bg-gray-700 transition-colors text-gray-300 hover:text-white"
            @click="isContextPanelOpen = !isContextPanelOpen"
          >
            {{ isContextPanelOpen ? "Close" : "Context" }}
          </button>

          <button
            aria-label="Export conversation"
            class="p-2 rounded-lg hover:bg-gray-700 transition-colors text-gray-300 hover:text-white"
            :disabled="messages.length === 0"
            @click="exportChat"
          >
            Export
          </button>

          <button
            aria-label="Clear conversation"
            class="p-2 rounded-lg hover:bg-gray-700 transition-colors text-gray-300 hover:text-white"
            :disabled="messages.length === 0"
            @click="clearChat"
          >
            Clear
          </button>
        </div>
      </header>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <div
          v-if="messages.length === 0"
          class="flex items-center justify-center h-full text-center"
        >
          <div class="max-w-md">
            <h2 class="text-2xl font-semibold mb-4 text-gray-200">
              Welcome to MDN Developer Chat
            </h2>
            <p class="text-gray-400 mb-6">
              Ask me anything about web development, JavaScript, CSS, HTML, or any other topics covered in MDN documentation.
            </p>
            <div class="grid grid-cols-1 gap-2 text-sm">
              <button
                class="p-3 text-left rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-200"
                @click="fillPrompt('What is the difference between let and var in JavaScript?')"
              >
                What is the difference between let and var in JavaScript?
              </button>
              <button
                class="p-3 text-left rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-200"
                @click="fillPrompt('How do CSS Grid and Flexbox differ?')"
              >
                How do CSS Grid and Flexbox differ?
              </button>
              <button
                class="p-3 text-left rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-200"
                @click="fillPrompt('What are JavaScript closures and when should I use them?')"
              >
                What are JavaScript closures and when should I use them?
              </button>
            </div>
          </div>
        </div>

        <template v-else>
          <article
            v-for="message in messages"
            :key="message.id"
            class="rounded-xl border border-gray-800 px-4 py-3"
            :class="message.type === 'user' ? 'bg-[#23233b]' : 'bg-[#1a1a2e]'"
          >
            <div class="flex items-center justify-between mb-2 text-xs text-gray-400">
              <span>{{ message.type === "user" ? "You" : "Assistant" }}</span>
              <span>{{ message.timestamp.toLocaleTimeString() }}</span>
            </div>
            <div class="space-y-3">
              <p
                v-if="message.type === 'ai' && !message.content && isLoading"
                class="text-sm italic text-gray-400"
              >
                Streaming answer...
              </p>
              <template
                v-for="(segment, segmentIndex) in parseMessageSegments(message.content)"
                :key="`${message.id}-${segmentIndex}`"
              >
                <p
                  v-if="segment.type === 'text'"
                  class="whitespace-pre-wrap leading-7 text-gray-100"
                >
                  {{ segment.value }}
                </p>
                <div
                  v-else
                  class="rounded-lg border border-gray-700 bg-[#0d0d1a]"
                >
                  <div class="flex items-center justify-between border-b border-gray-700 px-3 py-2 text-xs">
                    <span class="text-gray-400 uppercase tracking-wide">{{ segment.language }}</span>
                    <button
                      type="button"
                      class="rounded px-2 py-1 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
                      @click="copyCodeToClipboard(segment.value, `${message.id}-${segmentIndex}`)"
                    >
                      {{ copiedCodeBlockKey === `${message.id}-${segmentIndex}` ? 'Copied' : 'Copy' }}
                    </button>
                  </div>
                  <pre class="overflow-x-auto px-3 py-3 text-sm leading-6 text-gray-100"><code>{{ segment.value }}</code></pre>
                </div>
              </template>
            </div>

            <div
              v-if="message.type === 'ai' && (message.sources?.length ?? 0) > 0"
              class="mt-3 border-t border-gray-700 pt-3 space-y-2"
            >
              <p class="text-xs uppercase tracking-wide text-gray-400">
                Sources
              </p>
              <div
                v-for="(source, index) in message.sources"
                :key="`${message.id}-${source.id}`"
                class="rounded-lg bg-[#111122] p-3"
              >
                <p
                  v-if="getSourceHref(source)"
                  class="text-sm text-gray-100 hover:text-gray-400"
                >
                  <a
                    :href="getSourceHref(source)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >[Source {{ index + 1 }}] {{ source.title }}</a>
                </p>
                <p
                  v-else
                  class="text-sm text-gray-100"
                >
                  [Source {{ index + 1 }}] {{ source.title }}
                </p>
                <p class="text-xs text-gray-400">
                  {{ source.section }} · {{ Math.round(source.similarity * 100) }}%
                </p>
                <a
                  :href="getSourceHref(source)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs text-purple-300 hover:text-purple-200"
                >
                  {{ source.url }}
                </a>
              </div>
            </div>
          </article>
        </template>

        <div
          v-if="requestError"
          class="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-200"
        >
          {{ requestError }}
        </div>
        <div ref="messagesEndRef" />
      </div>

      <div class="border-t border-gray-800 p-4 bg-[#1a1a2e]">
        <form
          class="flex gap-3"
          @submit.prevent="handleSubmit"
        >
          <div class="flex-1 relative">
            <textarea
              v-model="input"
              placeholder="Ask me about web development, JavaScript, CSS, HTML..."
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 pr-12 text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 resize-none min-h-[50px] max-h-32"
              :disabled="isLoading"
              rows="1"
              @keydown="handleKeyDown"
            />
            <button
              type="submit"
              aria-label="Send message"
              class="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
              :disabled="!input.trim() || isLoading"
            >
              {{ isLoading ? "..." : "Send" }}
            </button>
          </div>
        </form>

        <div class="mt-2 text-xs text-gray-500 text-center">
          Press Enter to send, Shift+Enter for new line
        </div>
      </div>
    </div>

    <aside
      v-if="isContextPanelOpen"
      class="w-[360px] border-l border-gray-800 bg-[#121225] p-4 overflow-y-auto"
    >
      <h2 class="text-sm uppercase tracking-wide text-gray-400 mb-3">
        Latest Retrieved Context
      </h2>

      <div
        v-if="latestAiSources.length === 0"
        class="text-sm text-gray-500"
      >
        Ask a question to see retrieved MDN chunks here.
      </div>

      <div
        v-else
        class="space-y-3"
      >
        <article
          v-for="(source, index) in latestAiSources"
          :key="`${source.id}-${index}`"
          class="rounded-lg bg-[#1a1a2e] border border-gray-800 p-3"
        >
          <p class="text-sm text-gray-100">
            [Source {{ index + 1 }}] {{ source.title }}
          </p>
          <p class="text-xs text-gray-400 mb-2">
            {{ source.section }} · {{ Math.round(source.similarity * 100) }}%
          </p>
          <p class="text-sm text-gray-300 line-clamp-5">
            {{ source.content }}
          </p>
        </article>
      </div>
    </aside>
  </div>
</template>
