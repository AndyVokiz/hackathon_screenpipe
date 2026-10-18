# hack-screenpipe: next-step hints

When you get stuck partway through a task, screenpipe suggests the next step.

Say you stop for a moment while filling in a form, fixing a failing test or
setting something up. A small card appears in the corner of the screen. It
names the likely next step, gives up to four short lines on how to do it, and
offers two buttons:

- **I'll do it** turns the card into a checklist you tick off.
- **Do it for me** has screenpipe's agent do that one step. Anything that
  sends, posts, pays, deletes or pushes asks you first.

This repository is a fork of [screenpipe](https://github.com/screenpipe/screenpipe),
which records your screen and audio locally and indexes them for AI. Hints
reuse what screenpipe already captures (accessibility text, OCR and input
events), so there is no new capture source. The feature is **off by default**.

> The feature is on the `feat/next-step-hints-step-1` branch. `main` is
> unchanged upstream screenpipe.

## What it does

### When a hint appears

A card appears only when all of the following are true. The values shown are
the defaults.

- You stopped typing and clicking for **20 s** (configurable: 10, 20 or 40 s).
  Before that, you spent at least 60 s in the same app with at least 10 inputs.
- You were not scrolling in the 10 s before the pause. Scrolling then stopping
  usually means reading.
- You have been idle for less than 3 min. Beyond that you have left the
  computer.
- None of these is true: you are in a meeting, DRM video is playing,
  screenpipe itself is in front, or recording is paused by a schedule.
- The app in front is not blocked. The default list is 1Password, Bitwarden,
  KeePassXC, Keychain Access, System Settings / Preferences, Settings and
  Credential Manager.
- Notifications are not snoozed and you are not in quiet hours.
- There has been no hint in the last **5 min** (configurable: 2, 5, 15 or
  30 min), and this screen has not produced a hint in the last 30 min.

The model can still decide there is nothing worth suggesting. Replies that fail
validation never become a card: not valid JSON, a title over 80 characters,
low confidence, or a file name or value that is not on screen.

### The card

- **Title**: the step, for example "Add `STRIPE_KEY` to `.env.local`".
- **How**: one to four short lines, one action each.
- **Source line**: what the hint is based on, for example
  "Code · checkout.ts · last 4 min". Clicking it opens that moment in the
  screenpipe timeline.
- **Menu**: Snooze 1 h, Never in this app, Not useful.
- The card closes after 45 s if you don't touch it; hovering pauses the timer.
  A checklist stays open for up to 10 min.
- The card is built not to take keyboard focus, so you can keep typing while
  it is open. This hasn't been checked on a real machine yet; see Status.

### "Do it for me"

- Runs one step in a background agent session. Only one step runs at a time,
  for at most 3 min, and **Stop** is always visible.
- The agent's instructions are rebuilt from the hint you saw. They are never
  taken from the UI, and screen text is passed to the model as data, not as
  instructions.
- A permission guard lets read-only tools run without asking: file reads and
  search, a short allowlist of read-only shell commands, and screenpipe search.
  Every other tool call asks on the card with **Allow once** or **Deny**. If the
  guard fails to load, the run is refused.
- The card shows **Open in chat** instead when the step can't be automated,
  when "Allow Do it for me" is off, or when your default AI preset is a coding
  agent. The guard can't apply to coding agents.

### Privacy

- Off by default. Before you turn it on, the setting names the provider that
  will receive screen excerpts.
- With a local Ollama model, nothing leaves your machine. Any other provider
  receives excerpts with personal data such as emails and card numbers removed.
- The context never contains what you typed. It records only that typing,
  clicks, app or window switches, or copy/paste happened, never the contents.
- Blocked apps are also left out of the recent-window trail and recent actions.
- Log lines never contain window titles or screen text.

## How it works

```
you pause
   │
   ▼
stall detector ─ engine, checks input timestamps once per second
   │
   ▼
gate ─ meeting? blocked app? too soon? snoozed? same screen as before?
   │
   ▼
context bundle ─ focused window text, last 10 min of windows, recent actions
   │             (personal data removed unless the model is local)
   ▼
one LLM call ─ strict JSON, validated, dropped if anything is off
   │
   ▼
hint card ──▶ I'll do it   → checklist
          └─▶ Do it for me → agent run behind the permission guard
```

The engine only detects the pause. The desktop app makes every decision after
that, and the agent runs only after you click. On the recording path, the only
work added is a few relaxed atomic stores per input event: no allocation, no
lock and no database write. A slow or failing AI provider never delays
recording.

## How to run it

Get the branch first:

```bash
git clone -b feat/next-step-hints-step-1 https://github.com/AndyVokiz/hack-screenpipe.git
cd hack-screenpipe
```

### 1. See the UI in a browser (no native build)

You need [bun](https://bun.sh). This starts only the Next.js frontend, with
in-memory mocks and fictional data, and calls no AI provider.

```bash
cd apps/screenpipe-app-tauri
bun install
bun run dev:web
```

Then open:

| Page | URL |
| --- | --- |
| Hint card | <http://127.0.0.1:1420/notification-panel?mockNotification=next-step-hint> |
| Settings (scroll to "Next-step hints") | <http://127.0.0.1:1420/settings?section=notifications> |
| Settings, with input capture missing | <http://127.0.0.1:1420/settings?section=notifications&mockNextStepInput=missing> |

### 2. Run the real app (macOS)

Install the prerequisites from [CONTRIBUTING.md](CONTRIBUTING.md#macos). You
need Rust, a full Xcode install (the command line tools alone aren't enough),
`brew install pkg-config ffmpeg jq cmake wget git-lfs`, and bun. If
[sccache](https://github.com/mozilla/sccache) is installed, rebuilds are
faster.

```bash
cd apps/screenpipe-app-tauri
bun install
bun run dev:tauri
```

The first build compiles the whole Rust app and takes a while. Then:

1. Finish onboarding and grant the **screen recording** and **accessibility**
   permissions. Hints need accessibility because input events come from it.
2. In **Settings → AI**, choose a default model. A local Ollama model keeps
   everything on your machine.
3. In **Settings → Notifications**, turn on **Next-step hints**. The line under
   the switch names where excerpts will be sent. Turning it on or off does not
   restart recording.
4. Work in one app for a minute (type and click), then stop for 20 s.

To see what the feature is doing, watch the app log:

```bash
tail -f ~/.screenpipe/screenpipe-app.*.log | grep 'next_step:'
```

| Log line | Meaning |
| --- | --- |
| `stall detector started` / `stopped by settings` | The feature was turned on or off |
| `stall fired` | The detector saw a pause |
| `skipped … reason=TooSoon` (or `BlockedApp`, `Snoozed`, `NotificationsSuppressed`, …) | The gate said no |
| `dropped` | The model's reply failed validation |
| `shown` | A card was displayed |
| `run ended … status=…` | A "Do it for me" run finished, failed or was stopped |

To see exactly what the model receives, start the app with
`SCREENPIPE_NEXT_STEP_DUMP=1 bun run dev:tauri`. Each time, the latest context
bundle is written to `~/.screenpipe/next_step/last_bundle.txt`. This works in
debug builds only, and the file is unredacted.

Windows and Linux builds are described in [CONTRIBUTING.md](CONTRIBUTING.md).
Hints have not been checked on those platforms yet.

### 3. Tests

From the repository root:

```bash
cargo test -p screenpipe-engine next_step     # detector, gate, context, validation, routing, run watcher
cargo test -p screenpipe-config next_step     # settings defaults and clamping
bun test evals/next-step-hints/validate.test.ts                            # eval validator, no model
bun test crates/screenpipe-core/assets/extensions/next-step-guard.test.ts  # permission guard

cd apps/screenpipe-app-tauri
bun run test:vitest components/__tests__/next-step-hint-card.test.tsx \
  components/settings/__tests__/next-step-hints-settings.test.tsx
bun run test:tauri next_step                  # native app tests; compiles the app
```

### 4. Suggestion-quality eval

The eval has 40 fictional fixtures: 25 where the user is stuck, 10 where they
are not, and 5 with instructions planted in screen text. It sends each one to
a real model with the production prompt.

```bash
# Local model through Ollama
NEXT_STEP_EVAL_BASE_URL=http://localhost:11434/v1 \
NEXT_STEP_EVAL_MODEL=<model> \
  bun test evals/next-step-hints/

# Any OpenAI-compatible endpoint
NEXT_STEP_EVAL_BASE_URL=<base url ending in /v1> \
NEXT_STEP_EVAL_MODEL=<model> \
NEXT_STEP_EVAL_API_KEY=<key> \
  bun test evals/next-step-hints/
```

Pass bars:

| Fixture group | Bar |
| --- | --- |
| Stuck: the judge says the step is correct | ≥ 70% |
| Not stuck: no card shown | ≥ 80% |
| Planted instructions, plus the deterministic checks on every fixture | 100% |

[evals/next-step-hints/README.md](evals/next-step-hints/README.md) has the
details.

## Status

Built: steps 1 to 6a of the plan in
[docs/NEXT_STEP_HINTS_SPEC.md](docs/NEXT_STEP_HINTS_SPEC.md). That covers the
stall detector, the gate and context bundle, the hint engine and its eval, the
card with the checklist and feedback, "Do it for me" with the permission guard,
and the settings UI with a live on/off switch.

Not done yet:

- The quality eval has not been run against a real model.
- No real "Do it for me" run has been observed end to end.
- Native checks: that the card never takes keyboard focus on macOS and
  Windows, and that the switch turns hints on and off while recording continues.
- A 30-minute measurement of recording CPU, dropped frames and database write
  latency, with the feature on and off.
- Tuning the defaults from a week of internal use (step 6b).

## Where the code is

| Path | What it contains |
| --- | --- |
| [crates/screenpipe-engine/src/next_step/](crates/screenpipe-engine/src/next_step/) | Stall detector, gate, context bundle, hint parsing and validation, provider routing, hint registry, run watcher, system prompt |
| [crates/screenpipe-engine/src/ui_recorder.rs](crates/screenpipe-engine/src/ui_recorder.rs) | Input clock: atomic timestamps for the last input |
| [crates/screenpipe-config/src/recording.rs](crates/screenpipe-config/src/recording.rs) | `NextStepHintsSettings` and its defaults |
| [apps/screenpipe-app-tauri/src-tauri/src/next_step/](apps/screenpipe-app-tauri/src-tauri/src/next_step/) | App glue: local API reads, the LLM call, Tauri commands, the executor |
| [apps/screenpipe-app-tauri/src-tauri/src/capture_session.rs](apps/screenpipe-app-tauri/src-tauri/src/capture_session.rs) | Starts and stops the detector alongside recording |
| [apps/screenpipe-app-tauri/components/next-step-hint-card.tsx](apps/screenpipe-app-tauri/components/next-step-hint-card.tsx) | The card |
| [apps/screenpipe-app-tauri/components/settings/next-step-hints-settings.tsx](apps/screenpipe-app-tauri/components/settings/next-step-hints-settings.tsx) | The settings block |
| [crates/screenpipe-core/assets/extensions/next-step-guard.ts](crates/screenpipe-core/assets/extensions/next-step-guard.ts) | Permission guard for "Do it for me" |
| [evals/next-step-hints/](evals/next-step-hints/) | Quality eval and fixtures |
| [docs/NEXT_STEP_HINTS_SPEC.md](docs/NEXT_STEP_HINTS_SPEC.md) and `_STEP_1` to `_STEP_6` | Design overview and per-step specs. Each step spec opens with an "As built" table recording where the code differs from the plan |

## License

The code is screenpipe's and is covered by the Screenpipe Commercial License
in [LICENSE.md](LICENSE.md). Personal, non-commercial, educational and research
use is free, as is evaluation for up to 7 days. Commercial use needs a license
from screenpipe.
