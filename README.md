<div align="center">

# 🧭 pi-advisor

**A second model that reviews your main [pi](https://github.com/earendil-works/pi-coding-agent) agent and injects concise, actionable advice.**

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![pi 0.80+](https://img.shields.io/badge/pi-%3E%3D0.80-8A2BE2)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

## What it does

Coding agents can develop tunnel vision. `pi-advisor` runs a second model after each main-agent turn to catch concrete mistakes, missed constraints, fragile designs, and likely wasted work.

The advisor:

- sees recent **user prompts**, assistant messages, tool calls, and tool results;
- can inspect the project with isolated read-only `read`, `grep`, and `find` tools;
- stays silent when the main agent is on track;
- can send one `nit`, `concern`, or `blocker` advisory;
- cannot edit files, execute commands, or change session state.

Advice is framed as guidance for the main agent to weigh—not blindly obey.

## Install and update

### Install

Install the published npm package:

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
pi update
```

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

The limit is character-based, not message-count-based. Oldest complete transcript items are removed first, so the number of retained turns depends on message and tool-output size. A single item is never cut in half and may temporarily exceed the configured budget.

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

The rolling transcript resets on session replacement, reload, compaction, tree navigation, and advisor configuration changes. Existing history is marked as seen rather than replayed; the advisor resumes with newly submitted prompts and turns.

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
| `/advisor context [chars\|Nk\|default]` | Inspect or set the rolling transcript budget |
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
  "cooldownMs": 0,
  "maxToolRounds": 6,
  "maxRetries": 3,
  "interrupting": true,
  "syncLag": 0
}
```

| Field | Default | Description |
|---|---:|---|
| `enabled` | `true` | Master review switch |
| `advisorModel` | `null` | Advisor model as `provider/id`; inactive until selected |
| `thinking` | `false` | Enable advisor reasoning when supported by the model |
| `thinkingLevel` | `"medium"` | Reasoning effort |
| `contextChars` | `24000` | Rolling user/assistant/tool transcript budget |
| `cooldownMs` | `0` | Minimum delay between reviews; `0` reviews every completed turn |
| `maxToolRounds` | `6` | Maximum read-only exploration rounds; hard-capped at 12 |
| `maxRetries` | `3` | Consecutive failures before the backlog is dropped |
| `interrupting` | `true` | Whether every advisory immediately triggers a turn |
| `syncLag` | `0` | Backlog threshold before the main agent waits; `0` never waits |
| `systemPrompt` | built in | Optional full advisor system-prompt override |

The global config path follows pi's `getAgentDir()` and therefore respects `PI_CODING_AGENT_DIR`.

## How it works

```text
user prompt + completed main-agent turn
                 │
                 ▼
       bounded rolling transcript
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
- `src/runtime.ts` — rolling transcript, user-prompt capture, queue, retries, resets, dedupe, and delivery
- `src/transcript.ts` — serialization of user, assistant, and tool-result messages
- `src/agent.ts` — second-model `completeSimple` tool loop
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
| Reviews are expensive or slow | Lower context with `/advisor context 12k`, disable thinking, or set a cooldown in the config |
| Advisor misses earlier requirements | Increase context with `/advisor context 50k`; only post-start/reload prompts are accumulated |
| Repeated review failures | Fix provider/rate-limit issues or choose another model; the backlog drops after three failures by default |
| Project instruction is ignored | Ensure the project is trusted and check `/advisor instructions show` |
| Read tool rejects a path | Advisor filesystem access is intentionally confined to the project root |

## Development

Validated against `@earendil-works/pi-*` **0.83.0**.

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