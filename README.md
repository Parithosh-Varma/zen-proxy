# zen-proxy

Local Anthropic → OpenAI-compatible translation proxy that lets Claude Code use OpenCode Zen models (`https://opencode.ai/zen/v1`) through `ANTHROPIC_BASE_URL`.

## Why

Claude Code speaks the Anthropic Messages API. OpenCode Zen speaks the OpenAI Chat Completions API. This proxy translates between the two, so Claude Code can use Zen's free models (e.g. `hy3-free`, `deepseek-v4-flash-free`) or any paid Zen model.

## Requirements

- Node.js 18+
- Claude Code (`claude` on PATH)

## Install

```sh
mkdir -p ~/.zen-proxy
cp proxy.js zen-claude ~/.zen-proxy/
chmod +x ~/.zen-proxy/zen-claude
```

## Usage

Start the proxy:

```sh
MODEL=hy3-free PORT=9099 ZEN_KEY=public node ~/.zen-proxy/proxy.js
```

Then either:

1. Use the launcher (no global changes):

```sh
ZEN_MODEL=hy3-free ZEN_PORT=9099 ~/.zen-proxy/zen-claude
```

2. Or point Claude Code at it globally via `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9099",
    "ANTHROPIC_AUTH_TOKEN": "zen",
    "ANTHROPIC_MODEL": "hy3-free",
    "ANTHROPIC_SMALL_FAST_MODEL": "hy3-free"
  }
}
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `MODEL` | `hy3-free` | Zen model to forward requests to |
| `PORT` | `8083` | Local listen port |
| `ZEN_KEY` | `public` | Zen API key (free tier uses `public`) |

## Notes

- Zen rate limits are **per session** (`x-opencode-session` header). The proxy generates a fresh session id per request, so free-tier quota is not shared with your opencode sessions.
- The free tier quota is per-model — when a model returns `429 FreeUsageLimitError`, switch to another model (e.g. `hy3-free`, `nemotron-3-ultra-free`, `deepseek-v4-flash-free`).

## Endpoints

- `POST /v1/messages` — Anthropic Messages API → forwarded to Zen Chat Completions
- `POST /v1/messages/count_tokens` — token counting stub
- `GET /v1/models` — upstream model list
- `GET /health` — health check