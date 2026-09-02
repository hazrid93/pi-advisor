<div align="center">

# pi-advisor

**A second model that reviews your main [pi](https://github.com/earendil-works/pi-coding-agent) agent and injects concise, actionable advice.**

[![npm version](https://img.shields.io/npm/v/%40hazrid1993%2Fpi-advisor?logo=npm&label=npm)](https://www.npmjs.com/package/@hazrid1993/pi-advisor)
[![npm downloads](https://img.shields.io/npm/dm/%40hazrid1993%2Fpi-advisor?label=npm%20downloads)](https://www.npmjs.com/package/@hazrid1993/pi-advisor)
[![Pi package](https://img.shields.io/badge/Pi-package_catalog-8A2BE2)](https://pi.dev/packages/@hazrid1993/pi-advisor)
[![pi 0.80+](https://img.shields.io/badge/pi-%3E%3D0.80-8A2BE2)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

> [!NOTE]
> **Official release:** [`@hazrid1993/pi-advisor`](https://www.npmjs.com/package/@hazrid1993/pi-advisor) is published on npm and listed in the [Pi package catalog](https://pi.dev/packages/@hazrid1993/pi-advisor).

## What it does

Coding agents can develop tunnel vision. `pi-advisor` runs a second model after each main-agent turn to catch concrete mistakes, missed constraints, fragile designs, and likely wasted work.

The advisor:

- sees recent **user prompts**, assistant messages, tool calls, and tool results;
- can inspect the project with isolated read-only `read`, `grep`, and `find` tools;
- stays silent when the main agent is on track;
- can send one `nit`, `concern`, or `blocker` advisory;
- cannot edit files, execute commands, or change session state.

Advice is framed as guidance for the main agent to weigh—not blindly obey.

## Research: why a paired LLM improves coding results

The two-model design is backed by peer-reviewed research. [**PairCoder: Pair Programming-Inspired Two-Agent Collaboration for Code Generation**](https://aclanthology.org/2026.findings-acl.149.pdf) (Chen et al., [Findings of ACL 2026](https://aclanthology.org/2026.findings-acl.149/)) shows that pairing two LLMs — one generating code, the other reviewing it — measurably beats single-model inference on coding tasks.

Reported results:

| Result | Detail |
|---|---|
| Higher accuracy | Up to **20.3%** improvement in pass@1 over single-model inference; **91.0%** pass@1 on HumanEval across eight representative backbones |
| Consistent gains | Improvements hold across **13 LLMs**, so the effect is not specific to one model family |
| Cheaper than heavy multi-agent setups | **40–70% fewer tokens** than multi-agent baselines while still outperforming them |
| Heterogeneous pairs shine | Many pairings of *different* models outperform **both** constituent models |

What this means for `pi-advisor`:

- **Generator + reviewer beats a lone generator.** PairCoder's two-agent split — one model writes, one reviews — is exactly the shape `pi-advisor` gives pi: the main agent codes, the advisor model reviews every turn and catches what tunnel vision misses.
- **The reviewer can (and often should) be a different model.** PairCoder found heterogeneous pairings frequently beat both constituent models — one reason `/advisor` lets you pick any model rather than a copy of the main agent.
- **Lightweight beats heavyweight.** PairCoder achieves its gains with 40–70% fewer tokens than multi-agent frameworks. `pi-advisor` follows the same deployment-conscious philosophy: a bounded advisor conversation (default 24,000 characters) sent as an append-only prefix for provider prompt-cache hits, read-only exploration, and silence when the main agent is already on track.

One honest difference: PairCoder alternates the two models between coder and reviewer roles when repeated errors signal a stalled interaction. `pi-advisor` keeps the roles fixed — the main agent always drives, the advisor always reviews — because in an interactive session the human decides when to change course.

> Chen, Junhao, Xiang Li, Yibin Xu, Yuehan Cui, Fangsheng Weng, Hao Zhao, Fei Ma, and Qi Tian. 2026. *PairCoder: Pair Programming-Inspired Two-Agent Collaboration for Code Generation.* In *Findings of the Association for Computational Linguistics: ACL 2026*, pages 3043–3058, San Diego, California, United States. Association for Computational Linguistics. DOI: [10.18653/v1/2026.findings-acl.149](https://doi.org/10.18653/v1/2026.findings-acl.149). Code: [yisuanwang/PairCoder](https://github.com/yisuanwang/PairCoder).

## Install and update

### Install

Install the official package from npm:

```bash
pi install npm:@hazrid1993/pi-advisor
```

Then restart pi or run:

```text
/reload
```

To install directly from the source repository instead:

```bash
pi install git:github.com/hazrid93/pi-advisor
pi install git:git@github.com:hazrid93/pi-advisor
```

Do not use the bare `github.com/hazrid93/pi-advisor` form; pi treats bare values as local paths.

### Update

Use pi's package update command, then reload:

```bash
pi update --extensions
```

(`pi update` alone updates the pi CLI only — `--extensions` updates installed
packages; `--all` does both.) Unpinned installs — `npm:@hazrid1993/pi-advisor`
or `git:github.com/hazrid93/pi-advisor` — track the latest release this way.
Version-pinned installs (`npm:@hazrid1993/pi-advisor@0.6.4`, git tags/commits)
are deliberately skipped; re-`pi install` with the new version/ref to move them.

Then restart pi or run:

```text
/reload
```

For a one-off local test:

```bash
git clone https://github.com/hazrid93/pi-advisor
cd pi-advisor
pi -e ./advisor.ts
```

## Quick start

Choose an available advisor model:

```text
/advisor
```

Or set one directly:

```text
/advisor model anthropic/claude-sonnet-4-5
```

Check that it is active:

```text
/advisor status
```

The advisor uses pi's existing model registry and provider authentication. It does not manage separate API keys.

## What context the advisor sees

The advisor does **not** receive the main model's entire context window. It maintains a bounded, in-memory sliding transcript containing:

1. each newly submitted user prompt;
2. the corresponding assistant turn;
3. tool calls and tool results from that turn.

New user prompts are captured once from the authoritative session branch and placed before the assistant work they triggered. This lets the advisor compare the implementation against the user's actual request instead of inferring intent from the assistant's behavior.

### Default window

The default and recommended budget is:

```text
24,000 characters (roughly 6,000 tokens)
```

The limit is character-based, not message-count-based. The budget bounds the
advisor's **persistent conversation** (see [Prompt-cache-friendly context](#prompt-cache-friendly-context) below):
when it is exceeded, the **oldest half** of past reviews is dropped at once.
Cutting only at review boundaries keeps every tool result paired with its tool
call, and dropping in batches (rather than one message at a time) amortizes the
provider prompt-cache miss — one cold request, then many cache-hit reviews
before the next trim.

Inspect or change the window at runtime:

```text
/advisor context
/advisor context 50k
/advisor context 32000
/advisor context default
```

Accepted range: **512–200,000 characters**. `default`, `recommended`, and `reset` restore 24,000.

A larger window improves long-task awareness but increases advisor input cost and latency on every review. Recommended starting points:

| Workload | Suggested value |
|---|---:|
| Short fixes / low-cost advisor | `12k`–`24k` |
| General coding work | **`24k` (default)** |
| Long refactors / tool-heavy runs | `40k`–`80k` |

The advisor conversation resets on session replacement, reload, compaction, tree navigation, and advisor configuration changes. Existing history is marked as seen rather than replayed; the advisor resumes with newly submitted prompts and turns.

### Prompt-cache-friendly context

The advisor keeps a **persistent, append-only conversation** with its model
across reviews. Each review sends everything that came before **unchanged as
the leading prefix** and appends exactly one new user message (that turn's
session update). Consecutive requests therefore share a byte-identical prefix
— precisely what provider prompt caching matches against:

- **OpenAI / Gemini-style automatic prefix caching** discounts the repeated
  prefix with no API changes (the request just has to repeat it verbatim).
- **Anthropic** caches via `cache_control` breakpoints, which pi-ai applies
  automatically for Anthropic-api models (system prompt, last tool definition,
  and the trailing conversation content).
- A stable per-session id is forwarded as the provider prompt-cache key /
  session-affinity id (OpenAI `prompt_cache_key`, Anthropic-compatible
  `x-session-affinity`, OpenRouter `x-session-id`) so cache lookups route
  consistently.

Without this, every review rebuilt the whole rolling transcript as a fresh
single-message conversation: full input price for the entire window on every
turn, and cache hits only on the system prompt + tools. With it, the uncached
input per review is just the new session update — prior turns, the advisor's
own notes, and its read/grep/find results are read from cache at the
provider's discounted rate.

`/advisor status` shows per-review and session-wide token usage with the
cache split — raw totals plus the cached/written breakdown and the aggregate
hit rate, matching your provider's accounting (pi-ai reports `input` as
uncached-only, with cache reads/writes in separate buckets). High cache-read
on an Anthropic/OpenAI advisor model means the prefix is hitting.

Two tuning levers:

- **`cacheRetention`** (config): Anthropic's default cache TTL is 5 minutes
  (`"short"`). Every-turn cadences keep it warm naturally (each hit refreshes
  the TTL), but sparse setups — `agent_settled`-only triggers, long quiet
  gaps — can exceed 5 minutes between reviews and cold-prefill every time.
  `"long"` raises the TTL to 1 hour on models that support it. `"none"`
  disables cache markers and session-affinity routing entirely.
- **Keep the advisor model + instructions stable mid-session**: the system
  prompt and tools are the head of the cached prefix; changing the advisor
  model or `.pi/advisor.md` starts a fresh cache (the runtime also resets the
  conversation on model/config changes, so behavior stays consistent).

Known bound: tool results larger than 10k chars are truncated in the
*persisted* history copy (the live review saw the full result). The next
request diverges at that message, so the cache falls back to the previous
review's breakpoint — roughly one review cycle is re-processed, then the
prefix is warm again. Rare, bounded, and the price of keeping the history
budget predictable.

## Project-scoped advisor instructions

Each trusted project can persist its own advisor priorities in:

```text
<project>/.pi/advisor.md
```

Manage them from pi:

```text
/advisor instructions
/advisor instructions set Focus on backwards compatibility and migration safety.
/advisor instructions show
/advisor instructions clear
```

`/advisor instructions` opens a multi-line editor. Instructions are loaded for every review in that project and survive restarts. They are ignored when pi has not trusted the project.

Project instructions refine what the advisor prioritizes. They cannot grant write/command capabilities or override higher-priority safety constraints.

## Global advisor instructions (cross-repo)

A second, per-user instructions file persists across every repo:

```text
~/.pi/agent/extensions/pi-advisor-instructions.md
```

Manage it from any pi session:

```text
/advisor instructions global set Always prefer tests, avoid scope creep.
/advisor instructions global show
/advisor instructions global edit
/advisor instructions global clear
```

Then choose which source is active (saved to the global config):

```text
/advisor instructions mode <project|global|none>
```

`project` is the default and **opt-out of global**: a fresh repo does *not* inherit the global file unless you switch to `global`. `none` uses neither. This lets you maintain one global guidance set and opt into it per repo without editing each project file.

## Selectable review triggers

By default the advisor reviews at the end of each turn and after a turn that
contained a tool error (`turn_end` + `tool_error`). You can enable additional
review points or turn others off — capture of each finalized turn always runs
on `turn_end` regardless, so switching triggers never loses context.

One throttle shapes how often triggers actually start a review — **work
cadence**: `turnInterval` (default 1) reviews every N completed turns, which
self-adjusts to pacing (rapid bursts and slow thoughtful runs get the same
per-work coverage). Skipped turns coalesce rather than drop, and a run that
*finishes* early always flushes its final review at `agent_settled` with
everything coalesced — throttling never leaves a finished run unreviewed.

```text
/advisor triggers              # open the fuzzy-searchable toggle menu
/advisor triggers agent_settled  # toggle one trigger by name
```

The menu is a keyboard-driven multi-select: type to filter, ↑/↓ to move, `tab`
to toggle a row, `enter`/`ctrl+s` to save (at least one must stay on), `esc` to
cancel. Changes persist to the global config.

| Trigger | Fires |
|---|---|
| `turn_end` | After every turn (default) |
| `tool_error` | After a turn that contained a tool error, deferred to `turn_end` (default) |
| `tool_result` | After each tool completes |
| `agent_settled` | Once when the whole run settles (no auto-continuation) — delivered non-interrupting |
| `mid_pause` | After a quiet period mid-run (debounced; at most once per input) |
| `input` | On user input — a prompt/intent review before the agent acts |

`input` only counts **real** user input (typed or RPC). pi also fires the
`input` event for messages injected by extensions — including this
extension's own `<advisory>` deliveries — and those are deliberately ignored,
otherwise the advisor would review its own advice or re-arm `mid_pause` after
every delivery (a self-triggering review loop).

`agent_settled` is the robust choice for "review once when done, not every
turn": it fires a single non-triggering review per run, so advice can't blast
one-by-one after completion. `mid_pause` is opt-in early-warning on genuine
mid-run inactivity; a fluid run that never pauses fires nothing from it.

## Commands

| Command | Description |
|---|---|
| `/advisor` | Open the advisor model picker (fuzzy-searchable TUI) |
| `/advisor model <provider/id>` | Set the advisor model directly |
| `/advisor status` | Show configuration, backlog, and the last review result |
| `/advisor enable` / `disable` | Enable or disable reviews while keeping the selected model |
| `/advisor thinking <off\|minimal\|low\|medium\|high\|xhigh>` | Configure advisor reasoning effort |
| `/advisor interrupting [on\|off]` | Control whether all advice immediately triggers a main-agent turn |
| `/advisor sync <0-6>` | Pause the main loop when the advisor falls this many turns behind; `0` disables waiting |
| `/advisor context [chars\|Nk\|default]` | Inspect or set the advisor conversation budget |
| `/advisor rounds [0-12]` | Max advisor tool rounds per review (default `2`; each round is an extra LLM call — lower = cheaper) |
| `/advisor turns [1-50\|every]` | Review every N turns instead of every turn (default `1`); skipped turns coalesce, and a finished run always flushes its final review |
| `/advisor pause [4000\|4s]` | mid_pause quiet period before the once-per-run early-warning review (500ms–60s, default `4s`) |
| `/advisor cache [short\|long\|none]` | Prompt-cache retention: `short` = 5m TTL (default), `long` = 1h for sparse cadences, `none` = disable markers + session affinity |
| `/advisor triggers [name]` | Toggle review triggers (default: `turn_end`, `tool_error`) |
| `/advisor instructions [show\|set <text>\|edit\|clear]` | Manage project-scoped advisor guidance |
| `/advisor instructions global [show\|set <text>\|edit\|clear]` | Manage global (cross-repo) advisor guidance |
| `/advisor instructions mode <project\|global\|none>` | Pick which instruction source is active (default: `project`) |
| `/advisor review` | Re-review the latest completed turn now |
| `/advisor help` | Show command help |

## Advice delivery

| Severity | Intended use | Delivery when `interrupting` is off |
|---|---|---|
| `nit` | Cleanup, simplification, or low-risk opportunity | Non-interrupting; available at the next step boundary |
| `concern` | Material risk, missed constraint, or fragile direction | Interrupting steer |
| `blocker` | Continuing is clearly unsound or wasteful | Interrupting steer |

`interrupting` defaults to `on`, so all severities trigger a turn immediately. Set `/advisor interrupting off` to make only `concern` and `blocker` interrupt.

Reviews run in the background by default. `/advisor sync 1` makes the main agent wait after every turn; values `2`–`6` allow a bounded backlog. The wait is abortable and occurs between turns, not during tool execution.

## Configuration

Global configuration is stored at:

```text
~/.pi/agent/extensions/pi-advisor.json
```

Example:

```json
{
  "enabled": true,
  "advisorModel": "anthropic/claude-sonnet-4-5",
  "thinking": false,
  "thinkingLevel": "medium",
  "contextChars": 24000,
  "turnInterval": 1,
  "maxToolRounds": 2,
  "maxRetries": 3,
  "interrupting": true,
  "syncLag": 0,
  "cacheRetention": "short"
}
```

| Field | Default | Description |
|---|---:|---|
| `enabled` | `true` | Master review switch |
| `advisorModel` | `null` | Advisor model as `provider/id`; inactive until selected |
| `thinking` | `false` | Enable advisor reasoning when supported by the model |
| `thinkingLevel` | `"medium"` | Reasoning effort |
| `contextChars` | `24000` | Advisor conversation budget (append-only, cache-friendly; oldest half dropped at once when exceeded) |
| `turnInterval` | `1` | Review every N completed turns instead of every turn (work-cadence throttle — self-adjusts to slow vs rapid pacing); skipped turns coalesce; a finished run always flushes its final review; also `/advisor turns` |
| `maxToolRounds` | `2` | Maximum read-only exploration rounds per review; each round is an extra LLM call — the main per-review cost lever; hard-capped at 12 |
| `maxRetries` | `3` | Consecutive failures before the backlog is dropped |
| `interrupting` | `true` | Whether every advisory immediately triggers a turn |
| `syncLag` | `0` | Backlog threshold before the main agent waits; `0` never waits |
| `midPauseMs` | `4000` | Quiet period (agent inactivity) before the once-per-run `mid_pause` early-warning review fires (500–60000; also `/advisor pause`) |
| `cacheRetention` | `"short"` | Prompt-cache TTL preference forwarded to pi-ai: `"short"` (Anthropic 5m, default), `"long"` (1h where supported — for sparse review cadences), `"none"` (disable cache markers + session affinity). Unset also honors pi-ai's `PI_CACHE_RETENTION` env. Also `/advisor cache` |
| `systemPrompt` | built in | Optional full advisor system-prompt override |

The global config path follows pi's `getAgentDir()` and therefore respects `PI_CODING_AGENT_DIR`.

## How it works

```text
user prompt + completed main-agent turn
                 │
                 ▼
   staged per-turn deltas (bounded)
                 │
                 ▼
 persistent advisor conversation  ←—— append-only prefix, re-sent verbatim
   + one new "Session update" msg     (provider prompt-cache hits)
                 │
                 ▼
 advisor model + read/grep/find/advise
                 │
          silence or one note
                 │
                 ▼
      pi.sendMessage(<advisory>)
```

Implementation overview:

- `advisor.ts` — pi lifecycle hooks and `/advisor` commands
- `src/runtime.ts` — staged deltas + persistent advisor conversation, user-prompt capture, queue, retries, resets, dedupe, and delivery
- `src/transcript.ts` — serialization of user, assistant, and tool-result messages
- `src/agent.ts` — second-model `completeSimple` tool loop (history prefix + `appended` result)
- `src/tools.ts` — project-confined read-only tools and `advise`
- `src/project-instructions.ts` — trusted project `.pi/advisor.md` persistence
- `src/index.ts` — configuration, context parsing, and advisory formatting

The queue is single-flight, so advisor reviews never overlap. Epoch guards discard stale in-flight advice after session rewrites. Repeated notes are suppressed with a recent-advice ring and normalized delivery-time dedupe.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Model is not found | Run `/advisor` and select from the live available-model list |
| No API key | Configure the provider through pi (`/login` or its environment variable) |
| Advisor says nothing | Silence is expected when work is on track; inspect `/advisor status` or try a stronger model |
| Reviews are expensive or slow | Lower context with `/advisor context 12k`, disable thinking, set `/advisor rounds 1`, or thin cadence with `/advisor turns 3` |
| Advisor misses earlier requirements | Increase context with `/advisor context 50k`; only post-start/reload prompts are accumulated |
| Repeated review failures | Fix provider/rate-limit issues or choose another model; the backlog drops after three failures by default |
| Project instruction is ignored | Ensure the project is trusted and check `/advisor instructions show` |
| Read tool rejects a path | Advisor filesystem access is intentionally confined to the project root |

## Development

Validated against `@earendil-works/pi-*` **0.84.4** (latest; handles the pi 0.84.0 breaking change where `ModelRegistry.getApiKeyAndHeaders()` returns `ProviderHeaders` with `null` header-deletion markers plus credential-resolved `baseUrl`/`env`, all forwarded to the advisor's pi-ai stream unchanged).

```bash
npm install
npm run typecheck
npm test
```

The test suite uses fake completions and requires no API key.

## Uninstall

```bash
pi uninstall npm:@hazrid1993/pi-advisor
```

Optionally remove global configuration:

```bash
rm ~/.pi/agent/extensions/pi-advisor.json
```

Project-specific `.pi/advisor.md` files are not removed automatically.

## Acknowledgements

The advisor concept, system prompt, severity ladder, advisory framing, and core runtime discipline are adapted from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). This project ports that behavior to stock pi's public extension API.

## License

MIT
