/**
 * Global catalog of named remote projects (ssh-remote-config.json, version 2).
 *
 * Pure module: no Pi runtime imports, so it can be reused outside Pi. It loads, normalizes, validates, and
 * saves the catalog, migrates the version 1 endpoint-based file, and parses the user-facing argument formats.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shellWords } from "./shell.ts";
import { cacheId, parseSshCommand } from "./ssh/config.ts";
import { migrateMemories, type MemorySource } from "./memory.ts";

export type Guard = "readonly" | "confirm";

export interface Project {
  ssh: string;
  cwd: string;
  note?: string;
  guard?: Guard;
  /** Informational local checkout path; displayed only. */
  local?: string;
  forwards?: string[];
}

export interface Settings {
  displayLines?: number;
  readMaxLines?: number;
  readMaxBytes?: number;
  execMaxLines?: number;
  execMaxBytes?: number;
  turnMaxBytes?: number;
}

export interface Catalog extends Settings {
  projects: Record<string, Project>;
}

export interface ForwardSpec {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export const HOME_CWD = "~";
export const LOCAL_FOCUS = "local";
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CATALOG_VERSION = 2;
export const DEFAULT_DISPLAY_LINES = 5;
export const MAX_DISPLAY_LINES = 50;
export const DEFAULT_READ_MAX_LINES = 400;
export const DEFAULT_READ_MAX_BYTES = 16 * 1024;
export const DEFAULT_EXEC_MAX_LINES = 200;
export const DEFAULT_EXEC_MAX_BYTES = 8 * 1024;
export const DEFAULT_TURN_MAX_BYTES = 32 * 1024;
export const MIN_MODEL_OUTPUT_BYTES = 1024;
// Hard ceilings: Pi's DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES, duplicated so this module needs no Pi runtime.
export const HARD_MAX_LINES = 2000;
export const HARD_MAX_BYTES = 50 * 1024;

const SETTING_KEYS = ["displayLines", "readMaxLines", "readMaxBytes", "execMaxLines", "execMaxBytes", "turnMaxBytes"] as const;

export function parseForwardSpec(value: string): ForwardSpec {
  const match = value.match(/^(\d+):([^:]+):(\d+)$/);
  if (!match) throw new Error(`Invalid port-forward specification: ${value}; expected LOCAL_PORT:REMOTE_HOST:REMOTE_PORT`);
  const localPort = Number(match[1]);
  const remoteHost = match[2]!;
  const remotePort = Number(match[3]);
  if (![localPort, remotePort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error(`Port out of range in forwarding specification: ${value}`);
  }
  return { localPort, remoteHost, remotePort };
}

export const serializeForward = (spec: ForwardSpec): string => `${spec.localPort}:${spec.remoteHost}:${spec.remotePort}`;

function parseBoundedInteger(value: unknown, label: string, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export const parseDisplayLines = (value: unknown): number => parseBoundedInteger(value, "Display lines", MAX_DISPLAY_LINES);
export const parseOutputLines = (value: unknown, label: string): number => parseBoundedInteger(value, label, HARD_MAX_LINES);

export function parseOutputBytes(value: unknown, label: string, maximum = HARD_MAX_BYTES): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_MODEL_OUTPUT_BYTES || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${MIN_MODEL_OUTPUT_BYTES} to ${maximum}`);
  }
  return parsed;
}

const orDefault = <T>(parse: () => T, fallback: T): T => { try { return parse(); } catch { return fallback; } };

export function configuredDisplayLines(settings: Settings): number {
  return orDefault(() => parseDisplayLines(settings.displayLines ?? DEFAULT_DISPLAY_LINES), DEFAULT_DISPLAY_LINES);
}

export function configuredOutputLimits(settings: Settings) {
  return {
    readMaxLines: orDefault(() => parseOutputLines(settings.readMaxLines ?? DEFAULT_READ_MAX_LINES, "Read max lines"), DEFAULT_READ_MAX_LINES),
    readMaxBytes: orDefault(() => parseOutputBytes(settings.readMaxBytes ?? DEFAULT_READ_MAX_BYTES, "Read max bytes"), DEFAULT_READ_MAX_BYTES),
    execMaxLines: orDefault(() => parseOutputLines(settings.execMaxLines ?? DEFAULT_EXEC_MAX_LINES, "Exec max lines"), DEFAULT_EXEC_MAX_LINES),
    execMaxBytes: orDefault(() => parseOutputBytes(settings.execMaxBytes ?? DEFAULT_EXEC_MAX_BYTES, "Exec max bytes"), DEFAULT_EXEC_MAX_BYTES),
    turnMaxBytes: orDefault(() => parseOutputBytes(settings.turnMaxBytes ?? DEFAULT_TURN_MAX_BYTES, "Turn max bytes", HARD_MAX_BYTES * 4), DEFAULT_TURN_MAX_BYTES),
  };
}

function normalizeSettings(raw: Record<string, unknown>): Settings {
  const settings: Settings = {};
  const take = (key: keyof Settings, parse: () => number) => {
    if (raw[key] === undefined) return;
    try { settings[key] = parse(); } catch { /* invalid values fall back to defaults */ }
  };
  take("displayLines", () => parseDisplayLines(raw.displayLines));
  take("readMaxLines", () => parseOutputLines(raw.readMaxLines, "Read max lines"));
  take("readMaxBytes", () => parseOutputBytes(raw.readMaxBytes, "Read max bytes"));
  take("execMaxLines", () => parseOutputLines(raw.execMaxLines, "Exec max lines"));
  take("execMaxBytes", () => parseOutputBytes(raw.execMaxBytes, "Exec max bytes"));
  take("turnMaxBytes", () => parseOutputBytes(raw.turnMaxBytes, "Turn max bytes", HARD_MAX_BYTES * 4));
  return settings;
}

// ---- names -----------------------------------------------------------------------------------------------

export function validateProjectName(name: unknown): string {
  if (typeof name !== "string" || !name) throw new Error("A project name is required");
  if (name === LOCAL_FOCUS) throw new Error(`"${LOCAL_FOCUS}" is reserved for the local machine`);
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid project name "${name}": use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (max 64 characters)`);
  }
  return name;
}

const sanitizeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);

const SSH_OPTIONS_WITH_VALUE = new Set(["-p", "-l", "-i", "-J", "-o"]);

function sshPositionals(ssh: string): string[] {
  const words = shellWords(ssh).slice(1);
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (SSH_OPTIONS_WITH_VALUE.has(word)) i++;
    else if (!word.startsWith("-")) positional.push(word);
  }
  return positional;
}

/** Derives a catalog name from an ssh command: the alias for `ssh <alias>`, otherwise `<user>-<host>`. */
export function projectNameForSsh(ssh: string, taken: Iterable<string> = [], fallbackIdentity?: string): string {
  const used = new Set(taken);
  used.add(LOCAL_FOCUS);
  let base = "";
  try {
    const positional = sshPositionals(ssh);
    if (positional.length === 1 && !positional[0]!.includes("@")) base = sanitizeName(positional[0]!);
    else {
      try { const parsed = parseSshCommand(ssh); base = sanitizeName(`${parsed.username}-${parsed.host}`); }
      catch { base = sanitizeName(fallbackIdentity ?? positional.at(-1) ?? ""); }
    }
  } catch { base = sanitizeName(fallbackIdentity ?? ""); }
  if (!base) base = "project";
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}-${n}`;
  return name;
}

// ---- normalization ---------------------------------------------------------------------------------------

const oneLine = (value: string): string => value.replace(/\s*[\r\n]+\s*/g, " ").trim();

function normalizeProject(raw: unknown): Project | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  const ssh = typeof p.ssh === "string" ? p.ssh.trim() : "";
  if (!ssh) return undefined;
  const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : HOME_CWD;
  const note = typeof p.note === "string" ? oneLine(p.note) : "";
  const local = typeof p.local === "string" ? p.local.trim() : "";
  const forwards = Array.isArray(p.forwards) ? p.forwards.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : [];
  return {
    ssh, cwd,
    ...(note ? { note } : {}),
    ...(p.guard === "readonly" || p.guard === "confirm" ? { guard: p.guard } : {}),
    ...(local ? { local } : {}),
    ...(forwards.length ? { forwards } : {}),
  };
}

export function normalizeCatalog(raw: unknown): Catalog {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const projects: Record<string, Project> = {};
  if (source.projects && typeof source.projects === "object") {
    for (const [name, value] of Object.entries(source.projects)) {
      if (!NAME_PATTERN.test(name) || name === LOCAL_FOCUS) continue;
      const project = normalizeProject(value);
      if (project) projects[name] = project;
    }
  }
  return { projects, ...normalizeSettings(source) };
}

// ---- version 1 migration ---------------------------------------------------------------------------------

interface V1Endpoint { sshCommand?: unknown; remoteCwd?: unknown; forwards?: unknown; note?: unknown; memory?: unknown }

function commandFromEndpointKey(key: string): string | undefined {
  const match = key.match(/^([^@]+)@(.+):(\d+)$/);
  return match ? `ssh ${match[1]}@${match[2]} -p ${match[3]}` : undefined;
}

export interface V1Migration { catalog: Catalog; memories: MemorySource[] }

/** Converts a parsed version 1 file (endpoints keyed `user@host:port`) into a catalog and the memory sources to carry over. */
export function migrateV1(raw: Record<string, unknown>): V1Migration {
  const endpoints: Record<string, V1Endpoint> = {};
  for (const [key, value] of Object.entries((raw.endpoints && typeof raw.endpoints === "object" ? raw.endpoints : {}) as Record<string, unknown>)) {
    if (value && typeof value === "object") endpoints[key] = value as V1Endpoint;
  }
  if (typeof raw.sshCommand === "string" && raw.sshCommand.trim()) {
    let key = raw.sshCommand;
    try { key = cacheId(parseSshCommand(raw.sshCommand)); } catch { /* keep the raw command as the key */ }
    endpoints[key] = {
      ...(endpoints[key] ?? {}),
      sshCommand: raw.sshCommand,
      ...(raw.remoteCwd !== undefined ? { remoteCwd: raw.remoteCwd } : {}),
      ...(raw.forwards !== undefined ? { forwards: raw.forwards } : {}),
    };
  }
  const legacyMemories = (raw.serverMemories && typeof raw.serverMemories === "object" ? raw.serverMemories : {}) as Record<string, unknown>;
  const projects: Record<string, Project> = {};
  const memories: MemorySource[] = [];
  for (const [key, endpoint] of Object.entries(endpoints)) {
    const ssh = (typeof endpoint.sshCommand === "string" && endpoint.sshCommand.trim()) || commandFromEndpointKey(key);
    if (!ssh) continue;
    const identity = key.replace(/:\d+$/, "");
    const name = projectNameForSsh(ssh, Object.keys(projects), identity);
    const project = normalizeProject({ ssh, cwd: endpoint.remoteCwd, note: endpoint.note, forwards: endpoint.forwards });
    if (!project) continue;
    projects[name] = project;
    // The old per-host memory files were named after the resolved `user@host`, which is also the endpoint key.
    const serverIds = new Set([identity]);
    try { const parsed = parseSshCommand(ssh); serverIds.add(`${parsed.username}@${parsed.host}`); } catch { /* the key identity remains */ }
    const legacy = [typeof endpoint.memory === "string" ? endpoint.memory : undefined, ...[...serverIds].map((id) => legacyMemories[id])]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    memories.push({ name, serverIds: [...serverIds], ...(legacy ? { legacy: legacy.trim() } : {}) });
  }
  return { catalog: { projects, ...normalizeSettings(raw) }, memories };
}

// ---- file io ---------------------------------------------------------------------------------------------

export const emptyCatalog = (): Catalog => ({ projects: {} });

function readRaw(file: string): { raw?: Record<string, unknown>; error?: string } {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { error: (error as Error).message }; }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "expected a JSON object" };
    return { raw };
  } catch (error) { return { error: (error as Error).message }; }
}

const isV1Shape = (raw: Record<string, unknown>): boolean => raw.version === undefined && Object.keys(raw).length > 0;

export function backupPath(file: string): string {
  return file.replace(/\.json$/, "") + ".v1.backup.json";
}

export function loadCatalog(file: string): Catalog {
  const { raw } = readRaw(file);
  if (!raw) return emptyCatalog();
  if (raw.version === CATALOG_VERSION) return normalizeCatalog(raw);
  if (raw.version === undefined) return migrateV1(raw).catalog;
  return emptyCatalog(); // written by a newer version
}

function atomicWriteFileSync(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

/** Saves the catalog. Refuses to overwrite a file that cannot be parsed or was written by a newer version. */
export function saveCatalog(file: string, catalog: Catalog): void {
  const { raw, error } = readRaw(file);
  if (error) throw new Error(`${file} is not valid JSON (${error}); fix or remove it before saving`);
  if (raw && raw.version !== undefined && raw.version !== CATALOG_VERSION) throw new Error(`${file} was written by a newer version (version ${String(raw.version)})`);
  if (raw && isV1Shape(raw) && !existsSync(backupPath(file))) copyFileSync(file, backupPath(file));
  const normalized = normalizeCatalog(catalog);
  const out: Record<string, unknown> = { version: CATALOG_VERSION, projects: normalized.projects };
  for (const key of SETTING_KEYS) if (normalized[key] !== undefined) out[key] = normalized[key];
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/**
 * Rewrites a version 1 file as version 2 (after backing up the original and carrying memories over).
 * Idempotent; never throws and never touches a file it cannot parse. Returns warnings for the caller to surface.
 */
export function migrateCatalogFile(file: string, memoryDir: string): string[] {
  const warnings: string[] = [];
  try {
    const { raw, error } = readRaw(file);
    if (error) return [`SSH remote configuration ${file} is not valid JSON (${error}); it was left untouched and no projects are loaded`];
    if (!raw || !isV1Shape(raw)) return [];
    const { catalog, memories } = migrateV1(raw);
    warnings.push(...migrateMemories(memoryDir, memories));
    saveCatalog(file, catalog);
    warnings.push(`SSH remote configuration migrated to projects (${Object.keys(catalog.projects).length}); the original is saved as ${backupPath(file)}`);
  } catch (error) {
    warnings.push(`SSH remote configuration migration failed: ${(error as Error).message}`);
  }
  return warnings;
}

// ---- user-facing argument parsing ------------------------------------------------------------------------

/** Accepts a full `ssh ...` command or a bare target such as `user@host` or an alias. */
export function sshFromArg(value: string): string {
  const trimmed = value.trim();
  return trimmed === "ssh" || trimmed.startsWith("ssh ") ? trimmed : `ssh ${trimmed}`;
}

export interface ProjectFields { ssh?: string; cwd?: string; note?: string; guard?: string; local?: string; forwards?: string }

export const PROJECT_FIELDS = ["ssh", "cwd", "note", "guard", "local", "forwards"] as const;

/** Applies validated field changes; an empty string clears an optional field. */
export function applyProjectFields(base: Project | undefined, fields: ProjectFields): Project {
  const next: Project = { ssh: base?.ssh ?? "", cwd: base?.cwd ?? "", ...(base?.note ? { note: base.note } : {}), ...(base?.guard ? { guard: base.guard } : {}), ...(base?.local ? { local: base.local } : {}), ...(base?.forwards ? { forwards: base.forwards } : {}) };
  if (fields.ssh !== undefined) {
    const ssh = sshFromArg(fields.ssh);
    if (ssh === "ssh") throw new Error("ssh must name a host, for example ssh user@host -p 22 or an alias from ~/.ssh/config");
    parseSshCommand(ssh);
    next.ssh = ssh;
  }
  if (fields.cwd !== undefined) {
    if (!fields.cwd.trim()) throw new Error("cwd cannot be empty; use ~ for the remote home directory");
    next.cwd = fields.cwd.trim();
  }
  const optional = (key: "note" | "local", value: string | undefined) => {
    if (value === undefined) return;
    const text = key === "note" ? oneLine(value) : value.trim();
    if (text) next[key] = text; else delete next[key];
  };
  optional("note", fields.note);
  optional("local", fields.local);
  if (fields.guard !== undefined) {
    const guard = fields.guard.trim().toLowerCase();
    if (!guard) delete next.guard;
    else if (guard === "readonly" || guard === "confirm") next.guard = guard;
    else throw new Error(`guard must be "readonly" or "confirm" (empty clears it)`);
  }
  if (fields.forwards !== undefined) {
    const values = fields.forwards.split(/[\s,]+/).filter(Boolean);
    values.forEach(parseForwardSpec);
    if (values.length) next.forwards = values; else delete next.forwards;
  }
  if (!next.ssh) throw new Error("ssh is required");
  if (!next.cwd) throw new Error("cwd is required (use ~ for the remote home directory)");
  return next;
}

/** `/remote add NAME SSH CWD [NOTE...]` */
export function parseAddArgs(rest: string): { name: string; fields: Required<Pick<ProjectFields, "ssh" | "cwd">> & Pick<ProjectFields, "note"> } {
  const words = shellWords(rest);
  if (words.length < 3) throw new Error('Usage: /remote add NAME SSH CWD [NOTE...]  (quote a full ssh command, for example "ssh -p 2222 me@host")');
  const [name, ssh, cwd, ...note] = words as [string, string, string, ...string[]];
  return { name, fields: { ssh, cwd, ...(note.length ? { note: note.join(" ") } : {}) } };
}

/** `/remote edit NAME key=value...` (a key with an empty value clears an optional field). */
export function parseEditArgs(rest: string): { name: string; fields: ProjectFields } {
  const [name, ...pairs] = shellWords(rest);
  if (!name || !pairs.length) throw new Error(`Usage: /remote edit NAME key=value...  (keys: ${PROJECT_FIELDS.join(", ")}; "key=" clears it)`);
  const fields: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = at < 0 ? pair : pair.slice(0, at);
    if (at < 0 || !(PROJECT_FIELDS as readonly string[]).includes(key)) throw new Error(`Expected key=value with key one of ${PROJECT_FIELDS.join(", ")}: ${pair}`);
    fields[key] = pair.slice(at + 1);
  }
  return { name, fields };
}

/** Error text for an unknown project: lists up to five projects whose name, ssh, or note contains the query. */
export function unknownProjectMessage(catalog: Catalog, query: string): string {
  const needle = query.trim().toLowerCase();
  const candidates = needle
    ? Object.entries(catalog.projects)
      .filter(([name, p]) => [name, p.ssh, p.note ?? ""].some((text) => text.toLowerCase().includes(needle)))
      .slice(0, 5)
    : [];
  if (!candidates.length) return `No remote project named "${query}". Use remote(action="list") to see saved projects.`;
  const list = candidates.map(([name, p]) => `${name} (${p.ssh}, ${p.cwd})`).join("; ");
  return `No remote project named "${query}". Did you mean: ${list}? Use the exact name.`;
}
