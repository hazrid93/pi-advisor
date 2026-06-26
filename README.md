<div align="center">

# 🧭 pi-advisor

**A second model that peer-reviews every turn of your main [pi](https://github.com/earendil-works/pi-coding-agent) agent and injects concise advice.**

_Pick any model from your registry as the advisor — it watches, reads the workspace, and surfaces one note before your agent sinks work into the wrong direction._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![pi 0.80+](https://img.shields.io/badge/pi-%3E%3D0.80-8A2BE2)](https://github.com/earendil-works/pi-coding-agent)

</div>

---

## The idea

The best coding agents get tunnel vision. They commit to a fragile approach, miss an edge case, or keep drilling into a hole that won't satisfy your request. `pi-advisor` attaches a **second model** — the *advisor* — that passively reviews each turn of your main agent and, when something's worth saying, injects a single terse note.

It is **not a second executor.** The advisor cannot edit files, run commands, approve actions, or change session state. It can only read the workspace (`read` / `grep` / `find`) and call `advise`. The main agent decides what to do with the advice — the note is framed `weigh, don't blindly obey`, not an order.

This is the [pi extension](https://github.com/earendil-works/pi-coding-agent) port of the **advisor logic from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)** (its `packages/coding-agent/src/advisor/` package), rebuilt against pi's public extension API. oh-my-pi's advisor is welded into its own forked agent runtime; this extension delivers the same behaviour to stock pi via events, custom tools, and `pi.sendMessage`.

> **TL;DR flow:** on every `turn_end` the advisor gets a bounded slice of the transcript, runs a read-only tool loop on a second model you pick, and (if it has something worth saying) calls `advise` — which lands in your main agent's context as an `<advisory>` note (`nit` = gentle, `concern`/`blocker` = interrupting).

---

## Table of contents

- [Architecture](#architecture)
  - [Component diagram](#component-diagram)
  - [Module responsibilities](#module-responsibilities)
  - [What's ported from oh-my-pi](#whats-ported-from-oh-my-pi)
  - [What's different (and why)](#whats-different-and-why)
- [Flow](#flow)
  - [End-to-end sequence](#end-to-end-sequence)
  - [The advisor agent loop](#the-advisor-agent-loop)
  - [Delivery: nit vs concern/blocker](#delivery-nit-vs-concernblocker)
  - [Failure, reset & re-prime](#failure-reset--re-prime)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [First run — pick an advisor model](#first-run--pick-an-advisor-model)
  - [Verify it's working](#verify-its-working)
  - [Interactive commands (`/advisor`)](#interactive-commands-advisor)
  - [Troubleshooting](#troubleshooting)
  - [Uninstall](#uninstall)
- [Usage](#usage)
  - [Commands](#commands)
  - [Config file](#config-file)
  - [Advice severity & delivery](#advice-severity--delivery)
- [Development](#development)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Architecture

`pi-advisor` is a single pi extension (`advisor.ts`) backed by a small `src/` library. It hooks pi's lifecycle events, runs a background review on a second model per turn, and delivers captured advice back into the primary session.

### Component diagram

```
                         ┌─────────────────────────────── pi (main agent) ──────────────────────────────┐
                         │                                                                              │
   user prompt ───────► │  agent loop: LLM ↔ built-in tools (bash/edit/read/...)                         │
                         │     │                                                                        │
                         │     │  (each turn)                                                            │
                         │     ▼                                                                        │
                         │  turn_end  ──► ExtensionAPI dispatches to every extension's turn_end handler  │
                         └─────┬──────────────────────────────────────────────────────────────────────────┘
                               │ event: { turnIndex, message, toolResults }
                               ▼
 ┌──────────────────── advisor.ts (wiring layer) ────────────────────────────────────────────┐
 │  pi.on("turn_end", ...)        latestCtx = ctx;  ensureRuntime();  rt.onTurnEnd(branch)   │
 │  pi.on("session_start", ...)   rt.reset(); rt.seedToLeaf(branch)   (re-prime, no replay)  │
 │  pi.on("session_shutdown", ... rt.dispose()                                               │
 │  pi.registerCommand("advisor", ...)  picker + subcommands                                 │
 └─────┬─────────────────────────────────────────────────────────────────────────────┬───────┘
       │                                                                              │
       ▼                                                                              ▼
 ┌──────────── src/transcript.ts ────────────┐               ┌──────────── src/runtime.ts (AdvisorRuntime) ────────────┐
 │  buildAdvisorDelta(branch, lastSeenId, N) │               │  backlog queue  ·  single-flight `busy` guard           │
 │   1. slice from lastSeenEntryId           │   "Session     │  `epoch` counter (reset/dispose/session_start)          │
 │   2. bound to last N entries              │   update"      │  3-strike failure drop (configurable)                   │
 │   3. filter out <advisory> entries        │ ────────────►  │  retry-with-backoff                                      │
 │   4. convertToLlm + serializeConversation │   (text)       │  cursor = lastSeenEntryId                               │
 │   → "### Session update\n\n..."           │               │  drains by calling runAdvisorReview (one at a time)     │
 └───────────────────────────────────────────┘               └───────────────────────┬────────────────────────────────┘
                                                                                       │ per batch
                                                                                       ▼
                                              ┌──────── src/agent.ts (runAdvisorReview) ─────────┐
                                              │  completeSimple() loop  (reasoning-aware)         │
                                              │    messages = [ user: "Session update" ]          │
                                              │    tools = [ read, grep, find, advise ]           │
                                              │    ┌─────────────────────────────────────┐       │
                                              │    │ advisor model (YOUR PICK)            │       │
                                              │    │   system prompt ← src/prompts.ts     │       │
                                              │    │   (ported from oh-my-pi)             │       │
                                              │    └───────────────┬─────────────────────┘       │
                                              │                    │ tool calls                  │
                                              │     read/grep/find ─┘  advise(note, severity)     │
                                              │        │                       │                │
                                              │        ▼                       ▼  capture → done │
                                              │  src/tools.ts            AdviseCapture          │
                                              │  (local fs, read-only,                          │
                                              │   confined to cwd)                               │
                                              └───────────────────────┬──────────────────────────┘
                                                                      │ AdvisorReviewResult
                                                                      ▼
                                                ┌──── src/runtime.ts → makeHost → pi.sendMessage ────┐
                                                │  { customType:"advisor", <advisory severity=…> }   │
                                                │   nit        → deliverAs:"steer"                    │
                                                │   concern/blocker → deliverAs:"steer", triggerTurn  │
                                                └──────────────────────────┬────────────────────────┘
                                                                           │
                                                                           ▼
                                                back into the main agent's context (next turn)
```

### Module responsibilities

| File | Layer | Responsibility |
|---|---|---|
| `advisor.ts` | **Wiring** | Subscribes to pi events (`turn_end`, `session_start`, `session_shutdown`), lazily builds the runtime, registers the `/advisor` command + model picker, routes subcommands. The only file that touches `ExtensionAPI`. |
| `src/index.ts` | **Config/types** | Config schema + persistence (`~/.pi/agent/extensions/pi-advisor.json`), `provider/id` parsing, severity type, and the `<advisory>` framing (`formatAdvisorBatchContent`, `escapeXmlText`). No pi imports beyond `getAgentDir`. |
| `src/prompts.ts` | **Prompt** | The advisor system prompt and `advise` tool description — **ported verbatim from oh-my-pi** (`prompts/advisor/system.md` + `advise-tool.md`). Defines the reviewer role: peer-programmer, not a second executor; can only read + advise. |
| `src/tools.ts` | **Tools** | The advisor's hard-isolated read-only toolset: `read`, `grep`, `find` (re-implemented against the filesystem, read-only by construction — there is no write/edit capability at all — and confined to the project root) plus the `advise` tool that captures a note + severity. |
| `src/transcript.ts` | **Context** | Builds the per-turn "Session update": slices the branch from the advisor's cursor, bounds it to `contextEntries`, filters out the advisor's own `<advisory>` entries (so it never reviews itself), and serializes via pi's public `convertToLlm` + `serializeConversation`. |
| `src/agent.ts` | **Loop** | `runAdvisorReview()` — the advisor agent loop with pi-ai's `completeSimple()`: prompt → tool calls → execute read-only tools locally → capture `advise` → loop until `advise`/silence/round cap. Uses `/compat` so `reasoning`/thinking is honoured. |
| `src/runtime.ts` | **Runtime** | `AdvisorRuntime` — the discipline ported from oh-my-pi: backlog queue, single-flight `busy` guard, `epoch` counter, 3-strike failure drop, cursor seeding, and `nit`→steer / `concern`→steer+triggerTurn delivery via `pi.sendMessage`. |

### What's ported from oh-my-pi

| oh-my-pi (internal) | pi-advisor (extension) |
|---|---|
| `advisor/runtime.ts` — backlog queue, single-flight `busy` guard, `epoch` counter, 3-strike failure drop, cursor seeding | `src/runtime.ts` (same discipline, adapted to `completeSimple`) |
| `advisor/advise-tool.ts` — `nit` / `concern` / `blocker` severities, `<advisory guidance="weigh, don't blindly obey">` framing, severity-rank dedupe | `src/index.ts` + `src/tools.ts` (`advise` tool + `formatAdvisorBatchContent`) |
| `prompts/advisor/system.md` + `advise-tool.md` — the reviewer role definition | `src/prompts.ts` (ported verbatim) |
| hard-isolated read-only toolset (`read` / `search` / `find`) on a distinct `ToolSession` | `src/tools.ts` — re-implemented `read` / `grep` / `find` against the filesystem, read-only by construction, confined to the project root |
| per-turn transcript delta via `formatSessionHistoryMarkdown`, advisor's own notes filtered out | `src/transcript.ts` — bounded trailing window via pi's public `convertToLlm` + `serializeConversation`, `<advisory>` entries filtered out |
| `nit` non-interrupting aside vs `concern`/`blocker` interrupting steer | `src/runtime.ts` `deliveryOptions()` → pi's `sendMessage` `deliverAs: "steer"` + `triggerTurn` |
| `advisor.immuneTurns` / `syncBacklog` | not ported — pi's extension API doesn't expose the steering/yield internals those tune; reviews are fire-and-forget from `turn_end` instead |

### What's different (and why)

- **No second `Agent`.** oh-my-pi's advisor is a full `Agent` with its own append-only context, telemetry, and tool loop. The public pi extension API doesn't expose `Agent`, so the advisor loop is reimplemented with pi-ai's `completeSimple()` (`src/agent.ts`): prompt → tool calls → execute read-only tools locally → capture `advise` → loop until advise/silence/round cap.
- **`completeSimple`, not `complete`.** The `reasoning`/thinking option is only honoured on the `streamSimple` path; the plain `stream` path ignores it. Importing `completeSimple` from `@earendil-works/pi-ai/compat`.
- **Bounded recent window, not a byte-delta.** oh-my-pi feeds only the per-turn delta (rendered with its internal markdown formatter). This extension can't reach that formatter, so it sends a bounded trailing transcript window via pi's public `convertToLlm` + `serializeConversation` — the same helpers pi's own `handoff` example uses. Slicing whole entries keeps assistant/toolCall + toolResult pairs intact.
- **Fire-and-forget reviews.** A review kicked from `turn_end` runs in the background and never blocks the main agent; advice lands via `pi.sendMessage` when ready. (oh-my-pi's `syncBacklog` pause-the-agent modes aren't reproducible without access to the steering/yield internals.)
- **Read-only tools re-implemented, not shared.** oh-my-pi builds its read/search/find against a distinct `ToolSession`. The extension API can't create a second tool session, so the read-only primitives are re-implemented directly against the filesystem — they are read-only by construction (no write/edit code path exists) and confined to the project root (paths escaping via `..` are rejected).

---

## Flow

### End-to-end sequence

A single primary turn, from the user's prompt to a delivered advisory note:

```
 USER                MAIN pi AGENT              advisor.ts            AdvisorRuntime          transcript.ts        agent.ts (loop)         tools.ts            MAIN AGENT (next turn)
  │                       │                          │                       │                     │                     │                       │                      │
  │── prompt ────────────►│                          │                       │                     │                     │                       │                      │
  │                       │── LLM ↔ built-in tools ──►│ (turn_start..)        │                     │                     │                       │                      │
  │                       │── turn_end ──────────────►│                       │                     │                     │                       │                      │
  │                       │                          │  latestCtx = ctx      │                     │                     │                       │                      │
  │                       │                          │  rt.onTurnEnd(branch) │                     │                     │                       │                      │
  │                       │                          │──────────────────────►│                     │                     │                       │                      │
  │                       │                          │                       │── buildAdvisorDelta │                     │                       │                      │
  │                       │                          │                       │   (slice from       │                     │                       │                      │
  │                       │                          │                       │    lastSeenEntryId, │                     │                       │                      │
  │                       │                          │                       │    bound to N,      │                     │                       │                      │
  │                       │                          │                       │    drop <advisory>) │                     │                       │                      │
  │                       │                          │                       │◄── "### Session ◄───│                     │                       │                      │
  │                       │                          │                       │    update\n\n…"     │                     │                       │                      │
  │                       │                          │                       │  queue delta        │                     │                       │                      │
  │                       │                          │                       │  #drain (single-    │                     │                       │                      │
  │                       │                          │                       │   flight, epoch)    │                     │                       │                      │
  │                       │                          │                       │── runAdvisorReview ──────────────────────►│                       │                      │
  │                       │                          │                       │  resolveModel +     │                     │  completeSimple(...)  │                      │
  │                       │                          │                       │  getApiKeyAndHeaders│                     │  (systemPrompt +      │                      │
  │                       │                          │                       │                     │                     │   tools + reasoning)  │                      │
  │                       │                          │                       │                     │                     │──► advisor model      │                      │
  │                       │                          │                       │                     │                     │◄── tool calls ─────────│                      │
  │                       │                          │                       │                     │                     │   read/grep/find ─────►│ (local fs, read-only)│
  │                       │                          │                       │                     │                     │◄── tool result ────────│                      │
  │                       │                          │                       │                     │                     │   (…up to maxToolRounds)                      │
  │                       │                          │                       │                     │                     │   advise(note, sev) ──►│ capture → loop ends  │
  │                       │                          │                       │◄── AdvisorReviewResult (advise) ──────────┘                       │                      │
  │                       │                          │                       │  host.sendAdvice([note])                   │                       │                      │
  │                       │                          │                       │── pi.sendMessage({customType:"advisor",    │                       │                      │
  │                       │                          │                       │     <advisory severity=…>}, delivery) ────────────────────────────────────────────────────────►│
  │                       │                          │                       │   nit → steer            │                 │                       │  concern/blocker → steer + triggerTurn      │
  │                       │                          │                       │                     │                     │                       │                      │
  │                       │                          │                       │  cursor = lastSeenEntryId (advance)        │                       │                      │
  │                       │                          │                       │                     │                     │                       │  <advisory> enters context;                  │
  │                       │                          │                       │                     │                     │                       │  next delta filters it out                  │
  │◄──────────── (agent acts on / weighs the advice, or continues) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────│
```

### The advisor agent loop

`runAdvisorReview()` (`src/agent.ts`) is the heart of the advisor. For each review it:

1. Resolves the configured `provider/id` to a `Model` and fetches its API key + headers from pi's `ModelRegistry` (same auth as the main agent — no separate key management).
2. Sends the "Session update" as the first user message, with the advisor system prompt and the four tools (`read`, `grep`, `find`, `advise`).
3. Loops (up to `maxToolRounds`, hard-capped at 12):
   - Calls `completeSimple()` with `reasoning` set when thinking is on **and** the model declares `reasoning: true`.
   - If the advisor returns tool calls, executes them: `read`/`grep`/`find` run locally against the (confined) filesystem and their results are appended as `toolResult` messages; `advise` **captures** the note + severity and ends the loop.
   - If the advisor returns no tool calls (it stayed silent or just talked), the review ends with no advice — silence is a first-class, preferred outcome ("Prefer silence when the agent is on track").
   - If the round cap is hit without `advise`, the review ends as silence (the advisor explored but had nothing conclusive).
4. Returns an `AdvisorReviewResult` `{ advise, rounds, error? }` to the runtime.

The loop never touches the primary session — its only side-effect is the captured `advise` note.

### Delivery: nit vs concern/blocker

Captured advice is rendered as `<advisory>` elements and delivered via `pi.sendMessage`:

| Severity | `deliverAs` | `triggerTurn` | Effect |
|---|---|---|---|
| `nit` (default) | `"steer"` | — | Non-interrupting. Queues for delivery at the next step boundary while the agent streams; if the agent is idle, waits for the next user prompt. The agent keeps working uninterrupted. |
| `concern` | `"steer"` | `true` | Interrupting. Steered into the agent; if idle, **resumes the run immediately** so the advice is acted on now. |
| `blocker` | `"steer"` | `true` | Interrupting. Same as `concern` — use when continuing would clearly waste work. |

The note body is XML-escaped so advice containing `<`, `>`, or `&` can't break the wrapper:

```text
<advisory severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

### Failure, reset & re-prime

- **3-strike drop.** A failed review (model not found, no API key, network error, abort) increments a consecutive-failure counter. After `maxRetries` (default 3) the backlog is dropped and a warning is logged — a broken advisor model never stalls the session. Below the cap, the batch is re-queued with a 1s backoff.
- **Epoch guards.** Every `session_start` / `reset` / `dispose` bumps an `epoch` counter. A drain iteration captures the epoch before its `await`s; if the epoch changed when it resumes (the session was replaced/compacted mid-review), the stale batch is **dropped** instead of being delivered into the new conversation.
- **Re-prime, no replay.** On `session_start` the cursor is seeded to the current leaf (`seedToLeaf`), so enabling the advisor mid-session doesn't replay the whole old conversation on the first turn. On compaction/session-switch the cursor resets so the next turn replays the bounded window against the post-rewrite transcript.
- **No recursive review.** The advisor's own `<advisory>` entries are filtered out of its review window, so it never reviews (and re-raises) its own advice.

---

## Installation

### Prerequisites

1. **pi ≥ 0.80** — install from [omp.sh](https://omp.sh) or:
   ```bash
   # macOS / Linux
   curl -fsSL https://omp.sh/install | sh
   # or, with bun
   bun install -g @earendil-works/pi-coding-agent
   ```
   Verify: `pi --version`

2. **At least one model with a configured API key.** The advisor is just another model call, so it reuses pi's existing `ModelRegistry` auth — no separate key management. Configure a provider key the normal way (`/login`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, a custom provider extension, etc.). Check what's available:
   ```bash
   pi --list-models
   ```
   The advisor picker only lists models pi reports as **available** (auth configured), so any model you see there can be your advisor.

> The advisor is a *second* model call per turn, so it adds its own token cost. A cheap, fast model (e.g. a `smol`/flash-tier model) is a good default advisor; a stronger model is better at catching subtle issues but costs more.

### Install

Pick one of these three methods.

**A. `pi install` from GitHub (recommended)** — clones the repo and adds it to `~/.pi/agent/settings.json` for you:
```bash
# pick any one of these equivalent forms (the scheme/prefix matters):
pi install https://github.com/hazrid93/pi-advisor
pi install git:github.com/hazrid93/pi-advisor
pi install git:git@github.com:hazrid93/pi-advisor        # over SSH
```
> ⚠️ The bare form `pi install github.com/hazrid93/pi-advisor` (no scheme) does **not** work — pi treats a bare path as a local directory. Always prefix with `https://` or `git:` (or `ssh://`).

**B. Add to `settings.json` manually.** Edit `~/.pi/agent/settings.json` and add the repo under `packages`:
```json
{
  "packages": [
    "git:github.com/hazrid93/pi-advisor"
  ]
}
```
```

**C. Quick one-off test** (no install) — load the file directly for a single session:
```bash
git clone https://github.com/hazrid93/pi-advisor
cd pi-advisor
pi -e ./advisor.ts
```

After **A** or **B**, reload so pi discovers the new extension:
```bash
/reload
```
(or restart pi). Installed extensions are auto-discovered from `~/.pi/agent/extensions/` and hot-reloadable with `/reload`.

### First run — pick an advisor model

The advisor ships **enabled but with no model**, so it does nothing until you pick one:

```
/advisor
```

This opens an interactive picker listing every available model, with your current choice (if any) and reasoning-capable models sorted to the top. Select one with `Enter`, cancel with `Esc`. Your choice persists to `~/.pi/agent/extensions/pi-advisor.json`.

Or set it directly without the picker:
```
/advisor model anthropic/claude-sonnet-4-5
/advisor model openai/gpt-4o-mini
```

### Verify it's working

```
/advisor status
```

You should see something like:
```
Advisor: enabled
Advisor model: anthropic/claude-sonnet-4-5
Thinking: off
Context window: last 30 entries · max 6 tool rounds
Delivery: nit → non-interrupting, concern/blocker → interrupting (steer + triggerTurn)
Active: yes
Runtime: not started yet (no turn reviewed)
```

Now just use pi normally. After each turn the advisor reviews the recent transcript in the background; if it has something worth saying you'll see an `<advisory>` note appear in the transcript. Force a re-review on demand any time with:
```
/advisor review
```

### Interactive commands (`/advisor`)

All control is via the single `/advisor` slash command in the TUI. Tab-completion offers the subcommands.

| Command | What it does |
|---|---|
| `/advisor` | Open the **interactive model picker** — lists every available (auth-configured) model, with your current choice and reasoning-capable models sorted to the top. `Enter` to select, `Esc` to cancel. Picking a model also enables the advisor. |
| `/advisor model <provider/id>` | Set the advisor model directly, e.g. `/advisor model litellm/glm-5.2`. Validates the model exists in the registry. |
| `/advisor enable` | Enable the advisor (reviews resume). |
| `/advisor disable` | Disable the advisor — turns are no longer reviewed, but the chosen model is kept. |
| `/advisor status` | Show config + state: enabled/disabled, current model, thinking, window size, busy flag, and the last review result. |
| `/advisor thinking <off\|minimal\|low\|medium\|high\|xhigh>` | Set the advisor's thinking effort (`off` disables thinking). |
| `/advisor review` | **Manually** re-review the recent transcript now and await the result (the only synchronous path). |
| `/advisor help` | Print the command list. |

**Enable / disable** and **model selection** are fully supported and persist to `~/.pi/agent/extensions/pi-advisor.json` (so they survive restarts). The advisor also re-reads the config on each `session_start`, so changes made from another window take effect.

> **No "wait / catch-up" mode.** The advisor is strictly **fire-and-forget**: it reviews in the background after each turn and never blocks the main agent. If it falls behind, the main agent just keeps going — a late review still lands (via `pi.sendMessage`) whenever it finishes, and an interrupting `concern`/`blocker` will resume an idle agent. There is no setting that makes the main loop pause for a backed-up advisor. The closest thing is the manual `/advisor review`, which awaits a single on-demand review.

### Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Advisor model not found: …` | The `provider/id` in your config doesn't match any model in the registry. Re-run `/advisor` to pick from the live list, or `/advisor model <provider/id>`. |
| `No API key for advisor model …` | The chosen model has no configured auth. Run `/login` for that provider or set its env var (e.g. `ANTHROPIC_API_KEY`), then `/advisor` again. The picker only shows *available* models, so this usually means auth was removed after you picked the model. |
| Advisor never says anything | This is usually correct — the advisor prefers silence when the agent is on track. Check `/advisor status` → "last review: silent (N rounds)". If it's always silent even on tricky turns, try a stronger advisor model or enable thinking: `/advisor thinking medium`. |
| `last review failed: …` repeated | The advisor model is erroring (rate limit, bad endpoint, etc.). After `maxRetries` (default 3) consecutive failures the backlog is dropped so your session isn't stalled. Switch models with `/advisor` or fix the provider. |
| Advice isn't interrupting on `concern`/`blocker` | Interruption uses pi's steer + `triggerTurn`. If the main agent is mid-tool, the note lands at the next step boundary. An idle agent is resumed immediately. This is expected. |
| Config edits don't take effect | The runtime caches config in-memory; run the command that changes it (`/advisor enable`, `/advisor model …`, etc.) rather than hand-editing, or `/reload` after editing the JSON file. |
| Path errors from the advisor's `read`/`grep`/`find` | The read-only tools are confined to the project root (`cwd`). Paths escaping via `..` are rejected. This is intentional isolation, ported from oh-my-pi. |

### Uninstall

```bash
pi uninstall git:github.com/hazrid93/pi-advisor
# or: pi remove https://github.com/hazrid93/pi-advisor
```
Or remove the entry from the `packages` array in `~/.pi/agent/settings.json` and `/reload`. Optionally delete the config file:
```bash
rm ~/.pi/agent/extensions/pi-advisor.json
```

---

## Usage

### Commands

| Command | What it does |
|---------|-------------|
| `/advisor` | Open the model picker to choose the advisor model |
| `/advisor model <provider/id>` | Set the advisor model directly |
| `/advisor status` | Show config + last review |
| `/advisor enable` / `disable` | Master switch (keeps the configured model) |
| `/advisor thinking <off\|minimal\|low\|medium\|high\|xhigh>` | Set the advisor's thinking effort (`off` = disabled) |
| `/advisor review` | Re-review the recent transcript now |
| `/advisor help` | Show usage reference |

### Config file

Created automatically at `~/.pi/agent/extensions/pi-advisor.json` on first change:

```json
{
  "enabled": true,
  "advisorModel": "anthropic/claude-sonnet-4-5",
  "thinking": false,
  "thinkingLevel": "medium",
  "contextEntries": 30,
  "maxToolRounds": 6,
  "maxRetries": 3,
  "systemPrompt": null
}
```

| Field | Default | Effect |
|-------|---------|--------|
| `enabled` | `true` | Master switch. When `false`, no review occurs. |
| `advisorModel` | `null` | The advisor, as `provider/id`. `null` = not configured (advisor inactive). |
| `thinking` | `false` | Whether the advisor reasons before reviewing. Adds latency + cost; off by default. |
| `thinkingLevel` | `"medium"` | Thinking effort when `thinking` is on (only honoured if the advisor model declares `reasoning: true`). |
| `contextEntries` | `30` | How many trailing session entries to feed the advisor as context each turn. Bounded for cost + pairing safety. |
| `maxToolRounds` | `6` | Max read-only tool rounds per review before the advisor must `advise` or yield. Hard-capped at 12. |
| `maxRetries` | `3` | Max attempts to retry a failed review before dropping the backlog (mirrors oh-my-pi's 3-strike drop so a broken model never stalls the session). |
| `systemPrompt` | _(built-in)_ | Override the advisor system prompt. |

> The config path uses pi's `getAgentDir()` — set `PI_CODING_AGENT_DIR` to relocate it.

### Advice severity & delivery

| Severity | Delivery | Intended use |
|----------|----------|--------------|
| `nit` (default) | Non-interrupting — lands at the next step boundary; agent keeps working. | Cleanup, simplification, low-risk edge cases. |
| `concern` | Interrupting — steered into the agent; resumes an idle agent immediately. | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker` | Interrupting — same as `concern`. | Continuing would clearly waste work or produce broken output. |

---

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (latest pi: @earendil-works/*@0.80.2)
pnpm test        # vitest — 66 unit tests, no API key needed
```

### Testing

The repo ships a **vitest unit suite (66 tests)** that confirms the core logic
without any network or API key — the advisor loop runs against a *scriptable
fake `complete`*, so every code path is deterministic:

| Suite | Covers |
|---|---|
| `__tests__/agent.test.ts` | the advisor loop: capture `advise` (with/without exploration), silence, round cap, model-not-found, no-auth, thrown errors, `reasoning` gating, the four tools sent |
| `__tests__/runtime.test.ts` | `AdvisorRuntime`: happy-path delivery, no-model/disabled no-ops, 3-strike failure drop, recovery after error, epoch-guard drop on reset, dispose, cursor seeding (no replay), own-`<advisory>` filtering, `reviewNow`, `deliveryOptions` |
| `__tests__/transcript.test.ts` | delta building: full window, cursor advances, nothing-new → null, own-message filtering, window bounding, stale-cursor re-prime |
| `__tests__/tools.test.ts` | the read-only toolset: `read` (offset/limit/missing), `find` (glob, skips `node_modules`), `grep` (literal/regex/case-insensitive/no-match), `advise` capture, path-confinement via `..`, `resolveAdvisorReasoning` gating |
| `__tests__/config.test.ts` | config normalization/persistence, `provider/id` parsing, severity ladder, `<advisory>` framing + XML escaping |

The agent loop is testable because `runAdvisorReview` takes an **injectable
`complete`** (`AdvisorLoopDeps.complete`); production wires pi-ai's
`completeSimple`, tests wire a scriptable fake. Likewise `AdvisorRuntime`
takes an injectable `review` so its queue/epoch/retry discipline is tested
without a real model call.

### Live smoke test (verified)

The extension was smoke-tested against real models via `pi -e ./advisor.ts`
in print mode, confirming the full ported pipeline:

- **Main agent `litellm/kimi-k2.7` + advisor `litellm/glm-5.2`.**
- On a deliberately buggy prompt (an off-by-one `sumFirst`), the advisor ran
  the `completeSimple` loop, spotted the bug in 1 round, and called `advise`
  with severity `concern`:
  > *"The function you output sums 0..n-1 … but the user's stated goal was
  > 'sums 1..n' … prefer correctness: `for (let i = 1; i <= n; i++) s += i;`"*
- The note was delivered via `pi.sendMessage` as an interrupting
  `<advisory severity="concern">` (`steer` + `triggerTurn`), which resumed the
  agent to fix it. The follow-up review correctly returned **silent** (the
  agent had corrected itself).
- On correct turns the advisor stayed silent (the intended "prefer silence
  when the agent is on track" behaviour).

### Structure

```
.
├── advisor.ts            # Wiring layer: pi event hooks (turn_end, session_*) + /advisor command
├── src/
│   ├── index.ts          # Config schema, persistence, model-ref + severity helpers, <advisory> framing
│   ├── prompts.ts        # Advisor system prompt + advise-tool description (ported from oh-my-pi)
│   ├── tools.ts          # Hard-isolated read-only toolset (read/grep/find) + advise capture
│   ├── transcript.ts     # Bounded "Session update" delta builder (convertToLlm + serializeConversation)
│   ├── agent.ts          # The advisor agent loop (completeSimple + tools + advise capture)
│   └── runtime.ts        # AdvisorRuntime: backlog, single-flight, epoch guards, retries, delivery
├── docs/
│   └── architecture.md   # Standalone architecture + flow doc (linked from the GitHub profile)
├── __tests__/            # vitest unit suite (66 tests, no API key needed)
│   ├── agent.test.ts     # advisor loop: advise/silence/round-cap/errors/reasoning-gating
│   ├── runtime.test.ts   # backlog, epoch guards, 3-strike drop, cursor seeding, delivery
│   ├── transcript.test.ts# delta building, cursor, own-message filtering, bounding
│   ├── tools.test.ts     # read-only tools: read/find/grep/advise, path confinement
│   └── config.test.ts    # config normalization, model-ref, severity, <advisory> framing
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## Acknowledgements

The advisor concept, system prompt, severity ladder, `<advisory>` framing, and the runtime discipline (backlog queue, epoch guards, 3-strike failure drop, cursor seeding, own-message filtering) are all from **[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)**'s advisor package (`packages/coding-agent/src/advisor/`). This project ports that logic to stock pi's extension API. The picker/config-file conventions follow [`monotykamary/pi-vision-handoff`](https://github.com/monotykamary/pi-vision-handoff).

## License

MIT
