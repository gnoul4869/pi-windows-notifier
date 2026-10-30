import assert from "node:assert/strict";
import { test } from "node:test";
import { CombinedAutocompleteProvider, Editor, type AutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
import { notifierArgumentCompletions, withNotifierCompletions } from "../src/completion.ts";

const options = () => ({ signal: new AbortController().signal, force: true });
const baseProvider = () => new CombinedAutocompleteProvider([
  { name: "windows-notifier", getArgumentCompletions: notifierArgumentCompletions },
], process.cwd());

function editorHarness(wrap = withNotifierCompletions) {
  const identity = (text: string) => text;
  const editor = new Editor({ requestRender() {} } as unknown as TUI, {
    borderColor: identity,
    selectList: { selectedPrefix: identity, selectedText: identity, description: identity,
      scrollInfo: identity, noMatch: identity },
  });
  editor.setAutocompleteProvider(wrap(baseProvider()));
  let submitted = 0;
  editor.onSubmit = () => { submitted++; };
  return {
    editor,
    submitted: () => submitted,
    // Lets the real Editor's async completion request finish, without touching its private state.
    key: async (key: string) => {
      editor.handleInput(key);
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

test("Real consecutive Tab: command name to subcommand to event, without inserting a space or firing a notification", async () => {
  const h = editorHarness();
  h.editor.setText("/windows-not");
  await h.key("\t");
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier ");
  assert.equal(h.editor.isShowingAutocomplete(), false);
  await h.key("\t");
  assert.equal(h.editor.isShowingAutocomplete(), true);
  await h.key("\x1b[B");
  await h.key("\x1b[B");
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier test ");
  await h.key("\t");
  assert.equal(h.editor.isShowingAutocomplete(), true);
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier test permission");
  assert.equal(h.submitted(), 0);
});

test("Real consecutive Tab: status all detail, without manually inserting a space", async () => {
  const h = editorHarness();
  h.editor.setText("/windows-notifier st");
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier status ");
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier status all");
  h.editor.setText("/windows-notifier status a");
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier status all");
  assert.equal(h.submitted(), 0);
});

test("Tab still completes a prefix after the menu closes, keeping the text after the cursor and existing spaces", async () => {
  const provider = withNotifierCompletions(baseProvider());
  const line = "  /windows-notifier  test   co trailing text";
  const cursorCol = line.indexOf(" trailing text");
  const suggestions = await provider.getSuggestions([line], 0, cursorCol, options());
  assert.deepEqual(suggestions, {
    prefix: " test   co", items: [{ value: " test   completed", label: "completed" }],
  });
  assert.deepEqual(provider.applyCompletion([line], 0, cursorCol, suggestions!.items[0], suggestions!.prefix), {
    lines: ["  /windows-notifier  test   completed trailing text"], cursorLine: 0,
    cursorCol: "  /windows-notifier  test   completed".length,
  });
  const h = editorHarness();
  h.editor.setText("/windows-notifier te");
  await h.key("\t");
  assert.equal(h.editor.getText(), "/windows-notifier test ");
  await h.key("\t");
  assert.equal(h.editor.isShowingAutocomplete(), true);
  await h.key("\x1b");
  assert.equal(h.editor.isShowingAutocomplete(), false);
  await h.key("\t");
  assert.equal(h.editor.isShowingAutocomplete(), true);
});

test("Invalid arguments and a cancelled request don't fall through to file completion", async () => {
  const current = baseProvider();
  current.getSuggestions = async () => { assert.fail("File completion must not be called"); };
  current.shouldTriggerFileCompletion = () => false;
  const provider = withNotifierCompletions(current);
  for (const argument of ["unknown", "status nope", "status d", "status detail", "status detail ", "status all x", "reload x", "test nope", "test completed ", "test completed x"]) {
    const line = "/windows-notifier " + argument;
    assert.equal(provider.shouldTriggerFileCompletion!([line], 0, line.length), true);
    assert.equal(await provider.getSuggestions([line], 0, line.length, options()), null);
  }
  const line = "/windows-notifier test c";
  const controller = new AbortController();
  controller.abort();
  assert.equal(await provider.getSuggestions([line], 0, line.length, { signal: controller.signal, force: true }), null);
});

test("Other commands, files, second lines, and completion trigger characters keep the original provider behavior", async () => {
  const calls: unknown[][] = [];
  const current: AutocompleteProvider = {
    triggerCharacters: ["#"],
    async getSuggestions(...args) { calls.push(args); return null; },
    applyCompletion(...args) {
      calls.push(args);
      return { lines: args[0], cursorLine: args[1], cursorCol: args[2] };
    },
    shouldTriggerFileCompletion(...args) { calls.push(args); return false; },
  };
  const provider = withNotifierCompletions(current);
  assert.deepEqual(provider.triggerCharacters, ["#"]);
  for (const lines of [["/other test "], ["@src/"], ["/windows-notifier-extra "],
    ["/windows-not"], ["text /windows-notifier test "], ["text", "/windows-notifier test "]]) {
    const row = lines.length - 1;
    const col = lines[row].length;
    const request = options();
    await provider.getSuggestions(lines, row, col, request);
    assert.deepEqual(calls.pop(), [lines, row, col, request]);
    assert.equal(provider.shouldTriggerFileCompletion!(lines, row, col), false);
    assert.deepEqual(calls.pop(), [lines, row, col]);
  }
  const item = { value: "other", label: "other" };
  provider.applyCompletion(["/ot"], 0, 3, item, "/ot");
  assert.deepEqual(calls.pop(), [["/ot"], 0, 3, item, "/ot"]);
});
