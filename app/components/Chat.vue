<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

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

interface ChatApiResponse {
  answer: string
  sources: ChatSource[]
  usedContext: boolean
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

const input = ref('')
const isContextPanelOpen = ref(false)
const isLoading = ref(false)
const requestError = ref('')
const copiedCodeBlockKey = ref('')
const messagesEndRef = ref<HTMLDivElement | null>(null)
const messages = ref<Message[]>([])
const mdnBaseUrl = 'https://developer.mozilla.org'

const latestAiSources = computed<ChatSource[]>(() => {
  const latestAiMessage = [...messages.value].reverse().find(message => message.type === 'ai')
  return latestAiMessage?.sources ?? []
})

function createMessageId(prefix: 'user' | 'ai'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toHistoryPayload(): ChatHistoryMessage[] {
  return messages.value.map(message => ({
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

function parseMessageSegments(content: string): MessageSegment[] {
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

async function handleSubmit() {
  const question = input.value.trim()
  if (!question || isLoading.value) {
    return
  }

  requestError.value = ''
  input.value = ''

  messages.value.push({
    id: createMessageId('user'),
    type: 'user',
    content: question,
    timestamp: new Date()
  })

  isLoading.value = true

  try {
    const response = await $fetch<ChatApiResponse>('/api/chat', {
      method: 'POST',
      body: {
        message: question,
        history: toHistoryPayload()
      }
    })

    messages.value.push({
      id: createMessageId('ai'),
      type: 'ai',
      content: response.answer,
      timestamp: new Date(),
      sources: response.sources
    })
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : 'Failed to get an answer from the assistant.'
  } finally {
    isLoading.value = false
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void handleSubmit()
  }
}

function clearChat() {
  messages.value = []
  requestError.value = ''
}

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
                <p class="text-sm text-gray-100 hover:text-gray-400" v-if="getSourceHref(source)">
                  <a :href="getSourceHref(source)" target="_blank"
                  rel="noopener noreferrer">[Source {{ index + 1 }}] {{ source.title }}</a>
                </p>
                <p class="text-sm text-gray-100" v-else>
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
          v-if="isLoading"
          class="text-sm text-gray-400"
        >
          Assistant is thinking...
        </div>
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
