# Next-Step Hints — Step 4 of 6: Hint Card, "I'll Do It" Checklist, Feedback, Telemetry

<!-- doc-covers: apps/screenpipe-app-tauri/app/notification-panel, apps/screenpipe-app-tauri/components/next-step-hint-card.tsx, apps/screenpipe-app-tauri/lib/next-step-hint.ts, apps/screenpipe-app-tauri/lib/dev, apps/screenpipe-app-tauri/lib/notifications/actions.ts, apps/screenpipe-app-tauri/src-tauri/src/notifications, apps/screenpipe-app-tauri/src-tauri/src/commands.rs, apps/screenpipe-app-tauri/src-tauri/src/next_step, crates/screenpipe-engine/src/next_step, crates/screenpipe-engine/Cargo.toml -->
<!-- doc-verified: 5ce7edfcd -->

> **Status:** implemented on branch `feat/next-step-hints-step-1`, on top of
> steps 1–3. Read **As built** below first: it records where the code differs
> from the plan and why. **The native focus check below has not been done;
> do not ship until it has.**

## As built

| Plan | As built | Why |
| --- | --- | --- |
| Register the command in `main.rs` and `specta_bindings.rs` | Nothing registered by hand; `lib/utils/tauri.ts` regenerated | `tauri_helper` scans every `#[tauri::command] #[specta::specta]` at build time, and the `screenpipe-tauri` skill forbids editing those lists |
| `NextStepHintView` defined in `src-tauri/src/next_step/` | `screenpipe_engine::next_step::view::NextStepHintView`, mirrored in `lib/next-step-hint.ts` | Pure, so CI tests it; the test pins the camelCase wire keys the TypeScript mirror relies on |
| View fields `{ hintId, title, how, sourceLine, frameId, automatable, risk, effect }` | Adds `appName`, `confidenceBucket`, `latencyMs` | The header shows the app; `shown` telemetry needs the bucket and latency. Both are content-free |
| `HintOutcome` in the engine, used as a command argument | The engine gains an optional `specta` feature, enabled by the app | A command argument must derive `specta::Type`. Same pattern as `screenpipe-config` and `screenpipe-connect` |
| `send_next_step_hint` | Async and confirmed, like step 3's send | Step 3 counts a hint as shown only after the panel confirms delivery |
| Panel safety timeout unchanged | For hint payloads it is 10 min instead of `autoDismissMs + 5 s`, and every safety timeout now checks a delivery counter | Otherwise the panel force-hid a checklist after ~50 s. The counter stops a hint's 10 min timer (or any older timer) from hiding a newer notification |
| Hover pauses the panel's existing timer | The page turns its own timer off for hint payloads; the card owns both timers (45 s card, paused on hover or while the menu is open; 10 min checklist) | One owner per timer. The card also sends `timeout` feedback, which the page timer could not |
| `apply_outcome` sets snoozes | `Snooze1h` snoozes every hint for 60 min. `NeverInApp` returns `true` **and** snoozes that app for the session | A failed settings save still keeps the app quiet. Other outcomes change nothing |
| × sends `dismissed` | Only in card mode. In checklist mode × just closes | The outcome was already `manual` |
| Source line opens the frame | Opens `screenpipe://frame/<id>` and closes the card | Same as the panel's existing "open source" behaviour |
| Card size | The usual 340 × 380 webview panel; the card fits its content (max the panel height) and the how-list scrolls if it would not fit | No new window geometry to regression-test |
| — | How-line numbers are drawn, not CSS list markers; `source_line` uses a no-break space before `min` | Markers clipped inside the scroll box; `4 min` wrapped apart in the 340 px card |
| Mock scenario | `bun run dev:web`, then open `/notification-panel?mockNotification=next-step-hint`. `next_step_feedback` and `hide_notification_panel` are no-ops in the mock | Fictional fixture in `lib/dev/next-step-hint-fixture.ts` |

Closing the card when the user switches task is deferred, as planned. Say so
in the PR.

## Goal

Replace the plain notification layout with the dedicated hint card. Add the
**I'll do it** button, which collapses the card into a checklist. Add the
overflow menu (Snooze 1 h, Never in this app, Not useful) and content-free
telemetry. **Do it for me** comes in step 5. Until then that button slot shows
**Open in chat**: the step is pre-filled in chat and not sent.

## Card spec

```text
┌──────────────────────────────────────────┐
│ [icon] Next step · Code            ···  × │
│ Add STRIPE_KEY to .env.local              │   title, 15/600
│ 1. Open .env.local in the project root    │   how lines, 13
│ 2. Add STRIPE_KEY=sk_test_…               │
│ 3. Restart bun dev                        │
│ Based on Code · checkout.ts · last 4 min  │   11.5 quiet; click opens screenpipe://frame/<id>
│ [ Open in chat ]  [ I'll do it ]          │   step 5 replaces the first with Do it for me
└──────────────────────────────────────────┘

Checklist mode:
┌──────────────────────────────────────────┐
│ Add STRIPE_KEY to .env.local            × │
│ [x] Open .env.local in the project root   │
│ [ ] Add STRIPE_KEY=sk_test_…              │
│ [ ] Restart bun dev                       │
│ Closes when all are ticked                │
└──────────────────────────────────────────┘
```

- Follow `docs/DESIGN.md`: sentence case, no emoji, no exclamation marks,
  1px borders, existing tokens. Use phosphor accent only while the agent
  executes (step 5).
- Behaviour:
  - Auto-dismiss after 45 s without hover or interaction. Hovering pauses the
    timer; the panel already has `hoveredRef`.
  - In checklist mode, auto-dismiss is off. The checklist closes when all
    lines are ticked, on ×, after 10 min, or when a newer hint replaces it.
  - Closing on task switch is deferred. Document this in the PR.

## Facts this design relies on (verified at 5ce7edfcd)

- `deliver_notification_panel` (`commands.rs:4144`) sends `meeting_join`
  notifications to the **webview** panel on every platform. It skips the
  SwiftUI panel (`!meeting_join && native_notification::is_available()`) and
  the Windows Win32 pill. Hints follow the same rule, so the card has **one
  React implementation**.
- The panel page is `app/notification-panel/page.tsx`. Its special layout for
  meeting joins is at about line 453, rendered by
  `components/meeting-join-notification.tsx`.
- `/notify` builds `panel_payload` from explicit fields in
  `notifications/routes.rs` (~line 414). A new field has to be added there to
  reach the panel.
- Typed actions are dispatched in `lib/notifications/actions.ts`.
  `type: "chat"` with `auto_send: false` pre-fills chat without sending.
- `posthog.capture` is already used in the panel page for
  `notification_action`.

## Changes

### 1. Payload: carry a structured hint

- In `notifications/routes.rs`, add
  `#[serde(default)] pub hint: Option<serde_json::Value>` to the notify payload
  struct and forward it as `"hint"` in `panel_payload`.
- Add a predicate `notification_is_next_step_hint(&payload)` next to
  `notification_is_meeting_join` in `commands.rs`. Use it to route these
  notifications to the webview panel in both the native-macOS and Windows-pill
  checks.
- In `notifications/client.rs`, add
  `send_next_step_hint(view: &NextStepHintView, title, body)`. It posts
  `type: "next_step_hint"`, `autoDismissMs: 45000`, `transient: true`, and
  `hint: view`. Keep the plain `body` so the inbox entry stays readable.
- `NextStepHintView` (camelCase, defined in `src-tauri/src/next_step/` and
  mirrored in TS):
  `{ hintId, title, how: string[], sourceLine, frameId, automatable, risk, effect }`.
- Step 3's `mod.rs` switches from `send_typed_with_actions_and_priority` to
  `send_next_step_hint`.

### 2. Card component: `components/next-step-hint-card.tsx` (new)

- Props:
  `{ view: NextStepHintView, onAction, onDismiss, onMouseEnter, onMouseLeave }`.
  Render it in `page.tsx` when `payload.type === "next_step_hint" && payload.hint`,
  next to the meeting-join branch.
- Two modes, kept in local state: `card` and `checklist`.
- Buttons:
  - **Open in chat** dispatches the existing `chat` action with
    `prompt = "Help me with this next step: <title>\n<how lines>"` and
    `auto_send: false`.
  - **I'll do it** calls `commands.nextStepFeedback(hintId, "manual")` and
    switches to checklist mode.
- The overflow menu (`···`) has three items: Snooze 1 h, Never in this app,
  Not useful. Each calls `nextStepFeedback` with that outcome, then closes the
  card.
- The source line opens `screenpipe://frame/<frameId>` through
  `routeNotificationDeeplink`.
- × or timeout calls `nextStepFeedback(hintId, "dismissed" | "timeout")`.

### 3. Feedback command and ledger

- Engine (pure, `next_step/gate.rs`):
  - Add `HintLedger::snooze_all(until_ms)` and a `Snoozed` skip reason.
  - Add `pub enum HintOutcome { Manual, Auto, Dismissed, Timeout, Snooze1h, NeverInApp, NotUseful }`.
  - Add `pub fn apply_outcome(ledger, outcome, app, now_ms)`. It sets snoozes
    and returns whether `blocked_apps` must gain the app.
- App:
  - Add `src-tauri/src/next_step/commands.rs` with
    `#[tauri::command] #[specta::specta] next_step_feedback(app, hint_id: String, outcome: HintOutcome) -> Result<(), String>`.
  - It looks up the hint in the registry; an unknown or expired id is an
    error. It calls `apply_outcome`, and for `NeverInApp` it appends the app to
    `nextStepHints.blockedApps` in the settings store and saves.
  - Register the command in `main.rs` and `specta_bindings.rs`. Regenerate
    `lib/utils/tauri.ts` exactly as the `screenpipe-tauri` skill says.

### 4. Telemetry (content-free)

In the card, call `posthog.capture("next_step_hint", { event, latency_ms?, confidence_bucket?, risk?, automatable? })`
with `event` ∈ `shown | manual | open_chat | dismissed | timeout | snooze_1h | never_in_app | not_useful | checklist_done`.

- `confidence_bucket` is one of `0.6-0.7`, `0.7-0.8`, `0.8-0.9`, `0.9-1.0`.
- **Never send** titles, how-lines, app or window names, URLs, or ids that can
  be joined to content.
- Respect the existing analytics opt-out path that `notification_action`
  uses.

## Out of scope

Executing anything (step 5), the settings UI (step 6), and the SwiftUI and
Win32 layouts (the routing above makes them unnecessary).

## Tests and local verification

```bash
cargo test -p screenpipe-engine next_step
cd apps/screenpipe-app-tauri && bun run test            # Vitest
cd apps/screenpipe-app-tauri && bun run test:tauri next_step
cd apps/screenpipe-app-tauri && bun run dev:web         # browser-mock loop for screenshots
```

Vitest, in a new `components/__tests__/next-step-hint-card.test.tsx`:

- [x] Renders title, 1–4 how-lines, and the source line; caps at 4 lines.
- [x] I'll do it calls `nextStepFeedback(…, "manual")` and shows the checklist; ticking all lines closes it and sends `checklist_done`.
- [x] Each overflow item sends its outcome and closes the card.
- [x] Open in chat dispatches a `chat` action with `auto_send: false`.
- [x] The timeout fires at 45 s, hovering pauses it, and checklist mode disables it (and closes after 10 min).
- [x] No telemetry property contains the title or how text (assert on the captured objects). Also no app name, source line, effect or hint id.
- [x] `page.tsx` renders the hint card for `type: "next_step_hint"` and the old layout for everything else (in `app/notification-panel/page.test.tsx`, with a test that the page leaves timing to the card).

Rust:

- [x] `apply_outcome` table test: `Snooze1h` blocks every hint for 60 min; `NeverInApp` reports the app.
- [x] `notification_is_next_step_hint` routing test next to the existing meeting-join test, plus the hint safety-timeout length.
- [x] `NextStepHintView` wire keys; `HintOutcome` wire names match the card.

Browser mock:

- [x] Add a fictional `next_step_hint` notification to the mock scenario.
- [x] Capture screenshots of card mode and checklist mode in light and dark themes (headless Chrome over the mock loop; attach them to the PR).

Native check (window management, see `docs/TESTING.md`), on macOS and Windows:

- [ ] The webview panel showing a hint **does not take keyboard focus** from the app the user was typing in. Type into a text editor while the card appears; no keystrokes may be lost. If focus is stolen, stop and report it; do not ship.

## Done when

- [ ] All tests above pass. CI is green.
- [ ] The PR body has before/after screenshots and the focus check result for each OS.
