# Next-Step Hints — Step 1 of 6: Settings, Input Clock, Stall Detector

<!-- doc-covers: crates/screenpipe-config/src/recording.rs, crates/screenpipe-engine/src/recording_config.rs, crates/screenpipe-engine/src/ui_recorder.rs, crates/screenpipe-engine/src/hot_frame_cache.rs, crates/screenpipe-engine/src/next_step, apps/screenpipe-app-tauri/src-tauri/src/capture_session.rs -->
<!-- doc-verified: 5ce7edfcd -->

> **Status:** implemented on branch `feat/next-step-hints-step-1`. One PR.
> Everything ships behind `nextStepHints.enabled`, which defaults to `false`.
> Read **As built** below first: it records where the code differs from the
> plan and why.

## As built

| Plan | As built | Why |
| --- | --- | --- |
| Emit `next_step_stall` on the `screenpipe_events` bus | Private in-process channel: `screenpipe_engine::next_step::subscribe_stalls()` | The bus is mirrored to `/ws/events`, which would hand raw window titles to every local WebSocket client, bypassing PII redaction, and lets any client inject a fake stall |
| "No scroll in the last 10 s" | No scroll within 10 s **before the pause started** | When the pause is at least 10 s, the planned rule always passes. The real signal is "the user was scrolling, so reading, right before stopping" |
| Latest frame overall = focused window | Only frames with input triggers (`app_switch`, `window_focus`, `click`, `typing_pause`, `scroll_stop`, `key_press`, `clipboard`) count for focus, momentum and trail | `idle` and `visual_change` captures come from any monitor and would misreport focus |
| `get_frames_in_range` | New `HotFrameCache::get_hot_frames_in_range` | Keeps `capture_trigger`, skips the audio join, and clones are O(1) |
| Start when the UI recorder starts | Start only when the UI recorder runs **and** its input tap is up | In reduced mode only app and window events arrive, so pauses can't be measured |
| Suppress on meeting, DRM, schedule | Also suppress on a manually started meeting (`server.manual_meeting`) | A manual meeting is not reflected in the detector's flag |
| Mouse moves keep the user "present" | Moves are stamped when they arrive, but mouse-move capture is **off by default** (`capture_mouse_move: false`, high volume) | Presence therefore means deliberate input. Reading without scrolling can look like a pause; step 3's `show:false` and step 6 tuning handle that. Do not enable move capture for this feature |

**Does a settings change restart capture?** No. Recording settings are
applied through "Apply & restart" (`components/settings/apply-restart-bar.tsx`,
which calls `stopCapture`/`startCapture` in `recording-settings.tsx`), and
`build_config` re-reads the store on every `CaptureSession::start`. So
`nextStepHints.enabled` takes effect on the next capture start. Step 6 must
either route the toggle through that path or add a live toggle.

## The feature in one paragraph

When the user pauses mid-task, screenpipe shows a small card with the likely
next step, a few how-to lines, and two buttons: **Do it for me** (a screenpipe
agent runs the step) and **I'll do it** (the card collapses into a checklist).
The work is split into six steps; each one is a mergeable PR:

| Step | Delivers | Visible to user |
| --- | --- | --- |
| 1 | Settings, input clock, stall detector → `next_step_stall` event | No |
| 2 | Gate rules and bounded context bundle | No (debug log) |
| 3 | Hint engine (LLM + validation), first hint via existing notification panel, quality eval | Yes, read-only card |
| 4 | Dedicated card layout, "I'll do it" checklist, feedback, telemetry | Yes |
| 5 | "Do it for me" executor with a permission guard | Yes |
| 6 | Settings UI, live toggle, dogfood tuning, TESTING.md entries | Yes |

## Goal of this step

With the setting on, the engine emits exactly one `next_step_stall` event each
time the user stops typing and clicking after working in one app. No LLM call
and no UI yet.

## Facts this design relies on (verified at 5ce7edfcd)

- **Do not use `ActivityFeed` from the vision manager.**
  `vision_manager/manager.rs` (around line 643) creates a fresh
  `ActivityFeed::new()` per monitor. Nothing writes to it, so its idle values
  never change with user input.
- Every raw input event passes through the UI recorder loop in
  `crates/screenpipe-engine/src/ui_recorder.rs`: the `Some(event) =>` arm of
  `handle.recv_timeout(..)` (around line 900). This happens even when keyboard
  rows are not persisted, which is the consumer default
  (`disableKeyboardCapture = true`). Keyboard events still wake capture.
- `HotFrameCache::get_frames_in_range(start, end)` returns frames with
  `metadata.app_name`, `metadata.window_name`, and `metadata.browser_url`
  without touching SQLite. See `hot_frame_cache.rs:174` and
  `video_cache.rs:79`.
- Suppression signals already exist:
  - `screenpipe_engine::drm_detector::drm_content_paused()`
  - `screenpipe_engine::schedule_monitor::schedule_paused()`
  - `MeetingDetector::is_in_meeting()` via
    `server.audio_manager.meeting_detector().await` in `capture_session.rs`
  - `routes::search::is_screenpipe_app(app_name)`
- Event bus: `screenpipe_events::send_event(name, data)`. The app already
  subscribes in-process with `screenpipe_events::subscribe_to_event` (see
  `suggestions.rs:179`).
- Precedent for an engine feature flag: `enable_workflow_events` in
  `RecordingSettings` maps into `RecordingConfig` at `recording_config.rs`
  (~lines 159 and 319).

## Changes

### 1. Settings: `crates/screenpipe-config/src/recording.rs`

Add a settings struct and a field on `RecordingSettings`. Copy the derives and
`cfg_attr(feature = "specta", ...)` from neighbouring settings types.

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", default)]
pub struct NextStepHintsSettings {
    pub enabled: bool,              // false
    pub pause_seconds: u16,         // 20, clamped 10..=60
    pub min_interval_minutes: u16,  // 5, clamped 1..=120
    pub allow_auto_execute: bool,   // true (used in step 5)
    pub blocked_apps: Vec<String>,  // DEFAULT_BLOCKED_APPS
}

// on RecordingSettings:
#[serde(rename = "nextStepHints", default)]
pub next_step_hints: NextStepHintsSettings,
```

- `DEFAULT_BLOCKED_APPS`: `1Password`, `Bitwarden`, `KeePassXC`, `Keychain Access`,
  `System Settings`, `System Preferences`, `Settings`, `Credential Manager`.
- Add `pub fn pause_ms(&self) -> u64` and `pub fn min_interval_ms(&self) -> i64`
  that apply the clamps. Callers never read the raw fields.
- Tests:
  - JSON with no `nextStepHints` key loads the defaults.
  - A round trip keeps every field.
  - Out-of-range values clamp.

### 2. Engine config: `crates/screenpipe-engine/src/recording_config.rs`

Add `pub next_step_hints: NextStepHintsSettings` to `RecordingConfig` and map
it from settings next to `enable_workflow_events`.

### 3. Input clock: `crates/screenpipe-engine/src/ui_recorder.rs`

Add process-wide atomics, written once per raw input event at the top of the
`Some(event) =>` arm, before ignore filtering. The user is active even in an
ignored window.

```rust
static INPUT_LAST_MS: AtomicU64 = AtomicU64::new(0);     // any input incl. mouse move
static INPUT_LAST_KEY_MS: AtomicU64 = AtomicU64::new(0);
static INPUT_LAST_SCROLL_MS: AtomicU64 = AtomicU64::new(0);
static INPUT_EVENT_COUNT: AtomicU64 = AtomicU64::new(0); // deliberate actions only

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputClock { pub last_ms: u64, pub last_key_ms: u64, pub last_scroll_ms: u64, pub events: u64 }

pub fn input_clock() -> InputClock { /* four Relaxed loads */ }
fn stamp_input(kind: &screenpipe_db::UiEventType, now_ms: u64) { /* Relaxed stores */ }
```

- `Key` and `Text` stamp `last_ms` and `last_key_ms`, and increment `events`.
- `Click`, `Clipboard`, `AppSwitch`, and `WindowFocus` stamp `last_ms` and
  increment `events`.
- `Scroll` stamps `last_ms` and `last_scroll_ms`, and increments `events`.
- `Move` stamps `last_ms` only, so it does not count toward momentum.
- `Idle` and any other event type do nothing.
- Hot-path rule: the stamp is relaxed atomic stores plus one `SystemTime::now()`.
  There is no allocation and no lock. State this in the PR.
- Test: `stamp_input` updates the right fields for each event type.

### 4. Detector: `crates/screenpipe-engine/src/next_step/`

Create `mod.rs` and `stall_detector.rs`, and add `pub mod next_step;` to
`lib.rs`. Put `#![deny(clippy::string_slice)]` at the top of each new module
that handles window titles; `suggestions.rs` explains why.

**Event type** (in `mod.rs`, shared with later steps):

```rust
pub const STALL_EVENT: &str = "next_step_stall";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TrailEntry { pub app_name: String, pub window_name: String, pub secs: u32 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NextStepStall {
    pub stall_id: String,             // uuid v4
    pub at: DateTime<Utc>,
    pub idle_ms: u64,
    pub app_name: String,
    pub window_name: String,
    pub browser_url: Option<String>,
    pub frame_id: i64,                // latest frame overall = focused window
    pub active_secs_before: u32,      // contiguous time in app_name before the pause
    pub events_before_pause: u32,     // deliberate input events in the 60 s before the pause
    pub trail: Vec<TrailEntry>,       // last 10 min, newest first, max 15, consecutive dupes merged
    pub window_ping_pong: bool,       // >= 3 alternations between the same 2 windows in last 60 s
}
```

**Pure state machine** (no tokio, no clock reads, fully unit-tested):

```rust
pub struct StallParams { pub pause_ms: u64, pub away_ms: u64 /*180_000*/, pub scroll_quiet_ms: u64 /*10_000*/, pub min_events: u32 /*10*/ }
pub struct StallMachine { phase: Phase, samples: [u64; 128], head: usize, /* per-second INPUT_EVENT_COUNT samples */ }
pub enum StallVerdict { None, Candidate { idle_ms: u64, events_before_pause: u32 } }
impl StallMachine {
    pub fn tick(&mut self, now_ms: u64, clock: InputClock, suppressed: bool, p: &StallParams) -> StallVerdict;
}
```

- Phases:
  - `Active`: the threshold is not crossed yet.
  - `Fired`: this pause has already produced a verdict, or was spent by
    suppression.
- `Active` → `Candidate` once, when **all** of these hold:
  - `idle = now - clock.last_ms` is at least `pause_ms` and below `away_ms`.
  - `now - clock.last_scroll_ms` is at least `scroll_quiet_ms`.
  - The number of events in the 60 s before the pause started is at least
    `min_events`. The pause starts at `clock.last_ms`. Compute the count from
    the fixed ring buffer of per-second samples. Never allocate.
  - `suppressed` is false.
- When the threshold is crossed while `suppressed` is true, move to `Fired`
  without a verdict. That pause must never fire later.
- `Fired` → `Active` when `clock.last_ms` changes.

**Enrichment** runs only on a `Candidate`. It is async, with one cache read:

- `cache.get_frames_in_range(now - 10 min, now)`, then take the latest frame
  overall.
- Drop the candidate if `is_screenpipe_app(app_name)` is true.
- `active_secs_before` is the span of consecutive latest frames with the same
  `app_name`. Drop the candidate if it is under 60 s.
- Compute `trail` and `window_ping_pong` from the same frame list.

**Runner:**

```rust
pub type SuppressFn = Arc<dyn Fn() -> bool + Send + Sync>;
pub fn start_stall_detector(
    settings: NextStepHintsSettings,
    cache: Arc<HotFrameCache>,
    suppressed: SuppressFn,
    shutdown: broadcast::Receiver<()>,
) -> Option<tokio::task::JoinHandle<()>>; // None when !settings.enabled
```

- Use `tokio::time::interval(1 s)` with `MissedTickBehavior::Skip`. Each tick
  is one `input_clock()` call plus `machine.tick(..)`.
- On a stall, call `screenpipe_events::send_event(STALL_EVENT, stall)`. Log
  `info!("next_step: stall fired id={} app={} idle_ms={}")`. Never log window
  titles or screen text.

### 5. Wiring: `apps/screenpipe-app-tauri/src-tauri/src/capture_session.rs`

- After the UI recorder starts successfully, if
  `config.next_step_hints.enabled`, call `start_stall_detector`.
- Pass it:
  - `server.hot_frame_cache.clone()`
  - `shutdown_tx.subscribe()`
  - a `SuppressFn` that returns true while the meeting detector reports a
    meeting, `drm_content_paused()` is true, or `schedule_paused()` is true
- Store the handle in a new `next_step_task: Option<JoinHandle<()>>` field and
  abort it in `stop()`.
- If the UI recorder did not start (no accessibility permission), do not start
  the detector. Log one line saying why.
- Find out whether changing recording settings already restarts the capture
  session. Write the answer in the PR, because step 6 depends on it.

## Out of scope

LLM calls, context fetching, any UI, and the settings UI (step 6). For manual
testing, set `nextStepHints.enabled = true` in the dev build's settings store.

## Tests and local verification

```bash
cargo test -p screenpipe-config next_step
cargo test -p screenpipe-engine next_step
cargo test -p screenpipe-engine ui_recorder
cd apps/screenpipe-app-tauri && bun run test:tauri capture_session   # compiles src-tauri
# restore only generated noise under src-tauri/gen/schemas/ if it changed
```

Required unit tests for the state machine, using a fake clock and a fake
`InputClock`:

- [ ] Fires once after 20 s idle following 60 s of activity; does not fire again until input resumes.
- [ ] Does not fire with a scroll in the last 10 s, with idle ≥ 180 s, or with fewer than 10 events before the pause.
- [ ] A pause that crosses the threshold while suppressed never fires later in the same pause.
- [ ] Ring buffer wrap-around gives correct counts after more than 128 ticks.

Required enrichment tests, using `HotFrameCache::new()` with pushed `HotFrame`
fixtures:

- [ ] Momentum below 60 s drops the candidate.
- [ ] The trail merges consecutive duplicates, puts the newest first, and stops at 15 entries.
- [ ] Ping-pong is detected for A-B-A-B within 60 s and not for A-B-C.
- [ ] Screenpipe's own windows are dropped.

Manual check in a dev build (`bun run dev:tauri`) with the setting enabled:

- [ ] Type in an editor for over 60 s, then stop for 20 s. Exactly one `next_step: stall fired` log line appears.
- [ ] During a meeting, or while scrolling a long page, no line appears.

## Done when

- [ ] All tests above pass. CI is green.
- [ ] With the setting off, `start_stall_detector` returns `None`. A test asserts this.
- [ ] The PR body includes the hot-path statement (atomics only in the recorder loop) and a 10-minute CPU comparison of screenpipe with the detector on and off (`ps -o %cpu` samples every 10 s).
- [ ] The PR body answers whether a settings change restarts the capture session.
