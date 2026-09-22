# pi-advisor — Architecture & Flow

> A second model that peer-reviews every turn of your main [pi](https://github.com/earendil-works/pi-coding-agent) agent and injects concise advice. This is the standalone architecture doc linked from the [GitHub profile](https://github.com/hazrid93); the user-facing guide is the [repo README](../README.md).

`pi-advisor` is the [pi extension](https://github.com/earendil-works/pi-coding-agent) port of the **advisor logic from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)** (its `packages/coding-agent/src/advisor/` package), rebuilt against pi's public extension API. oh-my-pi's advisor is welded into its own forked agent runtime; this extension delivers the same behaviour to stock pi via lifecycle events, custom tools, and `pi.sendMessage`.

---

## 1. The one-paragraph version

On every primary `turn_end`, the extension takes a bounded slice of the session transcript (the advisor's own `<advisory>` notes filtered out so it never reviews itself), hands it to a **second model the user picked** as a "Session update", and lets that model explore the workspace with a hard-isolated read-only toolset (`read`/`grep`/`find`) before calling `advise(note, severity)`. The captured note is rendered as an `<advisory>` element and delivered back into the main agent's context via `pi.sendMessage` — `nit` lands non-interruptingly, `concern`/`blocker` interrupt (steer + resume an idle agent). The advisor never edits files, runs commands, or changes session state; it only reads and advises.

---

## 2. Component diagram

```
                         ┌─────────────────────────────── pi (main agent) ──────────────────────────────┐
                         │                                                                              │
   user prompt ────────► │  agent loop: LLM ↔ built-in tools (bash/edit/read/...)                       │
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
 │  serializeTurn(message, toolResults)      │               │  staging buffer (rolling, bounded by contextChars)      │
 │   1. take the turn_end payload as-is      │   "Session     │  commit-at-requestReview → one PendingTurn (latest-wins)│
 │   2. convertToLlm + serializeConversation │   update"      │  single-flight `busy` guard · `epoch` + `generation`     │
 │   → "### Session update\n\n..."           │ ────────────►  │  3-strike failure drop (configurable) · retry+backoff   │
 │                                           │   (text)       │  #advisorHistory: persistent advisor conversation       │
 │  (no cursor, no branch diff — the event   │               │  drains by calling runAdvisorReview (one at a time)     │
 │   payload IS one bounded turn)            │               │                                                          │
 └───────────────────────────────────────────┘               └───────────────────────┬────────────────────────────────┘
                                                                                       │ per batch
                                                                                       ▼
                                              ┌──────── src/agent.ts (runAdvisorReview) ─────────┐
                                              │  completeSimple() loop  (reasoning-aware)         │
                                              │    messages = [ ...history, user:"Session update"]│
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
                                              │  (local fs, read-only, confined to the          │
                                              │   CANONICAL cwd — symlinks can't escape)         │
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

---

## 3. Module responsibilities

| File | Layer | Responsibility |
|---|---|---|
| `advisor.ts` | **Wiring** | Subscribes to pi events (`turn_end` to queue reviews, `turn_start` for the optional `/advisor sync` catch-up gate, `session_start`/`session_compact`/`session_tree`/`session_shutdown`), lazily builds the runtime, registers the `/advisor` command + model picker, routes subcommands. The only file that touches `ExtensionAPI`. |
| `src/index.ts` | **Config/types** | Config schema + persistence (`~/.pi/agent/extensions/pi-advisor.json`), `provider/id` parsing, severity type, and the `<advisory>` framing (`formatAdvisorBatchContent`, `escapeXmlText`). No pi imports beyond `getAgentDir`. |
| `src/prompts.ts` | **Prompt** | The advisor system prompt and `advise` tool description — **ported verbatim from oh-my-pi** (`prompts/advisor/system.md` + `advise-tool.md`). Defines the reviewer role: peer-programmer, not a second executor; can only read + advise. |
| `src/tools.ts` | **Tools** | The advisor's hard-isolated read-only toolset: `read`, `grep`, `find` (re-implemented against the filesystem, read-only by construction — there is no write/edit capability at all — and confined to the project root — paths are canonicalized with `realpath` before the containment check, so an in-repo symlink cannot be used to read outside it) plus the `advise` tool that captures a note + severity. |
| `src/transcript.ts` | **Context** | Serializes ONE turn — the `turn_end` payload (`message` + its `toolResults`) — into the "Session update" body via pi's public `convertToLlm` + `serializeConversation`. No cursor, no branch diff, no explicit `<advisory>` filter: the event payload is already one bounded turn, and self-review exclusion is implicit (advisories are `custom` entries; only `role === "user"` entries are picked up from the branch). |
| `src/agent.ts` | **Loop** | `runAdvisorReview()` — the advisor agent loop with pi-ai's `completeSimple()`: `history` prefix + the new update → tool calls → execute read-only tools locally → capture `advise`. Exploration is offered only while `maxToolRounds` remains; at the budget the advisor gets one final `advise`-only call, so the last round is always judged. Returns the messages it added as `appended` for the runtime to persist. Uses `/compat` so `reasoning`/thinking is honoured. |
| `src/runtime.ts` | **Runtime** | `AdvisorRuntime` — the discipline ported from oh-my-pi, plus this extension's own: a rolling staging buffer bounded by `contextChars`, commit-at-`requestReview` into a single latest-wins `PendingTurn`, single-flight `busy` guard, `epoch` (reset/compact/tree-nav) and `generation` (latest-wins) guards, 3-strike failure drop, the persistent `#advisorHistory` conversation, and `nit`→steer / `concern`→steer+triggerTurn delivery via `pi.sendMessage`. |

---

## 4. End-to-end flow

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
  │                       │                          │                       │── serializeTurn ───►│                     │                       │                      │
  │                       │                          │                       │   (message +        │                     │                       │                      │
  │                       │                          │                       │    toolResults,     │                     │                       │                      │
  │                       │                          │                       │    one turn)        │                     │                       │                      │
  │                       │                          │                       │◄── "### Session ◄───│                     │                       │                      │
  │                       │                          │                       │    update\n\n…"     │                     │                       │                      │
  │                       │                          │                       │  stage delta,       │                     │                       │                      │
  │                       │                          │                       │  commit on request  │                     │                       │                      │
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
  │                       │                          │                       │  append this review's messages to          │                       │                      │
  │                       │                          │                       │  #advisorHistory (next review's prefix)    │                       │                      │
  │                       │                          │                       │                     │                     │                       │  <advisory> is a `custom` entry, so it       │
  │                       │                          │                       │                     │                     │                       │  is never captured as a user message        │
  │◄──────────── (agent acts on / weighs the advice, or continues) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────│
```

### 4.1 The advisor agent loop

`runAdvisorReview()` (`src/agent.ts`) is the heart of the advisor. For each review it:

1. Resolves the configured `provider/id` to a `Model` and fetches its API key + headers from pi's `ModelRegistry` (same auth as the main agent — no separate key management).
2. Builds `messages` as the persistent advisor conversation (`history`, unchanged) followed by the new "Session update" user message, with the advisor system prompt and the four tools (`read`, `grep`, `find`, `advise`). Re-sending the prefix byte-for-byte is what makes provider prompt caching hit.
3. Loops, executing at most `maxToolRounds` tool rounds (hard-capped at 12):
   - Calls `completeSimple()` with `reasoning` set when thinking is on **and** the model declares `reasoning: true`.
   - Exploration tools are offered only while rounds remain. `read`/`grep`/`find` run locally against the (confined) filesystem and their results are appended as `toolResult` messages; `advise` **captures** the note + severity and ends the loop.
   - If the advisor returns no tool calls (it stayed silent or just talked), the review ends with no advice — silence is a first-class, preferred outcome ("Prefer silence when the agent is on track").
   - Once the budget is spent the advisor gets one final call offering `advise` alone, so the results of the last tool round are always judged rather than discarded. Total model calls per review are bounded by `maxToolRounds + 2`. A `read`/`grep`/`find` emitted on that verdict call is answered with a refusal instead of executed — the budget is a hard cap.
4. Returns an `AdvisorReviewResult` `{ advise, rounds, error?, appended? }` to the runtime. `appended` is the messages this review added on top of `history`; the runtime persists them as the advisor's conversation so the next review re-sends them as its prefix.

The loop never touches the primary session — its only side-effect is the captured `advise` note.

### 4.2 Delivery: nit vs concern/blocker

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

### 4.3 Failure, reset & re-prime

- **3-strike drop.** A failed review (model not found, no API key, network error, abort) increments a consecutive-failure counter. After `maxRetries` (default 3) consecutive failures the backlog is dropped and a warning is logged — a broken advisor model never stalls the session. Below the cap, the batch is re-queued with a 1s backoff.
- **Epoch guards.** Every `session_start` / `reset` / `dispose` bumps an `epoch` counter. A drain iteration captures the epoch before its `await`s; if the epoch changed when it resumes (the session was replaced/compacted mid-review), the stale batch is **dropped** instead of being delivered into the new conversation.
- **Re-prime, no replay.** On `session_start`, `seedToLeaf(branch)` clears the staging buffer, the pending queue and the advisor conversation, and marks every user entry already on the branch as seen. Enabling the advisor mid-session therefore reviews new turns only, instead of replaying the whole prior conversation. `session_compact` and `session_tree` do the same against the rewritten branch.
- **No recursive review.** Advisories are delivered as pi `custom` messages, and only `role === "user"` entries are captured from the branch — so the advisor's own advice is never picked up as input. The exclusion is structural rather than a filter on the text.

---

## 5. What's ported from oh-my-pi vs. what's adapted

| oh-my-pi (internal) | pi-advisor (extension) | Notes |
|---|---|---|
| `advisor/runtime.ts` — backlog queue, single-flight `busy` guard, `epoch` counter, 3-strike failure drop, cursor seeding | `src/runtime.ts` | Same discipline, adapted to drive `completeSimple` instead of a second `Agent`. Cursor seeding became `seedToLeaf` over the event payload model (no cursor to advance). |
| `advisor/advise-tool.ts` — `nit`/`concern`/`blocker` severities, `<advisory guidance="weigh, don't blindly obey">` framing, severity-rank dedupe | `src/index.ts` + `src/tools.ts` | `advise` tool + `formatAdvisorBatchContent`. |
| `prompts/advisor/system.md` + `advise-tool.md` — the reviewer role definition | `src/prompts.ts` | Ported verbatim. |
| hard-isolated read-only toolset (`read`/`search`/`find`) on a distinct `ToolSession` | `src/tools.ts` | Re-implemented against the filesystem; read-only by construction (no write/edit code path exists) and confined to the canonicalized project root (symlinks cannot escape it). |
| per-turn transcript delta via `formatSessionHistoryMarkdown`, advisor's own notes filtered out | `src/transcript.ts` | Bounded trailing window via pi's public `convertToLlm` + `serializeConversation`; `<advisory>` entries filtered out. |
| `nit` non-interrupting aside vs `concern`/`blocker` interrupting steer | `src/runtime.ts` `deliveryOptions()` | Mapped onto pi's `sendMessage` `deliverAs: "steer"` + `triggerTurn`. |
| `advisor.immuneTurns` / `syncBacklog` | **recreated** | pi's extension API doesn't expose the steering/yield internals those tune, so reviews are fire-and-forget from `turn_end` by default. The bounded pause-the-agent behavior is recreated on top of pi's awaited `turn_start` hook via `/advisor sync` (`src/runtime.ts` `waitForCatchUp`). |

### Key adaptations (and why)

- **No second `Agent`.** oh-my-pi's advisor is a full `Agent` with its own append-only context, telemetry, and tool loop. The public pi extension API doesn't expose `Agent`, so the advisor loop is reimplemented with pi-ai's `completeSimple()`.
- **`completeSimple`, not `complete`.** The `reasoning`/thinking option is only honoured on the `streamSimple` path; the plain `stream` path ignores it. Importing `completeSimple` from `@earendil-works/pi-ai/compat`.
- **Bounded recent window, not a byte-delta.** oh-my-pi feeds only the per-turn delta (rendered with its internal markdown formatter). This extension can't reach that formatter, so it sends a bounded trailing transcript window via pi's public helpers (the same ones pi's own `handoff` example uses). Slicing whole entries keeps assistant/toolCall + toolResult pairs intact.
- **Fire-and-forget by default.** A review kicked from `turn_end` runs in the background and never blocks the main agent; advice lands via `pi.sendMessage` when ready. Optionally `/advisor sync <1-6>` makes the main loop pause at the awaited `turn_start` hook when the advisor falls `N` turns behind (bounded catch-up; fully abortable).
- **Read-only tools re-implemented, not shared.** oh-my-pi builds its read/search/find against a distinct `ToolSession`. The extension API can't create a second tool session, so the read-only primitives are re-implemented directly against the filesystem — read-only by construction and confined to the project root, canonicalizing each path so symlinks cannot walk out of it.

---

## 6. Acknowledgements

The advisor concept, system prompt, severity ladder, `<advisory>` framing, and the runtime discipline (backlog queue, epoch guards, 3-strike failure drop, re-priming on session replacement, own-message exclusion) are all from **[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)**'s advisor package (`packages/coding-agent/src/advisor/`). The picker/config-file conventions follow [`monotykamary/pi-vision-handoff`](https://github.com/monotykamary/pi-vision-handoff).
