# pi-memini

[![CI](https://github.com/lanquarden/pi-memini/actions/workflows/test.yml/badge.svg)](https://github.com/lanquarden/pi-memini/actions/workflows/test.yml)

A native [pi](https://pi.dev) extension for [memini](https://github.com/eleboucher/memini): automatic cross-session memory over memini's REST API, without wiring MCP.

It mirrors the opencode integration pattern:

- recalls relevant memories before each user turn and injects them as transient context;
- captures completed user/assistant turns as episodic memories after each turn;
- registers direct `memory_*` pi tools for explicit remember/recall/list/get/forget/answer/briefing operations.

## Install

```sh
pi install npm:@lanquarden/pi-memini
# or try once:
pi -e npm:@lanquarden/pi-memini
```

Configure the memini endpoint and token in the shell that launches pi:

```sh
export MEMINI_BASE_URL="https://memini.example.com"   # or http://localhost:8080
export MEMINI_API_KEY="..."                           # if your deployment requires auth
# optional, to share one memory namespace across agents/projects:
export MEMINI_NAMESPACE="my-project"
# optional tree topology: write to main/projects/<repo>, recall from main + descendants:
export MEMINI_NAMESPACE_PREFIX="main/projects"
export MEMINI_RECALL_NAMESPACE="main"
export MEMINI_RECALL_SCOPE="subtree"
```

If you are using your home-ops in-cluster service from inside the cluster, the base URL is likely `http://memini.ai:8080`. From your workstation, use the ingress URL or a port-forward and set `MEMINI_BASE_URL` accordingly.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `MEMINI_BASE_URL` / `MEMINI_URL` | `http://localhost:8080` | memini REST base URL |
| `MEMINI_API_KEY` / `MEMINI_TOKEN` | unset | bearer token |
| `MEMINI_NAMESPACE` | git repo basename, then cwd basename, then `pi` | write namespace sent via `X-Memini-Namespace`; explicit value bypasses `MEMINI_NAMESPACE_PREFIX` |
| `MEMINI_NAMESPACE_PREFIX` | unset | prefix for derived project namespaces, e.g. `main/projects` makes repo `foo` write to `main/projects/foo` |
| `MEMINI_RECALL_NAMESPACE` | write namespace | namespace used for automatic recall |
| `MEMINI_RECALL_SCOPE` | `exact` | automatic recall scope: `exact` or memini subtree search (`subtree`) |
| `MEMINI_SHARED_NAMESPACES` | unset | extra namespaces to query for auto-recall, comma/space/pipe separated; mostly superseded by subtree topology |
| `MEMINI_RECALL` | on | automatic recall before turns |
| `MEMINI_CAPTURE` | on | automatic capture after turns |
| `MEMINI_EXPOSE_TOOLS` | on | expose direct `memory_*` tools |
| `MEMINI_RECALL_LIMIT` | `5` | max auto-injected memories |
| `MEMINI_INJECT_RECALL_MAX_TOK` | `0` | token budget for the injected recall block (`0` = unbounded) |
| `MEMINI_INJECT_RECALL_MIN_SCORE` | `0` | optional fused-score floor for auto-recall |
| `MEMINI_TIMEOUT_MS` | `30000` | REST timeout |
| `MEMINI_FALLBACK` | on | automatic hooks degrade silently on memini errors |
| `MEMINI_REQUIRE_HTTPS` | unset | set `1` to refuse sending bearer tokens over non-loopback HTTP |

Optional config files can override non-secret options:

- `~/.pi/agent/memini.json`
- `<project>/.pi/memini.json` (only when the project is trusted)

Example:

```json
{
  "base_url": "https://memini.example.com",
  "api_key": "memini_...",
  "namespace_prefix": "main/projects",
  "recall_namespace": "main",
  "recall_scope": "subtree",
  "recall_limit": 8,
  "recall_max_tokens": 1200
}
```

Tokens via `api_key` in config files work, but prefer environment variables for secrets.

## Commands

- `/memini-status` — show endpoint, namespace, and `/healthz` status.
- `/memini-briefing` — display memini's namespace briefing.
- `/memini-recall <query>` — manual recall.
- `/memini-remember <fact>` — store a semantic memory tagged `pi,manual`.

## Tools exposed to the model

- `memory_recall`
- `memory_remember`
- `memory_list`
- `memory_get`
- `memory_forget`
- `memory_answer`
- `memory_briefing`

All tools call memini REST directly and accept an optional `namespace` override. Normally omit it so the extension uses the current project namespace.

## Development

```sh
npm install
npm run typecheck
```
