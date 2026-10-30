# Code architecture

This file is a code index for maintainers and coding agents; it doesn't replace the implementation. Progress and TODOs live in [current status](current-status.md); usage lives in the [README](../README.md).

## System position and data flow

This is a Pi extension for Windows that only observes events and notifies. It never approves permissions, answers questions, or changes the agent's execution results. There are no extra runtime dependencies: Pi APIs, Node.js built-ins, Windows PowerShell 5.1, and Windows/.NET APIs.

```text
pi.extensions in package.json
  → src/index.ts (default export)
  → runtime.ts (event registration, sessions, commands, diagnostics)
      ├─ config.ts → normalized Config
      ├─ completion.ts → command argument completion
      └─ Pi lifecycle/UI/tool events, extension event bus
          → state.ts → NotificationJob { key, kind, valid() }
          → scheduler.ts (switches, dedup, priority, rate limiting, cancellation)
          → launcher.ts (config snapshot → stdin JSON)
          → windows-notify.ps1
              ├─ Windows Toast (DOM text node, built-in sound disabled)
              └─ system sound / local WAV via windows-sound.ps1
          ← stdout JSON { code, toast, sound } + exit code
          ← Submission / fixed diagnostic code → status or a terminal notice
```

The state machine keeps only identifiers, boolean states, and outcomes — never tool arguments or message content. A notification payload contains only the event type and validated channel settings; custom static text and WAV paths come from the global config, never from the session.

## Modules and tests

| Module | Responsibility and main entry points | Tests |
|---|---|---|
| [index.ts](../src/index.ts) | Exports registerNotifier as the Pi extension factory | runtime |
| [runtime.ts](../src/runtime.ts) | Session lifecycle, event wiring, environment eligibility, status/reload/test, diagnostics | [runtime.test.ts](../test/runtime.test.ts) |
| [state.ts](../src/state.ts) | NotificationState: permission/question dedup and cancellation, final classification per logical run | [state.test.ts](../test/state.test.ts) |
| [config.ts](../src/config.ts) | defaults, parseConfig, loadConfig: strict schema, merging, global file read | [config.test.ts](../test/config.test.ts) |
| [types.ts](../src/types.ts) | Five event kinds, config/payload types, text, sound path and volume validation | config, launcher |
| [scheduler.ts](../src/scheduler.ts) | NotificationScheduler: bounded queue, re-validation before execution, single helper, Submission | [scheduler.test.ts](../test/scheduler.test.ts) |
| [launcher.ts](../src/launcher.ts) | windowsPaths, createWindowsBackend: fixed process launch, protocol validation, timeout/abort | [launcher.test.ts](../test/launcher.test.ts) |
| [windows-notify.ps1](../src/windows-notify.ps1) | Re-validates stdin, submits toast and sound independently, fixed JSON result | [helper.test.ts](../test/helper.test.ts) |
| [windows-sound.ps1](../src/windows-sound.ps1) | Local fixed-disk/reparse point checks, bounded WAV read, PCM validation, gain scaling, playback | [windows-sound.test.ts](../test/windows-sound.test.ts) |
| [completion.ts](../src/completion.ts) | Subcommand/argument completion and the autocomplete provider wrapper, preserving other completion behaviour | [completion.test.ts](../test/completion.test.ts), runtime |

Test helpers: [clock.ts](../test/clock.ts) provides a fake clock, [sound-fixtures.ts](../test/sound-fixtures.ts) synthesizes PCM WAV and path fixtures, and [pack.test.ts](../test/pack.test.ts) checks the exact npm pack file list.

## Event wiring and classification

| Source | State machine entry | Rule |
|---|---|---|
| `permissions:ui_prompt` / `permissions:decision` | permissionPrompt / permissionDecision | Dedup by requestId; cancelled once a decision arrives. Automatically approved/denied requests don't produce a notification from the decision alone |
| `tool_execution_start` / `tool_execution_end` | toolStart / toolEnd | Tracks only `ask_user_question` and `plan_mode_question`; tool end cancels |
| `ui_prompt_start` / `ui_prompt_end` | uiStart / uiEnd | A question is recognized only with exactly one supported tool and no pending permission; overlapping signals don't get a guessed source |
| `rpiv:ask-user:blocked` | rpivBlocked | Extra wait signal for RPIV, sharing dedup with UI signals |
| `agent_start` | agentStart | Starts a logical run; retries/continuations that haven't settled still count as the same run |
| `message_end` | messageEnd | Records only whether an assistant message appeared and the stopReason; no text kept |
| `turn_end` / `agent_before_settle` | boundary | Updates the outcome; never sends the completion notification here |
| `agent_settled` | settled | Final classification and a single submission; the next run invalidates older notifications |

Final classification: an assistant message plus an abort is `aborted`; otherwise an error outcome is `failed`; anything else with an assistant message is `completed`. An empty run with no assistant message and no error — including a direct Esc abort — doesn't notify. A single toolResult error doesn't classify the whole response as failed.

Questions notify at most once per toolCallId, never per number of questions or UI steps. UI events lack a tool source, so not every concurrent window can be covered; ambiguous cases are skipped and recorded as `UI_AMBIGUOUS`.

## Session and cancellation lifecycle

- The factory only registers APIs and captures the required OS environment; it starts no helper, timer, or event bus subscription.
- `session_start` installs the TUI completion wrapper and builds config, backend, scheduler, and state. Notifications are enabled only on Windows x64/arm64 with `mode === "tui"` and `hasUI`.
- start, config reload, and shutdown run on one Promise chain, serialized: the old session is cleaned up before a new one is created.
- Cleanup marks disposed, cancels event bus subscriptions, resets state, then closes the scheduler; it waits for its own child process to close instead of releasing the single-helper quota early.
- `/windows-notifier reload` rebuilds the notification session without reinstalling the completion wrapper. `/reload` is Pi reloading the extension runtime.
- Permission decisions, UI/tool wait ends, new runs, reload, session change, or shutdown can all cancel work. A submitted toast can't be recalled, and cancellation can still race with submission to Windows.

## Config and submission contract

- New global path: `~/.pi/agent/extensions/pi-windows-notifier/config.json`. The legacy path `~/.pi/agent/pi-windows-notifier/config.json` is read only when the new file doesn't exist. Files are never merged, project config is never read, and config is never written back.
- Config file limit 16 KiB; unknown fields, wrong types, unknown versions, or read failures fail closed and disable notifications. Missing file means built-in defaults.
- Schema v2 merges in order: built-in event defaults → defaults → events. `sound.source` is replaced as a whole, never mixed field by field. The legacy boolean-sound format without `schemaVersion` is converted in memory only.
- The master switch, the event switch, and at least one channel switch must all be on. By default all five events are on, toast and sound are on, `sound.volume` is 1; completed uses Hand, the rest use Exclamation. `sound.volume` is a linear 0–1 amplitude gain and only affects file sounds.
- state produces NotificationJob; the scheduler keeps key, kind, and the valid callback — no session content. Validity and config are checked at submission and when leaving the queue; channel settings are snapshotted at launch.
- Helper result and exit code must agree; toast and sound are reported separately. The scheduler maps results to fixed states such as submitted/partial/failed, and never retries automatically.
- `test`, in a valid session with a scheduler, immediately shows an English request notice (including the event type) without waiting for the queue or helper; the final English result still waits for the Submission and is reported only to the same non-disposed session. Not started / unsupported environments report disabled directly. The reload notice, diagnostics, and command usage are English too.
- The helper submits the toast first, then handles sound; system-sound `Play` is asynchronous with a 750 ms bounded wait, local WAV uses `PlaySync`. When `sound.volume` is below 1, PCM samples are scaled in place in bounded memory before playback; `0` is silent and never starts playback. SystemSounds has no volume interface, so system sounds ignore `sound.volume`. The launcher waits for the child to close and validates the protocol and exit code before returning, so success isn't declared early and the single-helper quota isn't released prematurely.
- `status` is a safe summary; only `status all` adds per-event detail. Custom text and WAV paths are never shown. File sounds show `volume N%` only when `sound.volume` is below 1. The diagnostic set holds at most 32 kinds, and terminal warnings appear at most once per minute.

## Resource limits and security boundaries

| Limit | Implementation / meaning |
|---|---|
| Permission dedup and pending sets capped at 256 entries each; at most 32 question tools | state; avoids unbounded event tracking |
| Wait queue at most 16 entries; at least 1 s between launches; waits expire after 30 s | scheduler; permission/question have priority, and when full, non-wait notifications are dropped first |
| At most one helper at a time; 25 s timeout; stdout/stderr at most 8 KiB each | launcher; only its own child is terminated, never processes with the same name; 25 s covers synchronous playback of a 15 s WAV |
| Title 128, message 512, WAV path 1024 UTF-16 code units | types plus re-validation in the helper; static single-line text, no template expansion |
| Helper stdin at most 4096 characters | windows-notify; nothing is submitted to a channel before full validation |
| WAV at most 10 MiB, 15 s, mono/stereo, 8/16 bit, 8–48 kHz RIFF PCM; `sound.volume` 0–1 | windows-sound; bounded read into memory, samples may be scaled in place, then synchronous playback; 16-bit scaling allocates a second sample buffer (peak roughly twice the data size); the 15 s limit leaves headroom under the 25 s helper timeout |

PowerShell comes from the absolute SystemRoot/windir path in the startup environment, never PATH. Fixed `-File`, `shell: false`, a fixed working directory, and a minimal environment whitelist. Text and sound paths travel only through stdin, and the toast uses DOM text nodes — no command or XML concatenation. The toast's built-in sound is off, an alert sound plays separately, and failure of one channel doesn't block the other.

WAV accepts local fixed disks only; UNC, device paths, alternate data streams, and reparse points at any level are rejected. Environment variables and home directories aren't expanded, and there is no external player, network audio, or fallback. Path checks are not a sandbox against a path being swapped concurrently; the design still trusts the OS, the startup environment, and installed packages, and cannot isolate a malicious extension in the same process.

## Development and publishing shape

- TypeScript ESM with `.ts` imports; Pi loads the source directly, so there is no `dist`.
- `npm run check` runs `tsc --noEmit`; `npm test` uses Node strip-types with the built-in test runner; `npm run verify` chains both.
- The `files` whitelist in package.json contains only runtime TS, the two PowerShell helpers, the README, and license files; package.json itself is included by npm.
- Docs, tests, and development config stay in the repository and are not published. Any change to the publish scope must be checked against the pack test.
