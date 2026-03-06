import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { z } from "zod";

import { getStoragePath } from "../../config.js";
import type { FormFields } from "../../types.js";

const allowedKeys = [
  "fullName",
  "email",
  "phone",
  "company",
  "location",
  "postalCode",
] as const;

const profileSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  postalCode: z.string().optional(),
});

export const profileMemory = new Memory({
  storage: new LibSQLStore({
    id: "profile-memory-store",
    url: getStoragePath(),
  }),
});

function sanitizeFields(fields: Partial<FormFields>): Partial<FormFields> {
  const out: Partial<FormFields> = {};
  for (const key of allowedKeys) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}

export async function ensureProfileThread(resourceId: string, threadId: string): Promise<void> {
  const existing = await profileMemory.getThreadById({ threadId });
  if (existing) {
    return;
  }

  await profileMemory.createThread({
    threadId,
    resourceId,
    title: `Form profile for ${resourceId}`,
    metadata: {
      formProfile: {},
    },
  });
}

export async function readProfileFields(resourceId: string, threadId: string): Promise<Partial<FormFields>> {
  await ensureProfileThread(resourceId, threadId);
  const thread = await profileMemory.getThreadById({ threadId });

  if (!thread?.metadata || typeof thread.metadata !== "object") {
    return {};
  }

  try {
    const parsed = (thread.metadata as Record<string, unknown>).formProfile as unknown;
    const validated = profileSchema.safeParse(parsed);
    if (!validated.success) {
      return {};
    }
    return sanitizeFields(validated.data);
  } catch {
    return {};
  }
}

export async function mergeAndPersistProfileFields(
  resourceId: string,
  threadId: string,
  incoming: Partial<FormFields>,
): Promise<Partial<FormFields>> {
  await ensureProfileThread(resourceId, threadId);
  const existing = await readProfileFields(resourceId, threadId);
  const merged = sanitizeFields({
    ...existing,
    ...incoming,
  });

  const thread = await profileMemory.getThreadById({ threadId });
  if (!thread) {
    throw new Error("Expected profile thread to exist.");
  }

  const existingMetadata =
    thread.metadata && typeof thread.metadata === "object" ? (thread.metadata as Record<string, unknown>) : {};

  await profileMemory.saveThread({
    thread: {
      ...thread,
      title: thread.title ?? `Form profile for ${resourceId}`,
      metadata: {
        ...existingMetadata,
        formProfile: merged,
      },
    },
  });

  return merged;
}
