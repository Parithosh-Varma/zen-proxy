# zen-proxy

[![Free Claude Code](https://img.shields.io/badge/Free%20Claude%20Code-green.svg)](https://github.com/Parithosh-Varma/zen-proxy)


# TLDR

I have made an AI proxy that routes opencode's responses to claude code, i feel that claude code has a better format and is one of the OG's. For this system you dont need an API key and othere opencode sessions are uninterrupted, btw you do not need to install opencode to route the repsones.

# Pipeline
Claude Code
  POST /v1/messages
     └─► Proxy (proxy.js)
          ├─ translate Anthropic → OpenAI
          ├─ add x-opencode-session header
          └─► POST /v1/chat/completions ──► OpenCode Zen
                └─► per‑session quota check
                      └─► model completion
                            └─► translated back
                                   └─► Anthropian response
                                          └─► Claude Code UI
# Free Claude Code

zen-proxy is a local translation proxy that bridges Claude Code's Anthropic Messages API with OpenCode Zen's OpenAI‑compatible Chat Completions endpoint (https://opencode.ai/zen/v1). It forwards requests so you can use Zen's free model tier — `hy3-free`, `deepseek-v4-flash-free`, `nemotron-3-ultra-free`, and others — directly from Claude Code, with full tool use, reasoning blocks, and streaming support.

No API key is required for the free tier (`ZEN_KEY` defaults to `"public"`). Each request gets its own session‑aware quota bucket, so your existing opencode sessions continue to work uninterrupted.

## Prerequisites

- **Claude Code** (v2.1.233 or newer) – the `claude` binary must be on your `$PATH`.
- **Node.js** – 18+ required to run `proxy.js`. (Tested on Node 20.)
- **zen-claude launcher** (optional) – copied from `~/.zen-proxy/zen-claude`; lets you start the proxy without editing `~/.claude/settings.json`.

## Quick Start

## Problem

Claude Code only speaks Anthropic. OpenCode Zen only speaks OpenAI Chat Completions. Without a proxy you're forced to choose: either use Claude Code's native models (which may be rate-limited or unavailable) or use the OpenAI API (which costs money and has its own limits).

This proxy bridges the gap. You get Zen's free model tier (`hy3-free`, `deepseek-v4-flash-free`, `nemotron-3-ultra-free`, etc.) inside Claude Code, with full tool use, reasoning, and streaming support.

## Quick Start

```sh
# 1. Install
mkdir -p ~/.zen-proxy
cp proxy.js zen-claude ~/.zen-proxy/
chmod +x ~/.zen-proxy/zen-claude

# 2. Start the proxy (default port 8083, model hy3-free)
MODEL=hy3-free PORT=8083 ZEN_KEY=public node ~/.zen-proxy/proxy.js &
# or with a different port:
# PORT=9099 MODEL=deepseek-v4-flash-free ZEN_KEY=public node ~/.zen-proxy/proxy.js &

# 3. Point Claude Code at it (global settings.json):
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8083",
    "ANTHROPIC_AUTH_TOKEN": "zen",
    "ANTHROPIC_MODEL": "hy3-free",
    "ANTHROPIC_SMALL_FAST_MODEL": "hy3-free"
  }
}

# 4. Ask Claude:
#   /p "Reply with exactly: ZEN-OK"
```

Or use the lightweight launcher (no global config changes):

```sh
ZEN_MODEL=hy3-free ZEN_PORT=8083 ~/.zen-proxy/zen-claude -p "Reply with exactly: ZEN-OK"
```

## Why this matters

- **Free model access** — Zen's free tier (`hy3-free`, etc.) works inside Claude Code
- **No API key needed** — `ZEN_KEY` defaults to `"public"`; set your own key only if you have a paid Zen account
- **Session-aware** — each proxy request gets its own quota bucket (the gateway rate-limits per-session, not per-IP). Your existing opencode sessions keep working.
- **Model agnostic** — swap `MODEL` to use any Zen-available model: `hy3-free`, `deepseek-v4-flash-free`, `nemotron-3-ultra-free`, etc.
- **Tool use + reasoning** — full Anthropic tool use and `reasoning_content` / `thinking` blocks are translated and forwarded

## Env vars

| Variable | Default | Description |
| --- | --- | --- |
| `MODEL` | `hy3-free` | Zen model id to forward to |
| `PORT` | `8083` | Listen port |
| `ZEN_KEY` | `public` | Zen API key (`public` for free tier) |

## Notes

- Zen rate limits are **per session**. The proxy generates a fresh session id per request, so free-tier quota does not conflict with your opencode sessions. If you get `429 FreeUsageLimitError`, switch to another model.
- The proxy adds `x-opencode-session`, `x-opencode-request`, `x-opencode-client`, and `User-Agent` headers to each upstream request — these are what give each request its own quota bucket.
- The `zen-claude` launcher sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` for you; no manual `~/.claude/settings.json` edit needed for quick tests.

## License

MIT
