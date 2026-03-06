# HITL Web Task Assistant with Memory

This repo demonstrates one thing:

**A Human-in-the-Loop web task assistant that runs in a Kernel cloud browser and remembers non-sensitive profile details across runs.**

Given a URL, the assistant:
1. inspects visible form fields,
2. asks only for missing values,
3. fills/submits with tools,
4. escalates to manual live-view steps when needed (captcha/MFA),
5. saves replay + run output.

## Why this is a good Mastra + Kernel example

- **Mastra agent loop:** handles iterative inspect → ask → act behavior
- **Mastra memory (`@mastra/memory` + `@mastra/libsql`):** stores reusable non-sensitive fields
- **Kernel browser sessions:** live view handoff + replay URL + optional profile persistence
- **Single CLI entrypoint:** `demo:start`

## Prerequisites

- Node.js 20+
- `KERNEL_API_KEY`
- `OPENAI_API_KEY` (default model is `openai/gpt-5.4`)

Copy `.env.example` to `.env` and fill values.

## Install

```bash
npm install
```

## Run

```bash
npm run demo:start -- --site "https://www.saucedemo.com/"
npm run demo:start -- --site "https://www.selenium.dev/selenium/web/web-form.html"
npm run demo:start -- --site linkedin.com/login
npm run demo:start -- --help
```

## Key options

- `--site <url|domain>` required; adds `https://` when missing
- `--profile <name>` optional explicit Kernel profile name to find/create
- `--resourceId <id>` default `demo-user`
- `--threadId <id>` default `<resourceId>-profile` (used for non-sensitive memory)
- `--turns <number>` default `6`
- `--trace <true|false>` default `true`
- `--debug <true|false>` default `false`

## Memory and security behavior

- The assistant remembers **non-sensitive profile fields** like:
  - `fullName`, `email`, `company`, `phone`, `location`, `postalCode`
- It does **not** intentionally persist:
  - passwords
  - verification codes / OTPs
  - other secret values
- Browser login state persists only when `--profile <name>` is provided.

## Output artifacts

- Run outputs: `.demo-runs/latest.json` and `.demo-runs/<run-id>.json`
- Local memory store: `mastra.db`
- Browser replay URL: printed at the end of a run
