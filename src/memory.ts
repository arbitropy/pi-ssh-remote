/**
 * Per-project memory files: `<memoryDir>/projects/<name>.json` = {"project": name, "entries": [{id, content}]}.
 *
 * Pure module (no Pi runtime). It also migrates the older per-host files (named after the base64url of the
 * resolved `user@host`) and the legacy `serverMemories` text into project files; old files are never deleted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSshCommand } from "./ssh/config.ts";

// Same rule as the catalog NAME_PATTERN; repeated here so project names can never escape the memory directory.
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface MemoryEntry { id: string; content: string }
export interface MemoryFile { project: string; entries: MemoryEntry[] }

/** A project whose memory may exist under older names: resolved `user@host` ids and legacy free text. */
export interface MemorySource { name: string; serverIds: string[]; legacy?: string }

export function projectMemoryPath(memoryDir: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid project name: ${name}`);
  return join(memoryDir, "projects", `${name}.json`);
}

export const hostMemoryPath = (memoryDir: string, serverId: string): string =>
  join(memoryDir, `${Buffer.from(serverId, "utf8").toString("base64url")}.json`);

export function serverIdsForSsh(ssh: string): string[] {
  try { const parsed = parseSshCommand(ssh); return [`${parsed.username}@${parsed.host}`]; }
  catch { return []; }
}

function writeMemoryFile(path: string, memory: MemoryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(memory, null, 2) + "\n", { mode: 0o600 });
}

function parseEntries(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value)) throw new Error("expected an object with an entries array");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.content !== "string" || !entry.content.trim()) {
      throw new Error(`entry ${index + 1} must contain non-empty string id and content fields`);
    }
    const id = entry.id.trim();
    if (ids.has(id)) throw new Error(`duplicate entry id: ${id}`);
    ids.add(id);
    return { id, content: entry.content.trim() };
  });
}

const legacyEntries = (text: string): MemoryEntry[] =>
  text.trim().split(/\n\s*\n/).map((content) => content.trim()).filter(Boolean)
    .map((content, index) => ({ id: `legacy-${String(index + 1).padStart(3, "0")}`, content }));

/** Copies older memory into any project file that does not exist yet. Returns warnings; never throws. */
export function migrateMemories(memoryDir: string, sources: MemorySource[]): string[] {
  const warnings: string[] = [];
  for (const source of sources) {
    try {
      const target = projectMemoryPath(memoryDir, source.name);
      if (existsSync(target)) continue;
      const old = source.serverIds.map((id) => hostMemoryPath(memoryDir, id)).find((path) => existsSync(path));
      let entries: MemoryEntry[] | undefined;
      if (old) {
        try { entries = parseEntries(JSON.parse(readFileSync(old, "utf8")).entries); }
        catch (error) { warnings.push(`Memory file ${old} was not migrated to project ${source.name}: ${(error as Error).message}`); }
      }
      if (!entries && source.legacy) entries = legacyEntries(source.legacy);
      if (entries) writeMemoryFile(target, { project: source.name, entries });
    } catch (error) { warnings.push(`Memory migration for project ${source.name} failed: ${(error as Error).message}`); }
  }
  return warnings;
}

/** Returns the project's memory file path, importing older per-host memory or creating an empty file when missing. */
export function ensureProjectMemory(memoryDir: string, name: string, ssh?: string): string {
  const path = projectMemoryPath(memoryDir, name);
  if (!existsSync(path)) {
    if (ssh) migrateMemories(memoryDir, [{ name, serverIds: serverIdsForSsh(ssh) }]);
    if (!existsSync(path)) writeMemoryFile(path, { project: name, entries: [] });
  }
  return path;
}

export function loadProjectMemory(memoryDir: string, name: string): MemoryFile | undefined {
  const path = projectMemoryPath(memoryDir, name);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MemoryFile>;
  if (!parsed || parsed.project !== name) throw new Error("expected an object with the matching project and an entries array");
  return { project: name, entries: parseEntries(parsed.entries) };
}

export function formatMemoryEntries(memory: MemoryFile | undefined): string {
  if (!memory?.entries.length) return "No entries.";
  return memory.entries.map((entry) => `[${entry.id}]\n${entry.content}`).join("\n\n");
}

/** The project's memory as the model should see it: path, entries, and the parse error when the file is invalid. */
export function projectMemorySnapshot(memoryDir: string, name: string): { path: string; entries: MemoryEntry[]; error?: string } {
  const path = projectMemoryPath(memoryDir, name);
  try { return { path, entries: loadProjectMemory(memoryDir, name)?.entries ?? [] }; }
  catch (error) { return { path, entries: [], error: (error as Error).message }; }
}
