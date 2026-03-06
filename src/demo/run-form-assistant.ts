import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { ensureModelApiKeysForModel, getDefaultModel } from "../config.js";
import type { FormFields } from "../types.js";
import { mergeAndPersistProfileFields, readProfileFields } from "../mastra/memory/profile-memory.js";
import {
  applyLoginFormValues,
  closeBrowserSession,
  extractLoginFormFields,
  startBrowserSession,
} from "../mastra/tools/kernel-tools.js";

type ArgMap = Record<string, string | boolean>;

const runsDir = path.resolve(".demo-runs");
const trackedKernelSessions = new Map<string, string | undefined>();
let sessionCleanupPromise: Promise<void> | undefined;

function trackKernelSession(sessionId?: string, replayId?: string): void {
  if (!sessionId) {
    return;
  }
  trackedKernelSessions.set(sessionId, replayId);
}

function untrackKernelSession(sessionId?: string): void {
  if (!sessionId) {
    return;
  }
  trackedKernelSessions.delete(sessionId);
}

async function cleanupTrackedKernelSessions(): Promise<void> {
  if (sessionCleanupPromise) {
    return sessionCleanupPromise;
  }
  sessionCleanupPromise = (async () => {
    const sessions = Array.from(trackedKernelSessions.entries());
    for (const [sessionId, replayId] of sessions) {
      await closeBrowserSession(sessionId, replayId).catch(() => undefined);
      trackedKernelSessions.delete(sessionId);
    }
  })();
  return sessionCleanupPromise;
}

function installSignalCleanup(): () => void {
  let handlingSignal = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (handlingSignal) {
      return;
    }
    handlingSignal = true;
    process.stderr.write(`\nReceived ${signal}. Closing active Kernel browser sessions...\n`);
    void (async () => {
      await cleanupTrackedKernelSessions().catch(() => undefined);
      process.exit(130);
    })();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function argString(args: ArgMap, key: string, fallback?: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function argBool(args: ArgMap, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "y"].includes(value.toLowerCase());
  }
  return fallback;
}

function isHelpRequested(args: ArgMap): boolean {
  return args.help === true || args.h === true || process.argv.slice(2).some((v) => v === "help");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSiteInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function printUsage(): void {
  const text = `Usage:
  npm run demo:start -- --site <url> [options]

Examples:
  npm run demo:start -- --site "https://www.saucedemo.com/"
  npm run demo:start -- --site "https://www.selenium.dev/selenium/web/web-form.html"
  npm run demo:start -- --site "https://www.linkedin.com/login"

Start options:
  --site <url|domain>           (required; adds https:// when missing)
  --task <text>                 (optional; high-level goal for the assistant)
  --profile <name>              (optional; explicit Kernel profile name to find/create)
  --resourceId <id>             (default: demo-user)
  --threadId <id>               (default: <resourceId>-profile)
  --turns <number>              (default: 6)
  --debug <true|false>          (default: false; prints turn/tool diagnostics)
  --trace <true|false>          (default: true; streams step/tool traces)

Suggested demo sites:
  - https://www.saucedemo.com/
  - https://www.selenium.dev/selenium/web/web-form.html
`;
  process.stdout.write(`${text}\n`);
}

type AgentTurnResult = {
  text: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  reasoning?: unknown;
  reasoningText?: string;
  reasoningStreamed?: boolean;
  reasoningChunks?: number;
  reasoningTokens?: number;
};

async function runAgentTurnWithTrace(args: {
  agent: Agent;
  prompt: string;
  system: string;
  resourceId: string;
  threadId: string;
  maxSteps: number;
  trace: boolean;
}): Promise<AgentTurnResult> {
  const providerOptions = {
    openai: {
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      reasoning: {
        summary: "detailed",
      },
    },
  } as const;

  if (!args.trace) {
    const result = await args.agent.generate(args.prompt, {
      system: args.system,
      memory: {
        resource: args.resourceId,
        thread: args.threadId,
      },
      providerOptions,
      maxSteps: args.maxSteps,
    });
    return {
      text: result.text,
      toolCalls: result.toolCalls as unknown[] | undefined,
      toolResults: result.toolResults as unknown[] | undefined,
      reasoning: undefined,
    };
  }

  const stream = await args.agent.stream(args.prompt, {
    system: args.system,
    memory: {
      resource: args.resourceId,
      thread: args.threadId,
    },
    providerOptions,
    maxSteps: args.maxSteps,
  });

  let reasoningChunkCount = 0;
  let streamedReasoningText = "";
  let reasoningLineOpen = false;
  const flushReasoningLine = () => {
    if (reasoningLineOpen) {
      process.stdout.write("\n");
      reasoningLineOpen = false;
    }
  };

  for await (const chunk of stream.fullStream as AsyncIterable<any>) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }
    const type = String(chunk.type ?? "");
    const payload = chunk.payload ?? {};

    if (type !== "reasoning-delta" && type !== "reasoning-start") {
      flushReasoningLine();
    }

    if (type === "tool-call") {
      process.stdout.write(
        `[agent] tool-call ${String(payload.toolName ?? "unknown")} args=${JSON.stringify(payload.args ?? {})}\n`,
      );
    } else if (type === "tool-result") {
      process.stdout.write(`[agent] tool-result ${String(payload.toolName ?? "unknown")}\n`);
    } else if (type === "start-step") {
      process.stdout.write(`[agent] step-start\n`);
    } else if (type === "finish-step") {
      process.stdout.write(`[agent] step-finish\n`);
    } else if (type === "reasoning-delta") {
      reasoningChunkCount += 1;
      const deltaText = typeof payload?.text === "string" ? payload.text : "";
      if (deltaText) {
        if (!reasoningLineOpen) {
          process.stdout.write("[agent] reasoning: ");
          reasoningLineOpen = true;
        }
        streamedReasoningText += deltaText;
        process.stdout.write(deltaText);
      }
    } else if (type === "reasoning-start" || type === "reasoning-end") {
      reasoningChunkCount += 1;
    } else if (type === "redacted-reasoning") {
      reasoningChunkCount += 1;
      process.stdout.write("[agent] reasoning [redacted by provider]\n");
    } else if (type.includes("reasoning")) {
      reasoningChunkCount += 1;
    }
  }
  flushReasoningLine();

  const full = await stream.getFullOutput();
  const reasoningTextFromOutput =
    typeof (full as { reasoningText?: unknown }).reasoningText === "string"
      ? ((full as { reasoningText?: string }).reasoningText ?? "")
      : "";
  const reasoningText = reasoningTextFromOutput || streamedReasoningText || undefined;
  const usage = (full as { usage?: { reasoningTokens?: number } }).usage;
  const reasoningTokens = usage?.reasoningTokens;
  if (reasoningChunkCount > 0 || typeof reasoningTokens === "number") {
    process.stdout.write(
      `[agent] reasoning activity chunks=${reasoningChunkCount}` +
        `${typeof reasoningTokens === "number" ? ` tokens=${reasoningTokens}` : ""}\n`,
    );
  }
  return {
    text: full.text ?? "",
    toolCalls: (full.toolCalls as unknown[] | undefined) ?? [],
    toolResults: (full.toolResults as unknown[] | undefined) ?? [],
    reasoning: full.reasoning,
    reasoningText,
    reasoningStreamed: streamedReasoningText.length > 0,
    reasoningChunks: reasoningChunkCount,
    reasoningTokens,
  };
}

async function writeRunRecord(record: Record<string, unknown>): Promise<void> {
  await mkdir(runsDir, { recursive: true });
  const runId = String(record.runId ?? `run-${Date.now()}`);
  await writeFile(path.join(runsDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(path.join(runsDir, "latest.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function extractNonSensitiveFieldsFromMessage(message: string): Partial<FormFields> {
  const text = message.trim();
  if (!text) {
    return {};
  }

  const out: Partial<FormFields> = {};
  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (emailMatch?.[0]) {
    out.email = emailMatch[0];
  }

  const fullNameMatch = text.match(/(?:my\s+name\s+is|i\s*am)\s+([a-z][a-z' -]{1,80})/i);
  if (fullNameMatch?.[1]) {
    out.fullName = fullNameMatch[1].trim();
  }

  const companyMatch = text.match(/(?:company|organization)\s*(?:is|:)\s*([a-z0-9&'., -]{2,80})/i);
  if (companyMatch?.[1]) {
    out.company = companyMatch[1].trim();
  }

  const phoneMatch = text.match(/(?:phone|mobile|cell)\s*(?:is|:)?\s*([\d +().-]{7,})/i);
  if (phoneMatch?.[1]) {
    out.phone = phoneMatch[1].trim();
  }

  const locationMatch = text.match(/(?:location|city)\s*(?:is|:)\s*([a-z0-9'., -]{2,80})/i);
  if (locationMatch?.[1]) {
    out.location = locationMatch[1].trim();
  }

  const postalCodeMatch = text.match(/(?:zip|postal(?:\s+code)?)\s*(?:is|:)?\s*([a-z0-9 -]{3,16})/i);
  if (postalCodeMatch?.[1]) {
    out.postalCode = postalCodeMatch[1].trim();
  }

  return out;
}

function formatRememberedFields(fields: Partial<FormFields>): string {
  const entries = Object.entries(fields).filter(([, value]) => typeof value === "string" && value.trim());
  if (entries.length === 0) {
    return "(none)";
  }
  return entries.map(([k, v]) => `- ${k}: ${String(v)}`).join("\n");
}

function buildInteractiveWebTaskAgent(sessionId: string, model: string, seedUrl: string): Agent {
  let lastKnownUrl = seedUrl;

  const inspectPageFormTool = createTool({
    id: "inspect-page-form",
    description: "Inspect the current page and extract visible form fields and submit controls.",
    inputSchema: z.object({
      url: z.string().url().optional(),
    }),
    outputSchema: z.object({
      url: z.string(),
      title: z.string(),
      submitSelector: z.string().optional(),
      needsLogin: z.boolean(),
      credentialHints: z
        .object({
          acceptedUsernames: z.array(z.string()).optional(),
          sharedPassword: z.string().optional(),
        })
        .optional(),
      fields: z.array(
        z.object({
          selector: z.string(),
          name: z.string().optional(),
          id: z.string().optional(),
          placeholder: z.string().optional(),
          label: z.string().optional(),
          type: z.string().optional(),
        }),
      ),
    }),
    execute: async ({ url: optionalUrl }) => {
      const targetUrl = optionalUrl ?? lastKnownUrl ?? seedUrl;
      let snapshot = await extractLoginFormFields(sessionId, targetUrl);
      if (snapshot.url.startsWith("about:blank")) {
        snapshot = await extractLoginFormFields(sessionId, seedUrl);
      }
      if (snapshot.url && !snapshot.url.startsWith("about:blank")) {
        lastKnownUrl = snapshot.url;
      }
      return snapshot;
    },
  });

  const fillPageFormTool = createTool({
    id: "fill-page-form",
    description: "Fill one or more page inputs and attempt to submit the current form.",
    inputSchema: z.object({
      fills: z.array(
        z.object({
          selector: z.string(),
          value: z.string(),
        }),
      ),
      submitSelector: z.string().optional(),
      pageUrl: z.string().url().optional(),
    }),
    outputSchema: z.object({
      url: z.string(),
      title: z.string(),
      submitted: z.boolean(),
    }),
    execute: async ({ fills, submitSelector, pageUrl }) => {
      const targetUrl = pageUrl ?? lastKnownUrl ?? seedUrl;
      const result = await applyLoginFormValues(sessionId, fills, submitSelector, targetUrl);
      if (result.url && !result.url.startsWith("about:blank")) {
        lastKnownUrl = result.url;
      }
      return result;
    },
  });

  return new Agent({
    id: "hitl-web-task-agent",
    name: "HITL Web Task Agent",
    model,
    instructions: `
You are a HITL web task assistant with memory for non-sensitive user profile details.

Tools:
- inspectPageFormTool
- fillPageFormTool

Rules:
1) Inspect first.
2) Ask only for missing values; accept free-form responses.
3) If the page already provides value hints, do not ask for those values again.
4) Use fillPageFormTool for best-effort form fill and submit.
5) Re-inspect after actions.
6) If manual step is needed (captcha/MFA), ask user to do it in live view and respond "done".
7) Never ask users to re-provide values already present in conversation history or remembered profile.
8) Never ask to persist sensitive values (passwords, OTPs, verification codes, secrets).
9) When the task appears complete or no more action is required, respond exactly: "[DONE] Task appears complete."
`,
    tools: {
      inspectPageFormTool,
      fillPageFormTool,
    },
  });
}

async function runInteractiveWebTaskLoop(args: {
  sessionId: string;
  resourceId: string;
  agentThreadId: string;
  profileThreadId: string;
  task: string;
  maxTurns: number;
  startUrl: string;
  introLabel: string;
  debug: boolean;
  trace: boolean;
}): Promise<boolean> {
  const model = getDefaultModel();
  ensureModelApiKeysForModel(model);
  const webTaskAgent = buildInteractiveWebTaskAgent(args.sessionId, model, args.startUrl);
  const rl = createInterface({ input, output });
  process.stdout.write(`${args.introLabel}\n`);
  process.stdout.write(`Task: ${args.task}\n`);

  const conversation: Array<{ role: "user" | "agent"; text: string }> = [];
  let rememberedProfile = await readProfileFields(args.resourceId, args.profileThreadId).catch(() => ({}));
  let latestUserMessage = `Start interactive web task flow for URL: ${args.startUrl}. Task: ${args.task}. Inspect first and ask only for missing values.`;
  try {
    for (let turn = 0; turn < args.maxTurns; turn += 1) {
      const preTurnSnapshot = await extractLoginFormFields(args.sessionId, args.startUrl).catch(() => undefined);
      const snapshotContext = preTurnSnapshot
        ? `Current page snapshot:
- url: ${preTurnSnapshot.url}
- title: ${preTurnSnapshot.title}
- needsLogin: ${preTurnSnapshot.needsLogin}
- fields: ${preTurnSnapshot.fields.map((field) => field.selector).join(", ")}
- acceptedUsernames: ${(preTurnSnapshot.credentialHints?.acceptedUsernames ?? []).join(", ")}
- sharedPasswordHint: ${preTurnSnapshot.credentialHints?.sharedPassword ?? ""}
`
        : "Current page snapshot unavailable.";
      const historyText =
        conversation.length > 0
          ? conversation
              .map((entry, idx) => `${idx + 1}. ${entry.role.toUpperCase()}: ${entry.text}`)
              .join("\n")
          : "(none)";
      const rememberedProfileText = formatRememberedFields(rememberedProfile);
      const turnPrompt = `Task goal:
${args.task}

${snapshotContext}
Remembered non-sensitive profile fields:
${rememberedProfileText}

Conversation history:
${historyText}

Latest user message:
${latestUserMessage}

Never ask again for credentials, verification codes, or decisions that already appear in conversation history unless the user explicitly changes them.
You can reuse remembered profile values when relevant for visible form fields.`;

      const result = await runAgentTurnWithTrace({
        agent: webTaskAgent,
        prompt: turnPrompt,
        system: `Task goal:
${args.task}

${snapshotContext}
Remembered profile fields:
${rememberedProfileText}
Always ground your answer in this snapshot and tools. If snapshot url is about:blank, call inspectPageFormTool with "${args.startUrl}" first.`,
        resourceId: args.resourceId,
        threadId: args.agentThreadId,
        maxSteps: 8,
        trace: args.trace,
      });

      if (args.debug) {
        const toolCallNames =
          (result.toolCalls ?? [])
            .map((call) => String((call as { toolName?: string; name?: string }).toolName ?? (call as { name?: string }).name ?? "tool"))
            .join(", ") || "(none)";
        process.stdout.write(
          `[debug] turn=${turn + 1} snapshot_url=${preTurnSnapshot?.url ?? "n/a"} tool_calls=${toolCallNames}\n`,
        );
      }

      process.stdout.write(`\nAgent: ${result.text}\n`);
      conversation.push({ role: "agent", text: result.text });
      if (args.trace && (result.reasoning || result.reasoningText)) {
        process.stdout.write(
          `[agent] reasoning summary available` +
            `${typeof result.reasoningTokens === "number" ? ` (tokens=${result.reasoningTokens})` : ""}\n`,
        );
        if (result.reasoningText && !result.reasoningStreamed) {
          process.stdout.write(`[agent] reasoning full: ${result.reasoningText}\n`);
        }
      }
      if (result.text.includes("[DONE]")) {
        return true;
      }

      let response: string;
      try {
        response = await rl.question("You: ");
      } catch {
        return false;
      }
      const normalized = response.trim().toLowerCase();
      if (normalized === "exit" || normalized === "quit") {
        return false;
      }
      latestUserMessage = response.trim() ? response : "done";
      const fieldUpdates = extractNonSensitiveFieldsFromMessage(latestUserMessage);
      if (Object.keys(fieldUpdates).length > 0) {
        rememberedProfile = await mergeAndPersistProfileFields(
          args.resourceId,
          args.profileThreadId,
          fieldUpdates,
        ).catch(() => rememberedProfile);
      }
      conversation.push({ role: "user", text: latestUserMessage });
    }
  } finally {
    rl.close();
  }

  return false;
}

async function runHitlWebTaskFlow(args: {
  siteUrl: string;
  profileName?: string;
  resourceId: string;
  profileThreadId: string;
  agentThreadId: string;
  task: string;
  maxTurns: number;
  debug: boolean;
  trace: boolean;
}): Promise<{ completed: boolean; replayUrl?: string }> {
  const session = await startBrowserSession({
    profileName: args.profileName,
  });
  trackKernelSession(session.sessionId, session.replayId);
  let done = false;
  let replayUrl: string | undefined;

  try {
    done = await runInteractiveWebTaskLoop({
      sessionId: session.sessionId,
      resourceId: args.resourceId,
      profileThreadId: args.profileThreadId,
      agentThreadId: args.agentThreadId,
      task: args.task,
      maxTurns: args.maxTurns,
      startUrl: args.siteUrl,
      introLabel: "HITL web task flow started.",
      debug: args.debug,
      trace: args.trace,
    });
  } finally {
    replayUrl = await closeBrowserSession(session.sessionId, session.replayId).catch(() => undefined);
    untrackKernelSession(session.sessionId);
  }

  return { completed: done, replayUrl };
}

async function runStart(args: ArgMap): Promise<void> {
  const siteArg = argString(args, "site");
  if (!siteArg) {
    throw new Error("Missing required --site. Pass a full URL, e.g. https://www.saucedemo.com/");
  }
  const siteUrl = normalizeSiteInput(siteArg);
  if (!isHttpUrl(siteUrl)) {
    throw new Error(`--site must be a valid URL or domain. Received: ${siteArg}`);
  }

  const resourceId = argString(args, "resourceId", "demo-user") ?? "demo-user";
  const profileThreadId = argString(args, "threadId", `${resourceId}-profile`) ?? `${resourceId}-profile`;
  const task =
    argString(args, "task")?.trim() ??
    "Log in if needed, then complete the requested web task using the page controls. Ask me only for missing information.";
  const profile = argString(args, "profile");
  const profileName = profile?.trim() ? profile.trim() : undefined;
  const turnsRaw = Number(argString(args, "turns", "6") ?? "6");
  const maxTurns = Number.isFinite(turnsRaw) && turnsRaw > 0 ? turnsRaw : 6;
  const debug = argBool(args, "debug", false);
  const trace = argBool(args, "trace", true);
  const agentThreadId = `${profileThreadId}-agent-${Date.now()}`;
  const runResult = await runHitlWebTaskFlow({
    siteUrl,
    profileName,
    resourceId,
    profileThreadId,
    agentThreadId,
    task,
    maxTurns,
    debug,
    trace,
  });
  const output = {
    runId: `web-task-${Date.now()}`,
    mode: "hitl_web_task",
    status: runResult.completed ? "completed" : "interrupted",
    site: siteUrl,
    task,
    profile: profileName,
    resourceId,
    threadId: profileThreadId,
    agentThreadId,
    requiresHumanAction: !runResult.completed,
    replayUrl: runResult.replayUrl,
  };
  await writeRunRecord(output);
  if (runResult.replayUrl) {
    process.stdout.write(`Kernel replay URL: ${runResult.replayUrl}\n`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function main(): Promise<void> {
  const removeSignalCleanup = installSignalCleanup();
  try {
    const args = parseArgs(process.argv.slice(2));
    if (isHelpRequested(args)) {
      printUsage();
      return;
    }
    await runStart(args);
  } finally {
    removeSignalCleanup();
  }
}

main().catch(async (error) => {
  await cleanupTrackedKernelSessions().catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
