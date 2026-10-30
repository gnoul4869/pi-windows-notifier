import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaults, parseConfig, type ConfigResult } from "../src/config.ts";
import type { NotificationPayload } from "../src/types.ts";
import type { Backend, LaunchResult } from "../src/launcher.ts";
import { registerNotifier } from "../src/runtime.ts";
import { FakeClock, flush } from "./clock.ts";
import { QUEUE_TTL } from "../src/scheduler.ts";

type Hook = (event: unknown, context: ExtensionContext) => unknown;
type GetCompletions = NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["getArgumentCompletions"]>;
function harness(options: { mode?: string; platform?: NodeJS.Platform; result?: ConfigResult; slow?: boolean } = {}) {
  const clock = new FakeClock();
  const handlers = new Map<string, Hook[]>();
  const listeners = new Map<string, Set<(raw: unknown) => void>>();
  const messages: string[] = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const calls: Array<{ kind: string; payload: NotificationPayload; signal: AbortSignal; resolve(result: LaunchResult): void }> = [];
  let command: (args: string, context: ExtensionCommandContext) => Promise<void>;
  let completions: GetCompletions;
  const providers: Parameters<ExtensionContext["ui"]["addAutocompleteProvider"]>[0][] = [];
  let makeCount = 0;
  let result: ConfigResult = options.result ?? { ok: true, config: defaults() };
  const context = { mode: options.mode ?? "tui", hasUI: !["print", "json"].includes(options.mode ?? "tui"),
    ui: { notify: (message: string, type?: string) => { messages.push(message); notices.push({ message, type }); },
      addAutocompleteProvider: (factory: typeof providers[number]) => providers.push(factory) } } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Hook) {
      const items = handlers.get(name) ?? [];
      handlers.set(name, [...items, handler]);
      return () => { handlers.set(name, items); };
    },
    events: {
      on(channel: string, handler: (raw: unknown) => void) {
        const set = listeners.get(channel) ?? new Set();
        set.add(handler); listeners.set(channel, set);
        return () => { set.delete(handler); };
      },
    },
    registerCommand(_name: string, spec: { handler: typeof command; getArgumentCompletions: GetCompletions }) {
      command = spec.handler;
      completions = spec.getArgumentCompletions;
    },
  } as unknown as ExtensionAPI;
  const backend: Backend = { available: true, code: "OK", launch: (payload, signal) => new Promise(resolve => {
    calls.push({ kind: payload.kind, payload, signal, resolve });
    if (!options.slow) resolve({ code: "OK", toast: payload.toast.enabled, sound: payload.sound.enabled ? "played" : "disabled" });
  }) };
  registerNotifier(api, { platform: options.platform ?? "win32", arch: "x64", clock, readConfig: () => result,
    backend: () => { makeCount++; return backend; } });
  return {
    clock, calls, messages, notices, listeners, providers,
    makeCount: () => makeCount,
    setResult: (next: ConfigResult) => { result = next; },
    hook: async (name: string, event: unknown = {}) => {
      const returns = [];
      for (const handler of handlers.get(name) ?? []) returns.push(await handler(event, context));
      return returns;
    },
    bus: (channel: string, raw: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(raw); },
    command: (args: string) => command(args, context as ExtensionCommandContext),
    complete: (prefix: string) => completions(prefix),
    tick: async (ms = 0) => { clock.advance(ms); await flush(); },
  };
}
test("Command argument completion covers subcommands, event prefixes, and full replacements, without starting a backend", async () => {
  const h = harness();
  assert.deepEqual(await h.complete(""), [
    { value: "status ", label: "status" }, { value: "reload", label: "reload" }, { value: "test ", label: "test" },
  ]);
  assert.deepEqual(await h.complete("te"), [{ value: "test ", label: "test" }]);
  assert.deepEqual(await h.complete("r"), [{ value: "reload", label: "reload" }]);
  assert.deepEqual(await h.complete("  st"), [{ value: "  status ", label: "status" }]);
  assert.deepEqual(await h.complete("status "), ["all"]
    .map(value => ({ value: "status " + value, label: value })));
  assert.equal(await h.complete("status d"), null);
  assert.equal(await h.complete("status detail"), null);
  assert.deepEqual(await h.complete(" status   a"), [{ value: " status   all", label: "all" }]);
  assert.deepEqual(await h.complete("test "), ["permission", "question", "completed", "aborted", "failed"]
    .map(kind => ({ value: "test " + kind, label: kind })));
  assert.deepEqual(await h.complete("test c"), [{ value: "test completed", label: "completed" }]);
  assert.deepEqual(await h.complete(" test   q"), [{ value: " test   question", label: "question" }]);
  assert.equal(h.makeCount(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.providers.length, 0);
});
test("Invalid or extra command arguments aren't completed; completion on a started session produces no notification", async () => {
  const h = harness();
  await h.hook("session_start");
  for (const prefix of ["unknown", "status nope", "status detail ", "status all x", "reload x", "test nope", "test completed ", "test completed x", "Test "])
    assert.equal(await h.complete(prefix), null);
  const suggestions = await h.complete("test co");
  assert.deepEqual(suggestions, [{ value: "test completed", label: "completed" }]);
  // Simulates Pi replacing the whole argument with value, so test isn't lost.
  const line = "/windows-notifier test co";
  const prefix = "test co";
  assert.equal(line.slice(0, -prefix.length) + suggestions![0].value, "/windows-notifier test completed");
  await h.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.length, 0);
  await h.hook("session_shutdown");
});
test("The TUI session installs the completion wrapper; config reload doesn't install it twice", async () => {
  const h = harness();
  await h.hook("session_start");
  assert.equal(h.providers.length, 1);
  await h.command("reload");
  assert.equal(h.providers.length, 1);
  assert.equal(h.calls.length, 0);
  await h.hook("session_shutdown");
});
test("status and empty arguments show a concise summary; all shows the safe detail", async () => {
  const h = harness();
  await h.hook("session_start");
  await h.command("status");
  const summary = h.messages.at(-1)!;
  assert.equal(summary, [
    "Windows notifier status", "Global: On", "Backend: OK", "Configured events: 5 / 5 enabled",
    "Queue: Queued 0 · Dropped 0", "Helper: Idle", "Diagnostics: None", "",
    "Details: /windows-notifier status all",
  ].join("\n"));
  await h.command("  ");
  assert.equal(h.messages.at(-1), summary);
  await h.command(" status   all ");
  const detail = h.messages.at(-1)!;
  assert.equal(/[\u3400-\u9fff]/u.test(summary + detail), false);
  assert.match(detail, /Schema version: 2/u);
  for (const kind of ["permission", "question", "completed", "aborted", "failed"])
    assert.match(detail, new RegExp(`^  ${kind} +Event: On  Toast: On  Sound: On \\(\\w+\\)$`, "mu"));
  assert.match(detail, /Sound: On \(Hand\)/u);
  assert.match(detail, /Sound: On \(Exclamation\)/u);
  assert.equal(/volume \d+%/u.test(detail), false);
  assert.equal(detail.includes("Details"), false);
  assert.equal(h.calls.length, 0);
  await h.hook("session_shutdown");
});
test("The status detail separates the master switch, events, and channels, without implying disabled events still notify", async () => {
  const h = harness({ result: parseConfig({ schemaVersion: 2, enabled: false, events: {
    permission: { enabled: false, toast: { enabled: false }, sound: { enabled: false } },
    question: { sound: { enabled: false } },
  } }) });
  await h.hook("session_start");
  await h.command("status all");
  const detail = h.messages.at(-1)!;
  assert.match(detail, /Global: Off/u);
  assert.match(detail, /Configured events: 4 \/ 5 enabled/u);
  assert.match(detail, /configured values; global switch and backend still apply/u);
  assert.match(detail, /^  permission +Event: Off  Toast: Off  Sound: Off \(Exclamation\)$/mu);
  assert.match(detail, /^  question +Event: On  Toast: On  Sound: Off \(Exclamation\)$/mu);
  await h.hook("session_shutdown");
});
test("status is readable and keeps diagnostic codes when not started, unsupported, or misconfigured", async () => {
  const h = harness();
  await h.command("status");
  assert.match(h.messages.at(-1)!, /Backend: NOT_STARTED/u);
  assert.match(h.messages.at(-1)!, /Configured events: Not loaded/u);
  assert.match(h.messages.at(-1)!, /Queue: Unavailable\nHelper: Unavailable/u);
  await h.command("status all");
  assert.match(h.messages.at(-1)!, /Schema version: Not loaded/u);
  assert.equal(h.makeCount(), 0);
  const unsupported = harness({ platform: "linux" });
  await unsupported.hook("session_start");
  await unsupported.command("status all");
  assert.match(unsupported.messages.at(-1)!, /Backend: ENV_UNSUPPORTED/u);
  assert.match(unsupported.messages.at(-1)!, /Queue: Unavailable/u);
  await unsupported.hook("session_shutdown");
  const invalid = harness({ result: { ok: false, code: "CONFIG_INVALID", config: { ...defaults(), enabled: false } } });
  await invalid.hook("session_start");
  await invalid.command("status");
  assert.match(invalid.messages.at(-1)!, /Global: Off/u);
  assert.match(invalid.messages.at(-1)!, /Diagnostics: CONFIG_INVALID/u);
  await invalid.hook("session_shutdown");
});
test("status shows running helpers, waiting, and drop counts; reading it submits no notification", async () => {
  const h = harness({ slow: true });
  await h.hook("session_start");
  h.bus("permissions:ui_prompt", { requestId: "active" });
  await h.tick();
  for (let i = 0; i < 18; i++) h.bus("permissions:ui_prompt", { requestId: `pending-${i}` });
  await h.command("status");
  assert.match(h.messages.at(-1)!, /Queue: Queued 16 · Dropped 2/u);
  assert.match(h.messages.at(-1)!, /Helper: Running/u);
  assert.match(h.messages.at(-1)!, /Diagnostics: QUEUE_DROPPED/u);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ code: "SOUND_FAILED", toast: true, sound: "failed" });
  await flush();
  await h.command("status");
  assert.match(h.messages.at(-1)!, /Diagnostics: QUEUE_DROPPED, SOUND_FAILED/u);
  await h.hook("session_shutdown");
});
test("Unknown or extra status arguments show usage, without echoing input or submitting a notification", async () => {
  const h = harness();
  await h.hook("session_start");
  for (const args of ["status PRIVATE_INPUT", "status detail", "status detail extra", "status all extra"]) {
    await h.command(args);
    assert.match(h.messages.at(-1)!, /^Usage: \/windows-notifier status \[all\]/u);
  }
  assert.equal(h.messages.join().includes("PRIVATE_INPUT"), false);
  assert.equal(h.calls.length, 0);
  await h.hook("session_shutdown");
});
test("The factory doesn't start a backend; session rebuilds and shutdown don't accumulate listeners or timers", async () => {
  const h = harness();
  assert.equal(h.makeCount(), 0);
  for (let i = 0; i < 5; i++) {
    await h.hook("session_start");
    assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 3);
  }
  h.bus("permissions:ui_prompt", { requestId: "q" });
  await h.hook("session_shutdown");
  await h.hook("session_shutdown");
  await h.tick();
  assert.equal(h.calls.length, 0);
  assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
  assert.equal(h.clock.count(), 0);
});
test("permission, RPIV/Lean, and Plan mode wiring; every observer handler returns no modification", async () => {
  const h = harness();
  await h.hook("session_start");
  h.bus("permissions:ui_prompt", { requestId: "p", command: "SECRET" });
  await h.hook("ui_prompt_start");
  await h.tick();
  assert.equal(h.calls[0].kind, "permission");
  h.bus("permissions:decision", { requestId: "p" });
  await h.hook("ui_prompt_end");
  await h.hook("tool_execution_start", { toolCallId: "q", toolName: "ask_user_question", args: { secret: "SECRET" } });
  h.bus("rpiv:ask-user:blocked", { active: true });
  await h.hook("ui_prompt_start");
  await h.tick(1_000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].kind, "question");
  h.bus("rpiv:ask-user:blocked", { active: false });
  await h.hook("ui_prompt_end");
  await h.hook("tool_execution_end", { toolCallId: "q" });
  await h.hook("tool_execution_start", { toolCallId: "plan", toolName: "plan_mode_question" });
  await h.hook("ui_prompt_start");
  await h.tick(1_000);
  assert.equal(h.calls[2].kind, "question");
  await h.hook("ui_prompt_end");
  await h.hook("tool_execution_end", { toolCallId: "plan" });
  await h.hook("agent_start");
  const message = await h.hook("message_end", { message: { role: "assistant", stopReason: "stop", content: "SECRET" } });
  const boundary = await h.hook("agent_before_settle", { outcome: "completed" });
  assert.deepEqual(message, [undefined]);
  assert.deepEqual(boundary, [undefined]);
  await h.hook("agent_settled", { aborted: false });
  await h.tick(1_000);
  assert.equal(h.calls[3].kind, "completed");
  await h.command("status");
  assert.equal(h.messages.join().includes("SECRET"), false);
  await h.hook("session_shutdown");
});
test("RPC/print/JSON/non-Windows notify nothing and create no backend", async () => {
  for (const options of [{ mode: "rpc" }, { mode: "print" }, { mode: "json" }, { platform: "linux" as const }]) {
    const h = harness(options);
    await h.hook("session_start");
    h.bus("permissions:ui_prompt", { requestId: "p" });
    await h.hook("agent_start");
    await h.hook("message_end", { message: { role: "assistant", stopReason: "stop" } });
    await h.hook("agent_settled", { aborted: false });
    await h.tick();
    await h.command("test");
    assert.equal(h.calls.length, 0);
    assert.equal(h.makeCount(), 0);
    assert.equal(h.providers.length, options.mode === undefined ? 1 : 0);
    await h.hook("session_shutdown");
  }
});
test("Invalid config fails closed, test can't bypass the switches; reload clears old events", async () => {
  const h = harness({ result: { ok: false, code: "CONFIG_INVALID", config: { ...defaults(), enabled: false } } });
  await h.hook("session_start");
  h.bus("permissions:ui_prompt", { requestId: "p" });
  await h.command("test");
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.filter(message => message.includes("CONFIG_INVALID")).length, 1);
  h.setResult({ ok: true, config: defaults() });
  await h.command("reload");
  h.bus("permissions:ui_prompt", { requestId: "pending" });
  await h.command("reload");
  await h.tick();
  assert.equal(h.calls.length, 0);
  const testPromise = h.command("test failed");
  await h.tick();
  await testPromise;
  assert.equal(h.calls[0].kind, "failed");
  assert.ok(h.messages.some(message => message.startsWith("Test notification submitted.")));
  await h.command("test $(SECRET)");
  assert.equal(h.messages.join().includes("SECRET"), false);
  await h.hook("session_shutdown");
});
test("test shows the English request immediately and reports the submission only after the helper ends", async () => {
  const h = harness({ slow: true });
  await h.hook("session_start");
  const pending = h.command("test");
  assert.deepEqual(h.notices, [{
    message: "Test notification requested (completed); waiting for the result.", type: "info",
  }]);
  assert.equal(h.calls.length, 0);
  await h.tick();
  await h.tick(750);
  assert.equal(h.messages.length, 1);
  h.calls[0].resolve({ code: "OK", toast: true, sound: "played" });
  await pending;
  assert.deepEqual(h.notices.at(-1), {
    message: "Test notification submitted. Windows settings determine whether it is displayed or heard.", type: "info",
  });
  await h.hook("session_shutdown");
});
test("While test is queued or rate-limited the event type is shown at once, without claiming success early or starting a second helper", async () => {
  const h = harness({ slow: true });
  await h.hook("session_start");
  h.bus("permissions:ui_prompt", { requestId: "active" });
  await h.tick();
  const pending = h.command("test question");
  assert.equal(h.messages.at(-1), "Test notification requested (question); waiting for the result.");
  await h.tick(100);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ code: "OK", toast: true, sound: "played" });
  await flush();
  await h.tick(899);
  assert.equal(h.calls.length, 1);
  assert.equal(h.messages.length, 1);
  await h.tick(1);
  assert.equal(h.calls[1].kind, "question");
  h.calls[1].resolve({ code: "OK", toast: true, sound: "played" });
  await pending;
  assert.match(h.messages.at(-1)!, /^Test notification submitted\./u);
  await h.hook("session_shutdown");
});
test("Partial submission, failure, and diagnostic messages from test are English warnings", async () => {
  for (const result of [
    { code: "SOUND_FAILED", toast: true, sound: "failed" },
    { code: "TOAST_FAILED", toast: false, sound: "played" },
    { code: "BOTH_FAILED", toast: false, sound: "failed" },
    { code: "HELPER_TIMEOUT", toast: false, sound: "failed" },
  ] as LaunchResult[]) {
    const h = harness({ slow: true });
    await h.hook("session_start");
    const pending = h.command("test failed");
    assert.match(h.messages.at(-1)!, /requested \(failed\)/u);
    await h.tick();
    h.calls[0].resolve(result);
    await pending;
    assert.deepEqual(h.notices.at(-2), {
      message: `Windows notifier: ${result.code}. Run /windows-notifier status to check the status.`, type: "warning",
    });
    assert.deepEqual(h.notices.at(-1), {
      message: result.toast || result.sound === "played"
        ? "Test notification partially submitted. Run /windows-notifier status for diagnostic codes."
        : "Test notification submission failed. Run /windows-notifier status for diagnostic codes.",
      type: "warning",
    });
    assert.equal(/[\u3400-\u9fff]/u.test(h.messages.join()), false);
    await h.hook("session_shutdown");
  }
});
test("A disabled result from test is an English warning and can't bypass environment, event, or channel switches", async () => {
  const cases = [
    harness(), harness({ platform: "linux" }),
    harness({ result: parseConfig({ schemaVersion: 2, enabled: false }) }),
    harness({ result: parseConfig({ schemaVersion: 2, events: { completed: { enabled: false } } }) }),
    harness({ result: parseConfig({ schemaVersion: 2, defaults: { toast: { enabled: false }, sound: { enabled: false } } }) }),
  ];
  for (const [index, h] of cases.entries()) {
    if (index !== 0) await h.hook("session_start");
    await h.command("test");
    assert.deepEqual(h.notices.at(-1), {
      message: "Notifications are disabled, or this environment/event is unsupported.", type: "warning",
    });
    assert.equal(/[\u3400-\u9fff]/u.test(h.messages.join()), false);
    assert.equal(h.calls.length, 0);
    await h.hook("session_shutdown");
  }
});
test("A cancelled result from test is an English warning and never claims submission", async () => {
  const h = harness({ slow: true });
  await h.hook("session_start");
  const pending = h.command("test aborted");
  await h.tick();
  h.calls[0].resolve({ code: "CANCELLED", toast: false, sound: "failed" });
  await pending;
  assert.deepEqual(h.notices.at(-1), { message: "Test notification cancelled.", type: "warning" });
  await h.hook("session_shutdown");
});
test("Queue-full and expiry results from test are English warnings", async () => {
  const full = harness({ slow: true });
  await full.hook("session_start");
  full.bus("permissions:ui_prompt", { requestId: "active" });
  await full.tick();
  const dropped = full.command("test");
  for (let i = 0; i < 16; i++) full.bus("permissions:ui_prompt", { requestId: `queued-${i}` });
  await dropped;
  assert.deepEqual(full.notices.at(-1), {
    message: "Test notification dropped because the queue is full.", type: "warning",
  });
  const closing = full.hook("session_shutdown");
  await flush();
  full.calls[0].resolve({ code: "CANCELLED", toast: false, sound: "failed" });
  await closing;

  const stale = harness({ slow: true });
  await stale.hook("session_start");
  stale.bus("permissions:ui_prompt", { requestId: "active" });
  await stale.tick();
  const expired = stale.command("test");
  await stale.tick(QUEUE_TTL);
  stale.calls[0].resolve({ code: "OK", toast: true, sound: "played" });
  await flush();
  await stale.tick();
  await expired;
  assert.deepEqual(stale.notices.at(-1), {
    message: "Test notification expired while waiting in the queue.", type: "warning",
  });
  assert.equal(stale.calls.length, 1);
  await stale.hook("session_shutdown");
});
test("test reports nothing from an old session after reload, session switch, or shutdown", async () => {
  for (const transition of ["reload", "session_start", "session_shutdown"]) {
    const h = harness({ slow: true });
    await h.hook("session_start");
    const pending = h.command("test");
    await h.tick();
    const switching = transition === "reload" ? h.command("reload") : h.hook(transition);
    await flush();
    assert.equal(h.calls[0].signal.aborted, true);
    h.calls[0].resolve({ code: "OK", toast: true, sound: "played" });
    await Promise.all([pending, switching]);
    assert.deepEqual(h.messages, [
      "Test notification requested (completed); waiting for the result.",
      ...(transition === "reload" ? [
        "Windows notifier configuration reloaded. Run /windows-notifier status to check the effective status.",
      ] : []),
    ]);
    await h.hook("session_shutdown");
  }
});
test("Reload messages are English for success and invalid config, keeping safe diagnostic codes", async () => {
  const h = harness();
  await h.hook("session_start");
  await h.command("reload");
  assert.deepEqual(h.notices.at(-1), {
    message: "Windows notifier configuration reloaded. Run /windows-notifier status to check the effective status.", type: "info",
  });
  h.setResult({ ok: false, code: "CONFIG_INVALID", config: { ...defaults(), enabled: false } });
  await h.command("reload");
  assert.deepEqual(h.notices.at(-2), {
    message: "Windows notifier: CONFIG_INVALID. Run /windows-notifier status to check the status.", type: "warning",
  });
  assert.equal(/[\u3400-\u9fff]/u.test(h.messages.join()), false);
  await h.command("status");
  assert.match(h.messages.at(-1)!, /Global: Off/u);
  assert.match(h.messages.at(-1)!, /Diagnostics: CONFIG_INVALID/u);
  await h.hook("session_shutdown");
});
test("Custom text reaches the backend, but status, warnings, and test results never show config text", async () => {
  const h = harness({ result: parseConfig({ schemaVersion: 2, defaults: {
    toast: { enabled: false, title: "PRIVATE_TITLE", message: "PRIVATE_MESSAGE" },
    sound: { source: { type: "system", name: "Question" } },
  } }) });
  await h.hook("session_start");
  const pending = h.command("test permission");
  await h.tick();
  await pending;
  assert.equal(h.calls[0].payload.toast.title, "PRIVATE_TITLE");
  assert.equal(h.calls[0].payload.toast.message, "PRIVATE_MESSAGE");
  assert.deepEqual(h.calls[0].payload.sound.source, { type: "system", name: "Question" });
  await h.command("status");
  assert.equal(h.messages.join().includes("PRIVATE_"), false);
  await h.command("status all");
  assert.match(h.messages.at(-1)!, /permission\s+Event: On  Toast: Off/u);
  assert.match(h.messages.at(-1)!, /Sound: On \(Question\)/u);
  assert.match(h.messages.at(-1)!, /Schema version: 2/u);
  assert.equal(h.messages.join().includes("PRIVATE_"), false);
  h.setResult(parseConfig({ schemaVersion: 2, defaults: { toast: { title: "PRIVATE_TITLE", message: 42 } } }));
  await h.command("reload");
  await h.command("status");
  assert.equal(h.messages.join().includes("PRIVATE_"), false);
  await h.hook("session_shutdown");
});
test("File sounds can be tested and reloaded, but status doesn't leak the private path", async () => {
  const makeConfig = (path: string) => parseConfig({ schemaVersion: 2,
    defaults: { sound: { source: { type: "file", path } } } });  const h = harness({ result: makeConfig("C:/PRIVATE_USER/done.wav") });
  await h.hook("session_start");
  const pending = h.command("test");
  await h.tick();
  await pending;
  assert.deepEqual(h.calls[0].payload.sound.source, { type: "file", path: "C:/PRIVATE_USER/done.wav" });
  await h.command("status");
  await h.command("status all");
  assert.match(h.messages.at(-1)!, /^  completed +Event: On  Toast: On  Sound: On \(WAV file\)$/mu);
  assert.equal(h.messages.join().includes("PRIVATE_USER"), false);
  // Volume is shown only below 1; system sounds show no volume.
  h.setResult(parseConfig({ schemaVersion: 2, defaults: { sound: { volume: 0.2, source: { type: "file", path: "C:/PRIVATE_USER/done.wav" } } },
    events: { permission: { sound: { volume: 0.2, source: { type: "system", name: "Beep" } } } } }));
  await h.command("reload");
  await h.command("status all");
  assert.match(h.messages.at(-1)!, /^  completed +Event: On  Toast: On  Sound: On \(WAV file, volume 20%\)$/mu);
  assert.match(h.messages.at(-1)!, /^  permission +Event: On  Toast: On  Sound: On \(Beep\)$/mu);
  assert.equal(h.messages.join().includes("PRIVATE_USER"), false);
  h.setResult(makeConfig("D:/PRIVATE_USER/new.wav"));
  await h.command("reload");
  const next = h.command("test question");
  await h.tick();
  await next;
  assert.deepEqual(h.calls[1].payload.sound.source, { type: "file", path: "D:/PRIVATE_USER/new.wav" });
  await h.hook("session_shutdown");
});
test("Simultaneous reloads wait for the old helper to close and can't create a second backend early", async () => {
  const h = harness({ slow: true });
  await h.hook("session_start");
  h.bus("permissions:ui_prompt", { requestId: "active" });
  await h.tick();
  const a = h.command("reload");
  const b = h.command("reload");
  await flush();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.makeCount(), 1);
  h.calls[0].resolve({ code: "CANCELLED", toast: false, sound: "failed" });
  await Promise.all([a, b]);
  assert.equal(h.makeCount(), 3);
  assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 3);
  await h.hook("session_shutdown");
});
test("Events before session load never notify, but leave PRE_SESSION_EVENTS and SETTLED_WITHOUT_RUN", async () => {
  const h = harness();
  await h.hook("agent_start");
  await h.hook("message_end", { message: { role: "assistant", stopReason: "stop" } });
  await h.hook("agent_settled", { aborted: false });
  assert.equal(h.calls.length, 0);
  await h.hook("session_start");
  assert.ok(h.notices.some(notice => notice.message.includes("PRE_SESSION_EVENTS")));
  await h.hook("agent_settled", { aborted: false });
  await h.tick();
  assert.equal(h.calls.length, 0);
  await h.command("status");
  const status = h.messages[h.messages.length - 1];
  assert.ok(status.includes("PRE_SESSION_EVENTS"));
  assert.ok(status.includes("SETTLED_WITHOUT_RUN"));
});
