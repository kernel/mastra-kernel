import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getKernelApiKey(): string {
  return readEnv("KERNEL_API_KEY");
}

export function getDefaultModel(): string {
  return process.env.MASTRA_MODEL?.trim() || "openai/gpt-5.4";
}

export function ensureModelApiKeysForModel(model: string): void {
  if (model.startsWith("openai/")) {
    readEnv("OPENAI_API_KEY");
    return;
  }
  if (model.startsWith("anthropic/")) {
    readEnv("ANTHROPIC_API_KEY");
    return;
  }
}

export function getStoragePath(): string {
  return process.env.MASTRA_STORAGE_URL?.trim() || "file:./mastra.db";
}
