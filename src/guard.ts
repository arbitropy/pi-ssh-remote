/**
 * Per-project guards: the read-only shell command classifier and the text of guard decisions.
 * Pure module (no Pi runtime). The classifier is a conservative allowlist: it answers true only when every
 * part of a command is provably read-only, and false whenever it is in doubt (which means "ask the user").
 * It is a safety net against agent mistakes, not a security boundary.
 */

import type { Guard } from "./catalog.ts";

// ---- tokenizer -----------------------------------------------------------------------------------------

interface Word { text: string; /** Contains an unquoted or double-quoted `$` expansion, so its value is unknown. */ expands: boolean }
interface Segment { words: Word[]; start: number; end: number }
type Split = { segments: Segment[] } | { unsafe: string };

const MAX_PART = 120;

const clip = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > MAX_PART ? `${flat.slice(0, MAX_PART - 1)}…` : flat;
};

/** The offending text for a tokenizer failure: from the start of the simple command to the end of the segment. */
function snippet(input: string, from: number, at: number): string {
  let end = at;
  while (end < input.length && end - at < 40 && !";|&\n".includes(input[end]!)) end++;
  return clip(input.slice(from, end));
}

const REDIRECT_STOP = /[\s;|&<>()]/;

/**
 * Splits a command into simple commands on `| || && ; &` and newlines, honouring quotes, comments and here-documents.
 * Fails (with the offending text) on anything that can write, run code, or that this module does not model:
 * redirections other than to /dev/null or between descriptors, substitutions, background jobs, subshells.
 */
function splitCommands(input: string): Split {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let cur: string | null = null;
  let expands = false;
  let segStart = 0;
  let dropNext = false;
  const heredocs: { delim: string; expand: boolean; strip: boolean }[] = [];
  const fail = (at: number): Split => ({ unsafe: snippet(input, segStart, at) });

  const endWord = (): void => {
    if (cur === null) return;
    if (dropNext) dropNext = false;
    else words.push({ text: cur, expands });
    cur = null;
    expands = false;
  };
  const endCommand = (at: number): boolean => {
    endWord();
    if (dropNext) return false;
    if (words.length) segments.push({ words, start: segStart, end: at });
    words = [];
    segStart = at + 1;
    return true;
  };
  const append = (text: string): void => { cur = (cur ?? "") + text; };

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;

    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) return fail(i);
      if (next !== "\n") append(next);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close < 0) return fail(i);
      append(input.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      for (;;) {
        const c = input[j];
        if (c === undefined) return fail(i);
        if (c === '"') break;
        if (c === "`") return fail(j);
        if (c === "$") {
          if (input[j + 1] === "(") return fail(j);
          expands = true;
        }
        if (c === "\\") {
          const next = input[j + 1];
          if (next === undefined) return fail(i);
          if (next === "\n") { j += 2; continue; }
          text += "$`\"\\".includes(next) ? next : `\\${next}`;
          j += 2;
          continue;
        }
        text += c;
        j++;
      }
      append(text);
      i = j + 1;
      continue;
    }
    if (ch === "`") return fail(i);
    if (ch === "$") {
      const next = input[i + 1];
      if (next === "(") return fail(i);
      if (next === "'") { // ANSI-C quoting: literal text with escapes; the value is not decoded here
        let j = i + 2;
        while (j < input.length && input[j] !== "'") j += input[j] === "\\" ? 2 : 1;
        if (j >= input.length) return fail(i);
        append(input.slice(i + 2, j));
        expands = true;
        i = j + 1;
        continue;
      }
      expands = true;
      append("$");
      i++;
      continue;
    }
    if (ch === "#" && cur === null) { // comment to the end of the line
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === " " || ch === "\t") { endWord(); i++; continue; }
    if (ch === "\n") {
      if (!endCommand(i)) return fail(i);
      i++;
      if (heredocs.length) {
        for (const doc of heredocs.splice(0)) {
          let found = false;
          while (i <= input.length) {
            const eol = input.indexOf("\n", i);
            const line = input.slice(i, eol < 0 ? input.length : eol);
            const body = doc.strip ? line.replace(/^\t+/, "") : line;
            i = eol < 0 ? input.length + 1 : eol + 1;
            if (body === doc.delim) { found = true; break; }
            if (doc.expand && (line.includes("`") || line.includes("$("))) return fail(i);
          }
          if (!found) return fail(i);
        }
        segStart = Math.min(i, input.length);
      }
      continue;
    }
    if (ch === ";") {
      if (input[i + 1] === ";" || input[i + 1] === "&") return fail(i);
      if (!endCommand(i)) return fail(i);
      i++;
      continue;
    }
    if (ch === "|") {
      if (!endCommand(i)) return fail(i);
      i += input[i + 1] === "|" || input[i + 1] === "&" ? 2 : 1;
      segStart = i;
      continue;
    }
    if (ch === "&" && input[i + 1] === "&") {
      if (!endCommand(i)) return fail(i);
      i += 2;
      segStart = i;
      continue;
    }
    if (ch === "(" || ch === ")") return fail(i);
    if (ch === ">" || (ch === "&" && input[i + 1] === ">")) {
      // Output redirection: only to /dev/null or a duplicated descriptor (2>&1) is accepted.
      if (ch === ">" && cur !== null && /^\d+$/.test(cur)) { cur = null; expands = false; } // the descriptor number
      else endWord();
      let j = i + (ch === "&" ? 2 : 1);
      let duplicate = false;
      if (input[j] === ">" || input[j] === "|") j++;
      else if (ch === ">" && input[j] === "&") { duplicate = true; j++; }
      while (input[j] === " " || input[j] === "\t") j++;
      let k = j;
      while (k < input.length && !REDIRECT_STOP.test(input[k]!)) k++;
      const target = input.slice(j, k);
      const allowed = duplicate ? /^(\d+|-)$/.test(target) : target === "/dev/null";
      if (!allowed) return fail(i);
      i = k;
      continue;
    }
    if (ch === "&") return fail(i); // background job
    if (ch === "<") {
      const next = input[i + 1];
      if (next === "(" || next === ">") return fail(i);
      if (cur !== null && /^\d+$/.test(cur)) { cur = null; expands = false; } else endWord();
      if (next === "<" && input[i + 2] === "<") { dropNext = true; i += 3; continue; } // here-string: the word is data
      if (next === "<") {
        let j = i + 2;
        let strip = false;
        if (input[j] === "-") { strip = true; j++; }
        while (input[j] === " " || input[j] === "\t") j++;
        let k = j;
        let delim = "";
        let quoted = false;
        while (k < input.length && !REDIRECT_STOP.test(input[k]!)) {
          const c = input[k]!;
          if (c === "'" || c === '"' || c === "\\") { quoted = true; k++; continue; }
          delim += c;
          k++;
        }
        if (!delim) return fail(i);
        heredocs.push({ delim, expand: !quoted, strip });
        i = k;
        continue;
      }
      dropNext = true; // `< file` and `<&N`: the next word is a redirection target, not an argument
      i += next === "&" ? 2 : 1;
      continue;
    }
    append(ch);
    i++;
  }
  if (heredocs.length) return fail(input.length);
  if (!endCommand(input.length)) return fail(input.length);
  return { segments };
}

// ---- helpers -------------------------------------------------------------------------------------------

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const UNSAFE_ASSIGNMENT = /^(PATH|IFS|ENV|BASH_ENV|SHELL|PAGER|MANPAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|PS4|PROMPT_COMMAND|LD_[A-Z_]*|GIT_[A-Z_]*|BASH[A-Z_]*|SSH_[A-Z_]*|PYTHON[A-Z_]*|NODE_[A-Z_]*|PERL[A-Z0-9_]*|RUBY[A-Z_]*)$/;
const BIN_DIRS = ["/usr/local/bin/", "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"];

const programName = (text: string): string => {
  for (const dir of BIN_DIRS) if (text.startsWith(dir) && !text.slice(dir.length).includes("/")) return text.slice(dir.length);
  return text;
};

const isShortCluster = (arg: string): boolean => /^-[^-]/.test(arg);
/** True when a short-option cluster (`-abc`) contains any of `chars`. Over-approximates: option values may match too. */
const clusterHas = (args: string[], chars: string): boolean => args.some((arg) => isShortCluster(arg) && [...arg.slice(1)].some((c) => chars.includes(c)));
const hasLong = (args: string[], ...names: string[]): boolean => args.some((arg) => names.some((n) => arg === n || arg.startsWith(`${n}=`)));
const hasPrefix = (args: string[], ...prefixes: string[]): boolean => args.some((arg) => prefixes.some((p) => arg.startsWith(p)));

interface FlagSpec { value?: string[]; bool?: string[]; shortBool?: string }

/**
 * Leading options of a subcommand-style tool: flags are skipped until the first positional.
 * Returns its index, or -1 when an option is not in the spec (unknown options might change what the tool does).
 * With `scanAll`, positionals are skipped and the result is args.length, or -1 on an unknown option.
 */
function firstPositional(args: string[], spec: FlagSpec, scanAll = false): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-") || arg === "-") { if (scanAll) continue; return i; }
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (spec.value?.includes(name)) { if (name === arg) i++; continue; }
    if (spec.value?.includes(arg.slice(0, 2)) && !arg.startsWith("--")) continue; // attached short value
    if (spec.bool?.includes(name)) continue;
    if (spec.shortBool && isShortCluster(arg) && [...arg.slice(1)].every((c) => spec.shortBool!.includes(c))) continue;
    return -1;
  }
  return args.length;
}

/** Positional arguments of a command whose options are known: value-taking options consume their argument. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { out.push(...args.slice(i + 1)); break; }
    if (arg.startsWith("-") && arg !== "-") { if (valueFlags.includes(arg)) i++; continue; }
    out.push(arg);
  }
  return out;
}

// ---- per-program validators ----------------------------------------------------------------------------

const PLAIN = new Set([
  "cat", "head", "tail", "grep", "egrep", "fgrep", "ls", "ll", "stat", "wc", "du", "df", "free", "uptime", "whoami", "id", "uname", "pwd",
  "echo", "printf", "which", "type", "realpath", "readlink", "basename", "dirname", "cut", "tr", "column", "jq", "diff", "cmp", "md5sum",
  "sha1sum", "sha256sum", "ps", "pgrep", "lsof", "netstat", "printenv", "getent", "nproc", "lscpu", "lsblk", "findmnt", "test", "[",
  "true", "false", "sleep",
]);

const SED_SIMPLE = "pPdDnNgGhHx=";

/** Whole-script check for sed: only addresses plus print/delete/substitute/transliterate commands are accepted. */
function sedScriptSafe(script: string): boolean {
  let i = 0;
  const n = script.length;
  const skipSpace = (): void => { while (i < n && /[ \t]/.test(script[i]!)) i++; };
  const section = (delim: string): boolean => { // reads up to and including the next unescaped delimiter
    while (i < n) {
      const c = script[i++]!;
      if (c === "\\") { i++; continue; }
      if (c === delim) return true;
    }
    return false;
  };
  const address = (): boolean => {
    const c = script[i];
    if (c !== undefined && /\d/.test(c)) {
      while (i < n && /\d/.test(script[i]!)) i++;
      if (script[i] === "~") { i++; while (i < n && /\d/.test(script[i]!)) i++; }
      return true;
    }
    if (c === "$") { i++; return true; }
    let delim: string | undefined;
    if (c === "/") { delim = "/"; i++; } else if (c === "\\" && n > i + 1 && !/[\s\\]/.test(script[i + 1]!)) { delim = script[i + 1]!; i += 2; }
    if (delim === undefined) return false;
    if (!section(delim)) return false;
    while (script[i] === "I" || script[i] === "M") i++;
    return true;
  };
  for (;;) {
    while (i < n && /[\s;]/.test(script[i]!)) i++;
    if (i >= n) return true;
    if (address()) {
      skipSpace();
      if (script[i] === ",") {
        i++;
        skipSpace();
        if (script[i] === "+" || script[i] === "~") { i++; if (!/\d/.test(script[i] ?? "")) return false; while (i < n && /\d/.test(script[i]!)) i++; }
        else if (!address()) return false;
      }
    }
    skipSpace();
    while (script[i] === "!") { i++; skipSpace(); }
    const cmd = script[i++];
    if (cmd === undefined) return false;
    if (SED_SIMPLE.includes(cmd)) { /* no operands */ }
    else if (cmd === "l" || cmd === "q" || cmd === "Q") { while (i < n && /\d/.test(script[i]!)) i++; }
    else if (cmd === "{" || cmd === "}") continue;
    else if (cmd === "s" || cmd === "y") {
      const delim = script[i++];
      if (delim === undefined || /[\s\\]/.test(delim) || !section(delim) || !section(delim)) return false;
      if (cmd === "s") while (i < n && /[gpiImM\d]/.test(script[i]!)) i++; // never w (write) or e (execute)
    } else return false;
    skipSpace();
    if (i < n && !/[;\n}]/.test(script[i]!)) return false;
  }
}

function sedSafe(args: string[]): boolean {
  let script: string | undefined;
  let haveScript = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { if (!haveScript && args[i + 1] !== undefined) { script = args[i + 1]; haveScript = true; } break; }
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (name === "--expression") {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
        if (value === undefined || !sedScriptSafe(value)) return false;
        haveScript = true;
      } else if (name === "--line-length") { if (name === arg) i++; }
      else if (!["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data", "--debug", "--posix", "--sandbox", "--follow-symlinks"].includes(arg)) return false;
      continue;
    }
    if (isShortCluster(arg)) {
      for (let c = 1; c < arg.length; c++) {
        const flag = arg[c]!;
        if (flag === "e") {
          const rest = arg.slice(c + 1);
          const value = rest || args[++i];
          if (value === undefined || !sedScriptSafe(value)) return false;
          haveScript = true;
          break;
        }
        if (flag === "l") { if (c === arg.length - 1) i++; break; }
        if (!"nErsuz".includes(flag)) return false; // includes -i (in place), -f (script file)
      }
      continue;
    }
    if (!haveScript) { script = arg; haveScript = true; }
  }
  return haveScript && (script === undefined || sedScriptSafe(script));
}

function awkSafe(args: string[]): boolean {
  if (hasLong(args, "--include", "--load", "--file", "--source", "--exec") || clusterHas(args, "ifWl")) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-v" || arg === "-F") { i++; continue; }
    if (/^-[vF]./.test(arg)) continue;
    if (/system\s*\(|getline|@include|@load/.test(arg)) return false;
    if (arg.replace(/\|\|/g, "").includes("|")) return false;
    if (arg.replace(/>=/g, "").includes(">")) return false;
  }
  return true;
}

function findSafe(args: string[]): boolean {
  return !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(arg));
}

function sortSafe(args: string[]): boolean {
  return !clusterHas(args, "o") && !hasLong(args, "--output", "--compress-program");
}

function uniqSafe(args: string[]): boolean {
  return positionals(args, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]).length <= 1;
}

function ssSafe(args: string[]): boolean {
  return !clusterHas(args, "K") && !hasLong(args, "--kill");
}

function dmesgSafe(args: string[]): boolean {
  return !clusterHas(args, "cCDEn") && !hasLong(args, "--clear", "--read-clear", "--console-off", "--console-on", "--console-level");
}

function journalctlSafe(args: string[]): boolean {
  return !hasPrefix(args, "--rotate", "--vacuum", "--flush", "--sync", "--relinquish", "--smart-relinquish", "--setup-keys", "--update-catalog", "--cursor-file", "--verify");
}

function topSafe(args: string[]): boolean {
  return (clusterHas(args, "b") || hasLong(args, "--batch")) && (clusterHas(args, "n") || hasLong(args, "--iterations"));
}

const IP_OPTIONS = /^-(4|6|s|d|o|j|p|r|c|br|brief|json|pretty|stats|details|oneline|resolve|color)$/;
const IP_OBJECTS = new Set(["addr", "address", "a", "route", "r", "link", "l"]);
function ipSafe(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) { if (!IP_OPTIONS.test(args[i]!)) return false; i++; }
  if (i >= args.length) return false;
  if (!IP_OBJECTS.has(args[i]!)) return false;
  const sub = args[i + 1];
  return sub === undefined || ["show", "list", "ls", "sh"].includes(sub);
}

const HOSTNAME_FLAGS = new Set(["-f", "-s", "-d", "-i", "-I", "-A", "-a", "-y", "-v", "--fqdn", "--short", "--domain", "--ip-address", "--all-ip-addresses", "--long", "--alias", "--all-fqdns", "--yp", "--nis"]);
const hostnameSafe = (args: string[]): boolean => args.every((arg) => HOSTNAME_FLAGS.has(arg));

function dateSafe(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-d" || arg === "-r" || arg === "--date" || arg === "--reference") { i++; continue; }
    if (arg.startsWith("--set") || clusterHas([arg], "s")) return false;
    if (arg.startsWith("-")) continue;
    if (!arg.startsWith("+")) return false; // a bare MMDDhhmm argument sets the clock
  }
  return true;
}

function lessSafe(args: string[]): boolean {
  return !args.some((arg) => arg.startsWith("+")) && !clusterHas(args, "oOk") && !hasLong(args, "--log-file", "--LOG-FILE", "--lesskey-file", "--lesskey-src");
}

function curlSafe(args: string[]): boolean {
  const LONG_BLOCKED = ["--data", "--form", "--upload-file", "--output", "--remote-name", "--dump-header", "--cookie-jar", "--trace", "--stderr", "--libcurl", "--config", "--json", "--create-dirs", "--output-dir", "--remote-header-name"];
  const method = (value: string | undefined): boolean => value !== undefined && /^(GET|HEAD)$/i.test(value);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (name === "--request") { if (!method(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i])) return false; continue; }
      if (LONG_BLOCKED.some((blocked) => name === blocked || name.startsWith(`${blocked}-`))) return false;
      continue;
    }
    if (!isShortCluster(arg)) continue;
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]!;
      if ("dFToODcKJ".includes(flag)) return false;
      if (flag === "X") {
        if (!method(arg.slice(c + 1) || args[++i])) return false;
        break;
      }
      if ("HuAebmwxrCEPtUQyYz".includes(flag)) { if (c === arg.length - 1) i++; break; }
    }
  }
  return true;
}

// ---- git, containers, orchestration, service managers --------------------------------------------------

const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "describe", "ls-files", "ls-remote", "blame", "grep", "cat-file", "shortlog", "whatchanged"]);
const GIT_GLOBALS: FlagSpec = { value: ["-C", "--git-dir", "--work-tree"], bool: ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects", "-P"] };
const GIT_LIST_FLAGS: Record<"branch" | "tag", { bool: string[]; value: string[]; list: string[] }> = {
  branch: {
    bool: ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "-l", "--show-current", "--no-color", "--color", "--column", "--no-column", "-i", "--ignore-case", "--no-abbrev"],
    value: ["--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format"],
    list: ["--list", "-l"],
  },
  tag: {
    bool: ["-l", "--list", "--no-color", "--color", "--column", "--no-column", "-i", "--ignore-case"],
    value: ["--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format"],
    list: ["-l", "--list"],
  },
};

/** `git branch` / `git tag`: listing only. A bare name would create one, so names are accepted only with --list. */
function gitListSafe(kind: "branch" | "tag", rest: string[]): boolean {
  const spec = GIT_LIST_FLAGS[kind];
  let names = 0;
  let listing = kind === "tag" ? rest.length === 0 : false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const name = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (spec.list.includes(name)) listing = true;
    if (spec.value.includes(name)) { if (name === arg) i++; continue; }
    if (spec.bool.includes(name) || /^--(abbrev|color)=/.test(arg) || (kind === "tag" && /^-n\d*$/.test(arg))) continue;
    if (arg.startsWith("-")) return false;
    names++;
  }
  return names === 0 || listing;
}

function gitSafe(args: string[]): boolean {
  const at = firstPositional(args, GIT_GLOBALS);
  if (at < 0 || at >= args.length) return false;
  const sub = args[at]!;
  const rest = args.slice(at + 1);
  if (hasLong(rest, "--output", "--ext-diff", "--open-files-in-pager") || rest.includes("-O") || rest.some((a) => /^-O./.test(a) && sub === "grep")) return false;
  if (GIT_READ.has(sub)) return true;
  switch (sub) {
    case "branch": return gitListSafe("branch", rest);
    case "tag": return gitListSafe("tag", rest);
    case "remote": {
      const [first, ...more] = rest;
      if (first === undefined || first === "-v" || first === "--verbose") return more.length === 0;
      if (first === "show") return more.every((a) => a === "-n" || !a.startsWith("-"));
      return first === "get-url" && more.every((a) => !a.startsWith("-") || a === "--all");
    }
    case "config": {
      const reading = rest.some((a) => /^--(get|get-all|get-regexp|get-urlmatch|list)$/.test(a) || a === "-l");
      const writing = rest.some((a) => /^--(add|unset|unset-all|replace-all|edit|rename-section|remove-section)$/.test(a) || a === "-e");
      return reading && !writing;
    }
    case "stash":
    case "worktree": return rest[0] === "list";
    case "reflog": return !rest.some((a) => a === "expire" || a === "delete");
    default: return false;
  }
}

const DOCKER_GLOBALS: FlagSpec = { value: ["-H", "--host", "--context", "-c"], bool: ["--debug", "-D", "--tls"] };
const COMPOSE_GLOBALS: FlagSpec = {
  value: ["-f", "--file", "-p", "--project-name", "--project-directory", "--profile", "--env-file", "--ansi", "--progress", "--parallel"],
  bool: ["--compatibility", "--dry-run", "--verbose"],
};
const COMPOSE_READ = new Set(["ps", "logs", "config", "images", "top", "version"]);
const DOCKER_READ = new Set(["ps", "logs", "inspect", "images", "version", "info", "top", "port", "diff", "history"]);

function composeSafe(args: string[]): boolean {
  const at = firstPositional(args, COMPOSE_GLOBALS);
  if (at < 0 || at >= args.length || !COMPOSE_READ.has(args[at]!)) return false;
  const rest = args.slice(at + 1);
  return args[at] !== "config" || (!rest.includes("-o") && !hasLong(rest, "--output"));
}

function dockerSafe(args: string[]): boolean {
  const at = firstPositional(args, DOCKER_GLOBALS);
  if (at < 0 || at >= args.length) return false;
  const sub = args[at]!;
  const rest = args.slice(at + 1);
  if (DOCKER_READ.has(sub)) return true;
  switch (sub) {
    case "stats": return rest.some((a) => a === "--no-stream" || a === "--no-stream=true");
    case "compose": return composeSafe(rest);
    case "network":
    case "volume": return ["ls", "list", "inspect"].includes(rest[0] ?? "");
    case "container": return ["ls", "list", "ps", "inspect", "logs"].includes(rest[0] ?? "");
    default: return false;
  }
}

const KUBECTL_GLOBALS: FlagSpec = { value: ["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "-s", "--server"] };
const KUBECTL_READ = new Set(["get", "describe", "logs", "top", "version", "explain", "api-resources"]);
function kubectlSafe(args: string[]): boolean {
  const at = firstPositional(args, KUBECTL_GLOBALS);
  if (at < 0 || at >= args.length) return false;
  const sub = args[at]!;
  const rest = args.slice(at + 1);
  if (KUBECTL_READ.has(sub)) return true;
  if (sub === "config") return ["view", "get-contexts", "current-context"].includes(rest[0] ?? "");
  if (sub === "auth") return rest[0] === "can-i";
  return false;
}

const SYSTEMCTL_FLAGS: FlagSpec = {
  value: ["-n", "--lines", "-o", "--output", "-t", "--type", "--state", "-p", "--property"],
  bool: ["--no-pager", "-l", "--full", "--user", "--system", "-a", "--all", "--failed", "--no-legend", "-q", "--quiet", "--value", "--plain", "--no-ask-password"],
  shortBool: "laq",
};
const SYSTEMCTL_READ = new Set(["status", "show", "list-units", "list-unit-files", "is-active", "is-enabled", "is-failed", "cat"]);
function systemctlSafe(args: string[]): boolean {
  const at = firstPositional(args, SYSTEMCTL_FLAGS);
  if (at < 0 || at >= args.length || !SYSTEMCTL_READ.has(args[at]!)) return false;
  return firstPositional(args.slice(at + 1), SYSTEMCTL_FLAGS, true) >= 0; // later options must be known too
}

function serviceSafe(args: string[]): boolean {
  return (args.length === 2 && args[1] === "status" && !args[0]!.startsWith("-")) || (args.length === 1 && args[0] === "--status-all");
}

function packageManagerSafe(args: string[]): boolean {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v" || args[0] === "-V")) return true;
  const sub = args.find((a) => !a.startsWith("-"));
  return sub !== undefined && ["ls", "list", "view", "outdated", "why"].includes(sub);
}

function pipSafe(args: string[]): boolean {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) return true;
  const sub = args.find((a) => !a.startsWith("-"));
  return sub !== undefined && ["list", "show", "freeze"].includes(sub);
}

const versionOnly = (...flags: string[]) => (args: string[]): boolean => args.length === 1 && flags.includes(args[0]!);

const CHECKED: Record<string, (args: string[]) => boolean> = {
  less: lessSafe, more: lessSafe,
  rg: (a) => !hasPrefix(a, "--pre", "--hostname-bin"),
  ag: (a) => !hasLong(a, "--pager"),
  tree: (a) => !clusterHas(a, "o") && !hasLong(a, "--output"),
  file: (a) => !clusterHas(a, "C") && !hasLong(a, "--compile"),
  sort: sortSafe, uniq: uniqSafe, hostname: hostnameSafe, date: dateSafe, top: topSafe, ss: ssSafe, ip: ipSafe,
  mount: (a) => a.length === 0, journalctl: journalctlSafe, dmesg: dmesgSafe, awk: awkSafe, sed: sedSafe, find: findSafe,
  yq: (a) => !clusterHas(a, "is") && !hasLong(a, "--inplace", "--split-exp"),
  command: (a) => a[0] === "-v" || a[0] === "-V",
  git: gitSafe, docker: dockerSafe, podman: dockerSafe, "docker-compose": composeSafe, kubectl: kubectlSafe,
  systemctl: systemctlSafe, service: serviceSafe, npm: packageManagerSafe, pnpm: packageManagerSafe, yarn: packageManagerSafe,
  pip: pipSafe, pip3: pipSafe, python: versionOnly("--version", "-V"), python3: versionOnly("--version", "-V"), node: versionOnly("--version", "-v", "-V"),
  curl: curlSafe,
};

// ---- simple commands -----------------------------------------------------------------------------------

function assignmentSafe(text: string): boolean {
  const match = ASSIGNMENT.exec(text);
  return !!match && !UNSAFE_ASSIGNMENT.test(match[1]!);
}

function simpleCommandSafe(input: Word[]): boolean {
  let words = input;
  while (words.length && ASSIGNMENT.test(words[0]!.text) && !words[0]!.text.startsWith("=")) {
    if (!assignmentSafe(words[0]!.text)) return false;
    words = words.slice(1);
  }
  for (let depth = 0; depth < 8; depth++) {
    if (!words.length) return true;
    const head = words[0]!;
    if (head.expands) return false;
    const program = programName(head.text);
    const rest = words.slice(1);
    const texts = rest.map((w) => w.text);
    if (program === "sudo") {
      let i = 0;
      while (i < texts.length && texts[i]!.startsWith("-")) {
        if (texts[i] === "-n" || texts[i] === "--non-interactive") i++;
        else if (texts[i] === "-u" && /^[\w.-]+$/.test(texts[i + 1] ?? "")) i += 2;
        else return false;
      }
      if (i >= rest.length) return false;
      words = rest.slice(i);
      continue;
    }
    if (program === "env") {
      let i = 0;
      while (i < texts.length) {
        const arg = texts[i]!;
        if (arg === "-i" || arg === "--ignore-environment") i++;
        else if (arg === "-u" && texts[i + 1] !== undefined) i += 2;
        else if (ASSIGNMENT.test(arg)) { if (!assignmentSafe(arg)) return false; i++; }
        else break;
      }
      if (i < texts.length && texts[i]!.startsWith("-")) return false;
      words = rest.slice(i);
      continue;
    }
    if (program === "nice") {
      let i = 0;
      if (texts[0] === "-n" && /^-?\d+$/.test(texts[1] ?? "")) i = 2;
      else if (/^-\d+$/.test(texts[0] ?? "")) i = 1;
      words = rest.slice(i);
      if (!words.length) return false;
      continue;
    }
    if (program === "timeout") {
      let i = 0;
      while (i < texts.length && texts[i]!.startsWith("-")) {
        const arg = texts[i]!;
        if (arg === "-k" || arg === "-s") i += 2;
        else if (["--preserve-status", "--foreground", "-v", "--verbose"].includes(arg) || /^--(kill-after|signal)=/.test(arg)) i++;
        else return false;
      }
      if (!/^\d+(\.\d+)?[smhd]?$/.test(texts[i] ?? "")) return false;
      words = rest.slice(i + 1);
      if (!words.length) return false;
      continue;
    }
    if (program === "time") {
      words = rest.slice(texts[0] === "-p" ? 1 : 0);
      continue;
    }
    const check = CHECKED[program];
    if (check) return !rest.some((w) => w.expands) && check(texts);
    return PLAIN.has(program);
  }
  return false;
}

// ---- public API ----------------------------------------------------------------------------------------

/** The first part of `command` that is not provably read-only, or undefined when the whole command is. */
function firstUnsafePart(command: string): string | undefined {
  const split = splitCommands(command);
  if ("unsafe" in split) return split.unsafe || clip(command);
  for (const segment of split.segments) {
    if (!simpleCommandSafe(segment.words)) return clip(command.slice(segment.start, segment.end));
  }
  return undefined;
}

/** True only when every part of the command is provably read-only; false when in doubt. */
export function isReadOnlyCommand(command: string): boolean {
  return firstUnsafePart(command) === undefined;
}

/** Why `command` needs confirmation, naming the first offending part. Empty when it is read-only. */
export function explainUnsafe(command: string): string {
  const part = firstUnsafePart(command);
  return part === undefined ? "" : `Not recognized as read-only: ${part}`;
}

// ---- guard decisions -----------------------------------------------------------------------------------

export type GuardTool = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";
export type GuardVerdict = "allow" | "block" | "confirm";

/**
 * What a guard does with a call. Read-style tools are always allowed. `confirm` asks for write, edit and bash;
 * `readonly` blocks write and edit and asks for bash unless the command is provably read-only.
 */
export function guardVerdict(guard: Guard | undefined, tool: string, command?: string): GuardVerdict {
  if (!guard || (tool !== "write" && tool !== "edit" && tool !== "bash")) return "allow";
  if (guard === "confirm") return "confirm";
  if (tool === "bash") return typeof command === "string" && isReadOnlyCommand(command) ? "allow" : "confirm";
  return "block";
}

export const guardBlockedMessage = (project: string): string =>
  `Blocked: ${project} has guard readonly, which forbids write/edit. Ask the user to make this change or to relax the guard (/remote edit ${project} guard=).`;

export const guardDeclinedMessage = (project: string, guard: Guard, tool: string): string =>
  `The user declined this ${tool === "bash" ? "command" : tool} on ${project} (guard: ${guard}). Do not retry; ask the user how to proceed.`;

export const guardNoUiMessage = (project: string, guard: Guard, tool: string, why?: string): string =>
  `${tool} on ${project} (guard: ${guard}) requires confirmation, but this session cannot ask the user.${why ? ` ${why}.` : ""} Do not retry; ask the user to run it or to relax the guard (/remote edit ${project} guard=).`;

const shorten = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Compact one-line summary of an edit call's replacements. */
export function summarizeEdits(params: any): string {
  const edits: { oldText?: unknown; newText?: unknown }[] = Array.isArray(params?.edits)
    ? params.edits
    : typeof params?.oldText === "string" ? [{ oldText: params.oldText, newText: params.newText }] : [];
  if (!edits.length) return "edit";
  const shown = edits.slice(0, 3).map((e) => `"${shorten(String(e.oldText ?? ""), 50)}" -> "${shorten(String(e.newText ?? ""), 50)}"`);
  return `${edits.length} replacement${edits.length === 1 ? "" : "s"}: ${shown.join("; ")}${edits.length > 3 ? `; ... ${edits.length - 3} more` : ""}`;
}

/** Dialog text for a call that needs confirmation. */
export function guardConfirmBody(tool: string, params: any, unsafePart?: string): string {
  const path = typeof params?.path === "string" ? params.path : "(no path)";
  if (tool === "bash") return `bash:\n${String(params?.command ?? "")}${unsafePart ? `\n\n${unsafePart}` : ""}`;
  if (tool === "write") return `write: ${path} (${Buffer.byteLength(typeof params?.content === "string" ? params.content : "", "utf8")} bytes)`;
  return `edit: ${path}\n${summarizeEdits(params)}`;
}

/** The short meaning shown after `Guard: <x>` in the prompt. */
export const guardMeaning = (guard: Guard): string =>
  guard === "readonly" ? "write/edit blocked; non-read-only bash needs user approval" : "write/edit/bash need user approval";
