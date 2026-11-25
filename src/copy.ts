/**
 * Pure helpers for the `copy` action and `/remote copy`: endpoint syntax and argument parsing.
 * The transfer itself is in transfer.ts.
 */

import { LOCAL_FOCUS } from "./catalog.ts";

/** Largest file `copy` moves (checked on the source before and while streaming). */
export const MAX_COPY_BYTES = 50 * 1024 * 1024;

/** `local:<path>` or `<project>:<path>`; `project` is "local" or a project name, not yet checked against the session. */
export interface CopyEndpoint { project: string; path: string }

export function parseCopyEndpoint(value: unknown, param: "from" | "to"): CopyEndpoint {
  const text = typeof value === "string" ? value.trim() : "";
  const colon = text.indexOf(":");
  const project = colon > 0 ? text.slice(0, colon).trim() : "";
  const path = colon > 0 ? text.slice(colon + 1) : "";
  if (!project || !path.trim()) {
    throw new Error(`${param} must be ${LOCAL_FOCUS}:<path> or <project>:<path>${text ? `, got "${text}"` : ""}`);
  }
  return { project, path };
}

/** `/remote copy FROM TO [--overwrite]` (already split into words; the flag may appear anywhere). */
export function parseCopyArgs(words: string[]): { from: string; to: string; overwrite: boolean } {
  const overwrite = words.includes("--overwrite");
  const rest = words.filter((word) => word !== "--overwrite");
  const unknown = rest.find((word) => word.startsWith("--"));
  if (unknown || rest.length !== 2) throw new Error(`${unknown ? `Unknown option ${unknown}. ` : ""}Usage: /remote copy FROM TO [--overwrite] (FROM and TO are local:<path> or <project>:<path>)`);
  return { from: rest[0]!, to: rest[1]!, overwrite };
}

export const copyDirectoryMessage = (label: string): string =>
  `Source is a directory: ${label}. copy handles regular files only; for a directory, use bash with tar (for example tar -cf - -C DIR . on one side and tar -xf - -C DIR on the other).`;

export const copyTooLargeMessage = (label: string, sizeText: string, limitText: string): string =>
  `Source is ${sizeText}, above the ${limitText} copy limit: ${label}. Use bash (scp, rsync, or tar over ssh) for larger files.`;
