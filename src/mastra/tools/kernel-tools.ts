import Kernel from "@onkernel/sdk";

import { getKernelApiKey } from "../../config.js";

const kernel = new Kernel({
  apiKey: getKernelApiKey(),
});

export async function ensureProfile(profileName: string): Promise<void> {
  try {
    await kernel.profiles.retrieve(profileName);
    return;
  } catch (error: unknown) {
    const message = String(error);
    if (!message.includes("404")) {
      throw error;
    }
  }

  await kernel.profiles.create({ name: profileName });
}

export async function startBrowserSession(options?: {
  profileName?: string;
}): Promise<{
  sessionId: string;
  liveUrl?: string;
  replayId?: string;
}> {
  const profileName = options?.profileName?.trim();
  if (profileName) {
    await ensureProfile(profileName);
  }

  const browser = await kernel.browsers.create({
    headless: false,
    stealth: true,
    timeout_seconds: 1800,
    ...(profileName
      ? {
          profile: {
            name: profileName,
            save_changes: true,
          },
        }
      : {}),
  });
  const replay = await kernel.browsers.replays.start(browser.session_id);

  if (browser.browser_live_view_url) {
    console.log(`Kernel live view URL: ${browser.browser_live_view_url}`);
  }

  return {
    sessionId: browser.session_id,
    liveUrl: browser.browser_live_view_url,
    replayId: replay.replay_id,
  };
}

async function getReplayViewUrlWithRetry(sessionId: string, replayId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const replays = await kernel.browsers.replays.list(sessionId);
    const replay = replays.find((item) => item.replay_id === replayId);
    if (replay?.replay_view_url) {
      return replay.replay_view_url;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return undefined;
}

export async function closeBrowserSession(sessionId: string, replayId?: string): Promise<string | undefined> {
  let replayUrl: string | undefined;
  if (replayId) {
    await kernel.browsers.replays.stop(replayId, { id: sessionId }).catch(() => undefined);
    replayUrl = await getReplayViewUrlWithRetry(sessionId, replayId);
  }
  await kernel.browsers.deleteByID(sessionId);
  return replayUrl;
}

async function executePlaywright<T>(sessionId: string, code: string): Promise<T> {
  const result = await kernel.browsers.playwright.execute(sessionId, {
    code,
    timeout_sec: 120,
  });

  if (!result.success) {
    throw new Error(`Playwright execution failed: ${result.error ?? "Unknown error"} ${result.stderr ?? ""}`.trim());
  }

  return result.result as T;
}

export interface LoginFieldDescriptor {
  selector: string;
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
  type?: string;
}

export interface LoginCredentialHints {
  acceptedUsernames?: string[];
  sharedPassword?: string;
}

export async function extractLoginFormFields(sessionId: string, url?: string): Promise<{
  url: string;
  title: string;
  submitSelector?: string;
  fields: LoginFieldDescriptor[];
  needsLogin: boolean;
  credentialHints?: LoginCredentialHints;
}> {
  return executePlaywright(sessionId, `
    const targetUrl = ${JSON.stringify(url ?? "")};
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
    }
    const extracted = await page.evaluate(() => {
      const visible = (el: Element) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const escapeCss = (value: string) => {
        try {
          return CSS.escape(value);
        } catch {
          return value.replace(/"/g, '\\"');
        }
      };

      const toSelector = (el: Element) => {
        if (!(el instanceof HTMLElement)) return "";
        if (el.id) return "#" + escapeCss(el.id);
        const name = el.getAttribute("name");
        const tag = el.tagName.toLowerCase();
        if (name) return \`\${tag}[name="\${name.replace(/"/g, '\\"')}"]\`;
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) return \`\${tag}[placeholder="\${placeholder.replace(/"/g, '\\"')}"]\`;
        return "";
      };

      const inputs = Array.from(document.querySelectorAll("input,textarea"))
        .filter((el) => visible(el))
        .filter((el) => !(el instanceof HTMLInputElement) || (el.type !== "hidden" && el.type !== "submit"))
        .filter((el) => !(el instanceof HTMLInputElement) || !el.disabled);

      const fields = inputs
        .map((el) => {
          const selector = toSelector(el);
          if (!selector) return null;
          const id = el.getAttribute("id") || undefined;
          let label;
          if (id) {
            const labelEl = document.querySelector(\`label[for="\${id.replace(/"/g, '\\"')}"]\`);
            label = labelEl?.textContent?.trim() || undefined;
          }
          const aria = el.getAttribute("aria-label");
          return {
            selector,
            name: el.getAttribute("name") || undefined,
            id: id || undefined,
            placeholder: el.getAttribute("placeholder") || undefined,
            label: label || aria || undefined,
            type: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
          };
        })
        .filter(Boolean);

      const form = inputs[0]?.closest("form");
      const submitControl =
        form?.querySelector("button[type='submit'],input[type='submit'],button:not([type])") ||
        document.querySelector("button[type='submit'],input[type='submit']");
      const submitSelector = submitControl ? toSelector(submitControl) : undefined;
      const hasPassword = fields.some((field: any) => field.type === "password");
      const url = window.location.href;
      const needsLogin = hasPassword || url.includes("login") || url.includes("signin");
      const pageText = (document.body?.innerText || "").replaceAll("\\r", "");
      const lowerText = pageText.toLowerCase();
      const usernamesMarker = "accepted usernames are:";
      const passwordMarker = "password for all users:";

      const usernamesIndex = lowerText.indexOf(usernamesMarker);
      const passwordIndex = lowerText.indexOf(passwordMarker);

      let sharedPassword: string | undefined;
      if (passwordIndex >= 0) {
        const afterMarker = pageText.slice(passwordIndex + passwordMarker.length).trimStart();
        const firstLine = afterMarker.split("\\n").map((line) => line.trim()).find((line) => line.length > 0);
        sharedPassword = firstLine || undefined;
      }

      let acceptedUsernames: string[] | undefined;
      if (usernamesIndex >= 0) {
        const start = usernamesIndex + usernamesMarker.length;
        const end = passwordIndex > start ? passwordIndex : pageText.length;
        const block = pageText.slice(start, end);
        acceptedUsernames = block
          .split("\\n")
          .map((line) => {
            let value = line.trim();
            while (value.startsWith("-") || value.startsWith("*") || value.startsWith("•")) {
              value = value.slice(1).trimStart();
            }
            return value;
          })
          .filter((line) => line.length > 0 && !line.includes(":"));
      }
      const credentialHints =
        sharedPassword || (acceptedUsernames && acceptedUsernames.length > 0)
          ? {
              acceptedUsernames:
                acceptedUsernames && acceptedUsernames.length > 0 ? acceptedUsernames : undefined,
              sharedPassword,
            }
          : undefined;

      return { fields, submitSelector, needsLogin, url, credentialHints };
    });

    return {
      url: extracted.url,
      title: await page.title(),
      submitSelector: extracted.submitSelector || undefined,
      fields: extracted.fields,
      needsLogin: extracted.needsLogin,
      credentialHints: extracted.credentialHints,
    };
  `);
}

export async function applyLoginFormValues(
  sessionId: string,
  fills: Array<{ selector: string; value: string }>,
  submitSelector?: string,
  pageUrl?: string,
): Promise<{ url: string; title: string; submitted: boolean }> {
  return executePlaywright(sessionId, `
    const fills = ${JSON.stringify(fills)};
    const submitSelector = ${JSON.stringify(submitSelector ?? "")};
    const pageUrl = ${JSON.stringify(pageUrl ?? "")};
    if (pageUrl) {
      const current = page.url();
      if (!current || current.startsWith("about:blank")) {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
      }
    }
    for (const item of fills) {
      if (!item?.selector) continue;
      try {
        await page.fill(item.selector, item.value ?? "");
      } catch {
        // ignore selectors that no longer match due to dynamic pages
      }
    }

    let submitted = false;
    if (submitSelector) {
      try {
        await page.click(submitSelector);
        submitted = true;
      } catch {
        submitted = false;
      }
    }

    if (!submitted) {
      const fallback = await page.$("button[type='submit'],input[type='submit']");
      if (fallback) {
        await fallback.click();
        submitted = true;
      }
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    return { url: page.url(), title: await page.title(), submitted };
  `);
}
