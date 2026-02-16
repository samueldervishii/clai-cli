import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Box, useApp, useInput, useStdout } from "ink";
import { Header } from "./components/Header.js";
import { MessageList } from "./components/MessageList.js";
import { InputBar } from "./components/InputBar.js";
import { StatusBar } from "./components/StatusBar.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { streamChat, MODELS, MODEL_DISPLAY, DEFAULT_MODEL, resetClients } from "./lib/claude.js";
import { filterCommands } from "./lib/commands.js";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  addLifetimeSpend,
  getLifetimeSpend,
} from "./lib/config.js";
import { saveConversation, loadConversation, listConversations } from "./lib/conversations.js";
import { validatePath } from "./lib/sandbox.js";
import { setTheme } from "./lib/theme.js";
import { loadContextFile } from "./lib/context-files.js";
import type { ChatMessage, AppState, TokenUsage, MessageSegment, ChatImage } from "./lib/types.js";
import { VERSION } from "./lib/version.js";

const HELP_TEXT = `Available commands:
  /clear       — Clear conversation history and free up context
  /compact     — Summarize conversation to save context
  /config      — Show config. /config save to persist settings
  /copy        — Copy last Clai response to clipboard
  /edit        — Open $EDITOR for multi-line input
  /exit        — Quit Clai
  /help        — Show this help message
  /image       — Send an image. Usage: /image <path> [question]
  /keys        — Show keyboard shortcuts
  /load        — Load a saved conversation. /load to list
  /model       — Show or switch model. /model <name> to switch
  /mood        — Set personality mood. /mood <pirate|formal|sarcastic|...>
  /permissions — Manage tool permissions. /permissions <tool> <always|ask|never>
  /preset      — System prompt presets. /preset <name> or /preset save <name>
  /restore     — Restore a session. /restore to list, /restore <name>
  /save        — Save conversation. /save [name]
  /system      — Set a system prompt. Usage: /system <prompt>
  /theme       — Switch theme. /theme <name> or /theme to list
  /tokens      — Show token usage and cost details
  /web         — Fetch and summarize a URL. Usage: /web <url>

Clai can also read, search, list, write files, and run commands in your working directory.
Just ask it to look at your code or run your tests!`;

const MOOD_PRESETS: Record<string, string> = {
  pirate:
    "Respond as a pirate. Use pirate slang, say 'arr', 'matey', 'ye', 'shiver me timbers', etc. Stay helpful but always in character.",
  formal:
    "Respond in an extremely formal, professional tone. Use sophisticated vocabulary, proper titles, and elaborate courtesy. Like a Victorian-era butler.",
  sarcastic:
    "Respond with dry, witty sarcasm. Be helpful but pepper every answer with sardonic humor and eye-roll-worthy remarks.",
  eli5: "Explain everything like I'm 5 years old. Use simple words, fun analogies, and be enthusiastic. No jargon.",
  zen: "Respond like a calm zen master. Use short, contemplative sentences. Include occasional wisdom metaphors. Be peaceful and mindful.",
  excited:
    "Respond with EXTREME enthusiasm!! Use lots of exclamation marks! Everything is amazing and fascinating! Be genuinely hyped about every topic!",
  noir: "Respond like a 1940s film noir detective. Use moody, atmospheric language. The code is the case. The bugs are the suspects. It was a dark and stormy compile.",
  shakespearean:
    "Respond in Shakespearean English. Use thee, thou, hath, doth, forsooth, etc. Dramatic monologues encouraged. All the world's a terminal.",
};

function checkEasterEgg(input: string): string | null {
  const lower = input.toLowerCase().trim();

  if (lower === "hello world") return 'printf("Hello, World!\\n"); // Classic.';
  if (lower === "sudo make me a sandwich")
    return [
      "Okay.",
      "    ___________",
      "   /           \\",
      "  |  ~  ~  ~  ~ |",
      "  |  =========  |",
      "  |  ~  ~  ~  ~ |",
      "   \\___________/",
      "",
      "One sandwich, made with root privileges.",
    ].join("\n");
  if (lower === "/cowsay" || lower === "cowsay")
    return [
      " _________",
      "< Moo!    >",
      " ---------",
      "        \\   ^__^",
      "         \\  (oo)\\_______",
      "            (__)\\       )\\/\\",
      "                ||----w |",
      "                ||     ||",
    ].join("\n");
  if (lower === "42")
    return "The Answer to the Ultimate Question of Life, the Universe, and Everything.";
  if (lower === "/flip" || lower === "flip table" || lower === "tableflip") return "(╯°□°)╯︵ ┻━┻";
  if (lower === "/unflip" || lower === "unflip") return "┬─┬ノ( º _ ºノ)  There, there.";
  if (lower === "/shrug" || lower === "shrug") return "¯\\_(ツ)_/¯";
  if (lower === "i am groot") return "I am Clai.";
  if (lower === "ping") return "pong";
  if (lower === "marco") return "Polo!";
  if (lower === "hello there") return "General Kenobi!";
  if (lower === "/lenny") return "( ͡° ͜ʖ ͡°)";
  if (lower === "xyzzy")
    return "Nothing happens. (But you clearly have good taste in adventure games.)";
  if (lower === "up up down down left right left right b a")
    return "Unlimited tokens activated! (just kidding)";

  return null;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface AppProps {
  initialMessage?: string;
}

export function App({ initialMessage }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const config = useMemo(() => {
    const cfg = loadConfig();
    if (cfg.theme) setTheme(cfg.theme);
    return cfg;
  }, []);

  // Load .claicontext file and append to system prompt
  const contextFileContent = useMemo(() => loadContextFile(), []);
  const baseSystemPrompt = config.systemPrompt;
  const effectiveSystemPrompt = useMemo(() => {
    if (contextFileContent) {
      return baseSystemPrompt ? `${baseSystemPrompt}${contextFileContent}` : contextFileContent;
    }
    return baseSystemPrompt;
  }, [baseSystemPrompt, contextFileContent]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [streamSegments, setStreamSegments] = useState<MessageSegment[]>([]);
  const [appState, setAppState] = useState<AppState>("idle");
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [currentModel, setCurrentModel] = useState<string>(config.defaultModel ?? DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState<string | undefined>(effectiveSystemPrompt);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [totalUsage, setTotalUsage] = useState<TokenUsage>({
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
  });
  const [currentMood, setCurrentMood] = useState<string | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInputRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sessionIdRef = useRef<string | null>(null);

  /** Get or create the session ID for the current conversation */
  const getSessionId = useCallback(() => {
    if (!sessionIdRef.current) {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
      sessionIdRef.current = `${randomUUID()}_${date}T${time}`;
    }
    return sessionIdRef.current;
  }, []);

  /** Save current conversation to disk (filtered, using session ID) */
  const persistSession = useCallback(
    (msgs: ChatMessage[]) => {
      const real = msgs.filter((m) => !m.id.startsWith("system-"));
      if (real.length === 0) return;
      try {
        saveConversation(real, getSessionId());
      } catch {}
    },
    [getSessionId],
  );

  // Auto-scroll to bottom only if user is already at the bottom
  useEffect(() => {
    setScrollOffset((prev) => (prev === 0 ? 0 : prev + 1));
  }, [messages.length]);

  // Handle piped stdin input
  useEffect(() => {
    if (!initialMessage) return;
    handleSubmit(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  //Keep ref in sync for exit handler
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Save session on process exit (safety net)
  useEffect(() => {
    const handleExit = () => {
      persistSession(messagesRef.current);
    };
    process.on("exit", handleExit);
    return () => {
      process.removeListener("exit", handleExit);
    };
  }, [persistSession]);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
    if (key.escape && appState === "streaming") {
      abortRef.current?.abort();
    }
    if (appState === "idle") {
      // Ctrl+Enter: add newline for multi-line input
      if (key.ctrl && key.return) {
        setInputValue((prev) => prev + "\n");
        return;
      }
      // PageUp/PageDown: scroll the conversation
      if (key.pageUp) {
        setScrollOffset((prev) => Math.min(prev + 3, Math.max(0, messages.length - 1)));
      }
      if (key.pageDown) {
        setScrollOffset((prev) => Math.max(0, prev - 3));
      }
      // Up/down arrows: input history only
      if (key.upArrow) {
        if (inputHistory.length > 0) {
          if (historyIndex < 0) {
            // Entering history mode — save current input
            savedInputRef.current = inputValue;
          }
          const newIdx = Math.min(historyIndex + 1, inputHistory.length - 1);
          setHistoryIndex(newIdx);
          setInputValue(inputHistory[newIdx]!);
        }
      }
      if (key.downArrow && historyIndex >= 0) {
        const newIdx = historyIndex - 1;
        setHistoryIndex(newIdx);
        // Restore saved input when leaving history mode
        setInputValue(newIdx >= 0 ? inputHistory[newIdx]! : savedInputRef.current);
      }
    }
  });

  const addSystemMessage = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: `system-${Date.now()}`,
      role: "assistant",
      content,
    };
    setMessages((prev) => [...prev, msg]);
  }, []);

  const copyToClipboard = useCallback((text: string): boolean => {
    try {
      const cmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
      execSync(cmd, { input: text });
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleInputChange = useCallback(
    (v: string) => {
      setInputValue(v);
      if (historyIndex >= 0) setHistoryIndex(-1);
    },
    [historyIndex],
  );

  const runStreamChat = useCallback(
    async (
      chatMessages: ChatMessage[],
      maxTokens?: number,
    ): Promise<{ text: string; segments: MessageSegment[] } | null> => {
      setAppState("streaming");
      setStreamSegments([]);

      const abortController = new AbortController();
      abortRef.current = abortController;

      let fullResponse = "";
      const localSegments: MessageSegment[] = [];

      try {
        // Prepend mood personality to system prompt if active
        const effectivePrompt =
          currentMood && MOOD_PRESETS[currentMood]
            ? systemPrompt
              ? `${MOOD_PRESETS[currentMood]}\n\n${systemPrompt}`
              : MOOD_PRESETS[currentMood]
            : systemPrompt;

        const generator = streamChat(
          chatMessages,
          currentModel,
          maxTokens,
          effectivePrompt,
          abortController.signal,
        );

        let result = await generator.next();
        while (!result.done) {
          const event = result.value;

          if (event.type === "text_delta") {
            fullResponse += event.text;
            const last = localSegments[localSegments.length - 1];
            if (last?.type === "text") {
              last.content += event.text;
            } else {
              localSegments.push({ type: "text", content: event.text });
            }
            setStreamSegments([...localSegments]);
          } else if (event.type === "tool_start") {
            localSegments.push({ type: "tool", name: event.tool.name, input: event.tool.input });
            setStreamSegments([...localSegments]);
          } else if (event.type === "tool_done") {
            for (let i = localSegments.length - 1; i >= 0; i--) {
              const seg = localSegments[i];
              if (seg?.type === "tool" && !seg.output) {
                seg.output = event.tool.output;
                seg.isError = event.tool.isError;
                break;
              }
            }
            setStreamSegments([...localSegments]);
          } else if (event.type === "tool_approve") {
            if (event.tool.name === "run_command") {
              const cmd = event.tool.input.command as string;
              addSystemMessage(`Run command: ${cmd}\n\nApproved automatically.`);
            } else {
              const path = event.tool.input.path as string;
              const content = event.tool.input.content as string;
              const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
              addSystemMessage(`Write file: ${path}\n\n${preview}\n\nApproved automatically.`);
            }
            event.approve();
          } else if (event.type === "warning") {
            setError(event.message);
          }

          result = await generator.next();
        }

        const { usage } = result.value;
        let newTotalUsage: TokenUsage | undefined;
        setTotalUsage((prev) => {
          newTotalUsage = {
            inputTokens: prev.inputTokens + usage.inputTokens,
            outputTokens: prev.outputTokens + usage.outputTokens,
            totalCost: prev.totalCost + usage.totalCost,
          };
          return newTotalUsage;
        });
        addLifetimeSpend(usage.totalCost);

        // Check context limit and warn if approaching threshold
        if (newTotalUsage) {
          const { checkContextLimit } = await import("./lib/providers.js");
          const contextWarning = checkContextLimit(
            currentModel,
            newTotalUsage.inputTokens + newTotalUsage.outputTokens,
          );
          if (contextWarning) {
            setInfo(contextWarning);
          }
        }

        return { text: fullResponse, segments: localSegments };
      } catch (err: unknown) {
        // Handle user-initiated cancel (Escape key)
        if (abortController.signal.aborted) {
          if (fullResponse) {
            return { text: fullResponse, segments: localSegments };
          }
          return null;
        }
        let msg: string;
        if (err && typeof err === "object" && "status" in err && "error" in err) {
          const apiErr = err as { status: number; error?: { error?: { message?: string } } };
          msg = apiErr.error?.error?.message ?? `API error (${apiErr.status})`;
        } else {
          msg = err instanceof Error ? err.message : String(err);
        }
        setError(msg);
        // Return partial response if we received any content before the error
        if (fullResponse) {
          return { text: fullResponse, segments: localSegments };
        }
        return null;
      } finally {
        abortRef.current = null;
        setStreamSegments([]);
        setAppState("idle");
      }
    },
    [currentModel, systemPrompt, currentMood],
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      let trimmed = value.trim();
      if (!trimmed || appState === "streaming") return;

      // Command aliases
      const COMMAND_ALIASES: Record<string, string> = {
        "/h": "/help",
        "/m": "/model",
        "/t": "/tokens",
        "/k": "/keys",
        "/c": "/clear",
        "/s": "/save",
        "/l": "/load",
        "/e": "/edit",
        "/p": "/permissions",
      };

      // Normalize aliases (only for commands without arguments)
      const firstWord = trimmed.split(" ")[0];
      if (firstWord && COMMAND_ALIASES[firstWord]) {
        const rest = trimmed.slice(firstWord.length).trim();
        trimmed = rest ? `${COMMAND_ALIASES[firstWord]} ${rest}` : COMMAND_ALIASES[firstWord]!;
      }

      setInputValue("");
      setError(undefined);
      setInfo(undefined);
      setHistoryIndex(-1);
      setScrollOffset(0); // Always scroll to bottom on submit
      setInputHistory((prev) => [value.trim(), ...prev.slice(0, 99)]); // Store original, not normalized

      // === Commands ===

      if (trimmed.toLowerCase() === "exit" || trimmed === "/exit") {
        exit();
        return;
      }

      if (trimmed === "/restore" || trimmed.startsWith("/restore ")) {
        const name = trimmed.slice("/restore".length).trim();

        if (!name) {
          // List available sessions
          const convos = listConversations();
          if (convos.length === 0) {
            addSystemMessage("No saved sessions.");
          } else {
            const list = convos
              .slice(0, 10)
              .map((c) => `  - ${c}`)
              .join("\n");
            const more = convos.length > 10 ? `\n  ... and ${convos.length - 10} more` : "";
            addSystemMessage(`Available sessions:\n${list}${more}\n\nUse /restore <name>`);
          }
          return;
        }

        const loaded = loadConversation(name);
        if (!loaded) {
          setError(`Session "${name}" not found. Use /restore to list.`);
          return;
        }
        setMessages(loaded);
        setTotalUsage({ inputTokens: 0, outputTokens: 0, totalCost: 0 });
        sessionIdRef.current = null;
        // Restore the model from the last assistant message
        const lastAssistantModel = [...loaded]
          .reverse()
          .find((m) => m.role === "assistant" && m.model)?.model;
        if (lastAssistantModel) {
          setCurrentModel(lastAssistantModel);
          resetClients();
        }
        setInfo("session restored");
        return;
      }

      if (trimmed === "/clear") {
        setMessages([]);
        setTotalUsage({ inputTokens: 0, outputTokens: 0, totalCost: 0 });
        sessionIdRef.current = null;
        return;
      }

      if (trimmed === "/help") {
        addSystemMessage(HELP_TEXT);
        return;
      }

      if (trimmed === "/keys") {
        const keysText = `Keyboard Shortcuts:

  Ctrl+C         - Exit Clai
  Escape         - Cancel streaming response
  Ctrl+Enter     - Insert newline (multi-line input)
  Enter          - Send message
  Up/Down        - Navigate input history
  PageUp/PageDown - Scroll conversation

Input History:
  - Last 100 inputs saved
  - Use Up arrow to recall previous inputs
  - Use Down arrow to move forward in history`;
        addSystemMessage(keysText);
        return;
      }

      if (trimmed === "/tokens") {
        const lifetime = getLifetimeSpend();

        // Helper to create visual progress bar
        const makeBar = (value: number, max: number, width = 20): string => {
          const percentage = Math.min(value / max, 1);
          const filled = Math.round(percentage * width);
          const empty = width - filled;
          return "█".repeat(filled) + "░".repeat(empty);
        };

        const totalTokens = totalUsage.inputTokens + totalUsage.outputTokens;
        const maxBarTokens = Math.max(totalTokens, 10000); // Min scale for visibility

        // Get context limit info
        const { checkContextLimit } = await import("./lib/providers.js");
        const contextWarning = checkContextLimit(currentModel, totalTokens, 0.5); // Show at 50%

        const detail = `Token Usage (This Session)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Input:  ${makeBar(totalUsage.inputTokens, maxBarTokens)} ${totalUsage.inputTokens.toLocaleString()} tokens
  Output: ${makeBar(totalUsage.outputTokens, maxBarTokens)} ${totalUsage.outputTokens.toLocaleString()} tokens
  Total:  ${totalTokens.toLocaleString()} tokens

Cost Breakdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Session:  $${totalUsage.totalCost.toFixed(4)}
  Lifetime: $${lifetime.toFixed(4)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${contextWarning ? `\n\n${contextWarning}` : ""}`;
        addSystemMessage(detail);
        return;
      }

      if (trimmed === "/model" || trimmed.startsWith("/model ")) {
        const arg = trimmed.slice("/model".length).trim().toLowerCase();
        if (!arg) {
          // Show current model and list available ones
          const { getModelConfig } = await import("./lib/providers.js");
          const currentConfig = getModelConfig(currentModel);
          const currentName = currentConfig?.displayName ?? currentModel;

          const { getAvailableModels } = await import("./lib/claude.js");
          const available = getAvailableModels();

          const anthropicList = available.anthropic
            .map((m) => {
              const marker = m.id === currentModel ? " (active)" : "";
              const shortName = Object.keys(MODELS).find((k) => MODELS[k]?.id === m.id);
              return `  ${shortName} — ${m.displayName}${marker}`;
            })
            .join("\n");

          const groqList = available.groq
            .map((m) => {
              const marker = m.id === currentModel ? " (active)" : "";
              const shortName = Object.keys(MODELS).find((k) => MODELS[k]?.id === m.id);
              return `  ${shortName} — ${m.displayName}${marker}`;
            })
            .join("\n");

          addSystemMessage(
            `Current model: ${currentName}\n\nAnthropic Models:\n${anthropicList}\n\nGroq Models (fast, free tier):\n${groqList}\n\nUsage: /model <name>`,
          );
          return;
        }
        // Match by short name
        const match = Object.entries(MODELS).find(([name]) => name === arg);
        if (!match) {
          const names = Object.keys(MODELS).join(", ");
          setError(`Unknown model "${arg}". Available: ${names}`);
          return;
        }
        const [modelName, modelConfig] = match;

        // Check if switching to Groq model - prompt for API key if needed
        if (modelConfig.provider === "groq" && !process.env.GROQ_API_KEY) {
          try {
            const { ensureGroqApiKey } = await import("./lib/api-key.js");
            await ensureGroqApiKey();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`Failed to configure Groq API key: ${msg}`);
            return;
          }
        }

        setCurrentModel(modelConfig.id);
        resetClients(); // Clear cached client so new provider/key is used
        addSystemMessage(`Switched to ${modelConfig.displayName}`);
        return;
      }

      if (trimmed === "/system" || trimmed.startsWith("/system ")) {
        const prompt = trimmed.slice("/system".length).trim();
        if (!prompt) {
          if (systemPrompt) {
            addSystemMessage(`Current system prompt: "${systemPrompt}"`);
          } else {
            addSystemMessage("No system prompt set. Usage: /system <prompt>");
          }
          return;
        }
        if (prompt.length > 10_000) {
          setError("System prompt too long (max 10,000 characters).");
          return;
        }
        setSystemPrompt(prompt);
        addSystemMessage(`System prompt set: "${prompt}"`);
        return;
      }

      if (trimmed === "/copy") {
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (!lastAssistant) {
          setError("No Clai response to copy.");
          return;
        }
        const ok = copyToClipboard(lastAssistant.content);
        if (ok) {
          addSystemMessage("Copied last response to clipboard.");
        } else {
          setError("Failed to copy. Install xclip: sudo apt install xclip");
        }
        return;
      }

      if (trimmed === "/save" || trimmed.startsWith("/save ")) {
        if (messages.length === 0) {
          setError("No messages to save.");
          return;
        }
        const name = trimmed.slice("/save".length).trim() || undefined;
        try {
          const slug = saveConversation(messages, name);
          addSystemMessage(`Conversation saved as "${slug}". Use /load ${slug} to restore.`);
        } catch {
          setError("Failed to save conversation.");
        }
        return;
      }

      if (trimmed === "/load" || trimmed.startsWith("/load ")) {
        const name = trimmed.slice("/load".length).trim();
        if (!name) {
          const convos = listConversations();
          if (convos.length === 0) {
            addSystemMessage("No saved conversations. Use /save [name] to save one.");
          } else {
            const list = convos
              .slice(0, 10)
              .map((c) => `  ${c}`)
              .join("\n");
            const more = convos.length > 10 ? `\n  ... and ${convos.length - 10} more` : "";
            addSystemMessage(
              `Saved conversations:\n${list}${more}\n\nUse /load <name> to restore.`,
            );
          }
          return;
        }
        const loaded = loadConversation(name);
        if (!loaded) {
          setError(`Conversation "${name}" not found. Use /load to list.`);
          return;
        }
        setMessages(loaded);
        setTotalUsage({ inputTokens: 0, outputTokens: 0, totalCost: 0 });
        // Restore the model from the last assistant message
        const lastModel = [...loaded]
          .reverse()
          .find((m) => m.role === "assistant" && m.model)?.model;
        if (lastModel) {
          setCurrentModel(lastModel);
          resetClients();
        }
        setInfo("conversation loaded");
        return;
      }

      if (trimmed === "/config" || trimmed === "/config save") {
        if (trimmed === "/config save") {
          const existing = loadConfig();
          const ok = saveConfig({
            ...existing,
            defaultModel: currentModel,
            systemPrompt,
          });
          if (ok) {
            addSystemMessage(`Config saved to ${getConfigPath()}`);
          } else {
            setError("Failed to save config.");
          }
          return;
        }
        const modelName = MODEL_DISPLAY[currentModel] ?? currentModel;
        addSystemMessage(`Current settings:
  Model:   ${modelName}
  System:  ${systemPrompt ?? "(none)"}
  Config:  ${getConfigPath()}

Use /config save to persist current settings.`);
        return;
      }

      if (trimmed === "/preset" || trimmed.startsWith("/preset ")) {
        const arg = trimmed.slice("/preset".length).trim();
        const cfg = loadConfig();
        const presets = cfg.presets ?? {};

        if (!arg) {
          const names = Object.keys(presets);
          if (names.length === 0) {
            addSystemMessage(
              "No presets saved. Usage:\n  /preset save <name> — Save current system prompt\n  /preset <name> — Activate a preset",
            );
          } else {
            const list = names.map((n) => `  ${n}: "${presets[n]}"`).join("\n");
            addSystemMessage(`System prompt presets:\n${list}\n\nUse /preset <name> to activate.`);
          }
          return;
        }

        if (arg.startsWith("save ")) {
          const name = arg.slice("save ".length).trim();
          if (!name) {
            setError("Usage: /preset save <name>");
            return;
          }
          if (!systemPrompt) {
            setError("No system prompt set. Use /system first.");
            return;
          }
          presets[name] = systemPrompt;
          cfg.presets = presets;
          saveConfig(cfg);
          addSystemMessage(`Preset "${name}" saved.`);
          return;
        }

        if (arg === "delete" || arg.startsWith("delete ")) {
          const name = arg.slice("delete".length).trim();
          if (!name || !presets[name]) {
            setError(`Preset "${name}" not found.`);
            return;
          }
          delete presets[name];
          cfg.presets = presets;
          saveConfig(cfg);
          addSystemMessage(`Preset "${name}" deleted.`);
          return;
        }

        const preset = presets[arg];
        if (!preset) {
          setError(`Preset "${arg}" not found. Use /preset to list.`);
          return;
        }
        setSystemPrompt(preset);
        addSystemMessage(`Activated preset "${arg}": "${preset}"`);
        return;
      }

      if (trimmed.startsWith("/image ")) {
        const rest = trimmed.slice("/image ".length).trim();
        const parts = rest.split(/\s+/);
        const imagePath = parts[0];
        const question = parts.slice(1).join(" ") || "What's in this image?";

        if (!imagePath) {
          setError("Usage: /image <path> [question]");
          return;
        }

        const absPath = resolve(imagePath);
        const pathCheck = validatePath(absPath);
        if (!pathCheck.allowed) {
          setError(pathCheck.reason ?? "Access denied.");
          return;
        }
        if (!existsSync(absPath)) {
          setError(`File not found: ${imagePath}`);
          return;
        }

        // Enforce 10MB size limit to prevent OOM
        const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
        const imgStat = statSync(absPath);
        if (imgStat.size > MAX_IMAGE_SIZE) {
          setError(`Image too large (${Math.round(imgStat.size / 1024 / 1024)}MB, max 10MB).`);
          return;
        }

        const ext = extname(absPath).toLowerCase();
        const mediaType = IMAGE_EXTENSIONS[ext];
        if (!mediaType) {
          setError(`Unsupported image format: ${ext}. Use .jpg, .png, .gif, or .webp`);
          return;
        }

        try {
          const data = readFileSync(absPath).toString("base64");
          const image: ChatImage = { data, mediaType };

          const userMessage: ChatMessage = {
            id: `user-${Date.now()}`,
            role: "user",
            content: question,
            images: [image],
          };
          const updatedMessages = [...messages, userMessage];
          setMessages(updatedMessages);

          const chatResult = await runStreamChat(updatedMessages);
          if (chatResult) {
            const newMessages = [
              ...updatedMessages,
              {
                id: `${currentModel}-${Date.now()}`,
                role: "assistant" as const,
                content: chatResult.text,
                model: currentModel,
                segments: chatResult.segments,
              },
            ];
            setMessages(newMessages);
            persistSession(newMessages);
          }
        } catch {
          setError("Failed to read image file.");
        }
        return;
      }

      if (trimmed === "/edit") {
        const tmpDir = mkdtempSync(join(tmpdir(), "clai-"));
        const tmpFile = join(tmpDir, "edit.md");
        const editor = process.env.EDITOR ?? process.env.VISUAL ?? "nano";
        const cleanup = () => {
          try {
            rmSync(tmpDir, { recursive: true });
          } catch {}
        };
        try {
          writeFileSync(tmpFile, "", { mode: 0o600 });
          process.on("exit", cleanup);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();

          execSync(`${editor} "${tmpFile}"`, { stdio: "inherit" });

          process.stdin.resume();
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.removeListener("exit", cleanup);

          const content = readFileSync(tmpFile, "utf-8").trim();
          cleanup();

          if (!content) {
            addSystemMessage("Editor closed with no content.");
            return;
          }

          const userMessage: ChatMessage = {
            id: `user-${Date.now()}`,
            role: "user",
            content,
          };
          const updatedMessages = [...messages, userMessage];
          setMessages(updatedMessages);

          const chatResult = await runStreamChat(updatedMessages);
          if (chatResult) {
            const newMessages = [
              ...updatedMessages,
              {
                id: `${currentModel}-${Date.now()}`,
                role: "assistant" as const,
                content: chatResult.text,
                model: currentModel,
                segments: chatResult.segments,
              },
            ];
            setMessages(newMessages);
            persistSession(newMessages);
          }
        } catch (err) {
          process.stdin.resume();
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.removeListener("exit", cleanup);
          cleanup();
          const msg = err instanceof Error ? err.message : String(err);
          setError(`Editor failed: ${msg}`);
        }
        return;
      }

      if (trimmed === "/theme" || trimmed.startsWith("/theme ")) {
        const arg = trimmed.slice("/theme".length).trim().toLowerCase();
        if (!arg) {
          const { getThemeName, listThemes } = await import("./lib/theme.js");
          const current = getThemeName();
          const list = listThemes()
            .map((t) => `  ${t}${t === current ? " (active)" : ""}`)
            .join("\n");

          addSystemMessage(
            `Current theme: ${current}\n\nAvailable themes:\n${list}\n\nUsage: /theme <name>`,
          );
          return;
        }

        const { setTheme, getThemeName } = await import("./lib/theme.js");
        if (!setTheme(arg)) {
          const { listThemes } = await import("./lib/theme.js");
          setError(`Unknown theme "${arg}". Available: ${listThemes().join(", ")}`);
          return;
        }
        const currentConfig = loadConfig();
        currentConfig.theme = arg;
        saveConfig(currentConfig);
        addSystemMessage(`Switched to ${arg} theme.`);
        return;
      }

      if (trimmed === "/mood" || trimmed.startsWith("/mood ")) {
        const arg = trimmed.slice("/mood".length).trim().toLowerCase();
        if (!arg) {
          const moodList = Object.keys(MOOD_PRESETS)
            .map((m) => `  ${m}${m === currentMood ? " (active)" : ""}`)
            .join("\n");
          addSystemMessage(
            `${currentMood ? `Current mood: ${currentMood}` : "No mood set"}\n\nAvailable moods:\n${moodList}\n\nUsage: /mood <name> or /mood off`,
          );
          return;
        }
        if (arg === "off" || arg === "none") {
          setCurrentMood(null);
          addSystemMessage("Mood cleared. Back to normal.");
          return;
        }
        if (!MOOD_PRESETS[arg]) {
          setError(`Unknown mood "${arg}". Available: ${Object.keys(MOOD_PRESETS).join(", ")}`);
          return;
        }
        setCurrentMood(arg);
        addSystemMessage(`Mood set to ${arg}. Arr, let's go! (Use /mood off to disable)`);
        return;
      }

      if (trimmed === "/permissions" || trimmed.startsWith("/permissions ")) {
        const args = trimmed.slice("/permissions".length).trim().split(/\s+/);

        // List all permissions
        if (args.length === 0 || !args[0]) {
          const { getToolPermission } = await import("./lib/config.js");
          const tools = [
            "read_file",
            "write_file",
            "list_dir",
            "search_files",
            "web_fetch",
            "run_command",
          ];
          const permissions = tools
            .map((tool) => `  ${tool.padEnd(15)} — ${getToolPermission(tool)}`)
            .join("\n");

          addSystemMessage(
            `Tool permissions:\n\n${permissions}\n\nPermission levels:\n  always — Auto-approve (no prompts)\n  ask    — Require approval each time (default)\n  never  — Block tool completely\n\nUsage: /permissions <tool> <always|ask|never>\nExample: /permissions write_file always`,
          );
          return;
        }

        // Set permission
        if (args.length === 2) {
          const [toolName, permission] = args;
          const validTools = [
            "read_file",
            "write_file",
            "list_dir",
            "search_files",
            "web_fetch",
            "run_command",
          ];
          const validPermissions = ["always", "ask", "never"];

          if (!validTools.includes(toolName!)) {
            setError(`Unknown tool "${toolName}". Available: ${validTools.join(", ")}`);
            return;
          }

          if (!validPermissions.includes(permission!)) {
            setError(`Invalid permission "${permission}". Must be: always, ask, or never`);
            return;
          }

          const { setToolPermission } = await import("./lib/config.js");
          setToolPermission(toolName!, permission! as "always" | "ask" | "never");
          addSystemMessage(`Set ${toolName} permission to: ${permission}`);
          return;
        }

        setError("Usage: /permissions <tool> <always|ask|never>");
        return;
      }

      if (trimmed === "/compact" || trimmed === "/compact confirm") {
        if (messages.length < 4) {
          setError("Not enough messages to compact.");
          return;
        }
        if (trimmed === "/compact") {
          addSystemMessage(
            `This will replace all ${messages.length} messages with a summary.\nType /compact confirm to proceed.`,
          );
          return;
        }
        const summaryRequest: ChatMessage[] = [
          ...messages.filter((m) => !m.id.startsWith("system-")),
          {
            id: "compact-req",
            role: "user",
            content:
              "Summarize our conversation so far in a concise paragraph. Include key topics discussed, any decisions made, and important context to remember.",
          },
        ];

        const compactResult = await runStreamChat(summaryRequest, 512);
        if (compactResult) {
          setMessages([
            {
              id: `compact-${Date.now()}`,
              role: "assistant",
              content: `[Conversation compacted]\n\n${compactResult.text}`,
            },
          ]);
        }
        return;
      }

      if (trimmed.startsWith("/web ")) {
        const url = trimmed.slice("/web ".length).trim();
        if (!url) {
          setError("Usage: /web <url>");
          return;
        }

        const userMessage: ChatMessage = {
          id: `user-${Date.now()}`,
          role: "user",
          content: `Fetch and summarize this URL: ${url}`,
        };
        const updatedMessages = [...messages, userMessage];
        setMessages(updatedMessages);
        const chatResult = await runStreamChat(updatedMessages);
        if (chatResult) {
          const newMessages = [
            ...updatedMessages,
            {
              id: `${currentModel}-${Date.now()}`,
              role: "assistant" as const,
              content: chatResult.text,
              model: currentModel,
              segments: chatResult.segments,
            },
          ];
          setMessages(newMessages);
          persistSession(newMessages);
        }
        return;
      }

      // === Easter eggs ===
      const easterEgg = checkEasterEgg(trimmed);
      if (easterEgg) {
        addSystemMessage(easterEgg);
        return;
      }

      if (trimmed.startsWith("/")) {
        setError(`Unknown command: ${trimmed}. Type /help for available commands.`);
        return;
      }

      // === Regular chat message ===
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
      };

      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);

      const chatResult = await runStreamChat(updatedMessages);
      if (chatResult) {
        const assistantMessage: ChatMessage = {
          id: `${currentModel}-${Date.now()}`,
          role: "assistant",
          content: chatResult.text,
          model: currentModel,
          segments: chatResult.segments,
        };
        const newMessages = [...updatedMessages, assistantMessage];
        setMessages(newMessages);
        persistSession(newMessages);
      }
    },
    [
      messages,
      appState,
      exit,
      addSystemMessage,
      totalUsage,
      currentModel,
      systemPrompt,
      copyToClipboard,
      runStreamChat,
      persistSession,
    ],
  );

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {messages.filter((m) => !m.id.startsWith("system-")).length === 0 && (
        <Header version={VERSION} model={currentModel} />
      )}
      <MessageList
        messages={messages}
        streamSegments={streamSegments}
        appState={appState}
        scrollOffset={scrollOffset}
      />
      <CommandSuggestions commands={filterCommands(inputValue)} />
      <InputBar
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isDisabled={appState === "streaming"}
        hasNewlines={inputValue.includes("\n")}
      />
      <StatusBar
        messageCount={messages.filter((m) => !m.id.startsWith("system-")).length}
        appState={appState}
        error={error}
        info={info}
        totalUsage={totalUsage}
      />
    </Box>
  );
}
