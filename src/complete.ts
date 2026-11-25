/**
 * `/remote` argument completion and the provider that suppresses completions before trailing text.
 */

import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { LOCAL_FOCUS, PROJECT_FIELDS } from "./catalog.ts";

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "list", label: "list", description: "List saved remote projects and the current focus" },
  { value: "add", label: "add", description: "Save a project: add NAME SSH CWD [NOTE...]" },
  { value: "edit", label: "edit", description: "Change project fields: edit NAME key=value..." },
  { value: "remove", label: "remove", description: "Delete a saved project" },
  { value: "connect", label: "connect", description: "Connect a project and focus it" },
  { value: "focus", label: "focus", description: "Switch tools to a session project or local" },
  { value: "disconnect", label: "disconnect", description: "Disconnect a project (default: the focused one)" },
  { value: "status", label: "status", description: "Show focus and session projects" },
  { value: "copy", label: "copy", description: "Copy a file: copy local:PATH|PROJECT:PATH local:PATH|PROJECT:PATH [--overwrite]" },
  { value: "memory", label: "memory", description: "Show a project's memory file" },
  { value: "cd", label: "cd", description: "Change the focused project's working directory" },
  { value: "exec", label: "exec", description: "Run a command in the focused project" },
  { value: "forward", label: "forward", description: "Start port forwarding for the focused project" },
  { value: "unforward", label: "unforward", description: "Stop extension-managed port forwards" },
  { value: "forget", label: "forget", description: "Disconnect and clear cached credentials" },
  { value: "ssh", label: "ssh", description: "Quick connect: ssh USER@HOST [-p PORT] [-i KEY] [-J JUMP]" },
  { value: "config", label: "config", description: "Show or change output limits" },
];

const CONFIG_KEYS: AutocompleteItem[] = [
  { value: "display-lines", label: "display-lines", description: "Set collapsed command preview lines" },
  { value: "read-max-lines", label: "read-max-lines", description: "Set remote read line budget" },
  { value: "read-max-bytes", label: "read-max-bytes", description: "Set remote read byte budget" },
  { value: "exec-max-lines", label: "exec-max-lines", description: "Set command output line budget" },
  { value: "exec-max-bytes", label: "exec-max-bytes", description: "Set command output byte budget" },
  { value: "turn-max-bytes", label: "turn-max-bytes", description: "Set aggregate per-turn output budget" },
];

const EXEC_OPTIONS: AutocompleteItem[] = [
  { value: "--timeout", label: "--timeout", description: "Override command timeout in seconds" },
  { value: "--lines", label: "--lines", description: "Override collapsed preview line count" },
];

const NAME_ARGUMENT = new Set(["connect", "focus", "edit", "remove", "memory", "disconnect", "forget"]);

function filterItems(items: AutocompleteItem[], prefix: string): AutocompleteItem[] | null {
  const needle = prefix.toLowerCase();
  // Pi consumes Enter while an argument completion is active. A complete token must submit as-is,
  // even if it is also a prefix of another project name.
  if (items.some((item) => item.value.toLowerCase() === needle)) return null;
  const matches = items.filter((item) => item.value.toLowerCase().startsWith(needle));
  return matches.length ? matches : null;
}

const withPrefix = (items: AutocompleteItem[], commandPrefix: string): AutocompleteItem[] =>
  items.map((item) => ({ ...item, value: `${commandPrefix}${item.label ?? item.value}` }));

export function remoteArgumentCompletions(prefix: string, projectItems: () => AutocompleteItem[]): AutocompleteItem[] | null {
  const input = prefix.replace(/^\/?remote(?:\s+|$)/i, "");
  if (!input.includes(" ")) return filterItems(SUBCOMMANDS, input);

  const match = input.match(/^(\S+)\s+([\s\S]*)$/);
  const sub = match?.[1]?.toLowerCase() ?? "";
  const rest = match?.[2] ?? "";

  if (NAME_ARGUMENT.has(sub) && !rest.includes(" ")) {
    const names = projectItems();
    const items = sub === "focus" ? [{ value: LOCAL_FOCUS, label: LOCAL_FOCUS, description: "This machine" }, ...names] : names;
    const matches = filterItems(items, rest);
    return matches ? withPrefix(matches, `${sub} `) : null;
  }
  if (sub === "edit") {
    const [, tail = ""] = rest.match(/^\S+\s+([\s\S]*)$/) ?? [];
    const token = tail.match(/(\S*)$/)?.[1] ?? "";
    if (token.includes("=")) return null;
    const matches = filterItems(PROJECT_FIELDS.map((key) => ({ value: `${key}=`, label: `${key}=`, description: `Set ${key}; empty value clears it` })), token);
    return matches ? withPrefix(matches, `edit ${rest.slice(0, rest.length - token.length)}`) : null;
  }
  if (sub === "config" && !rest.includes(" ")) {
    const matches = filterItems(CONFIG_KEYS, rest);
    return matches ? withPrefix(matches, "config ") : null;
  }
  if (sub === "exec" && (!rest || rest.startsWith("--"))) {
    const [, head = "", token = ""] = rest.match(/^(.*\s)(\S*)$/s) ?? ["", "", rest];
    const matches = filterItems(EXEC_OPTIONS, token);
    return matches ? withPrefix(matches, `exec ${head}`) : null;
  }
  return null;
}

export function suppressRemoteCompletionsBeforeSuffix(current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const remoteCommand = /^\s*\/remote(?=\s|$)/i.exec(line);
      const afterCursor = line.slice(cursorCol);
      if (remoteCommand && cursorCol >= remoteCommand[0].length && /\S/.test(afterCursor)) return null;
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
  };
}
