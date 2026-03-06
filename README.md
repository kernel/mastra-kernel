# Mastra + Kernel Demo: HITL Web Task Assistant with Memory

This repository is an end-to-end demo of building with [Mastra](https://mastra.ai/) and [Kernel](https://www.kernel.sh): a Human-in-the-Loop web task assistant that runs in cloud browsers, asks for human input only when needed, and remembers non-sensitive profile details across runs.

## GPT-5.4 computer-use focus

The demo defaults to `openai/gpt-5.4` and is designed around its stronger reasoning and tool-driven computer-use patterns (see [Introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)).

The assistant takes a `--site` and an optional `--task`, then runs an iterative loop:
1. inspect current page state and controls,
2. infer missing information for the task,
3. ask the user only for what is missing,
4. execute browser actions with tools,
5. escalate to manual live-view steps (captcha/MFA/verification) when required,
6. continue until complete or interrupted, then emit replay + run metadata.

## Features used in this demo

### Mastra features

- `Agent` with iterative tool use and bounded multi-step execution
- streaming generation (`agent.stream`) with live trace output
- memory scoping with `resourceId` + `threadId`
- non-sensitive profile memory persistence via `@mastra/memory` + `@mastra/libsql`

### Kernel features

- browser session lifecycle (`browsers.create`, `browsers.deleteByID`)
- optional named browser profile lookup/create + `save_changes`
- live view URL handoff for HITL steps
- replay recording (`browsers.replays.start/stop/list`)
- server-side Playwright execution (`browsers.playwright.execute`)

## Prerequisites

- Node.js 20+
- `KERNEL_API_KEY`
- `OPENAI_API_KEY`

Copy `.env.example` to `.env` and fill values.

## Install

```bash
npm install
```

## Run

```bash
npm run demo:start -- --site "https://www.saucedemo.com/"
npm run demo:start -- --site "https://www.selenium.dev/selenium/web/web-form.html" --task "submit the demo form with sensible values"
npm run demo:start -- --site "https://www.linkedin.com/login" --task "log in and get me to the home feed"
npm run demo:start -- --site linkedin.com/login
npm run demo:start -- --help
```

## CLI options

- `--site <url|domain>` required; `https://` is added when missing
- `--task <text>` optional task goal; defaults to a generic HITL web-task objective
- `--profile <name>` optional explicit Kernel profile name to find/create
- `--resourceId <id>` default `demo-user`
- `--threadId <id>` default `<resourceId>-profile` (for non-sensitive memory)
- `--turns <number>` default `6`
- `--trace <true|false>` default `true`
- `--debug <true|false>` default `false`

## Memory and security behavior

- Remembers non-sensitive profile fields: `fullName`, `email`, `company`, `phone`, `location`, `postalCode`
- Intentionally avoids persisting passwords, OTPs, verification codes, and other secrets
- Browser login state persists only when `--profile <name>` is provided

## Output artifacts

- Run outputs: `.demo-runs/latest.json` and `.demo-runs/<run-id>.json`
- Local memory store: `mastra.db`
- Browser replay URL: printed at run completion
