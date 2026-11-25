/**
 * Remote grep/find helpers.
 *
 * Pure command builders and output parsers for searching over SSH. They mirror the
 * behavior and output format of Pi's built-in grep and find tools, which cannot be
 * redirected to a remote host through their operations hooks.
 */

import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import { quote } from "./shell.ts";

export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;
const GREP_MAX_LINE_LENGTH = 500; // Mirrors Pi's GREP_MAX_LINE_LENGTH, which is not exported from the package root.
export const RG_MARKER = "@@pi-search:rg";
export const GREP_MARKER = "@@pi-search:grep";

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export function grepLimits(params: Pick<GrepParams, "context" | "limit">): { limit: number; context: number } {
  const context = params.context && params.context > 0 ? Math.min(Math.floor(params.context), Number.MAX_SAFE_INTEGER) : 0;
  return { limit: Math.max(1, Math.floor(params.limit ?? GREP_DEFAULT_LIMIT)), context };
}

/**
 * Shell script run inside the search directory. `target` is "." for a directory search or the
 * file's base name. The first output line is a marker naming the tool that produced the rest.
 */
export function buildGrepScript(params: GrepParams, target: string): string {
  const { context } = grepLimits(params);
  // rg never matches a leading "./", and "!" negates.
  const glob = params.glob?.replace(/^(!?)(?:\.\/)+/, "$1");
  const rg = ["rg", "--no-config", "--json", "--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) rg.push("--ignore-case");
  if (params.literal) rg.push("--fixed-strings");
  if (glob) rg.push("--glob", quote(glob));
  if (context > 0) rg.push("--context", String(context));
  rg.push("--", quote(params.pattern), quote(target));

  // -Z puts a NUL after the file name, so names containing ':' or '-<digits>-' stay unambiguous.
  const grep = ["grep", "-rnHIZ", "--color=never", "--exclude-dir=.git", "--exclude-dir=node_modules"];
  if (params.ignoreCase) grep.push("-i");
  if (params.literal) grep.push("-F");
  if (context > 0) grep.push("-C", String(context));
  if (glob) {
    // GNU grep matches --include/--exclude against base names only, so a directory part is dropped.
    const negated = glob.startsWith("!");
    const base = (negated ? glob.slice(1) : glob).split("/").pop() ?? "";
    if (base) grep.push(`${negated ? "--exclude" : "--include"}=${quote(base)}`);
  }
  grep.push("-e", quote(params.pattern), "--", quote(target));
  return `if command -v rg >/dev/null 2>&1; then echo ${RG_MARKER}; ${rg.join(" ")}; else echo ${GREP_MARKER}; ${grep.join(" ")}; fi`;
}

/** Splits a byte stream into lines without cutting multi-byte characters. */
export class LineSplitter {
  private rest = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (let index = data.indexOf(10, start); index >= 0; index = data.indexOf(10, start)) {
      lines.push(data.subarray(start, index).toString("utf8"));
      start = index + 1;
    }
    this.rest = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    return lines;
  }

  flush(): string[] {
    const last = this.rest.length ? [this.rest.toString("utf8")] : [];
    this.rest = Buffer.alloc(0);
    return last;
  }
}

/** Decodes a ripgrep JSON text field; non-UTF-8 data arrives base64-encoded in `bytes`. */
function decodeRgText(data: any): string {
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf-8");
  return "";
}

/**
 * Collects remote grep output into the same text the built-in grep tool produces: `path:LINE: text`
 * for matches, `path-LINE- text` for context, the match limit with trailing context, long-line
 * truncation, and the byte limit. Feed every output line to `addLine`; it returns true once the
 * remote process can be stopped.
 */
export class GrepCollector {
  matchCount = 0;
  done = false;
  private mode: "rg" | "grep" | undefined;
  private outputLines: string[] = [];
  private outputBytes = 0;
  private outputLineCount = 0;
  private linesTruncated = false;
  private matchLimitReached = false;
  private limitHit = false;
  private trailingContextEnd = 0;
  private lastFile: string | undefined;

  constructor(private limit: number, private context: number, private isDirectory: boolean) {}

  private formatPath(filePath: string): string {
    if (!this.isDirectory) return filePath.split("/").pop() ?? filePath;
    return filePath.replace(/^(?:\.\/)+/, "");
  }

  private push(filePath: string, lineNumber: number, lineText: string, isMatch: boolean): void {
    this.lastFile = filePath;
    const relativePath = this.formatPath(filePath);
    // Strip only the line terminator: a lone CR inside a line is content, as in the read tool.
    const { text, wasTruncated } = truncateLine(lineText.replace(/\r?\n?$/, ""), GREP_MAX_LINE_LENGTH);
    if (wasTruncated) this.linesTruncated = true;
    const line = isMatch ? `${relativePath}:${lineNumber}: ${text}` : `${relativePath}-${lineNumber}- ${text}`;
    // Keep counting after the byte cap but stop storing, as the built-in does.
    if (this.outputBytes - 1 <= DEFAULT_MAX_BYTES) this.outputLines.push(line);
    this.outputBytes += Buffer.byteLength(line, "utf-8") + 1;
    this.outputLineCount++;
  }

  addLine(raw: string): boolean {
    if (this.done) return true;
    if (raw === RG_MARKER) { this.mode = "rg"; return false; }
    if (raw === GREP_MARKER) { this.mode = "grep"; return false; }
    if (!raw.trim() || !this.mode) return false;

    let filePath: string;
    let lineNumber: number;
    let lineText: string;
    let isMatch: boolean;
    if (this.mode === "rg") {
      let event: any;
      try { event = JSON.parse(raw); } catch { return false; }
      isMatch = event.type === "match";
      if (!isMatch && event.type !== "context") return false;
      filePath = decodeRgText(event.data?.path);
      lineNumber = event.data?.line_number;
      lineText = decodeRgText(event.data?.lines);
    } else {
      if (raw === "--") return false;
      const nul = raw.indexOf("\0");
      const parsed = nul > 0 ? /^(\d+)([:-])([\s\S]*)$/.exec(raw.slice(nul + 1)) : null;
      if (!parsed) return false;
      filePath = raw.slice(0, nul);
      lineNumber = Number(parsed[1]);
      isMatch = parsed[2] === ":";
      lineText = parsed[3]!;
    }
    if (!filePath || typeof lineNumber !== "number") return false;

    if (!this.limitHit) {
      this.push(filePath, lineNumber, lineText, isMatch);
      if (!isMatch) return false;
      this.matchCount++;
      if (this.matchCount >= this.limit) {
        this.limitHit = true;
        this.trailingContextEnd = lineNumber + this.context;
      }
      return false;
    }
    const inWindow = filePath === this.lastFile && lineNumber <= this.trailingContextEnd;
    // A match inside the last match's trailing context is shown as context.
    if (inWindow) this.push(filePath, lineNumber, lineText, false);
    // Only another match proves that the limit cut results off.
    if (isMatch) this.matchLimitReached = true;
    if (this.matchLimitReached && !(inWindow && lineNumber < this.trailingContextEnd)) this.done = true;
    return this.done;
  }

  finish(): { text: string; details: Record<string, unknown> | undefined } {
    if (this.matchCount === 0) return { text: "No matches found", details: undefined };
    const truncation = truncateHead(this.outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    truncation.totalLines = this.outputLineCount;
    truncation.totalBytes = this.outputBytes - 1;
    let text = truncation.content;
    const details: Record<string, unknown> = {};
    const notices: string[] = [];
    if (this.matchLimitReached) {
      notices.push(`${this.limit} matches limit reached. Use limit=${this.limit * 2} for more, or refine pattern`);
      details.matchLimitReached = this.limit;
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      details.truncation = truncation;
    }
    if (this.linesTruncated) {
      notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
      details.linesTruncated = true;
    }
    if (notices.length) text += `\n\n[${notices.join(". ")}]`;
    return { text, details: Object.keys(details).length ? details : undefined };
  }
}

function globEscape(value: string): string {
  return value.replace(/[\\*?[\]{}]/g, "\\$&");
}

/**
 * One shell script that lists files below `dir` matching a glob: fd (or Debian's fdfind) when
 * installed, otherwise find. fd prints `dir`-prefixed paths; use `parseFindOutput` to relativize.
 */
export function buildFindScript(pattern: string, dir: string, limit: number): string {
  const root = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  // fd's full paths never contain "/./", so "./src/*.ts" would find nothing.
  const effective = pattern.replace(/^(?:\.\/)+/, "");
  const isPathPattern = effective.includes("/");
  // fd's smart case: an all-lowercase pattern matches case-insensitively.
  const lower = effective === effective.toLowerCase();
  const isRelativePathPattern = isPathPattern && !effective.startsWith("/");

  const fdArgs = ["--color=never", "--hidden", "--no-require-git", "--exclude", "node_modules", "--exclude", ".git", "--glob", "--max-results", String(limit)];
  let fdPattern = effective;
  if (isPathPattern) fdArgs.push("--full-path");
  if (isRelativePathPattern) {
    // fd matches the absolute path, so a relative pattern is anchored with the glob-escaped search root.
    fdPattern = `${globEscape(root.replace(/\/+$/, ""))}/${effective}`;
    if (lower) fdArgs.push("--ignore-case");
  }
  const fd = `${fdArgs.join(" ")} -- ${quote(fdPattern)} ${quote(root)}`;

  // find -path lets '*' cross '/', so '**/' collapses to '*'.
  const findPattern = effective.replace(/\*\*\/?/g, "*");
  const matcher = isPathPattern
    ? `${lower ? "-ipath" : "-path"} ${quote(isRelativePathPattern ? `${globEscape(root)}/${findPattern}` : findPattern)}`
    : `${lower ? "-iname" : "-name"} ${quote(findPattern)}`;
  const find = `find ${quote(root)} -mindepth 1 \\( -name node_modules -o -name .git \\) -prune -o ${matcher} -print | head -n ${limit}`;
  return `if command -v fd >/dev/null 2>&1; then fd ${fd}; elif command -v fdfind >/dev/null 2>&1; then fdfind ${fd}; else ${find}; fi`;
}

/** Splits find/fd output into paths relative to `dir`. */
export function parseFindOutput(output: string, dir: string): string[] {
  const root = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const results: string[] = [];
  for (const raw of output.split("\n")) {
    let line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (line.startsWith(prefix)) line = line.slice(prefix.length);
    else if (line === root || line === `${root}/`) continue;
    line = line.replace(/^(?:\.\/)+/, "");
    if (line) results.push(line);
  }
  return results;
}
