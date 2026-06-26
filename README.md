<div align="center">

# 🧭 pi-advisor

**A second model that peer-reviews every turn of your main [pi](https://github.com/earendil-works/pi-coding-agent) agent and injects concise advice.**

_Pick any model from your registry as the advisor — it watches, reads the workspace, and surfaces one note before your agent sinks work into the wrong direction._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## The idea

The best coding agents get tunnel vision. They commit to a fragile approach, miss an edge case, or keep drilling into a hole that won't satisfy your request. `pi-advisor` attaches a **second model** — the *advisor* — that passively reviews each turn of your main agent and, when something's worth saying, injects a single terse note.

It is **not a second executor.** The advisor cannot edit files, run commands, approve actions, or change session state. It can only read the workspace (read / grep / find) and call `advise`. The main agent decides what to do with the advice — the note is framed `weigh, don't blindly obey`, not an order.

This is the [pi extension](https://github.com/earendil-works/pi-coding-agent) port of the **advisor logic from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)** (its `packages/coding-agent/src/advisor/` package), rebuilt against pi's public extension API. oh-my-pi's advisor is welded into its own forked agent runtime; this extension delivers the same behaviour to stock pi via events, tools, and `pi.sendMessage`.

## How it works

```
turn_end  ──►  AdvisorRuntime builds a "Session update" (bounded recent transcript window,
               advisor's own <advisory> notes filtered out so it never reviews itself)
        ──►  runAdvisorReview()  (completeSimple loop, background, never blocks the agent)
                 │  advisor system prompt (ported from oh-my-pi) + read-only tools
                 ├─ read / grep / find  →  execute locally, results fed back
                 └─ advise(note, severity)  →  captured, loop ends
        ──►  pi.sendMessage({ customType: "advisor", <advisory …> }, delivery)
                 ├─ nit        → non-interrupting (next step boundary)
                 └─ concern / blocker → interrupting (steer + triggerTurn)
```

### What's ported from oh-my-pi

| oh-my-pi (internal) | pi-advisor (extension) |
|---|---|
| `advisor/runtime.ts` — backlog queue, single-flight `busy` guard, `epoch` counter, 3-strike failure drop, cursor seeding | `src/runtime.ts` (same discipline, adapted to `completeSimple`) |
| `advisor/advise-tool.ts` — `nit` / `concern` / `blocker` severities, `<advisory guidance="weigh, don't blindly obey">` framing, severity-rank dedupe | `src/index.ts` + `src/tools.ts` (`advise` tool + `formatAdvisorBatchContent`) |
| `prompts/advisor/system.md` + `advise-tool.md` — the reviewer role definition | `src/prompts.ts` (ported verbatim) |
| hard-isolated read-only toolset (`read` / `search` / `find`) on a distinct `ToolSession` | `src/tools.ts` — re-implemented `read` / `grep` / `find` against the filesystem, read-only by construction (no write/edit capability exists), confined to the project root |
| per-turn transcript delta via `formatSessionHistoryMarkdown`, advisor's own notes filtered out | `src/transcript.ts` — bounded trailing window via pi's public `convertToLlm` + `serializeConversation`, `<advisory>` entries filtered out |
| `nit` non-interrupting aside vs `concern`/`blocker` interrupting steer | `src/runtime.ts` `deliveryOptions()` → pi's `sendMessage` `deliverAs: "steer"` + `triggerTurn` |
| `advisor.immuneTurns` / `syncBacklog` | not ported — pi's extension API doesn't expose the steering/yield internals those tune; reviews are fire-and-forget from `turn_end` instead |

### What's different (and why)

- **No second `Agent`.** oh-my-pi's advisor is a full `Agent` with its own append-only context, telemetry, and tool loop. The public pi extension API doesn't expose `Agent`, so the advisor loop is reimplemented with pi-ai's `completeSimple()` (`src/agent.ts`): prompt → tool calls → execute read-only tools locally → capture `advise` → loop until advise/silence/round cap.
- **`completeSimple`, not `complete`.** The `reasoning`/thinking option is only honoured on the `streamSimple` path; the plain `stream` path ignores it. Importing from `@earendil-works/pi-ai/compat`.
- **Bounded recent window, not a byte-delta.** oh-my-pi feeds only the per-turn delta (rendered with its internal markdown formatter). This extension can't reach that formatter, so it sends a bounded trailing transcript window via pi's public `convertToLlm` + `serializeConversation` — the same helpers pi's own `handoff` example uses. Slicing whole entries keeps assistant/toolCall + toolResult pairs intact.
- **Fire-and-forget reviews.** A review kicked from `turn_end` runs in the background and never blocks the main agent; advice lands via `pi.sendMessage` when ready. (oh-my-pi's `syncBacklog` pause-the-agent modes aren't reproducible without access to the steering/yield internals.)

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

Each note is rendered into the transcript as an `<advisory>` element (severity as an attribute, `guidance="weigh, don't blindly obey"` framing):

```text
<advisory severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

Advisor messages are filtered out of the advisor's own review window, so it never recursively reviews (and re-raises) its own advice.

## Installation

**With `pi install`** (recommended):

```bash
pi install https://github.com/hazrid93/pi-advisor
```

Or install from GitHub:

```bash
pi install github.com/hazrid93/pi-advisor
```

Or in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "github.com/hazrid93/pi-advisor"
  ]
}
```

Then `/reload` or restart pi. For a quick one-off test: `pi -e ./advisor.ts`.

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit (latest pi: @earendil-works/*@0.80.2)
```

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
├── package.json
├── tsconfig.json
└── README.md
```

## Acknowledgements

The advisor concept, system prompt, severity ladder, `<advisory>` framing, and the runtime discipline (backlog queue, epoch guards, 3-strike failure drop, cursor seeding, own-message filtering) are all from **[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)**'s advisor package (`packages/coding-agent/src/advisor/`). This project ports that logic to stock pi's extension API. The picker/config-file conventions follow [`monotykamary/pi-vision-handoff`](https://github.com/monotykamary/pi-vision-handoff).

## License

MIT
