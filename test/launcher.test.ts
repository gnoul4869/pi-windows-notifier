import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { createWindowsBackend, windowsPaths, OUTPUT_LIMIT } from "../src/launcher.ts";
import { defaults } from "../src/config.ts";
import type { NotificationKind, NotificationPayload } from "../src/types.ts";

function payload(kind: NotificationKind = "completed", sound = true, toast = true): NotificationPayload {
  const event = defaults().events[kind];
  return { kind, toast: { ...event.toast, enabled: toast }, sound: { ...event.sound, enabled: sound } };
}

function fixture(timeoutMs = 10_000) {
  const children: ChildProcess[] = [];
  const calls: Array<{ file: string; args: string[]; options: SpawnOptions; input: string }> = [];
  const backend = createWindowsBackend({ platform: "win32", arch: "x64",
    env: { SystemRoot: "C:\\Windows", PATH: "D:\\evil", OPENAI_API_KEY: "SECRET", USERPROFILE: "C:\\Users\\test" },
    scriptPath: "D:/trusted/src/windows-notify.ps1", isFile: () => true, timeoutMs,
    spawnProcess(file, args, options) {
      const child = new ChildProcess();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
      const call = { file, args, options, input: "" };
      child.stdin.on("data", data => { call.input += data.toString(); });
      calls.push(call);
      children.push(child);
      return child;
    },
  });
  const close = (json: unknown, exitCode = 0) => {
    children.at(-1)!.stdout!.emit("data", Buffer.from(JSON.stringify(json)));
    children.at(-1)!.emit("close", exitCode);
  };
  return { backend, children, calls, close };
}
test("Rejects relative, UNC, device, and wrong OS root paths; never resolves from PATH", () => {
  for (const root of ["", "Windows", "C:Windows", "\\\\server\\Windows", "\\\\?\\C:\\Windows", "C:\\bad\u0000"]) {
    assert.equal(windowsPaths({ SystemRoot: root }), undefined);
  }
  const result = windowsPaths({ windir: "D:/Windows", Path: "evil", API_TOKEN: "SECRET" })!;
  assert.equal(result.executable, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(result.env.Path, undefined);
  assert.equal(result.env.API_TOKEN, undefined);
  assert.ok(windowsPaths({ SYSTEMROOT: "C:\\Windows" }));
});
test("Fixed path, args, cwd, allowed environment, and minimal stdin", async () => {
  const { backend, calls, close } = fixture();
  const promise = backend.launch(payload("permission", true), new AbortController().signal);
  const call = calls[0];
  assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.cwd?.toString().replaceAll("\\", "/"), "D:/trusted/src");
  assert.equal(call.options.env?.PATH, undefined);
  assert.equal(call.options.env?.OPENAI_API_KEY, undefined);
  assert.equal(JSON.stringify(call).includes("SECRET"), false);
  assert.equal(call.args.includes("-NoProfile"), true);
  assert.equal(call.args.includes("-Command"), false);
  assert.deepEqual(JSON.parse(call.input), payload("permission"));
  close({ code: "OK", toast: true, sound: "played" });
  assert.equal((await promise).code, "OK");
});
test("Helper protocol is fixed; partial success and raw error text don't leak", async () => {
  for (const value of [{ code: "evil SECRET", toast: false, sound: "failed" }, { code: "OK", toast: false, sound: "played" },
    { code: "OK", toast: true, sound: "played", secret: "SECRET" }, { code: "OK", toast: true, sound: "disabled" },
    { code: "OK", toast: true, sound: ["played"] }, { code: ["OK"], toast: true, sound: "played" }]) {
    const { backend, close } = fixture();
    const promise = backend.launch(payload("question", true), new AbortController().signal);
    close(value);
    assert.equal((await promise).code, "HELPER_PROTOCOL");
  }
  const { backend, close } = fixture();
  const promise = backend.launch(payload("failed", true), new AbortController().signal);
  close({ code: "TOAST_FAILED", toast: false, sound: "played" }, 1);
  assert.equal((await promise).code, "TOAST_FAILED");
});
test("A single channel success isn't mistaken; every required channel's result and the exit code must agree", async () => {
  const cases: Array<[boolean, boolean, unknown, number, string]> = [
    [true, false, { code: "OK", toast: true, sound: "disabled" }, 0, "OK"],
    [false, true, { code: "OK", toast: false, sound: "played" }, 0, "OK"],
    [true, false, { code: "TOAST_FAILED", toast: false, sound: "disabled" }, 1, "TOAST_FAILED"],
    [false, true, { code: "SOUND_FAILED", toast: false, sound: "failed" }, 1, "SOUND_FAILED"],
    [true, true, { code: "SOUND_FAILED", toast: true, sound: "failed" }, 1, "SOUND_FAILED"],
    [true, true, { code: "BOTH_FAILED", toast: false, sound: "failed" }, 1, "BOTH_FAILED"],
    [false, true, { code: "OK", toast: true, sound: "played" }, 0, "HELPER_PROTOCOL"],
    [true, false, { code: "OK", toast: true, sound: "played" }, 0, "HELPER_PROTOCOL"],
    [false, true, { code: "OK", toast: false, sound: "disabled" }, 0, "HELPER_PROTOCOL"],
    [false, true, { code: "TOAST_FAILED", toast: false, sound: "played" }, 1, "HELPER_PROTOCOL"],
    [false, true, { code: "OK", toast: false, sound: "played" }, 1, "HELPER_PROTOCOL"],
  ];
  for (const [toast, sound, result, exit, expected] of cases) {
    const { backend, close } = fixture();
    const request = payload("completed", sound, toast);
    const promise = backend.launch(request, new AbortController().signal);
    close(result, exit);
    assert.equal((await promise).code, expected);
  }
});
test("Text travels over stdin and never appears in args; payload and result judgement are immune to later mutation", async () => {
  const { backend, calls, close } = fixture();
  const request = payload("completed", false);
  request.toast.title = 'Pi <tag> & "quotes" 😀';
  request.toast.message = "$(Get-Process) is just text";
  request.sound.source = { type: "system", name: "Hand" };
  const promise = backend.launch(request, new AbortController().signal);
  const sent = JSON.parse(calls[0].input);
  assert.deepEqual(sent, request);
  assert.equal(calls[0].args.join().includes("Get-Process"), false);
  request.toast.enabled = false;
  request.sound.enabled = true;
  close({ code: "OK", toast: true, sound: "disabled" });
  assert.equal((await promise).code, "OK");
});
test("File paths travel only over stdin; sound failure keeps the toast partial success", async () => {
  const { backend, calls, close } = fixture();
  const request = payload();
  request.sound.source = { type: "file", path: String.raw`C:\Sounds\it's $(PRIVATE); done.wav` };
  const promise = backend.launch(request, new AbortController().signal);
  assert.deepEqual(JSON.parse(calls[0].input), request);
  assert.equal(calls[0].args.join().includes("PRIVATE"), false);
  request.sound.source.path = "C:/changed.wav";
  assert.equal(JSON.parse(calls[0].input).sound.source.path.includes("PRIVATE"), true);
  close({ code: "SOUND_FAILED", toast: true, sound: "failed" }, 1);
  assert.deepEqual(await promise, { code: "SOUND_FAILED", toast: true, sound: "failed" });
});
test("Invalid payloads create no helper", async () => {
  const { backend, calls } = fixture();
  for (const request of [payload("completed", false, false),
    { ...payload(), extra: "SECRET" }, { ...payload(), toast: { ...payload().toast, title: "" } },
    { ...payload(), sound: { enabled: true, source: { type: "file", path: "SECRET.wav" } } }]) {
    assert.equal((await backend.launch(request as NotificationPayload, new AbortController().signal)).code, "INPUT_INVALID");
  }
  assert.equal(calls.length, 0);
});
test("stdout/stderr over the limit kills only its own child", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const { backend, children } = fixture();
    const promise = backend.launch(payload("completed", false), new AbortController().signal);
    children[0][stream]!.emit("data", Buffer.alloc(OUTPUT_LIMIT + 1));
    assert.equal((await promise).code, "OUTPUT_LIMIT");
  }
});
test("Timeout, abort, and spawn failure all return fixed result codes", async () => {
  const { backend } = fixture(5);
  // The launcher timer doesn't keep the host alive; this test keeps a short timer of its own so the timeout can be observed.
  const keepAlive = setTimeout(() => {}, 100);
  try { assert.equal((await backend.launch(payload("completed", false), new AbortController().signal)).code, "HELPER_TIMEOUT"); }
  finally { clearTimeout(keepAlive); }
  const aborted = fixture();
  const controller = new AbortController();
  const promise = aborted.backend.launch(payload("question", true), controller.signal);
  controller.abort();
  assert.equal((await promise).code, "CANCELLED");
  const broken = createWindowsBackend({ platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows" },
    isFile: () => true, spawnProcess() { throw new Error("SECRET"); } });
  assert.equal((await broken.launch(payload("completed", true), new AbortController().signal)).code, "LAUNCH_FAILED");
});
test("Pipe errors end only its own helper and don't throw raw errors at the host", async () => {
  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    const { backend, children } = fixture();
    const promise = backend.launch(payload("completed", false), new AbortController().signal);
    children[0][stream]!.emit("error", new Error("SECRET"));
    assert.equal((await promise).code, "LAUNCH_FAILED");
  }
});
test("Non-Windows, 32-bit, and a missing file start no process", async () => {
  for (const options of [{ platform: "linux" as const }, { platform: "win32" as const, arch: "ia32" },
    { platform: "win32" as const, isFile: () => false },
    { platform: "win32" as const, isFile: (path: string) => !path.endsWith("windows-sound.ps1") }]) {
    const backend = createWindowsBackend({ env: { SystemRoot: "C:\\Windows" }, ...options });
    assert.equal(backend.available, false);
    assert.equal((await backend.launch(payload("completed", true), new AbortController().signal)).code, "BACKEND_UNAVAILABLE");
  }
});
