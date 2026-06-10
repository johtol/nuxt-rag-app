<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useChat } from "@ai-sdk/vue";
import { DefaultChatTransport } from "ai";
// // import type { AppUIMessage } from "~/src/app/helpers/aiMessage";
//
interface ChatSource {
  id: string;
  title: string;
  content: string;
  url: string;
}

interface Message {
  id: string;
  type: "user" | "ai";
  content: string;
  timestamp: Date | null;
  sources?: ChatSource[];
}

const input = ref("");
const isContextPanelOpen = ref(false);
const isExportDialogOpen = ref(false);
const messagesEndRef = ref<HTMLDivElement | null>(null);

// const { messages, sendMessage, status, setMessages } = useChat<AppUIMessage>({
//   transport: new DefaultChatTransport({
//     api: "/api/chat",
//   }),
// });
//
// const chatMessages = computed<Message[]>(() =>
//   messages.value.map((msg) => {
//     const isDone = Boolean(
//       msg?.parts?.find((part) => part.type === "text" && part.state === "done")
//     );
//
//     return {
//       id: msg.id,
//       type: msg.role === "user" ? "user" : "ai",
//       content:
//         msg.parts
//           ?.filter((part) => part.type === "text")
//           .map((part) => ("text" in part ? part.text : ""))
//           .join("") || "",
//       timestamp: msg.metadata?.createdAt
//         ? new Date(msg.metadata.createdAt)
//         : null,
//       sources: isDone
//         ?
//             msg.parts?.find(
//               (part) =>
//                 part?.type === "tool-queryKnowledgeBase" &&
//                 part?.state === "output-available"
//             )?.output || []
//         : [],
//     };
//   })
// );
//
// const allSources = computed(() =>
//   chatMessages.value
//     .filter((m) => m.type === "ai" && m.sources)
//     .flatMap((m) => m.sources || [])
// );
//
// async function scrollToBottom() {
//   await nextTick();
//   messagesEndRef.value?.scrollIntoView({ behavior: "smooth" });
// }
//
// watch(chatMessages, () => {
//   void scrollToBottom();
// });
//
function handleSubmit() {
  if (!input.value.trim()) {
    return;
  }

  const currentInput = input.value.trim();
  input.value = "";

  sendMessage({ text: currentInput, metadata: { createdAt: Date.now() } });
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
}

function clearChat() {
  setMessages([]);
}
</script>

<template>
  <div class="flex h-screen bg-[#0f0f23] text-white">
    <div
      class="flex flex-col transition-all duration-300"
      :class="isContextPanelOpen ? 'flex-1' : 'w-full'"
    >
      <!-- header of the app: App title and buttons on the right -->
      <header
        class="border-b border-gray-800 p-4 flex items-center justify-between bg-[#1a1a2e]"
      >
        <div class="flex items-center gap-3">
          <h1 class="text-xl font-semibold text-white">MDN Developer Chat</h1>
          <span class="text-sm text-gray-400">
            AI-powered documentation assistant
          </span>
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
            @click="isExportDialogOpen = true"
          >
            Export
          </button>

          <button
            aria-label="Clear conversation"
            class="p-2 rounded-lg hover:bg-gray-700 transition-colors text-gray-300 hover:text-white"
            @click="clearChat"
          >
            Clear
          </button>
        </div>
      </header>
      <!-- main part of the page -->
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <div

          class="flex items-center justify-center h-full text-center"
        >
          <div class="max-w-md">
            <h2 class="text-2xl font-semibold mb-4 text-gray-200">
              Welcome to MDN Developer Chat
            </h2>
            <p class="text-gray-400 mb-6">
              Ask me anything about web development, JavaScript, CSS, HTML, or
              any other topics covered in MDN documentation.
            </p>
            <div class="grid grid-cols-1 gap-2 text-sm">
              <button
                class="p-3 text-left rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-200"
                @click="input = 'What is the difference between let and var in JavaScript?'"
              >
                What is the difference between let and var in JavaScript?
              </button>
              <button
                class="p-3 text-left rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-200"
                @click="input = 'How do CSS Grid and Flexbox differ?'"
              >
                How do CSS Grid and Flexbox differ?
              </button>
              <button
                class="p-3 text-left rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-gray-200"
                @click="input = 'What are Web Components and how do I use them?'"
              >
                What are Web Components and how do I use them?
              </button>
            </div>
          </div>
        </div>
        <div ref="messagesEndRef" />
      </div>
      <!-- footer: It includes the textarea and the send button -->
      <div class="border-t border-gray-800 p-4 bg-[#1a1a2e]">
        <form class="flex gap-3" @submit.prevent="handleSubmit">
          <div class="flex-1 relative">
            <textarea
              v-model="input"
              placeholder="Ask me about web development, JavaScript, CSS, HTML..."
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 pr-12 text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 resize-none min-h-[50px] max-h-32"

              rows="1"
              @keydown="handleKeyDown"
            />
            <button
              type="submit"
              aria-label="Send message"
              class="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
              :disabled="!input.trim()"
            >
              Send
            </button>
          </div>
        </form>

        <div class="mt-2 text-xs text-gray-500 text-center">
          Press Enter to send, Shift+Enter for new line
        </div>
      </div>
    </div>
  </div>
</template>

