/**
 * Remote project instructions: AGENTS.md / CLAUDE.md files found on the remote, discovered the way Pi
 * discovers them locally, fetched in one round trip, and formatted for the system prompt and tool results.
 *
 * Pure module (no Pi runtime, no SSH): it builds the remote script, parses its output, and renders text.
 *
 * Discovery mirrors Pi's `loadContextFileFromDir` / `loadProjectContextFiles` (resource-loader.js): for every
 * directory from the session cwd up to `/`, the first existing regular file among CONTEXT_FILE_NAMES, ordered
 * outermost ancestor first. Known difference: Pi's git-worktree shadowing logic is not reproduced.
 */

import { randomBytes } from "node:crypto";
import { quote } from "./shell.ts";

/** Candidate file names per directory, in priority order (the first readable regular file wins). */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
export const MAX_INSTRUCTION_FILE_BYTES = 32 * 1024;
export const MAX_INSTRUCTION_TOTAL_BYTES = 64 * 1024;
/** Bound for an explicit fetch (connect, focus, chdir, reconnect). */
export const CONTEXT_FETCH_TIMEOUT_SECONDS = 10;
/** Bound for the refresh that runs inside before_agent_start. */
export const CONTEXT_PROMPT_TIMEOUT_MS = 5_000;
/** A cached context older than this is refreshed before the next agent run. */
export const CONTEXT_MAX_AGE_MS = 5 * 60_000;
/** After a failed refresh, do not try again for this long (so a hung remote cannot stall every turn). */
export const CONTEXT_RETRY_BACKOFF_MS = 30_000;

export interface InstructionFile {
  /** Absolute path on the remote. */
  path: string;
  /** Decoded content without BOM, cut to the byte caps (with a trailing truncation note when cut). */
  content: string;
  /** Bytes of the file that are included / the file's size on the remote. */
  includedBytes: number;
  totalBytes: number;
}

export interface MemorySnapshot { path: string; entries: { id: string; content: string }[]; error?: string }

export const newDelimiter = (): string => `__PI_SSH_CTX_${randomBytes(12).toString("hex")}__`;

/**
 * POSIX sh script that walks from `cwd` to `/` and prints one line per instruction file, nearest directory first:
 *
 *   <delimiter> F <size-in-bytes> <hex path> <hex content, at most the caps>
 *
 * followed by `<delimiter> END`. Hex (od, which POSIX guarantees) keeps the framing independent of file content;
 * the delimiter only lets the parser ignore anything a login shell prints around the script's own output.
 * The script stops reading content once the total cap is spent, but still lists the remaining files.
 */
export function buildContextScript(cwd: string, delimiter = newDelimiter(), limits = { file: MAX_INSTRUCTION_FILE_BYTES, total: MAX_INSTRUCTION_TOTAL_BYTES }): string {
  if (!cwd.startsWith("/")) throw new Error(`Instruction discovery needs an absolute directory: ${cwd}`);
  if (!/^[A-Za-z0-9_]+$/.test(delimiter)) throw new Error("Invalid delimiter");
  const names = CONTEXT_FILE_NAMES.join(" ");
  return [
    `D=${delimiter}`,
    `d=${quote(cwd)}`,
    "total=0",
    "hex() { od -An -v -tx1 | tr -d ' \\n'; }",
    "while :; do",
    `  for n in ${names}; do`,
    '    f="${d%/}/$n"',
    '    if [ -f "$f" ] && [ -r "$f" ]; then',
    "      size=$(wc -c < \"$f\" | tr -d ' ')",
    `      lim=${limits.file}; room=$((${limits.total} - total)); [ "$room" -lt "$lim" ] && lim=$room`,
    '      printf \'%s F %s %s \' "$D" "$size" "$(printf %s "$f" | hex)"',
    '      head -c "$lim" "$f" | hex; echo',
    '      if [ "$size" -lt "$lim" ]; then total=$((total + size)); else total=$((total + lim)); fi',
    "      break",
    "    fi",
    "  done",
    '  [ "$d" = / ] && break',
    '  d=${d%/*}; [ -n "$d" ] || d=/',
    "done",
    'echo "$D END"',
  ].join("\n");
}

const isHex = (text: string): boolean => text.length % 2 === 0 && /^[0-9a-f]*$/.test(text);

// Cuts to at most `limit` bytes. When the result is a prefix of a longer file (`total`), a UTF-8 sequence
// that the cut left incomplete is dropped, so truncation never produces a replacement character.
function cutUtf8(bytes: Buffer, limit: number, total: number): Buffer {
  let end = Math.min(bytes.length, limit);
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end >= total) return bytes.subarray(0, end);
  for (let back = 1; back <= Math.min(3, end); back++) {
    const lead = bytes[end - back]!;
    if ((lead & 0xc0) === 0x80) continue; // continuation byte: keep looking for its lead
    const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    return bytes.subarray(0, length > back ? end - back : end);
  }
  return bytes.subarray(0, end);
}

/**
 * Parses the script's output into files ordered outermost ancestor first (the order Pi uses locally).
 * Applies the byte caps again (a remote that ignores them cannot inflate the prompt), strips a UTF-8 BOM, and
 * appends `[truncated: N of M bytes; read the file for the rest]` to every file the caps cut.
 * Throws when the output has no END line (the script did not finish).
 */
export function parseContextOutput(stdout: Buffer | string, delimiter: string, limits = { file: MAX_INSTRUCTION_FILE_BYTES, total: MAX_INSTRUCTION_TOTAL_BYTES }): InstructionFile[] {
  const text = typeof stdout === "string" ? stdout : stdout.toString("latin1");
  const files: InstructionFile[] = [];
  let finished = false;
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${delimiter} `)) continue;
    const parts = line.trimEnd().split(" ");
    if (parts[1] === "END") { finished = true; continue; }
    if (parts[1] !== "F") continue;
    const size = Number(parts[2]);
    const pathHex = parts[3] ?? "";
    const contentHex = parts[4] ?? "";
    if (!Number.isSafeInteger(size) || size < 0 || !pathHex || !isHex(pathHex) || !isHex(contentHex)) continue;
    const path = Buffer.from(pathHex, "hex").toString("utf8");
    const room = Math.max(0, Math.min(limits.file, limits.total - total));
    const kept = cutUtf8(Buffer.from(contentHex, "hex"), room, size);
    total += kept.length;
    const bom = kept.length >= 3 && kept[0] === 0xef && kept[1] === 0xbb && kept[2] === 0xbf;
    let content = (bom ? kept.subarray(3) : kept).toString("utf8");
    if (kept.length < size) content += `${content && !content.endsWith("\n") ? "\n" : ""}[truncated: ${kept.length} of ${size} bytes; read the file for the rest]`;
    files.push({ path, content, includedBytes: kept.length, totalBytes: size });
  }
  if (!finished) throw new Error("instruction discovery output was incomplete");
  return files.reverse(); // the script walks from the nearest directory outwards
}

/** The label that tells remote files from local ones in the system prompt and in tool results. */
export const instructionLabel = (project: string, path: string): string => `ssh://${project}${path}`;

/** Instruction files as Pi `contextFiles` entries (`{path, content}`) labelled for the project. */
export const toContextFiles = (project: string, files: InstructionFile[]): { path: string; content: string }[] =>
  files.map((file) => ({ path: instructionLabel(project, file.path), content: file.content }));

/** Instruction files as tagged blocks, for hosts without structured prompt options and for tool results. */
export const renderInstructionBlocks = (project: string, files: InstructionFile[]): string =>
  files.map((file) => `<instructions path="${instructionLabel(project, file.path)}">\n${file.content}\n</instructions>`).join("\n");

/** Same file set (paths only; the content of an unchanged path is already known to the model). */
export const sameInstructionPaths = (a: InstructionFile[], b: InstructionFile[]): boolean =>
  a.length === b.length && a.every((file, index) => file.path === b[index]!.path);

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The one-line summary the `/remote connect|focus` commands notify. */
export const contextSummary = (project: string, files: InstructionFile[], memoryEntries: number): string =>
  `Loaded ${plural(files.length, "instruction file", "instruction files")} and ${plural(memoryEntries, "memory entry", "memory entries")} for ${project}`;

/**
 * Text appended to a `connect` / `focus` tool result so the context is in the transcript when the agent
 * switches. Empty parts are omitted; when both are empty a single sentence says so. `memory` is left out
 * (undefined) when only the instruction files changed, for example after `chdir`.
 */
export function formatSwitchContext(project: string, files: InstructionFile[], memory: MemorySnapshot | undefined, options: { fetchError?: string } = {}): string {
  const parts: string[] = [];
  if (files.length) parts.push(`Project instructions for ${project} (apply while working on this project):\n${renderInstructionBlocks(project, files)}`);
  if (options.fetchError) parts.push(`Project instructions for ${project} could not be refreshed: ${options.fetchError}`);
  if (memory?.error) parts.push(`Project memory for ${project} (${memory.path}) is invalid JSON and must not be applied until repaired: ${memory.error}`);
  else if (memory?.entries.length) parts.push(`Project memory for ${project} (${memory.path}):\n${JSON.stringify(memory.entries, null, 2)}`);
  if (!parts.length) return "No project instructions or memory found.";
  return parts.join("\n");
}
