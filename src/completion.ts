import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { KINDS } from "./types.ts";

export function notifierArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const leading = prefix.match(/^\s*/u)![0];
  const argument = prefix.slice(leading.length);
  if (!/\s/u.test(argument)) {
    const matches = ["status", "reload", "test"].filter(value => value.startsWith(argument));
    // status and test have a next argument level; append a space so the next Tab completes directly.
    return matches.length ? matches.map(value => ({
      value: leading + value + (value === "test" || value === "status" ? " " : ""), label: value,
    })) : null;
  }
  const match = argument.match(/^(test|status)(\s+)(\S*)$/u);
  if (!match) return null;
  const values = match[1] === "test" ? KINDS : ["all"];
  const matches = values.filter(value => value.startsWith(match[3]));
  // Pi replaces the whole argument prefix; the subcommand and spaces must be preserved.
  return matches.length ? matches.map(value => ({ value: leading + match[1] + match[2] + value, label: value })) : null;
}

/** Takes over only this command's arguments, so a Tab after the menu closes doesn't fall back to Pi's forced file completion. */
export function withNotifierCompletions(current: AutocompleteProvider): AutocompleteProvider {
  const argumentPrefix = (lines: string[], cursorLine: number, cursorCol: number) =>
    cursorLine === 0 ? (lines[0] ?? "").slice(0, cursorCol).match(/^\s*\/windows-notifier (.*)$/u)?.[1] : undefined;
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = argumentPrefix(lines, cursorLine, cursorCol);
      if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (options.signal.aborted) return null;
      const items = notifierArgumentCompletions(prefix);
      return items ? { items, prefix } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (argumentPrefix(lines, cursorLine, cursorCol) !== undefined) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
