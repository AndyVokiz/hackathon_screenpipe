# Next-Step Hints — Step 6 of 6: Settings UI, Live Toggle, Dogfood Tuning, Regression Docs

<!-- doc-covers: apps/screenpipe-app-tauri/components/settings/notifications-settings.tsx, apps/screenpipe-app-tauri/components/settings/next-step-hints-settings.tsx, apps/screenpipe-app-tauri/components/settings/notification-registry.ts, apps/screenpipe-app-tauri/src-tauri/src/capture_session.rs, apps/screenpipe-app-tauri/src-tauri/src/next_step, crates/screenpipe-engine/src/next_step, apps/screenpipe-app-tauri/lib/dev, docs/TESTING.md -->
<!-- doc-verified: 5ce7edfcd -->

> **Status:** 6a and the `docs/TESTING.md` section are implemented on branch
> `feat/next-step-hints-step-1`, on top of steps 1–5. Read **As built** below
> first. **Not done:** maintainer sign-off, the native toggle check and the
> 30-minute hot-path measurement (both need a dev build), and all of 6b, which
> needs a week of dogfood.
> **Before 6a: get maintainer sign-off.** `docs/VISION.md` says every feature
> must serve Record, Rewind, or Ask, and warns against feature creep. This
> feature fits "context layer for agents … trigger without prompts". Record the
> decision in the PR.

## As built

| Plan | As built | Why |
| --- | --- | --- |
| Registry entry like the others | `nextStepHints` has `optIn: true`. Its switch writes `nextStepHints.enabled`, not `notificationPrefs`. Presets, group toggles and reset skip it, and it has no `notificationPrefs` key (`BULK_CATEGORIES`, `bulkCategoriesForGroup`) | A preset or group toggle would otherwise turn on a feature that sends screen excerpts, without the user seeing the disclosure |
| Label "next-step hints" | "Next-step hints", tagged Experimental | Every other label in the registry, and `docs/DESIGN.md`, use sentence case. Hints can appear when the user is not stuck |
| Call `set_next_step_enabled` "from the existing settings-change path" | There is no Rust-side settings-change path: the webview writes the store directly. The block calls the new command `next_step_apply_settings` after saving `enabled` or `pauseSeconds`, and it calls `CaptureSession::apply_next_step_settings` | The pause is read only when the detector starts, so a changed pause needs a restart, not just on/off. The decision is `next_step::detector_change` in the engine, where CI tests it |
| — | The session keeps the detector's inputs (frame cache, suppression check) whenever the UI recorder started, even with hints off | So the toggle can start the detector later. Built once per session; nothing per frame |
| Disclosure "using the same routing table as step 3" | The new command `next_step_settings_status` returns `route::recipient(..)`, which is built on `route_for`, so there is no TypeScript copy of the table. The provider is the url host, "OpenAI" for its default endpoint, or "screenpipe cloud" for the gateway (also for ChatGPT and coding-agent presets, which route there). With no usable model it says "Hints need an AI model. Choose a default one in AI settings." | The disclosure must name where hints are actually sent |
| Toggle disabled "if the UI recorder is not running" | Status `inputCapture` is `running`, `missing` or `recording_off`. The switch is disabled only for `missing` (recording on, no input events), and never when turning it off. On macOS the line links to Settings → Permissions | With recording paused the recorder is off, but turning hints on is fine: the detector starts with capture. The permissions section exists only on macOS |
| Blocked apps "pre-filled defaults" | The defaults come from `next_step_settings_status` (`NextStepHintsSettings::default()`) | One list, in Rust |
| All controls always visible | The disclosure (and the input line) always show; the other controls appear once hints are on | Progressive disclosure keeps the notifications list short |
| — | Status refreshes every 5 s while the section is open | Permissions and the default preset can change while Settings is open |
| — | Browser mock answers both commands; `?mockNextStepInput=missing` shows the blocked switch | Screenshots without a native build |

## Goal

Users can turn the feature on in Settings, see which AI provider receives
screen excerpts, and tune it. Turning it on or off takes effect without
restarting capture. Defaults are then tuned from content-free dogfood
telemetry, and the regression checklist gains the new window behaviour.

## Facts this design relies on (verified at 5ce7edfcd)

- `components/settings/notification-registry.ts` is the single source of truth
  for notification types. Its category ids persist under
  `settings.notificationPrefs[id]`, and it feeds the settings UI, the defaults,
  and settings search.
- `components/settings/notifications-settings.tsx` uses
  `useSettings()` / `updateSettings()`.
- The settings field is `nextStepHints`, flattened from `RecordingSettings` in
  step 1.
- Step 1's PR records whether a recording-settings change restarts the capture
  session. The live toggle below depends on that answer.

## 6a — Settings UI and live toggle

### 1. Registry entry

Add category `nextStepHints` to `notification-registry.ts` in the `automation`
group. Use lowercase house-style labels, for example "next-step hints", and add
search keywords: `hint`, `next step`, `stuck`, `suggestion`.

### 2. Settings block: `components/settings/next-step-hints-settings.tsx` (new)

Render it inside `notifications-settings.tsx` under the registry entry.

| Control | Setting | Values |
| --- | --- | --- |
| Toggle "Show next-step hints" | `nextStepHints.enabled` | default off |
| Pause before hint | `pauseSeconds` | 10 / 20 / 40 s |
| Minimum time between hints | `minIntervalMinutes` | 2 / 5 / 15 / 30 min |
| "Allow Do it for me" | `allowAutoExecute` | default on; caption: "Actions that send, post, pay, delete or push always ask first." |
| Blocked apps | `blockedApps` | editable list, pre-filled defaults, remove and add |

- **Provider disclosure.** It shows under the toggle and is visible before
  enabling. Base it on the default AI preset, using the same routing table as
  step 3:
  - local: "Hints are generated on this device with {model}."
  - other: "Screen excerpts from the current window are sent to {provider} to
    generate hints. Personal data like emails and card numbers is removed
    first."
- **Input capture requirement.** If the UI recorder is not running (no
  accessibility permission), the toggle is disabled with one line explaining
  why and a link to the existing permission flow.
- Follow `docs/DESIGN.md`: sentence case, no emoji, existing settings
  components.

### 3. Live toggle

- If step 1 found that settings changes already restart capture, do nothing
  and note it in the PR.
- Otherwise, add `CaptureSession::set_next_step_enabled(&mut self, settings)`
  in `capture_session.rs`. It aborts or starts the detector task using the
  handles kept in step 1. Call it from the existing settings-change path. The
  app glue already re-reads settings on every event, so gate changes such as
  intervals and blocked apps are live without this.

## 6b — Dogfood tuning (after at least 7 days with at least 5 internal users)

Inputs: the step 4/5 telemetry and the `next_step: shown|dropped|skipped`
reason counts. Users paste these counts from their own logs; logs are never
collected automatically. The counts are content-free:

```bash
grep -ho 'next_step: \(shown\|dropped\|skipped\) .*' ~/.screenpipe/screenpipe-app.*.log \
  | sed -E 's/^(next_step: [a-z]+)( id=[^ ]*)?( reason=[A-Za-z]+)?.*/\1\3/' | sort | uniq -c
```

| Metric | Target | If missed, change |
| --- | --- | --- |
| Accepted (manual + auto + checklist_done) / shown | ≥ 40% | raise `MIN_CONFIDENCE` (0.6 → 0.7), or require ≥ 1 stuck signal |
| Dismissed within 5 s / shown | ≤ 25% | raise default `pauseSeconds` (20 → 30) or `min_events` (10 → 20) |
| Shown per active hour, p90 | ≤ 4 | raise default `minIntervalMinutes` |
| `auto_failed` / `auto` | ≤ 20% | narrow which tools count as automatable in the prompt |
| LLM latency p90 | ≤ 4 s | use a smaller default cloud model |

- Change defaults only in `NextStepHintsSettings::default()` and the engine
  constants. Re-run the step 3 eval after any prompt or threshold change and
  put both result tables in the PR.
- Update this file with the final values and bump `doc-verified`.

## 4. Regression docs: `docs/TESTING.md`

Add a section "Next-step hints" with commit references, covering:

- The hint panel never takes keyboard focus (macOS, Windows).
- No hint during a meeting, DRM video, snooze, quiet hours, or in a blocked app.
- At most one hint per interval.
- Outward actions always prompt.
- Stop ends a run within 2 s.
- Turning the feature off stops the detector without restarting capture.

## Tests and local verification

```bash
cd apps/screenpipe-app-tauri && bun run test
cd apps/screenpipe-app-tauri && bun run test:tauri next_step capture_session
cargo test -p screenpipe-engine next_step
bun scripts/check-doc-freshness.ts --check
cd apps/screenpipe-app-tauri && bun run dev:web     # screenshots of the settings block
```

- [x] Vitest (`components/settings/__tests__/next-step-hints-settings.test.tsx`, 14 tests):
  - [x] the settings block renders defaults and writes each field
  - [x] the disclosure text matches the preset kind
  - [x] the toggle is disabled without input capture
  - [x] settings search finds "next step"
  - [x] presets and group toggles never turn hints on (also `notification-registry.test.ts`)
- [x] `cargo test -p screenpipe-engine next_step`: `detector_change` and `route::recipient` tests.
- [x] `bun run test:tauri next_step`: status wire shape and input-capture states. `capture_session.rs` has no tests; its change is covered by `detector_change` and the native check below.
- [ ] Native: toggling on and off starts and stops the detector with capture still recording (check that recording continues in the timeline).
- [ ] 30-minute hot-path measurement with the feature on and off: capture CPU, dropped frames, and DB write p95. Numbers go in the PR (AGENTS.md: a hot-path regression is a battery or data-loss bug).

## Done when (feature complete)

- [ ] 6a: the settings UI is merged with screenshots (light and dark) and maintainer sign-off.
- [ ] 6b: dogfood targets are met or the gaps are explained; defaults are tuned; the eval is re-run; this file is updated.
- [x] `docs/TESTING.md` has the new section (33, "Next-step hints"); replace its branch reference with the merge SHAs.
- [ ] The step 1–5 acceptance checks still pass on the release build.
