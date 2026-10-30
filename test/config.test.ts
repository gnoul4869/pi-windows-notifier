import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, parseConfig, loadConfig, configPath, CONFIG_LIMIT } from "../src/config.ts";
import { validSoundPath } from "../src/types.ts";
import { validPaths, invalidPaths } from "./sound-fixtures.ts";

test("merges defaults with a partial config without sharing mutable objects", () => {
  const result = parseConfig({ events: { question: { sound: false } } });
  assert.equal(result.ok, true);
  assert.equal(result.config.events.question.sound.enabled, false);
  assert.equal(result.config.events.permission.enabled, true);
  assert.equal(defaults().events.question.sound.enabled, true);
});
test("built-in, empty, and legacy configs keep English messages, and custom text is preserved", () => {
  const expected = {
    permission: "Permission approval needed", question: "Waiting for your answer", completed: "Response complete",
    aborted: "Response interrupted", failed: "Response failed",
  };
  for (const config of [defaults(), parseConfig({}).config, parseConfig({ events: { completed: { sound: false } } }).config,
    parseConfig({ schemaVersion: 2 }).config]) {
    for (const kind of Object.keys(expected) as Array<keyof typeof expected>) {
      assert.equal(config.events[kind].toast.title, "Pi");
      assert.equal(config.events[kind].toast.message, expected[kind]);
    }
  }
  const custom = parseConfig({ schemaVersion: 2, events: { question: { toast: { message: "Please answer the question" } } } });
  assert.equal(custom.config.events.question.toast.message, "Please answer the question");
});
test("completed defaults to Hand, other events unchanged, explicit Asterisk kept", () => {
  for (const config of [defaults(), parseConfig({}).config, parseConfig({ schemaVersion: 2 }).config,
    parseConfig({ events: { completed: { sound: false } } }).config]) {
    for (const [kind, event] of Object.entries(config.events)) {
      assert.deepEqual(event.sound.source, { type: "system", name: kind === "completed" ? "Hand" : "Exclamation" });
    }
  }
  const explicit = parseConfig({ schemaVersion: 2,
    events: { completed: { sound: { source: { type: "system", name: "Asterisk" } } } } });
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.config.events.completed.sound.source, { type: "system", name: "Asterisk" });
});
test("sound.volume defaults to 1, event overrides win, only finite 0-1 accepted", () => {
  for (const config of [defaults(), parseConfig({}).config, parseConfig({ schemaVersion: 2 }).config]) {
    for (const event of Object.values(config.events)) assert.equal(event.sound.volume, 1);
  }
  for (const volume of [0, 0.2, 0.5, 1]) {
    const result = parseConfig({ schemaVersion: 2, defaults: { sound: { volume } } });
    assert.equal(result.ok, true);
    assert.equal(result.config.events.completed.sound.volume, volume);
  }
  const merged = parseConfig({ schemaVersion: 2, defaults: { sound: { volume: 0.6 } },
    events: { completed: { sound: { volume: 0.2 } } } });
  assert.equal(merged.ok, true);
  assert.equal(merged.config.events.completed.sound.volume, 0.2);
  assert.equal(merged.config.events.failed.sound.volume, 0.6);
  const input = { schemaVersion: 2, defaults: { sound: { volume: 0.6 } } };
  const before = JSON.stringify(input);
  parseConfig(input);
  assert.equal(JSON.stringify(input), before);
  for (const volume of [-0.01, 1.0001, Number.NaN, Number.POSITIVE_INFINITY, "0.5", true, null, [], {}]) {
    const result = parseConfig({ schemaVersion: 2, defaults: { sound: { enabled: false, volume } } });
    assert.equal(result.ok, false);
    assert.equal(result.config.enabled, false);
  }
});
test("unknown fields and wrong types fail closed", () => {
  for (const value of [null, [], true, { enabled: "true" }, { server: "https://example.test" },
    { events: { other: {} } }, { events: { question: null } }, { events: { question: { sound: 1 } } },
    { events: { question: { text: "secret" } } }]) {
    const result = parseConfig(value);
    assert.equal(result.ok, false);
    assert.equal(result.config.enabled, false);
  }
});
test("schema v2 merges built-in defaults, shared defaults, then event overrides", () => {
  const input = { schemaVersion: 2, defaults: { toast: { enabled: false, title: "Shared title" },
    sound: { source: { type: "system", name: "Beep" } } },
    events: { completed: { toast: { enabled: true, message: "Done" },
      sound: { enabled: false, source: { type: "system", name: "Question" } } } } };
  const result = parseConfig(input);
  assert.equal(result.ok, true);
  assert.equal(result.config.events.permission.toast.enabled, false);
  assert.equal(result.config.events.permission.toast.title, "Shared title");
  assert.equal(result.config.events.permission.toast.message, "Permission approval needed");
  assert.equal(result.config.events.completed.toast.enabled, true);
  assert.equal(result.config.events.completed.toast.title, "Shared title");
  assert.equal(result.config.events.completed.toast.message, "Done");
  assert.equal(result.config.events.completed.sound.enabled, false);
  assert.deepEqual(result.config.events.completed.sound.source, { type: "system", name: "Question" });
  assert.ok(result.config.events.permission.sound.source.type === "system");
  result.config.events.permission.sound.source.name = "Hand";
  assert.deepEqual(result.config.events.question.sound.source, { type: "system", name: "Beep" });
  assert.equal(input.defaults.sound.source.name, "Beep");
  assert.deepEqual(defaults().events.completed.sound.source, { type: "system", name: "Hand" });
});
test("validates local WAV paths; unknown or mixed fields are rejected even with sound disabled", () => {
  for (const path of validPaths) {
    assert.equal(validSoundPath(path), true);
    assert.equal(parseConfig({ schemaVersion: 2, defaults: { sound: { source: { type: "file", path } } } }).ok, true);
  }
  for (const source of [
    ...invalidPaths.map(path => ({ type: "file", path })),
    { type: "file" }, { type: "file", path: validPaths[0], name: "Beep" },
    { type: "file", path: validPaths[0], volume: 0.5 }, { type: "FILE", path: validPaths[0] },
  ]) {
    const result = parseConfig({ schemaVersion: 2, defaults: { sound: { enabled: false, source } } });
    assert.equal(result.ok, false);
    assert.equal(result.config.enabled, false);
  }
});
test("file and system sources replace as a whole; defaults share nothing and input is untouched", () => {
  const source = { type: "file", path: validPaths[0] };
  const input = { schemaVersion: 2, defaults: { sound: { source } }, events: {
    completed: { sound: { source: { type: "system", name: "Beep" } } },
    failed: { sound: { source: { type: "file", path: validPaths[1] } } },
  } };
  const result = parseConfig(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.events.completed.sound.source, { type: "system", name: "Beep" });
  assert.deepEqual(result.config.events.failed.sound.source, { type: "file", path: validPaths[1] });
  assert.ok(result.config.events.question.sound.source.type === "file");
  result.config.events.question.sound.source.path = validPaths[2];
  assert.deepEqual(result.config.events.permission.sound.source, source);
  assert.equal(source.path, validPaths[0]);
});
test("legacy format converts in memory only, keeping event enabled and sound boolean semantics", () => {
  const old = { enabled: false, events: { question: { enabled: false, sound: false }, completed: { sound: false } } };
  const before = JSON.stringify(old);
  const result = parseConfig(old);
  assert.equal(result.ok, true);
  assert.equal(result.config.schemaVersion, 2);
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.events.question.enabled, false);
  assert.equal(result.config.events.question.toast.enabled, true);
  assert.equal(result.config.events.question.sound.enabled, false);
  assert.equal(JSON.stringify(old), before);
});
test("v2 rejects mixed formats, unknown versions/fields, and incomplete sources", () => {
  for (const value of [
    { schemaVersion: 1 }, { schemaVersion: "2" }, { defaults: {} },
    { schemaVersion: 2, defaults: { enabled: true } },
    { schemaVersion: 2, events: { completed: { sound: false } } },
    { schemaVersion: 2, defaults: { toast: { path: "SECRET" } } },
    { schemaVersion: 2, defaults: { sound: { enabled: "true" } } },
    { schemaVersion: 2, events: { completed: { sound: { source: { type: "file", path: "SECRET.wav" } } } } },
    ...[{ type: "system" }, { name: "Beep" }, { type: "system", name: "beep" },
      { type: "system", name: "Beep", path: "SECRET" }].map(source =>
      ({ schemaVersion: 2, defaults: { sound: { source } } })),
  ]) {
    assert.equal(parseConfig(value).ok, false);
    assert.equal(parseConfig(value).config.enabled, false);
  }
});
test("text length and XML character validation; quotes, command-like text, and emoji are just text", () => {
  for (const text of ['<tag> & "quote" $(Get-Process)', "Done 😀"]) {
    const result = parseConfig({ schemaVersion: 2, defaults: { toast: { title: text, message: text } } });
    assert.equal(result.ok, true);
    assert.equal(result.config.events.question.toast.message, text);
  }
  assert.equal(parseConfig({ schemaVersion: 2, defaults: { toast: { title: "x".repeat(128), message: "x".repeat(512) } } }).ok, true);
  for (const toast of [{ title: "" }, { title: " " }, { title: "x".repeat(129) }, { message: "x".repeat(513) },
    { title: null }, { message: "line\nline" }, { message: "\u0000" }, { message: "\ud800" }, { message: "\uffff" }]) {
    assert.equal(parseConfig({ schemaVersion: 2, defaults: { toast } }).ok, false);
  }
});
test("README system examples match built-in behaviour; the file sound example parses", () => {
  for (const name of ["README.md"]) {
    const document = readFileSync(new URL("../" + name, import.meta.url), "utf8");
    const examples = [...document.matchAll(/```json\n([\s\S]*?)\n```/gu)];
    assert.equal(examples.length, 2);
    const fileExample = parseConfig(JSON.parse(examples[1][1]));
    assert.equal(fileExample.ok, true);
    assert.deepEqual(fileExample.config.events.completed.sound.source, { type: "file", path: "C:/Users/you/Sounds/done.wav" });
    const input = JSON.parse(examples[0][1]);
    assert.equal(input.schemaVersion, 2);
    assert.equal(input.enabled, true);
    const assertChannels = (value: typeof input.defaults) => {
      assert.deepEqual(Object.keys(value.toast).sort(), ["enabled", "message", "title"]);
      assert.deepEqual(Object.keys(value.sound).sort(), ["enabled", "source"]);
      assert.deepEqual(Object.keys(value.sound.source).sort(), ["name", "type"]);
    };
    assertChannels(input.defaults);
    assert.deepEqual(Object.keys(input.events).sort(), Object.keys(defaults().events).sort());
    for (const event of Object.values(input.events) as Array<typeof input.defaults>) {
      assert.equal(event.enabled, true);
      assertChannels(event);
    }
    const result = parseConfig(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config, defaults());
  }
});
test("default config path is the package directory under global extensions", () => {
  assert.equal(configPath(), join(homedir(), ".pi", "agent", "extensions", "pi-windows-notifier", "config.json"));
});
test("the new location wins and never merges legacy config; legacy is read only when the new file is missing, and no file is created or rewritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-paths-"));
  const primary = join(dir, "new.json");
  const legacy = join(dir, "old.json");
  try {
    assert.deepEqual(loadConfig(primary, legacy), { ok: true, config: defaults() });
    for (const text of [
      JSON.stringify({ enabled: false, events: { completed: { sound: false } } }),
      JSON.stringify({ schemaVersion: 2, defaults: { toast: { title: "Legacy path" } } }),
    ]) {
      writeFileSync(legacy, text);
      assert.deepEqual(loadConfig(primary, legacy), parseConfig(JSON.parse(text)));
      assert.equal(readFileSync(legacy, "utf8"), text);
      assert.equal(existsSync(primary), false);
    }
    writeFileSync(primary, JSON.stringify({ schemaVersion: 2, enabled: false }));
    assert.equal(loadConfig(primary, legacy).config.enabled, false);
    assert.equal(loadConfig(primary, legacy).config.events.completed.toast.title, "Pi");
    // A new file never merges from the legacy file, even without override fields.
    writeFileSync(primary, "{}");
    assert.deepEqual(loadConfig(primary, legacy), { ok: true, config: defaults() });
    assert.equal(readFileSync(primary, "utf8"), "{}");
    assert.equal(readFileSync(legacy, "utf8"), JSON.stringify({ schemaVersion: 2, defaults: { toast: { title: "Legacy path" } } }));
  } finally { rmSync(dir, { recursive: true }); } // Cleans up only the temp directory this test created.
});
test("an error in the new location doesn't fall back to the legacy file; an error in the legacy file also disables notifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-path-errors-"));
  const primary = join(dir, "new.json");
  const legacy = join(dir, "old.json");
  try {
    writeFileSync(legacy, "{}");
    for (const [text, code] of [
      ["{", "CONFIG_INVALID"],
      [JSON.stringify({ schemaVersion: 2, unknown: true }), "CONFIG_INVALID"],
      [" ".repeat(CONFIG_LIMIT + 1), "CONFIG_TOO_LARGE"],
    ]) {
      writeFileSync(primary, text);
      const result = loadConfig(primary, legacy);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, code);
      assert.equal(result.config.enabled, false);
    }
    const unreadable = loadConfig(dir, legacy);
    assert.equal(unreadable.ok, false);
    if (!unreadable.ok) assert.equal(unreadable.code, "CONFIG_READ_FAILED");
    assert.equal(unreadable.config.enabled, false);
    writeFileSync(legacy, "{");
    const invalidLegacy = loadConfig(join(dir, "missing.json"), legacy);
    assert.equal(invalidLegacy.ok, false);
    if (!invalidLegacy.ok) assert.equal(invalidLegacy.code, "CONFIG_INVALID");
    assert.equal(invalidLegacy.config.enabled, false);
    assert.equal(readFileSync(legacy, "utf8"), "{");
  } finally { rmSync(dir, { recursive: true }); } // Cleans up only the temp directory this test created.
});
test("reads a bounded file, uses defaults when missing, and disables on error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-config-"));
  const path = join(dir, "config.json");
  try {
    assert.equal(loadConfig(path).config.enabled, true);
    assert.equal(loadConfig(path).config.events.completed.toast.message, "Response complete");
    writeFileSync(path, "{");
    assert.equal(loadConfig(path).ok, false);
    writeFileSync(path, " ".repeat(CONFIG_LIMIT + 1));
    assert.deepEqual(loadConfig(path).ok, false);
    assert.equal(loadConfig(path).config.enabled, false);
    writeFileSync(path, JSON.stringify({ enabled: false }));
    assert.equal(loadConfig(path).config.enabled, false);
    assert.equal(loadConfig(dir).ok, false);
  } finally { rmSync(dir, { recursive: true }); } // Cleans up only the temp directory this test created.
});
