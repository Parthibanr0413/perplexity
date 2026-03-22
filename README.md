# Scout Query

This is now a simple OpenRouter-only chatbot.

## What changed

- One chat UI
- One provider: OpenRouter
- One default model: `openrouter/free`
- Optional lightweight web research for source cards
- Optional API-key rotation every 4 hours

## Environment

Create or edit [`.env.local`](/Users/parthibanramakrishnan/Documents/New%20project/perplexity/.env.local):

```bash
OPENROUTER_API_KEY=...
OPENROUTER_API_KEY_HASH=
OPENROUTER_MANAGEMENT_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_SITE_NAME=Scout Query
OPENROUTER_DEFAULT_MODEL=openrouter/free
DEFAULT_SOURCE_LIMIT=6
```

## Key refresh

Your normal OpenRouter API key does not auto-refresh by itself.

If you want the app to rotate the active key every 4 hours, add:

- `OPENROUTER_MANAGEMENT_API_KEY`

Optional but recommended for the first cleanup:

- `OPENROUTER_API_KEY_HASH`

How it works:

1. The app starts with `OPENROUTER_API_KEY`.
2. If `OPENROUTER_MANAGEMENT_API_KEY` is present, the server creates a fresh OpenRouter key when the current one is older than 4 hours.
3. The new key is stored in `.runtime/openrouter-key.json`.
4. If the old key hash is known, the app deletes the previous key after rotation.

## Important note

If you only have `OPENROUTER_API_KEY`, the app will still work, but rotation will stay off.

## Run

```bash
cd "/Users/parthibanramakrishnan/Documents/New project/perplexity"
npm install
npm run dev
```

## Official docs

- [OpenRouter API keys](https://openrouter.ai/docs/api-keys)
- [OpenRouter API key rotation](https://openrouter.ai/docs/guides/administration/api-key-rotation)
- [OpenRouter management API keys](https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys)
