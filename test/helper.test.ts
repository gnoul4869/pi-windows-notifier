import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "../src/config.ts";
import { SYSTEM_SOUNDS } from "../src/types.ts";
import { windowsPaths } from "../src/launcher.ts";
import { validPaths, invalidPaths } from "./sound-fixtures.ts";

const script = fileURLToPath(new URL("../src/windows-notify.ps1", import.meta.url));
const paths = process.platform === "win32" && ["x64", "arm64"].includes(process.arch) ? windowsPaths(process.env) : undefined;
function run(input: string) {
  return spawnSync(paths!.executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script],
    { input, encoding: "utf8", env: paths!.env, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 8192 });
}
function disabledPayload() {
  const event = defaults().events.completed;
  return { kind: "completed", toast: { ...event.toast, enabled: false }, sound: { ...event.sound, enabled: false } };
}
test("Windows PowerShell can parse the fixed helper (without running it)", { skip: !paths }, () => {
  const command = '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { exit 1 }; Write-Output "OK"';
  for (const file of [script, fileURLToPath(new URL("../src/windows-sound.ps1", import.meta.url))]) {
    const result = spawnSync(paths!.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { input: file, encoding: "utf8", env: paths!.env, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 8192 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "OK");
  }
});
test("The helper rejects invalid input and only allows a toast or sound after full validation", { skip: !paths }, () => {
  const base = disabledPayload();
  const invalid = ["", "{", "x".repeat(4097), "null", "[]", JSON.stringify({ kind: "completed", sound: true }),
    ...[
      { ...base, kind: "COMPLETED" }, { ...base, extra: "SECRET" },
      { ...base, toast: { ...base.toast, enabled: "false" } },
      { ...base, toast: { ...base.toast, message: "x".repeat(513) } },
      { ...base, toast: { ...base.toast, title: "" } },
      { ...base, toast: { ...base.toast, title: "x".repeat(129) } },
      { ...base, toast: { ...base.toast, message: "line\nline" } },
      { ...base, toast: { ...base.toast, message: "\u0000" } },
      { ...base, toast: { ...base.toast, message: "\ud800" } },
      { ...base, toast: { ...base.toast, message: "\uffff" } },
      { ...base, toast: { ...base.toast, path: "SECRET" } },
      { ...base, sound: { ...base.sound, source: { type: "system", name: "beep" } } },
      ...invalidPaths.map(path => ({ ...base, sound: { ...base.sound, source: { type: "file", path } } })),
      { ...base, sound: { ...base.sound, source: { type: "file", path: validPaths[0], name: "Beep" } } },
      { ...base, sound: { ...base.sound, source: { type: "FILE", path: validPaths[0] } } },
      { ...base, sound: { ...base.sound, source: { type: "system" } } },
      { ...base, sound: { ...base.sound, source: { type: "system", name: "Beep", extra: "SECRET" } } },
      { ...base, sound: { ...base.sound, volume: 1.0001 } },
      { ...base, sound: { ...base.sound, volume: -0.01 } },
      { ...base, sound: { ...base.sound, volume: "0.5" } },
      { ...base, sound: { ...base.sound, volume: true } },
      { ...base, sound: { ...base.sound, volume: null } },
      { ...base, sound: { ...base.sound, volume: [] } },
    ].map(value => JSON.stringify(value))];
  // Every full fixture has all channels disabled; even if validation regresses, nothing is notified.
  for (const [index, input] of invalid.entries()) {
    const result = run(input);
    assert.equal(result.status, 1, `Must reject invalid fixture ${index}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { code: "INPUT_INVALID", toast: false, sound: "failed" });
    assert.equal(result.stdout.includes("SECRET"), false);
    assert.equal(result.stderr, "");
  }
});
test("The helper accepts valid file sources; with sound disabled it never reads a missing WAV", { skip: !paths }, () => {
  for (const path of validPaths) {
    const request = disabledPayload();
    request.sound.source = { type: "file", path };
    const result = run(JSON.stringify(request));
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { code: "OK", toast: false, sound: "disabled" });
    assert.equal(result.stderr, "");
  }
});
test("The helper accepts 0-1 volume and an omitted volume, neither starting playback", { skip: !paths }, () => {
  for (const volume of [0, 0.2, 1]) {
    const request = disabledPayload();
    request.sound.volume = volume;
    const result = run(JSON.stringify(request));
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { code: "OK", toast: false, sound: "disabled" });
    assert.equal(result.stderr, "");
  }
  // A legacy payload has no volume: still accepted, at the original volume.
  const legacy = { kind: "completed", toast: { enabled: false, title: "Pi", message: "Response complete" },
    sound: { enabled: false, source: { type: "file", path: validPaths[0] } } };
  const result = run(JSON.stringify(legacy));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { code: "OK", toast: false, sound: "disabled" });
  assert.equal(result.stderr, "");
});
test("The helper returns SOUND_FAILED for a missing WAV, without leaking the path or switching to a beep", { skip: !paths }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-PRIVATE-"));
  try {
    const request = disabledPayload();
    request.sound = { enabled: true, volume: 1, source: { type: "file", path: join(dir, "missing.wav") } };
    const result = run(JSON.stringify(request));
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { code: "SOUND_FAILED", toast: false, sound: "failed" });
    assert.equal(result.stdout.includes("PRIVATE"), false);
    assert.equal(result.stderr, "");
  } finally { rmSync(dir, { recursive: true }); }
});
test("The helper accepts Unicode/XML text and every system sound name; a disabled channel calls no API", { skip: !paths }, () => {
  for (const name of SYSTEM_SOUNDS) {
    const request = disabledPayload();
    request.toast.title = 'Pi <tag> & "quotes" 😀';
    request.toast.message = "$(Write-Output SECRET) is just text";
    request.sound.source = { type: "system", name };
    const result = run(JSON.stringify(request));
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { code: "OK", toast: false, sound: "disabled" });
    assert.equal(result.stdout.includes("SECRET"), false);
    assert.equal(result.stderr, "");
  }
  const request = disabledPayload();
  request.toast.title = "x".repeat(128);
  request.toast.message = "x".repeat(512);
  assert.equal(run(JSON.stringify(request)).status, 0);
  request.toast.title = "emoji 😀";
  request.toast.message = String.raw`literal \ud800`;
  assert.equal(run(JSON.stringify(request).replace("😀", String.raw`\ud83d\ude00`)).status, 0);
});
