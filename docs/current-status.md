# Current status

Last checked: 2026-10-30.

This file records current capabilities, verification scope and results, known limitations, and outstanding acceptance checks. It is not a work log. See [architecture](architecture.md) for the code map.

## Quick summary

- This project ([gnoul4869/pi-windows-notifier](https://github.com/gnoul4869/pi-windows-notifier)) is at **0.1.0**: raised WAV size/duration and helper timeout limits, added `sound.volume`, and added diagnostic codes for every notification drop path (notification behaviour unchanged).
- The full local Windows notification path works: five event classes → state machine → rate limiting/cancellation → PowerShell → toast/sound.
- The next priority is real-machine and end-to-end acceptance, plus the feature TODOs listed below.

## Implemented

| Area | Current behaviour |
|---|---|
| Five notification types | permission, question, completed, aborted, failed |
| Permission integration | Observes pi-permission-system prompts/decisions, deduplicates and cancels by requestId, supports forwarded requests |
| Question integration | RPIV/Lean `ask_user_question` and Plan mode `plan_mode_question`; conservative detection from tool and UI wait signals |
| Final response classification | Waits for `agent_settled` before notifying, so retries/continuations don't report completion mid-run; a plain abort with no assistant message doesn't notify |
| Configuration | Schema v2, shared defaults plus event overrides, `sound.volume` (0–1), legacy format handled in memory, new/legacy global path precedence, invalid config fails closed |
| Channels and content | Independent toast/sound switches, custom static text, system-sound whitelist and local WAV; completed defaults to Hand; file sounds scale PCM samples linearly by `sound.volume` |
| Processes and cancellation | Single helper, bounded queue, wait-events-first, rate limiting, TTL, timeout, serialized cleanup on reload/shutdown |
| Commands | `status` summary, `status all` detail, `reload`, `test [event]`, chained Tab and argument-prefix completion; `test` shows an immediate English request notice and a deferred final result; reload/diagnostics/usage are English |
| Privacy and security | No session content is carried out; status/diagnostics never list custom text or paths; fixed helper, stdin JSON, minimal environment, strict protocol |
| Published surface | Exact pack whitelist; docs, tests, and development config are not published |

## Verification status

### Automated verification

Run on 2026-10-30 on Windows, Node.js `v22.23.4`, npm `10.9.9`, Windows PowerShell 5.1:

- `npm run verify`: TypeScript check passes; **85 tests pass, 0 failures, 0 skipped**.
- `npm pack --dry-run --ignore-scripts`: 14 files.
- `Set-WaveGain` limit measurement: gain 0.5 applied to a 48 kHz/stereo/16-bit/15-second fixture (2,880,044 bytes, 1,440,000 samples) took 822 ms including `Read-LocalWave`. Adding up to 15 s of synchronous playback plus PowerShell startup still stays under the 25 s helper timeout.

Test scope and evidence boundaries:

- Configuration: schema v2 merging, legacy compatibility, independent channels, `sound.volume` default 1 and finite 0–1 validation, event overrides winning, system-sound whitelist, local WAV paths, text limits and Unicode/XML validation; status and error notices never show config text or paths.
- Events and scheduling: permission/question detection, final response classification, dedup and cancellation, rate-limited queue, launcher protocol and resource cleanup. Mostly mock event buses, backends, or a fake clock — not the real Pi workflow.
- Commands and completion: `test` shows the English request notice before the helper starts and while queued/rate-limited, while the final submitted result still waits for the helper; seven outcomes plus diagnostic warnings, config switches, suppression of stale results after reload/session change/shutdown, English reload notice; chained Tab, argument prefixes, and existing provider behaviour. Timing is verified with a mock backend and fake clock — not real TUI/toast latency.
- Windows helpers: real syntax checks of both PowerShell scripts, invalid input, valid input when all channels are off, `sound.volume` 0/0.2/1 and legacy input without `volume`, and the fixed failure result for a missing WAV. No toast is shown and no sound is played. Single-channel success/failure and partial success are verified with a mock launcher.
- WAV: synthesized PCM fixtures, calling the real read and validation functions; mono/stereo, 8/16 bit, the 15-second boundary, odd chunk padding, Unicode/quote/command-like filenames, oversized/truncated/forged formats, duplicate chunks, missing file, directory, and ancestor junction. Gain is verified separately against known samples: `Set-WaveGain` in-place scaling for 8/16 bit, clipping beyond range, and the original file staying unchanged. These tests never run the playback function.
- Publishing: the npm pack dry-run checks the exact list — package metadata, runtime TS, PowerShell helpers, the README, and license files only.

Ordinary tests never show a toast or play a sound; neither automated tests nor a successful helper submission proves that a user actually saw or heard anything.

Reproduce:

```bash
npm ci --ignore-scripts
npm run verify
npm pack --dry-run --ignore-scripts
```

With dependencies already installed, verify and the pack dry-run can be run directly. Non-Windows environments skip the Windows-only tests; calling the Node test runner directly, without npm, may also skip the pack test — check the skipped count.

### Recorded real-machine results

These include carried-over manual acceptance records plus this round's measurements. Undated entries are carried over, not re-verified now:

- The five notification types were each sent once on the 0.1.x Windows backend, with toast popups and alert sounds confirmed by hand.
- Custom WAV playback has a real, audible acceptance record; the original record doesn't state the version or environment, so no inference is added.
- 2026-10-28, against a locally installed extension build with the same WAV-limit change (before this 0.1.0 release): two local WAVs of about 8 s and about 700 KB returned `{"code":"OK","sound":"played","toast":true}`, exit code 0, about 8 s elapsed, and the user confirmed hearing them. That result comes from the raised 15 s / 10 MiB limits and the 25 s timeout, not the earlier limits (which returned SOUND_FAILED). Not yet re-run locally with the 0.1.0 config, and no audible record exists for `sound.volume` below 1.
- 2026-10-28, submitting protocol input directly to this project's helper: `volume` 0 with an ~8 s, ~700 KB local WAV returned `{"code":"OK","sound":"played","toast":false}` (silence still reads and validates the file, about 0.7 s); `volume` 1.2 returned INPUT_INVALID, and a missing WAV returned SOUND_FAILED. That run deliberately produced no sound and no toast. No audible record yet for `volume` between 0 and 1.
- Toast-only and sound-only, recorded as pending acceptance since 0.2.0, still have no recorded visible/audible result. Passing on an older version doesn't mean the current helper or every Pi situation passes.

The automated verification above never triggers a real notification, plays a sound, or performs end-to-end acceptance.

## Outstanding acceptance

These are acceptance TODOs, not confirmed bugs, and not authorized external actions:

- [ ] Confirm visible/audible results for the current helper's toast-only and sound-only paths.
- [ ] Confirm that with a missing WAV, an enabled toast is still actually delivered; mock/safe-helper tests can't replace this.
- [ ] Confirm cancellation and process cleanup on reload/shutdown during WAV playback.
- [ ] Confirm audible volume for `sound.volume` below 1 and at 0, and that WAVs near the 15-second boundary aren't cut off by the timeout.
- [ ] Verify ask and subagent-forwarded requests in a real pi-permission-system workflow.
- [ ] Verify structured questions, deduplication, and third-party terminal bell in RPIV Lean/Plan mode.
- [ ] Verify final notification classification for normal completion, abort, error, and automatic retry/continuation in real Pi.
- [ ] Confirm behaviour under Windows do-not-disturb, disabled notifications, mute, and sound schemes.
- [ ] Confirm real process lifecycles across different extension load orders and after reload.

Real-machine testing produces notifications and sound, so it requires user confirmation before running. After acceptance, update this file with version, environment, scenario, and result.

## Features to implement

TODOs that are not implemented or investigated yet:

- [ ] After a toast click, switch to the matching tab of the matching terminal.

## Known limitations and deliberate non-support

- Windows 10/11 only, 64-bit Node.js ≥22.19, Pi ≥1.1.0, Windows PowerShell 5.1, and the interactive TUI. RPC, print, JSON, other OSes, and 32-bit don't enable notifications.
- UI events carry no tool source, so question detection can't cover all concurrent/overlapping windows; ambiguous cases are skipped. Plain text questions and manually configured UI aren't treated as questions.
- The Windows API accepts a request without guaranteeing the user sees or hears it; the toast source may show PowerShell, and a delivered toast can't be recalled.
- Configuration is read from a global file only; nothing is auto-created, moved, or written back. No text templates, no language switch, no notifications containing session content.
- WAV is limited to local fixed-disk, short PCM formats (max 10 MiB, 15 s). No MP3, network sources, reparse points, external players, loop, or fallback.
- `sound.volume` applies to file sounds only; SystemSounds has no volume interface, so system sounds always play at the Windows volume. The value is a linear amplitude gain, not perceptual, and above 1 there is no boost (capped at 1).
- Process isolation and path validation have explicit trust assumptions; they are not a sandbox against a malicious extension or a compromised account.

## Where to start and maintenance

Read this file first, then the architecture, and check the relevant implementation using this index rather than reading all code every time:

- Event detection/dedup/result classification: `src/state.ts` and its tests, then the runtime wiring.
- Config/default sounds/compatibility: `src/config.ts`, `src/types.ts`, and the config tests; keep the README examples in sync.
- Status/commands/completion: `src/runtime.ts`, `src/completion.ts`, and their tests.
- Scheduling/cancellation/process safety: `src/scheduler.ts`, `src/launcher.ts`, and their tests; look at the PowerShell helpers when real APIs are involved.
- WAV: `src/windows-sound.ps1`, `src/types.ts`, and the helper/windows-sound tests.
- Publishing: `package.json`, the pack test, and the verification section of this file; don't widen the npm publish list just because maintenance docs were added.

Update this file when behaviour, limitations, verification scope, or results change; update `architecture.md` when module responsibilities, data flow, or security boundaries change. When docs and code disagree, the code and actual verification win — fix the docs. Don't copy large implementation blocks into the docs, and never record secrets, private configuration, or session content.
