# Swagger AI Tester

Paste a Swagger / OpenAPI link — localhost or live — and the app discovers every endpoint, generates a request payload with AI (OpenAI, Claude or Hugging Face), and runs it for you. Register APIs always get unique data, and **Run all** chains register → login → create → read → update → delete automatically.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test             # 10 tests, no network needed
```

Needs Node 18+. Paste a link such as `http://localhost:8081/swagger-ui/index.html#/` — the Swagger UI page, a direct `/v3/api-docs` link or just the host all work.

## Features

- Reads Swagger 2 and OpenAPI 3 (JSON or YAML), resolves `$ref`, `allOf` / `oneOf`, and springdoc groups.
- The Base URL always comes from the link you pasted (never from a third-party spec such as petstore).
- AI payloads from Ollama (free, local), OpenAI, Claude or Hugging Face — pick one in **Settings** (a drawer that slides in from the right).
- Unique test data per run: `{{email}} {{username}} {{phone}} {{name}} {{uuid}} {{random}} {{timestamp}} …`. Login endpoints are never randomised.
- Chained **Run all**: the login token is applied as a Bearer header and created IDs are reused in later calls.
- Light / dark theme, Apple-style scrolling landing page and motion, desktop and mobile layouts.

## AI keys — where do they go?

**In one place only. Not in both.**

1. **Settings (recommended)** — paste the key in the app. It is stored only in your browser (localStorage) and sent with each request.
2. **Server environment variable** — `HF_TOKEN`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (see `.env.example`). Useful for shared or deployed setups.

If both exist, the key from Settings wins. Never hard-code a key in the source files. Use **Settings → Test connection** to verify a key.

## Ollama (API key or local)

**With an Ollama API key (nothing to install):** create a key at https://ollama.com/settings/keys, then in the app go to **Settings → Ollama**, paste the key, pick a model (default `gpt-oss:20b`), **Test connection → Save**. Calls go to Ollama Cloud (`https://ollama.com`). Free-plan usage limits apply.

**Without a key (free, on your PC):** install Ollama, run `ollama pull llama3.2`, then in Settings pick Ollama, set the model to `llama3.2`, leave the key empty. Using Docker? Set `OLLAMA_BASE_URL=http://host.docker.internal:11434`.

## Troubleshooting

**"Hugging Face call failed (out of credits) — using a schema-based payload"**
Hugging Face answered with HTTP 402: the account has no Inference Providers credits left. The free plan only includes a small monthly credit, and big models (70B) use it up fast — the app now defaults to the small `meta-llama/Llama-3.1-8B-Instruct`, which stretches the free credit much further. If you saved a 70B model in Settings, switch it back to the 8B one. The app still works — it falls back to a payload built from the schema. To get AI payloads again:

- add credits or upgrade on Hugging Face, or wait for the monthly credits to reset; or
- add an OpenAI or Claude key in Settings (small models such as `gpt-4o-mini` or `claude-haiku-5-5` are cheap). If several providers have keys, a failing one is skipped automatically and the next one is used.

Other messages: 401 = invalid key, 403 = no access to that model, 404 = wrong model name, 429 = rate limit.

**"Connection refused"** — the target server is not running, or the port / Base URL is wrong.
**TLS errors on HTTPS hosts** — turn on *Allow self-signed HTTPS* in Settings (always allowed for localhost).

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default 3000) |
| `HF_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY` | Optional server-side AI keys |
| `HF_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OLLAMA_BASE_URL` | Override provider endpoints |
| `APP_PASSWORD`, `APP_USER` | Enable HTTP Basic auth for the whole app |
| `RATE_LIMIT_PER_MIN` | Per-IP request limit |

## Production

- Set `APP_PASSWORD` before exposing the app: it can send requests to any URL the server can reach. Requests to cloud-metadata addresses are blocked.
- Docker: `docker compose up -d` (requires `APP_PASSWORD`, binds to 127.0.0.1:3000). To test an API on your host machine use `host.docker.internal`. *The Dockerfile has not been built in the development environment — build it once before relying on it.*
- Put it behind HTTPS (a reverse proxy) when it is not on localhost.

## Security notes

Security headers and a strict CSP are on by default, request sizes are capped, and shutdown is graceful. If you ever pasted a token into a chat or a public place, rotate it.
