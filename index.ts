/**
 * Pi SSH Remote extension.
 *
 * A global catalog of named remote projects, a pooled SSH connection per host, and a session "focus":
 * while focus is a remote project, Pi's file and shell tools (and user `!` commands) run there over SSH.
 * This file wires the pieces into Pi: session state, tools, the /remote command, and events.
 */

import type { Client as SshClient, ClientChannel } from "ssh2";
import { existsSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  SettingsManager,
  DEFAULT_MAX_BYTES,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { quote, shellWords } from "./src/shell.ts";
import { parseSshCommand, poolKey, type ParsedSsh } from "./src/ssh/config.ts";
import { createSshAuthenticator, type SshCredentialCache } from "./src/ssh/auth.ts";
import { buildFindScript, buildGrepScript, GrepCollector, grepLimits, LineSplitter, parseFindOutput } from "./src/remote-search.ts";
import {
  HOME_CWD, LOCAL_FOCUS, MAX_DISPLAY_LINES, DEFAULT_READ_MAX_LINES, DEFAULT_READ_MAX_BYTES, DEFAULT_EXEC_MAX_LINES, DEFAULT_EXEC_MAX_BYTES,
  applyProjectFields, configuredDisplayLines, configuredOutputLimits, loadCatalog, migrateCatalogFile, parseAddArgs, parseDisplayLines,
  parseEditArgs, parseForwardSpec, parseOutputBytes, parseOutputLines, projectNameForSsh, saveCatalog, serializeForward,
  unknownProjectMessage, validateProjectName, type Catalog, type ForwardSpec, type ProjectFields,
} from "./src/catalog.ts";
import {
  ensureProjectMemory, formatMemoryEntries, loadProjectMemory, migrateMemories, projectMemoryPath, projectMemorySnapshot, serverIdsForSsh,
} from "./src/memory.ts";
import {
  buildContextScript, CONTEXT_FETCH_TIMEOUT_SECONDS, CONTEXT_MAX_AGE_MS, CONTEXT_PROMPT_TIMEOUT_MS, CONTEXT_RETRY_BACKOFF_MS, contextSummary,
  formatSwitchContext, instructionLabel, newDelimiter, parseContextOutput, renderInstructionBlocks, sameInstructionPaths, toContextFiles,
  type InstructionFile, type MemorySnapshot,
} from "./src/context.ts";
import {
  abortedError, DEFAULT_REMOTE_TIMEOUT_SECONDS, execRemote, execRemoteLimited, isDirectoryMode, isReconnectable, limitRemoteToolResult,
  MAX_REMOTE_TIMEOUT_SECONDS, missingAsFalse, openAbortableExec, parseRemoteTimeout, remoteCommandLine, REMOTE_SEARCH_TIMEOUT_SECONDS,
  runExecChannel, sftpCall, sftpStat, untilAborted, withSftp, writeRemoteFileAtomic,
  OUTPUT_FOOTER_RESERVE_BYTES,
} from "./src/exec.ts";
import { createKnownHosts, createPool, resolveCwd, type ConnectUi, type PoolConn } from "./src/pool.ts";
import { focusLabel, formatProjectList, projectMemorySection, remotePrompt, renderPromptSections, type RemoteView } from "./src/prompt.ts";
import { parseSessionState, SESSION_STATE_ENTRY_TYPE, type SessionState } from "./src/session.ts";
import { askSecret, NON_INTERACTIVE_DIALOG_TIMEOUT_MS, previewRemoteOutput, renderRemoteControlCall, renderRemoteControlResult } from "./src/render.ts";
import { remoteArgumentCompletions, suppressRemoteCompletionsBeforeSuffix } from "./src/complete.ts";

/** A project used in this session. `key`/`parsed` identify its pooled connection while connected. */
interface SessionProject {
  name: string;
  cwd: string;
  connected: boolean;
  key?: string;
  parsed?: ParsedSsh;
  /** Why the last project-instruction refresh failed; cleared by the next success. */
  contextError?: string;
}

interface ContextEntry { files: InstructionFile[]; fetchedAt: number }

interface ForwardEntry { project: string; spec: ForwardSpec; server: Server }

/** Process-level state carried across reload, /new and fork, which re-create the extension. */
interface CredentialCache extends SshCredentialCache {
  projectsResume?: { focus: string; projects: { name: string; cwd: string; connected: boolean; forwards?: string[] }[] };
}

/**
 * `before_agent_start` payload as hosts actually deliver it.
 *
 * Pi exposes mutable `systemPromptOptions` and replaces the prompt string with complete
 * overrides. Hosts that embed Pi extensions without that structure (omp routes them through a
 * legacy Pi shim) pass only the rendered `systemPrompt` blocks and expect a replacement, so both
 * fields are optional here.
 */
interface PromptSectionHost {
  systemPrompt?: string | string[];
  systemPromptOptions?: {
    cwd?: string;
    sections?: Record<string, string>;
    contextFiles?: { path: string; content: string }[];
  };
}

// Use Pi's agent dir so Windows follows USERPROFILE and PI_CODING_AGENT_DIR is honored.
const AGENT_DIR = getAgentDir();
const KNOWN_HOSTS_FILE = join(AGENT_DIR, "ssh-remote-known-hosts.json");
const CONFIG_FILE = join(AGENT_DIR, "ssh-remote-config.json");
const MEMORY_DIR = join(AGENT_DIR, "ssh-remote-memories");
const CACHE_KEY = "__piHpcCredentialCacheV1";
const FILE_ROUTING = "When the focus is a remote project, this tool operates on that project.";
const SHELL_ROUTING = "When the focus is a remote project, this tool runs in that project.";
const REMOTE_ACTIONS = ["list", "add", "edit", "remove", "connect", "disconnect", "focus", "status", "chdir", "memory", "forward", "unforward", "exec", "forget"] as const;
const cacheHost = globalThis as typeof globalThis & { [CACHE_KEY]?: CredentialCache };
const credentialCache = cacheHost[CACHE_KEY] ??= { passwords: new Map<string, string>(), keyPassphrases: new Map<string, string>() };
credentialCache.keyPassphrases ??= new Map<string, string>();

const firstLine = (text: string): string => text.split("\n")[0] ?? text;

export default function sshRemoteExtension(pi: ExtensionAPI) {
  // Migrate the version 1 catalog (and per-host memory) before anything reads it; warnings surface at session_start.
  const startupWarnings = migrateCatalogFile(CONFIG_FILE, MEMORY_DIR);
  try {
    const missing = Object.entries(loadCatalog(CONFIG_FILE).projects).filter(([name]) => !existsSync(projectMemoryPath(MEMORY_DIR, name)));
    startupWarnings.push(...migrateMemories(MEMORY_DIR, missing.map(([name, project]) => ({ name, serverIds: serverIdsForSsh(project.ssh) }))));
  } catch { /* memory import is best effort; the lazy path retries per project */ }

  const auth = createSshAuthenticator(credentialCache);
  const localCwd = process.cwd();
  const session: SessionProject[] = [];
  const forwards = new Map<number, ForwardEntry>();
  const reconnecting = new Map<string, Promise<PoolConn>>();
  // Remote instruction files per (project, session cwd), when each fetch was attempted, and fetches in flight.
  const contextCache = new Map<string, ContextEntry>();
  const contextAttempts = new Map<string, number>();
  const contextFetches = new Map<string, Promise<ContextEntry>>();
  let focus = LOCAL_FOCUS;
  let currentCtx: any;
  let sessionReady = false;
  let restoringSessionState = false;
  const turnBudget = { used: 0 };

  const pool = createPool({
    auth,
    knownHosts: createKnownHosts(KNOWN_HOSTS_FILE),
    onClose: (conn) => { void handleConnectionDrop(conn); },
  });

  // ---- session state -----------------------------------------------------------------------------------

  const catalog = (): Catalog => loadCatalog(CONFIG_FILE);
  const findSession = (name: string): SessionProject | undefined => session.find((p) => p.name === name);
  const focusedProject = (): SessionProject | undefined => focus === LOCAL_FOCUS ? undefined : findSession(focus);
  const connectedUsing = (key: string | undefined): SessionProject[] => key ? session.filter((p) => p.connected && p.key === key) : [];

  const view = (projects = catalog().projects): RemoteView => ({
    projects,
    session: session.map(({ name, cwd, connected }) => ({ name, cwd, connected })),
    focus,
    localCwd,
  });

  const describe = (rt: SessionProject, projects = catalog().projects): string =>
    `${rt.name} (${rt.parsed?.command ?? projects[rt.name]?.ssh ?? "not saved"}, ${rt.cwd})`;

  const requireConnected = (rt: SessionProject): SessionProject => {
    if (!rt.connected) {
      throw new Error(`Remote project ${rt.name} is not connected; reconnect with remote(action="connect", name="${rt.name}") or switch focus to local`);
    }
    return rt;
  };

  const sessionState = (): SessionState => ({
    version: 2,
    focus,
    projects: session.map(({ name, cwd, connected }) => ({ name, cwd, connected })),
  });

  const persistSessionState = (): void => {
    if (!sessionReady || restoringSessionState) return;
    pi.appendEntry(SESSION_STATE_ENTRY_TYPE, sessionState());
  };

  const loadSessionState = (ctx: any): SessionState | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as any;
      if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) continue;
      return parseSessionState(entry.data, catalog());
    }
    return undefined;
  };

  const status = (ctx: any = currentCtx) => {
    if (!ctx) return;
    currentCtx = ctx;
    if (!session.length) return ctx.ui.setStatus("ssh-remote", undefined);
    const theme = ctx.ui.theme;
    const focused = focusedProject();
    const head = focused
      ? theme.fg(focused.connected ? "accent" : "warning", `${focused.connected ? "" : "○ "}${focused.name}:${focused.cwd}`)
      : theme.fg("accent", LOCAL_FOCUS);
    const others = session.filter((p) => p !== focused).map((p) => theme.fg(p.connected ? "accent" : "muted", `${p.connected ? "●" : "○"} ${p.name}`));
    ctx.ui.setStatus("ssh-remote", [head, ...others].join("  "));
  };

  const transientStatus = (text: string) => {
    if (currentCtx) currentCtx.ui.setStatus("ssh-remote", currentCtx.ui.theme.fg("warning", text));
  };

  const uiFor = (ctx: any): ConnectUi => ({
    confirm: (title, message) => ctx.ui.confirm(title, message, ctx.mode !== "tui" ? { timeout: NON_INTERACTIVE_DIALOG_TIMEOUT_MS } : undefined),
    secret: (label, placeholder) => askSecret(ctx, label, placeholder),
  });

  // ---- connections -------------------------------------------------------------------------------------

  const closeIfUnused = (key: string | undefined) => {
    if (key && !connectedUsing(key).length) pool.close(key);
  };

  // Replaces a dead pooled connection (cached credentials only, no prompts) and re-resolves the cwd of every
  // connected project that uses it. Concurrent callers share one attempt per host.
  const reconnectConn = (rt: SessionProject, stale: SshClient | undefined): Promise<PoolConn> => {
    const key = rt.key!;
    const inflight = reconnecting.get(key);
    if (inflight) return inflight;
    const attempt = (async () => {
      const conn = await pool.reconnect(rt.parsed!, stale);
      const notes: string[] = [];
      for (const project of connectedUsing(key)) {
        const resolved = await resolveCwd(conn.client, project.cwd);
        project.cwd = resolved.cwd;
        if (resolved.unavailableCwd) notes.push(`${project.name}: directory unavailable: ${resolved.unavailableCwd}; using ${resolved.cwd}`);
      }
      status();
      persistSessionState();
      for (const project of connectedUsing(key)) void loadContext(project, conn.client); // in the background; never fails
      if (currentCtx) {
        const names = connectedUsing(key).map((p) => p.name).join(", ");
        currentCtx.ui.notify(notes.length ? `SSH remote reconnected (${names}); ${notes.join("; ")}` : `SSH remote reconnected automatically: ${names}`, notes.length ? "warning" : "info");
      }
      return conn;
    })().finally(() => reconnecting.delete(key));
    reconnecting.set(key, attempt);
    return attempt;
  };

  async function handleConnectionDrop(conn: PoolConn): Promise<void> {
    const users = connectedUsing(conn.key);
    if (!users.length) return;
    transientStatus(`reconnecting ${users.map((p) => p.name).join(", ")}…`);
    try { await reconnectConn(users[0]!, conn.client); }
    catch (error) {
      for (const project of users) {
        project.connected = false;
        void stopForwards(project.name);
      }
      // Focus stays where it is: routed tools now fail with a clear "not connected" error until the user reconnects.
      status();
      persistSessionState();
      currentCtx?.ui.notify(`SSH remote automatic reconnection failed (${users.map((p) => p.name).join(", ")}): ${firstLine((error as Error).message)}`, "error");
    }
  }

  const withReconnect = async <T>(rt: SessionProject, operation: (client: SshClient) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    requireConnected(rt);
    if (signal?.aborted) throw abortedError();
    const first = (rt.key ? pool.get(rt.key) : undefined) ?? await untilAborted(reconnectConn(rt, undefined), signal);
    try { return await operation(first.client); }
    catch (error) {
      if (signal?.aborted || !isReconnectable(error)) throw error;
      const next = await untilAborted(reconnectConn(rt, first.client), signal);
      return operation(next.client);
    }
  };

  // ---- project context: remote instruction files + project memory --------------------------------------

  const contextKey = (rt: SessionProject): string => `${rt.name}\0${rt.cwd}`;
  const cachedInstructions = (rt: SessionProject): InstructionFile[] => contextCache.get(contextKey(rt))?.files ?? [];
  const dropContext = (name: string): void => {
    for (const key of [...contextCache.keys()]) if (key.startsWith(`${name}\0`)) contextCache.delete(key);
  };

  // One round trip: a POSIX sh script prints every applicable AGENTS.md/CLAUDE.md. Concurrent callers for the
  // same (project, cwd) share one fetch. A failure rejects and leaves the previous cache entry in place.
  const refreshContext = (rt: SessionProject, client: SshClient, timeoutSeconds = CONTEXT_FETCH_TIMEOUT_SECONDS): Promise<ContextEntry> => {
    const key = contextKey(rt);
    const inflight = contextFetches.get(key);
    if (inflight) return inflight;
    const fetch = (async () => {
      contextAttempts.set(key, Date.now());
      const delimiter = newDelimiter();
      // execRemote has no timer until the channel opens; the deadline also covers a remote that never answers.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const output = await Promise.race([
        execRemote(client, buildContextScript(rt.cwd, delimiter), false, timeoutSeconds),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`remote did not answer within ${timeoutSeconds + 2} seconds`)), (timeoutSeconds + 2) * 1000); }),
      ]).finally(() => clearTimeout(timer));
      const entry = { files: parseContextOutput(output, delimiter), fetchedAt: Date.now() };
      contextCache.set(key, entry);
      return entry;
    })().finally(() => contextFetches.delete(key));
    contextFetches.set(key, fetch);
    return fetch;
  };

  /** Refreshes the project's instruction files; never throws. A failure is kept in `rt.contextError` and the stale cache stays. */
  const loadContext = async (rt: SessionProject, client?: SshClient): Promise<void> => {
    try {
      if (client) await refreshContext(rt, client);
      else await withReconnect(rt, (live) => refreshContext(rt, live));
      rt.contextError = undefined;
    } catch (error) {
      rt.contextError = firstLine((error as Error).message);
    }
  };

  // Used by before_agent_start: refreshes a context older than five minutes, but waits at most five seconds,
  // never reconnects, never prompts, and keeps the stale cache on any failure. A fetch that is still running
  // (a hung remote) is not waited on again.
  const ensureFreshContext = async (rt: SessionProject): Promise<InstructionFile[]> => {
    const key = contextKey(rt);
    const entry = contextCache.get(key);
    const client = rt.key ? pool.get(rt.key)?.client : undefined;
    const now = Date.now();
    const due = !entry || now - entry.fetchedAt > CONTEXT_MAX_AGE_MS;
    if (due && client && !contextFetches.has(key) && now - (contextAttempts.get(key) ?? 0) > CONTEXT_RETRY_BACKOFF_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          refreshContext(rt, client, CONTEXT_PROMPT_TIMEOUT_MS / 1000).then(
            () => { rt.contextError = undefined; },
            (error) => { rt.contextError = firstLine((error as Error).message); },
          ),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, CONTEXT_PROMPT_TIMEOUT_MS); }),
        ]);
      } catch { /* keep the stale cache */ }
      finally { clearTimeout(timer); }
    }
    return cachedInstructions(rt);
  };

  const memorySnapshot = (name: string, ssh?: string): MemorySnapshot => {
    try { ensureProjectMemory(MEMORY_DIR, name, ssh); }
    catch { /* the snapshot still names the path; the model can create the file */ }
    return projectMemorySnapshot(MEMORY_DIR, name);
  };

  /** Text appended to a connect/focus tool result: the project's instructions and memory, visible in the transcript. */
  const switchContextText = (rt: SessionProject): string =>
    formatSwitchContext(rt.name, cachedInstructions(rt), memorySnapshot(rt.name, catalog().projects[rt.name]?.ssh), { fetchError: rt.contextError });

  /** One-line summary for the /remote connect and /remote focus commands. */
  const contextNotice = (rt: SessionProject): { text: string; level: "info" | "warning" } => {
    const memory = memorySnapshot(rt.name, catalog().projects[rt.name]?.ssh);
    if (rt.contextError) return { text: `Could not load project instructions for ${rt.name}: ${rt.contextError}`, level: "warning" };
    return { text: memory.error ? `${contextSummary(rt.name, cachedInstructions(rt), 0)} (memory file is invalid: ${memory.error})` : contextSummary(rt.name, cachedInstructions(rt), memory.entries.length), level: memory.error ? "warning" : "info" };
  };

  /** Connects (or re-connects) a catalog project, adds it to the session, and by default focuses it. */
  const connectProject = async (name: string, ctx: any, options: { focus?: boolean } = {}): Promise<SessionProject> => {
    currentCtx = ctx;
    const projects = catalog();
    const project = projects.projects[name];
    if (!project) throw new Error(unknownProjectMessage(projects, name));
    const parsed = parseSshCommand(project.ssh);
    const key = poolKey(parsed);
    let rt = findSession(name);
    if (rt?.connected && rt.key === key && pool.get(key)) {
      if (options.focus !== false) {
        focus = name;
        status(ctx);
        persistSessionState();
        ctx.ui.notify(`SSH remote ${name} is already connected; focus set to it`, "info");
        await loadContext(rt);
      }
      return rt;
    }
    transientStatus(`connecting ${name}…`);
    let resolved: { cwd: string; unavailableCwd?: string };
    try {
      const conn = await pool.acquire(parsed, uiFor(ctx));
      resolved = await resolveCwd(conn.client, rt?.cwd ?? project.cwd);
    } catch (error) {
      if (!connectedUsing(key).length) pool.close(key);
      status(ctx);
      throw error;
    }
    const previousKey = rt?.connected ? rt.key : undefined;
    if (rt) Object.assign(rt, { cwd: resolved.cwd, connected: true, key, parsed });
    else session.push(rt = { name, cwd: resolved.cwd, connected: true, key, parsed });
    if (previousKey && previousKey !== key) closeIfUnused(previousKey);
    if (options.focus !== false) focus = name;
    status(ctx);
    persistSessionState();
    ctx.ui.notify(resolved.unavailableCwd
      ? `SSH remote directory unavailable: ${resolved.unavailableCwd}; connected ${name} in default directory ${resolved.cwd}`
      : `SSH remote connected: ${describe(rt, projects.projects)}`, resolved.unavailableCwd ? "warning" : "info");
    await loadContext(rt);
    return rt;
  };

  const setFocus = (name: string, ctx: any) => {
    focus = name;
    status(ctx);
    persistSessionState();
  };

  /** Switches the focus; returns the project, or undefined for local. A disconnected project is reconnected first. */
  const focusProject = async (name: string, ctx: any): Promise<SessionProject | undefined> => {
    if (name === LOCAL_FOCUS) {
      setFocus(LOCAL_FOCUS, ctx);
      return undefined;
    }
    const rt = findSession(name);
    if (!rt) {
      const projects = catalog();
      throw new Error(projects.projects[name]
        ? `Project "${name}" is not in this session; connect it with remote(action="connect", name="${name}")`
        : unknownProjectMessage(projects, name));
    }
    if (!rt.connected) await connectProject(name, ctx);
    else {
      setFocus(name, ctx);
      await loadContext(rt);
    }
    return rt;
  };

  const disconnectProject = async (name: string, ctx: any, forgetCredentials = false): Promise<void> => {
    const rt = findSession(name);
    const parsed = rt?.parsed ?? (() => { try { return parseSshCommand(catalog().projects[name]?.ssh ?? ""); } catch { return undefined; } })();
    if (!rt && !(forgetCredentials && parsed)) throw new Error(`Project "${name}" is not in this session`);
    if (rt) {
      rt.connected = false;
      dropContext(name);
      await stopForwards(name);
      closeIfUnused(rt.key);
      if (focus === name) focus = LOCAL_FOCUS;
    }
    if (forgetCredentials && parsed) for (const hop of [...(parsed.jumps ?? []), parsed]) auth.forget(hop);
    status(ctx);
    persistSessionState();
    ctx.ui.notify(forgetCredentials ? `SSH remote ${name} disconnected and cached credentials cleared` : `SSH remote ${name} disconnected (credentials remain cached in memory only)`, "info");
  };

  const removeProject = async (name: string, ctx: any): Promise<void> => {
    const projects = catalog();
    if (!projects.projects[name]) throw new Error(unknownProjectMessage(projects, name));
    const rt = findSession(name);
    if (rt) {
      rt.connected = false;
      dropContext(name);
      await stopForwards(name);
      closeIfUnused(rt.key);
      session.splice(session.indexOf(rt), 1);
      if (focus === name) focus = LOCAL_FOCUS;
    }
    delete projects.projects[name];
    saveCatalog(CONFIG_FILE, projects);
    status(ctx);
    persistSessionState();
  };

  const changeCwd = async (rt: SessionProject, requested: string, ctx: any): Promise<string> => {
    const target = requested.trim() || HOME_CWD;
    const targetCommand = target === HOME_CWD ? "cd -- ~" : `cd -- ${quote(target)}`;
    const resolved = (await withReconnect(rt, (client) => execRemote(client, `cd -- ${quote(rt.cwd)} && ${targetCommand} && pwd -P`))).toString().trim();
    rt.cwd = resolved;
    status(ctx);
    persistSessionState();
    await loadContext(rt);
    return resolved;
  };

  const standaloneCdTarget = (command: string): string | undefined => {
    try {
      const words = shellWords(command);
      if (words[0] !== "cd" || words.length > 3) return undefined;
      if (words.length === 3 && words[1] !== "--") return undefined;
      return words.at(-1) === "cd" || words.at(-1) === "--" ? HOME_CWD : words.at(-1);
    } catch {
      return undefined;
    }
  };

  // ---- port forwards -----------------------------------------------------------------------------------

  const forwardsOf = (name: string): string[] => [...forwards.values()].filter((f) => f.project === name).map((f) => serializeForward(f.spec));

  const startForward = async (rt: SessionProject, spec: ForwardSpec): Promise<void> => {
    const existing = forwards.get(spec.localPort);
    if (existing) {
      if (existing.project === rt.name) return;
      throw new Error(`Local port ${spec.localPort} is already forwarded for project ${existing.project}`);
    }
    const server = createServer((socket: Socket) => {
      void withReconnect(rt, (client) => new Promise<ClientChannel>((resolve, reject) =>
        client.forwardOut("127.0.0.1", 0, spec.remoteHost, spec.remotePort, (error, stream) =>
          error ? reject(error) : resolve(stream)))).then((stream) => {
            socket.on("error", () => stream.close());
            stream.on("error", () => socket.destroy());
            socket.pipe(stream).pipe(socket);
          }, () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.close(); reject(error); };
      server.once("error", onError);
      server.listen(spec.localPort, "127.0.0.1", () => {
        server.off("error", onError);
        server.on("error", () => {});
        resolve();
      });
    });
    forwards.set(spec.localPort, { project: rt.name, spec, server });
  };

  /** Stops one project's forwards, or all of them when no name is given. */
  const stopForwards = async (name?: string): Promise<void> => {
    const stopped = [...forwards.entries()].filter(([, f]) => name === undefined || f.project === name);
    for (const [port] of stopped) forwards.delete(port);
    await Promise.all(stopped.map(([, f]) => new Promise<void>((resolve) => f.server.close(() => resolve()))));
  };

  // Starts forwards one by one: a local port that is already taken must not abort the rest.
  const startForwards = async (rt: SessionProject, values: string[], ctx = currentCtx): Promise<string[]> => {
    const running: string[] = [];
    const failures: string[] = [];
    for (const serialized of values) {
      try {
        await startForward(rt, parseForwardSpec(serialized));
        running.push(serialized);
      } catch (error) {
        failures.push(`${serialized} (${(error as Error).message})`);
      }
    }
    if (failures.length && ctx) ctx.ui.notify(`SSH remote forward(s) not started for ${rt.name}: ${failures.join("; ")}`, "warning");
    return running;
  };

  // ---- remote file and shell operations ----------------------------------------------------------------

  const mapPath = (rt: SessionProject, path: string): string => {
    if (path === localCwd) return rt.cwd;
    const prefix = localCwd.endsWith(sep) ? localCwd : localCwd + sep;
    if (path.startsWith(prefix)) return rt.cwd.replace(/\/$/, "") + "/" + relative(localCwd, path).split(sep).join("/");
    return path;
  };

  const remotePath = (rt: SessionProject, path: string): string => {
    const normalized = path.replace(/^@/, "");
    if (normalized.startsWith("/")) return mapPath(rt, normalized);
    return posix.join(rt.cwd, normalized);
  };

  // Built-in tools resolve paths against ctx.cwd, but mapPath only translates paths under localCwd.
  // Object.create keeps Pi's lazy context getters and non-enumerable members that a spread would drop.
  const remoteToolContext = <T extends { cwd: string }>(ctx: T): T =>
    ctx && Object.create(ctx, { cwd: { value: localCwd, enumerable: true } });

  // AgentTool types execute with four parameters, but Pi's wrapper forwards a fifth context argument to the
  // tool definition, which reads the PI_* session variables, model, and cwd from it.
  type WithContext<T> = T & { execute(id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any): Promise<any> };
  const withContext = <T extends object>(tool: T): WithContext<T> => tool as WithContext<T>;

  const limitResult = (result: any, kind: "read" | "exec" | "search", startLine = 1, requestedMaxLines?: number) =>
    limitRemoteToolResult(result, kind, configuredOutputLimits(catalog()), turnBudget, startLine, requestedMaxLines);

  const detectRemoteMimeType = async (rt: SessionProject, path: string): Promise<string | undefined> => {
    try {
      return (await withReconnect(rt, (client) => execRemote(client, `file --mime-type -b -- ${quote(remotePath(rt, path))}`))).toString().trim() || undefined;
    } catch { return undefined; }
  };

  const isTextMimeType = (mime: string): boolean =>
    mime.startsWith("text/") || /\/(?:json|ld\+json|xml|javascript|x-sh|x-shellscript|x-empty)$/.test(mime);

  const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  const remoteReadOps = (rt: SessionProject): ReadOperations => ({
    readFile: (path) => withReconnect(rt, (client) => withSftp(client, (sftp) =>
      new Promise<Buffer>((resolve, reject) => sftp.readFile(mapPath(rt, path), (error, data) => error ? reject(error) : resolve(data))))),
    access: (path) => withReconnect(rt, (client) => withSftp(client, (sftp) =>
      new Promise<void>((resolve, reject) => sftp.stat(mapPath(rt, path), (error) => error ? reject(error) : resolve())))),
    detectImageMimeType: async (path) => {
      const mime = await detectRemoteMimeType(rt, path);
      return mime && IMAGE_MIME_TYPES.includes(mime) ? mime : null;
    },
  });

  const executeRemoteRead = async (rt: SessionProject, id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) => {
    if (signal?.aborted) throw new Error("aborted");
    const path = remotePath(rt, params.path);
    await withReconnect(rt, (client) => withSftp(client, (sftp) =>
      new Promise<void>((resolve, reject) => sftp.stat(path, (error) => error ? reject(error) : resolve()))));
    const mime = await detectRemoteMimeType(rt, path);
    if (mime && IMAGE_MIME_TYPES.includes(mime)) {
      const result = await withContext(createReadTool(localCwd, { operations: remoteReadOps(rt) })).execute(id, params, signal, update, remoteToolContext(ctx));
      return limitResult(result, "read", params.offset ?? 1);
    }
    if (mime && !isTextMimeType(mime)) throw new Error(`Refusing to read remote binary file as text (${mime}): ${params.path}`);

    const limits = configuredOutputLimits(catalog());
    const startLine = Math.max(1, Math.floor(Number(params.offset ?? 1)));
    const requestedLines = Math.max(1, Math.floor(Number(params.limit ?? limits.readMaxLines)));
    const linesToFetch = Math.min(requestedLines, limits.readMaxLines) + 1;
    const endLine = startLine + linesToFetch - 1;
    const transferBytes = Math.min(DEFAULT_MAX_BYTES, limits.readMaxBytes + OUTPUT_FOOTER_RESERVE_BYTES + 4096);
    const command = `sed -n '${startLine},${endLine}p' ${quote(path)} | head -c ${transferBytes}`;
    const output = await withReconnect(rt, (client) => execRemote(client, command, false, DEFAULT_REMOTE_TIMEOUT_SECONDS));
    if (signal?.aborted) throw new Error("aborted");
    if (!output.length && startLine > 1) throw new Error(`Offset ${startLine} is beyond end of remote file`);
    const result = {
      content: [{ type: "text", text: output.toString("utf8") }],
      details: { remoteRange: { path, startLine, requestedLines: Math.min(requestedLines, limits.readMaxLines) } },
    };
    return limitResult(result, "read", startLine, Math.min(requestedLines, limits.readMaxLines));
  };

  const remoteWriteOps = (rt: SessionProject): WriteOperations => ({
    writeFile: (path, content) => withReconnect(rt, (client) => withSftp(client, (sftp) => writeRemoteFileAtomic(client, sftp, mapPath(rt, path), content))),
    mkdir: async (path) => { await withReconnect(rt, (client) => execRemote(client, `mkdir -p -- ${quote(mapPath(rt, path))}`)); },
  });

  const remoteEditOps = (rt: SessionProject): EditOperations => {
    const read = remoteReadOps(rt);
    const write = remoteWriteOps(rt);
    return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
  };

  const remoteBashOps = (rt: SessionProject): BashOperations => ({
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const timeoutSeconds = parseRemoteTimeout(timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS);
      const full = remoteCommandLine(command, timeoutSeconds, mapPath(rt, cwd));
      const stream = await withReconnect(rt, (client) => openAbortableExec(client, full, signal), signal);
      const { code, timedOut } = await runExecChannel(stream, timeoutSeconds, onData, onData, signal);
      if (timedOut || code === 124 || code === 137) throw new Error(`timeout:${timeoutSeconds}`);
      return { exitCode: code };
    },
  });

  // One SFTP session per ls call. readdir remembers each entry's type, so the built-in's per-entry stat
  // is answered from memory; symlinks are not remembered because the built-in follows them with stat.
  const executeRemoteLs = async (rt: SessionProject, id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) => {
    const result = await withReconnect(rt, (client) => withSftp(client, async (sftp) => {
      const isDirectoryByPath = new Map<string, boolean>();
      const operations: LsOperations = {
        exists: (path) => sftpStat(sftp, mapPath(rt, path)).then(() => true, missingAsFalse),
        stat: async (path) => {
          const known = isDirectoryByPath.get(path);
          if (known !== undefined) return { isDirectory: () => known };
          const attrs = await sftpStat(sftp, mapPath(rt, path));
          return { isDirectory: () => isDirectoryMode(attrs.mode) };
        },
        readdir: async (path) => {
          const entries = await sftpCall<any[]>((done) => sftp.readdir(mapPath(rt, path), done));
          const names: string[] = [];
          for (const entry of entries) {
            if (entry.filename === "." || entry.filename === "..") continue;
            names.push(entry.filename);
            if ((entry.attrs.mode & 0o170000) !== 0o120000) isDirectoryByPath.set(join(path, entry.filename), isDirectoryMode(entry.attrs.mode));
          }
          return names;
        },
      };
      return withContext(createLsTool(localCwd, { operations })).execute(id, params, signal, update, remoteToolContext(ctx));
    }), signal);
    return limitResult(result, "search");
  };

  // Runs a shell script in `cwd` on one exec channel and returns its stdout; abort signals the remote process.
  const captureRemoteScript = async (rt: SessionProject, script: string, cwd: string, signal?: AbortSignal): Promise<string> => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const { code, timedOut } = await withReconnect(rt, async (client) => {
      stdout.length = 0;
      stderr.length = 0;
      const stream = await openAbortableExec(client, remoteCommandLine(script, REMOTE_SEARCH_TIMEOUT_SECONDS, cwd), signal);
      return runExecChannel(stream, REMOTE_SEARCH_TIMEOUT_SECONDS, (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk), signal);
    }, signal);
    if (timedOut || code === 124 || code === 137) throw new Error(`Remote search timed out after ${REMOTE_SEARCH_TIMEOUT_SECONDS} seconds`);
    const text = Buffer.concat(stdout).toString("utf8");
    if (code !== 0 && !text.trim()) throw new Error(Buffer.concat(stderr).toString().trim() || `Remote search exited with code ${code}`);
    return text;
  };

  const executeRemoteFind = async (rt: SessionProject, id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) => {
    const operations: FindOperations = {
      exists: (path) => withReconnect(rt, (client) => withSftp(client, (sftp) => sftpStat(sftp, mapPath(rt, path))), signal).then(() => true, missingAsFalse),
      glob: async (pattern, cwd, { limit }) => {
        const dir = mapPath(rt, cwd);
        return parseFindOutput(await captureRemoteScript(rt, buildFindScript(pattern, dir, limit), dir, signal), dir);
      },
    };
    const result = await withContext(createFindTool(localCwd, { operations })).execute(id, params, signal, update, remoteToolContext(ctx));
    return limitResult(result, "search");
  };

  // The built-in grep cannot be redirected through its operations, so this reproduces its output format
  // from a remote ripgrep (or GNU grep when rg is missing) streamed over one exec channel. The remote
  // process is stopped as soon as the match limit and its trailing context are satisfied.
  const executeRemoteGrep = async (rt: SessionProject, params: any, signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw abortedError();
    const searchPath = remotePath(rt, params.path || ".");
    let isDirectory: boolean;
    try {
      isDirectory = isDirectoryMode((await withReconnect(rt, (client) => withSftp(client, (sftp) => sftpStat(sftp, searchPath)), signal)).mode);
    } catch (error) {
      if ((error as any)?.code === 2) throw new Error(`Path not found: ${searchPath}`);
      throw error;
    }
    const { limit, context } = grepLimits(params);
    const script = buildGrepScript(params, isDirectory ? "." : posix.basename(searchPath));
    const cwd = isDirectory ? searchPath : posix.dirname(searchPath);

    let collector!: GrepCollector;
    let stderr = "";
    let stoppedEarly = false;
    const { code, timedOut } = await withReconnect(rt, async (client) => {
      collector = new GrepCollector(limit, context, isDirectory);
      stderr = "";
      stoppedEarly = false;
      const splitter = new LineSplitter();
      const early = new AbortController();
      const stop = signal ? AbortSignal.any([signal, early.signal]) : early.signal;
      const feed = (lines: string[]) => {
        for (const line of lines) {
          if (collector.addLine(line)) { stoppedEarly = true; early.abort(); return; }
        }
      };
      const stream = await openAbortableExec(client, remoteCommandLine(script, REMOTE_SEARCH_TIMEOUT_SECONDS, cwd), stop);
      try {
        const result = await runExecChannel(stream, REMOTE_SEARCH_TIMEOUT_SECONDS, (chunk) => { if (!stoppedEarly) feed(splitter.push(chunk)); },
          (chunk) => { if (stderr.length < 16384) stderr += chunk.toString(); }, stop);
        feed(splitter.flush());
        return result;
      } catch (error) {
        if (stoppedEarly && !signal?.aborted) return { code: 0, timedOut: false };
        throw error;
      }
    }, signal);
    if (timedOut || code === 124 || code === 137) throw new Error(`Remote search timed out after ${REMOTE_SEARCH_TIMEOUT_SECONDS} seconds`);
    // rg and grep exit 1 for "no matches" and 2 for partial errors (for example unreadable directories).
    if (code !== 0 && code !== 1 && !(code === 2 && collector.matchCount > 0)) throw new Error(stderr.trim() || `Remote search exited with code ${code}`);
    const { text, details } = collector.finish();
    return limitResult({ content: [{ type: "text", text }], details }, "search");
  };

  // ---- tool routing ------------------------------------------------------------------------------------

  // The focused project's memory file is always read and edited locally, even while tools are routed.
  const targetsLocalProjectMemory = (path: unknown): boolean => {
    if (focus === LOCAL_FOCUS || typeof path !== "string") return false;
    return resolve(path.replace(/^@/, "")) === projectMemoryPath(MEMORY_DIR, focus);
  };

  /**
   * The project a built-in tool call runs on, or undefined to run locally. A remote focus that is not
   * connected throws: routed tools never fall back to the local machine.
   */
  const routeTarget = (path?: unknown): SessionProject | undefined => {
    if (focus === LOCAL_FOCUS || targetsLocalProjectMemory(path)) return undefined;
    const rt = focusedProject();
    if (!rt) throw new Error(`Remote project ${focus} is not connected; reconnect with remote(action="connect", name="${focus}") or switch focus to local`);
    return requireConnected(rt);
  };

  const localRead = withContext(createReadTool(localCwd));
  const localWrite = withContext(createWriteTool(localCwd));
  const localEdit = withContext(createEditTool(localCwd));
  let localBash = withContext(createBashTool(localCwd));
  const localGrep = withContext(createGrepTool(localCwd));
  const localFind = withContext(createFindTool(localCwd));
  const localLs = withContext(createLsTool(localCwd));
  pi.registerTool({
    ...localRead,
    description: `Read file contents. Remote text reads fetch only the requested range and return at most ${DEFAULT_READ_MAX_LINES} lines or ${formatSize(DEFAULT_READ_MAX_BYTES)} by default; use offset/limit to continue. ${FILE_ROUTING}`,
    promptGuidelines: ["Use read with offset/limit for remote code and logs; inspect large files in focused chunks instead of reading them wholesale."],
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget(params.path);
      return rt ? executeRemoteRead(rt, id, params, signal, update, ctx) : localRead.execute(id, params, signal, update, ctx);
    },
  });
  pi.registerTool({
    ...localWrite,
    description: `${localWrite.description} ${FILE_ROUTING}`,
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget(params.path);
      return rt
        ? withContext(createWriteTool(localCwd, { operations: remoteWriteOps(rt) })).execute(id, params, signal, update, remoteToolContext(ctx))
        : localWrite.execute(id, params, signal, update, ctx);
    },
  });
  pi.registerTool({
    ...localEdit,
    description: `${localEdit.description} ${FILE_ROUTING}`,
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget(params.path);
      return rt
        ? withContext(createEditTool(localCwd, { operations: remoteEditOps(rt) })).execute(id, params, signal, update, remoteToolContext(ctx))
        : localEdit.execute(id, params, signal, update, ctx);
    },
  });
  pi.registerTool({
    ...localGrep,
    // Like the built-in, active only when enabled (defaultTools / --tools), not on registration.
    defaultActive: false,
    description: `${localGrep.description} ${FILE_ROUTING}`,
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget(params.path);
      return rt ? executeRemoteGrep(rt, params, signal) : localGrep.execute(id, params, signal, update, ctx);
    },
  });
  pi.registerTool({
    ...localFind,
    defaultActive: false,
    description: `${localFind.description} ${FILE_ROUTING}`,
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget(params.path);
      return rt ? executeRemoteFind(rt, id, params, signal, update, ctx) : localFind.execute(id, params, signal, update, ctx);
    },
  });
  pi.registerTool({
    ...localLs,
    defaultActive: false,
    description: `${localLs.description} ${FILE_ROUTING}`,
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget(params.path);
      return rt ? executeRemoteLs(rt, id, params, signal, update, ctx) : localLs.execute(id, params, signal, update, ctx);
    },
  });
  pi.registerTool({
    ...localBash,
    description: `Execute a shell command. Remote model-facing output returns at most the last ${DEFAULT_EXEC_MAX_LINES} lines or ${formatSize(DEFAULT_EXEC_MAX_BYTES)} by default; complete oversized output is saved locally. ${SHELL_ROUTING}`,
    promptGuidelines: ["When using bash for remote logs and broad searches, use bounded commands such as tail, sed, or rg with limits instead of cat or unbounded find output."],
    execute: async (id, params, signal, update, ctx) => {
      const rt = routeTarget();
      if (!rt) return localBash.execute(id, params, signal, update, ctx);
      const result = await withContext(createBashTool(localCwd, { operations: remoteBashOps(rt) })).execute(id, params, signal, update, remoteToolContext(ctx));
      return limitResult(result, "exec");
    },
  });

  // ---- the remote tool and /remote command -------------------------------------------------------------

  const statusText = (): string => {
    const projects = catalog().projects;
    const lines = [`Focus: ${focus === LOCAL_FOCUS ? `local (${localCwd})` : describe(focusedProject() ?? { name: focus, cwd: "?", connected: false }, projects)}`];
    if (!session.length) lines.push("No remote projects in this session.");
    for (const rt of session) {
      const ports = forwardsOf(rt.name);
      lines.push(`- ${describe(rt, projects)}: ${rt.connected ? "connected" : "disconnected"}${ports.length ? `; forwards: ${ports.join(", ")}` : ""}${projects[rt.name]?.guard ? `; guard: ${projects[rt.name]!.guard}` : ""}`);
    }
    const more = Object.keys(projects).filter((name) => !findSession(name)).length;
    if (more) lines.push(`${more} more saved: remote(action="list")`);
    const focused = focusedProject();
    if (focused?.connected) {
      const files = cachedInstructions(focused);
      const memory = memorySnapshot(focused.name, projects[focused.name]?.ssh);
      const fetchedAt = contextCache.get(contextKey(focused))?.fetchedAt;
      lines.push(
        `Project instructions (${focused.name}): ${files.length ? files.map((file) => instructionLabel(focused.name, file.path)).join(", ") : "none loaded"}${fetchedAt ? ` (fetched ${Math.round((Date.now() - fetchedAt) / 1000)}s ago)` : ""}${focused.contextError ? `; last refresh failed: ${focused.contextError}` : ""}`,
        `Project memory (${focused.name}): ${memory.error ? `invalid JSON (${memory.error})` : `${memory.entries.length} ${memory.entries.length === 1 ? "entry" : "entries"}`}; ${memory.path}`,
      );
    }
    return lines.join("\n");
  };

  const contextDetails = (rt: SessionProject) => ({ instructions: cachedInstructions(rt).map((file) => instructionLabel(rt.name, file.path)) });

  // Every result built here ends with exactly one `Focus:` line; `extra` (project context) goes before it.
  const actionResult = (summary: string, details: Record<string, unknown> = {}, extra = "") => ({
    content: [{ type: "text" as const, text: [summary, extra, `Focus: ${focusLabel(view())}`].filter(Boolean).join("\n") }],
    details: { summary, focus, ...details },
  });

  /** The project a name (or the focus) refers to; `requireSession` rejects projects that are not in this session. */
  const sessionTarget = (name: string | undefined, what: string): SessionProject => {
    const target = name ? findSession(name) : focusedProject();
    if (target) return target;
    if (name) throw new Error(`Project "${name}" is not in this session; connect it first with remote(action="connect", name="${name}")`);
    throw new Error(`The focus is local; pass name to choose the project to ${what}`);
  };

  const parsedForwardValues = (value: string | undefined, fallback: string[] | undefined): string[] => {
    const values = value?.trim() ? value.trim().split(/[\s,]+/) : fallback ?? [];
    values.forEach(parseForwardSpec);
    return values;
  };

  const runForward = async (rt: SessionProject, mappings: string | undefined, ctx: any): Promise<string> => {
    requireConnected(rt);
    const values = parsedForwardValues(mappings, catalog().projects[rt.name]?.forwards);
    if (!values.length) throw new Error(`No port mappings given and project ${rt.name} has none saved; pass LOCAL_PORT:REMOTE_HOST:REMOTE_PORT or set forwards with edit`);
    const started: string[] = [];
    const failures: string[] = [];
    for (const value of values) {
      try { await startForward(rt, parseForwardSpec(value)); started.push(`127.0.0.1:${parseForwardSpec(value).localPort}`); }
      catch (error) { failures.push(`${value} (${(error as Error).message})`); }
    }
    status(ctx);
    if (!started.length) throw new Error(`Port forwarding failed for ${rt.name}: ${failures.join("; ")}`);
    return `Forwarding for ${rt.name}: ${started.join(", ")}; tool routing is unchanged${failures.length ? `. Not started: ${failures.join("; ")}` : ""}`;
  };

  const memoryReport = (name: string, ssh?: string): { path: string; text: string; entries: unknown[] } => {
    const path = ensureProjectMemory(MEMORY_DIR, name, ssh);
    try {
      const memory = loadProjectMemory(MEMORY_DIR, name);
      return { path, text: `Memory for ${name}: ${path}\n${formatMemoryEntries(memory)}`, entries: memory?.entries ?? [] };
    } catch (error) {
      throw new Error(`Invalid project-memory JSON at ${path}: ${(error as Error).message}`);
    }
  };

  /** Runs a command on a connected project and returns the formatted, bounded result. */
  const runExec = async (rt: SessionProject, command: string, options: { timeout?: number; cwd?: string; signal?: AbortSignal }) => {
    const timeoutSeconds = parseRemoteTimeout(options.timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS);
    const limits = configuredOutputLimits(catalog());
    return withReconnect(rt, (client) => execRemoteLimited(
      client, command, timeoutSeconds, limits.execMaxLines, limits.execMaxBytes, options.signal, options.cwd ?? rt.cwd,
    ), options.signal);
  };

  pi.registerTool({
    name: "remote",
    label: "Remote",
    description: "Manage saved remote SSH projects and which one tools run on. Connecting a project focuses it; while focus is a remote project, read, write, edit, bash, grep, find, and ls run there, and focus local returns them to this machine.",
    promptSnippet: "Manage remote SSH projects and the tool focus",
    promptGuidelines: [
      "Find saved projects with remote list and connect by exact name; switch with focus. Use chdir, not exec, to change a project's directory.",
      "Use remote add or edit only when the user asks to save or change a project; use remove only on an explicit user request.",
      "remote memory returns a project's memory file path; read/edit that file directly and delete entries only on an explicit user request.",
      `Set timeout for remote exec (default ${DEFAULT_REMOTE_TIMEOUT_SECONDS}s) and keep output bounded (tail, sed, rg limits).`,
    ],
    parameters: Type.Object({
      action: StringEnum(REMOTE_ACTIONS),
      name: Type.Optional(Type.String({ description: "Exact project name (focus also accepts local)" })),
      ssh: Type.Optional(Type.String({ description: "ssh command or target, e.g. me@host or an ~/.ssh/config alias" })),
      cwd: Type.Optional(Type.String({ description: "Remote directory (~ ok); chdir target; exec one-command override" })),
      note: Type.Optional(Type.String({ description: "One-line note; empty clears" })),
      guard: Type.Optional(Type.String({ description: "readonly or confirm (not yet enforced); empty clears" })),
      local: Type.Optional(Type.String({ description: "Local checkout path (informational); empty clears" })),
      forwards: Type.Optional(Type.String({ description: "Space-separated LOCAL_PORT:REMOTE_HOST:REMOTE_PORT" })),
      remoteCommand: Type.Optional(Type.String({ description: "Shell command for exec" })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_REMOTE_TIMEOUT_SECONDS, description: "Exec timeout in seconds" })),
      displayLines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DISPLAY_LINES, description: "Collapsed exec preview lines" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      currentCtx = ctx;
      const projects = catalog();
      switch (params.action) {
        case "list":
          return { content: [{ type: "text", text: formatProjectList(view(projects.projects)) }], details: { focus, projects: Object.keys(projects.projects) } };
        case "status":
          return { content: [{ type: "text", text: statusText() }], details: { focus, projects: session.map(({ name, cwd, connected }) => ({ name, cwd, connected })) } };
        case "add": {
          const name = validateProjectName(params.name);
          if (projects.projects[name]) throw new Error(`Project "${name}" already exists; use action "edit" to change it`);
          if (!params.ssh || !params.cwd) throw new Error("add requires name, ssh, and cwd");
          const project = applyProjectFields(undefined, { ssh: params.ssh, cwd: params.cwd, note: params.note, guard: params.guard, local: params.local, forwards: params.forwards });
          projects.projects[name] = project;
          saveCatalog(CONFIG_FILE, projects);
          return actionResult(`Saved remote project ${name} (${project.ssh}, ${project.cwd}). Not connected; connect with remote(action="connect", name="${name}").`);
        }
        case "edit": {
          const name = params.name ?? "";
          const existing = projects.projects[name];
          if (!existing) throw new Error(unknownProjectMessage(projects, name));
          const fields: ProjectFields = { ssh: params.ssh, cwd: params.cwd, note: params.note, guard: params.guard, local: params.local, forwards: params.forwards };
          if (!Object.values(fields).some((value) => value !== undefined)) throw new Error("edit needs at least one of ssh, cwd, note, guard, local, forwards");
          const updated = applyProjectFields(existing, fields);
          if (updated.ssh !== existing.ssh && findSession(name)?.connected) throw new Error(`Project ${name} is connected; disconnect it before changing ssh`);
          projects.projects[name] = updated;
          saveCatalog(CONFIG_FILE, projects);
          return actionResult(`Updated remote project ${name} (${updated.ssh}, ${updated.cwd}).`);
        }
        case "remove": {
          const name = params.name ?? "";
          if (!name) throw new Error("remove requires name");
          await removeProject(name, ctx);
          return actionResult(`Removed remote project ${name}; its memory file was kept.`);
        }
        case "connect": {
          if (!params.name) throw new Error("connect requires name");
          const rt = await connectProject(params.name, ctx);
          return actionResult(`Connected: ${describe(rt)}`, contextDetails(rt), switchContextText(rt));
        }
        case "focus": {
          if (!params.name) throw new Error('focus requires name (a session project or "local")');
          const rt = await focusProject(params.name, ctx);
          return rt
            ? actionResult(`Tools now run on ${describe(rt)}.`, contextDetails(rt), switchContextText(rt))
            : actionResult("Tools now run on this machine.");
        }
        case "disconnect": {
          const name = params.name ?? (focus !== LOCAL_FOCUS ? focus : undefined);
          if (!name) return actionResult("Focus is already local; pass name to disconnect a specific project.");
          await disconnectProject(name, ctx);
          return actionResult(`Disconnected ${name}.`);
        }
        case "forget": {
          const name = params.name ?? (focus !== LOCAL_FOCUS ? focus : undefined);
          if (!name) throw new Error("forget requires name when the focus is local");
          await disconnectProject(name, ctx, true);
          return actionResult(`Disconnected ${name} and cleared its cached credentials.`);
        }
        case "chdir": {
          if (!params.cwd) throw new Error("cwd is required for chdir");
          const rt = requireConnected(sessionTarget(params.name, "change directory for"));
          const before = cachedInstructions(rt);
          const resolved = await changeCwd(rt, params.cwd, ctx);
          const after = cachedInstructions(rt);
          let extra = "";
          if (rt.contextError) extra = `Project instructions for ${rt.name} could not be refreshed for ${resolved}: ${rt.contextError}`;
          else if (!sameInstructionPaths(before, after)) extra = after.length ? formatSwitchContext(rt.name, after, undefined) : `No project instructions found for ${resolved}.`;
          return { content: [{ type: "text", text: [`${rt.name} working directory: ${resolved}`, extra].filter(Boolean).join("\n") }], details: { project: rt.name, cwd: resolved, ...contextDetails(rt) } };
        }
        case "memory": {
          const name = params.name ?? (focus !== LOCAL_FOCUS ? focus : undefined);
          if (!name) throw new Error("memory requires name when the focus is local");
          const project = projects.projects[name];
          if (!project) throw new Error(unknownProjectMessage(projects, name));
          const report = memoryReport(name, project.ssh);
          return { content: [{ type: "text", text: report.text }], details: { project: name, path: report.path, entries: report.entries } };
        }
        case "forward": {
          const rt = sessionTarget(params.name, "forward ports for");
          return { content: [{ type: "text", text: await runForward(rt, params.forwards, ctx) }], details: { project: rt.name, forwards: forwardsOf(rt.name) } };
        }
        case "unforward": {
          const name = params.name ?? (focus !== LOCAL_FOCUS ? focus : undefined);
          await stopForwards(name);
          persistSessionState();
          return { content: [{ type: "text", text: name ? `Closed port forwards for ${name}.` : "Closed all extension-managed port forwards." }], details: { project: name } };
        }
        case "exec": {
          if (!params.remoteCommand) throw new Error("remoteCommand is required for exec");
          const rt = requireConnected(sessionTarget(params.name, "run the command on"));
          const cdTarget = params.cwd === undefined ? standaloneCdTarget(params.remoteCommand) : undefined;
          if (cdTarget !== undefined) {
            const resolved = await changeCwd(rt, cdTarget, ctx);
            return { content: [{ type: "text", text: resolved }], details: { project: rt.name, cwd: resolved } };
          }
          const displayLines = parseDisplayLines(params.displayLines ?? configuredDisplayLines(projects));
          const formatted = await runExec(rt, params.remoteCommand, { timeout: params.timeout, cwd: params.cwd, signal });
          return limitResult({
            content: [{ type: "text", text: formatted.text }],
            details: {
              action: "exec",
              project: rt.name,
              cwd: rt.cwd,
              displayLines,
              output: formatted.content,
              modelLimited: true,
              truncation: formatted.truncation.truncated ? formatted.truncation : undefined,
              fullOutputPath: formatted.fullOutputPath,
            },
          }, "exec");
        }
      }
    },
    renderCall(params, theme) {
      return renderRemoteControlCall(params, theme);
    },
    renderResult(result, { expanded }, theme) {
      return renderRemoteControlResult(result, expanded, theme);
    },
  });

  const projectCompletionItems = (): AutocompleteItem[] =>
    Object.entries(catalog().projects).map(([name, project]) => {
      const rt = findSession(name);
      const state = name === focus ? "focus" : rt ? (rt.connected ? "connected" : "disconnected") : "saved";
      return { value: name, label: name, description: `${state}: ${project.ssh}, ${project.cwd}` };
    });

  const REMOTE_USAGE = "Usage: /remote [list] | add NAME SSH CWD [NOTE...] | edit NAME key=value... | remove NAME | connect NAME | focus NAME|local | disconnect [NAME] | status | memory [NAME] | cd PATH | exec [--timeout S] [--lines N] COMMAND | forward [MAPPINGS] | unforward | forget [NAME] | ssh ARGS... | config [KEY N]";

  pi.registerCommand("remote", {
    description: "Manage remote SSH projects: /remote [list] | add NAME SSH CWD [NOTE] | edit NAME key=value... | remove NAME | connect NAME | focus NAME|local | disconnect [NAME] | status | memory [NAME] | cd PATH | exec [--timeout S] [--lines N] COMMAND | forward [MAPPINGS] | unforward | forget [NAME] | ssh ARGS... | config",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => remoteArgumentCompletions(prefix, projectCompletionItems),
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const input = args.trim().replace(/^\/?remote(?:\s+|$)/i, "").trim();
      const match = input.match(/^(\S+)\s*([\s\S]*)$/);
      const sub = match?.[1]?.toLowerCase() ?? "list";
      const rest = (match?.[2] ?? "").trim();
      const info = (text: string) => ctx.ui.notify(text, "info");
      const fail = (error: unknown) => ctx.ui.notify(firstLine((error as Error).message), "error");
      try {
        switch (sub) {
          case "list":
            return info(formatProjectList(view()));
          case "status":
            return info(statusText());
          case "add": {
            const { name, fields } = parseAddArgs(rest);
            validateProjectName(name);
            const projects = catalog();
            if (projects.projects[name]) throw new Error(`Project "${name}" already exists; use /remote edit ${name} key=value...`);
            projects.projects[name] = applyProjectFields(undefined, fields);
            saveCatalog(CONFIG_FILE, projects);
            return info(`Saved remote project ${name} (${projects.projects[name]!.ssh}, ${projects.projects[name]!.cwd}). Connect with /remote connect ${name}`);
          }
          case "edit": {
            const { name, fields } = parseEditArgs(rest);
            const projects = catalog();
            const existing = projects.projects[name];
            if (!existing) throw new Error(unknownProjectMessage(projects, name));
            const updated = applyProjectFields(existing, fields);
            if (updated.ssh !== existing.ssh && findSession(name)?.connected) throw new Error(`Project ${name} is connected; disconnect it before changing ssh`);
            projects.projects[name] = updated;
            saveCatalog(CONFIG_FILE, projects);
            status(ctx);
            return info(`Updated remote project ${name} (${updated.ssh}, ${updated.cwd}${updated.note ? `; ${updated.note}` : ""})`);
          }
          case "remove": {
            if (!rest) throw new Error("Usage: /remote remove NAME");
            await removeProject(rest, ctx);
            return info(`Removed remote project ${rest}; its memory file was kept`);
          }
          case "connect": {
            if (!rest) throw new Error("Usage: /remote connect NAME");
            const rt = await connectProject(rest, ctx);
            const notice = contextNotice(rt);
            return ctx.ui.notify(notice.text, notice.level);
          }
          case "focus": {
            if (!rest) throw new Error("Usage: /remote focus NAME|local");
            const rt = await focusProject(rest, ctx);
            if (!rt) return info("Focus: local");
            const notice = contextNotice(rt);
            return ctx.ui.notify(`Focus: ${describe(rt)}. ${notice.text}`, notice.level);
          }
          case "disconnect": {
            const name = rest || (focus !== LOCAL_FOCUS ? focus : "");
            if (!name) return info("Focus is already local; use /remote disconnect NAME");
            return await disconnectProject(name, ctx);
          }
          case "forget": {
            const name = rest || (focus !== LOCAL_FOCUS ? focus : "");
            if (!name) throw new Error("Usage: /remote forget NAME");
            return await disconnectProject(name, ctx, true);
          }
          case "memory": {
            const name = rest || (focus !== LOCAL_FOCUS ? focus : "");
            if (!name) throw new Error("Usage: /remote memory NAME (the focus is local)");
            const projects = catalog();
            if (!projects.projects[name]) throw new Error(unknownProjectMessage(projects, name));
            return info(memoryReport(name, projects.projects[name]!.ssh).text);
          }
          case "cd": {
            const rt = requireConnected(sessionTarget(undefined, "change directory for"));
            return info(`${rt.name} path: ${await changeCwd(rt, rest || HOME_CWD, ctx)}`);
          }
          case "exec": {
            const rt = requireConnected(sessionTarget(undefined, "run the command on"));
            let execInput = rest;
            let displayLines = configuredDisplayLines(catalog());
            let timeoutSeconds = DEFAULT_REMOTE_TIMEOUT_SECONDS;
            while (execInput.startsWith("--")) {
              const option = execInput.match(/^--(lines|timeout)\s+(\S+)\s+([\s\S]+)$/i);
              if (!option) throw new Error("Expected --lines N or --timeout SECONDS followed by a command");
              if (option[1]!.toLowerCase() === "lines") displayLines = parseDisplayLines(option[2]);
              else timeoutSeconds = parseRemoteTimeout(option[2]);
              execInput = option[3]!;
            }
            if (!execInput) throw new Error("Usage: /remote exec [--timeout S] [--lines N] COMMAND");
            const formatted = await runExec(rt, execInput, { timeout: timeoutSeconds });
            const omitted = formatted.truncation.totalLines > displayLines
              ? `\n\n[Showing last ${Math.min(displayLines, formatted.truncation.totalLines)} of ${formatted.truncation.totalLines} lines]`
              : "";
            const fullOutput = formatted.fullOutputPath ? `\n[Full output: ${formatted.fullOutputPath}]` : "";
            return info(`${previewRemoteOutput(formatted.content, displayLines)}${omitted}${fullOutput}`);
          }
          case "forward": {
            const rt = requireConnected(sessionTarget(undefined, "forward ports for"));
            return info(await runForward(rt, rest, ctx));
          }
          case "unforward": {
            await stopForwards(focus !== LOCAL_FOCUS ? focus : undefined);
            return info(focus !== LOCAL_FOCUS ? `Closed port forwards for ${focus}` : "Closed all extension-managed port forwards");
          }
          case "ssh": {
            if (!rest) throw new Error("Usage: /remote ssh USER@HOST [-p PORT] [-i KEY] [-J [USER@]JUMP[:PORT][,...]]");
            const ssh = `ssh ${rest}`;
            parseSshCommand(ssh);
            const projects = catalog();
            let name = Object.entries(projects.projects).find(([, project]) => project.ssh === ssh)?.[0];
            if (!name) {
              name = projectNameForSsh(ssh, Object.keys(projects.projects));
              projects.projects[name] = { ssh, cwd: HOME_CWD };
              saveCatalog(CONFIG_FILE, projects);
            }
            const rt = await connectProject(name, ctx);
            const notice = contextNotice(rt);
            return ctx.ui.notify(notice.text, notice.level);
          }
          case "config": {
            const outputConfig = rest.match(/^(display-lines|read-max-lines|read-max-bytes|exec-max-lines|exec-max-bytes|turn-max-bytes)\s+(\S+)$/i);
            if (outputConfig) {
              const key = outputConfig[1]!.toLowerCase();
              const value = outputConfig[2]!;
              const projects = catalog();
              if (key === "display-lines") projects.displayLines = parseDisplayLines(value);
              else if (key === "read-max-lines") projects.readMaxLines = parseOutputLines(value, "Read max lines");
              else if (key === "read-max-bytes") projects.readMaxBytes = parseOutputBytes(value, "Read max bytes");
              else if (key === "exec-max-lines") projects.execMaxLines = parseOutputLines(value, "Exec max lines");
              else if (key === "exec-max-bytes") projects.execMaxBytes = parseOutputBytes(value, "Exec max bytes");
              else projects.turnMaxBytes = parseOutputBytes(value, "Turn max bytes", DEFAULT_MAX_BYTES * 4);
              saveCatalog(CONFIG_FILE, projects);
              return info(`SSH remote setting updated: ${key}=${value}`);
            }
            if (rest) throw new Error("Usage: /remote config [display-lines|read-max-lines|read-max-bytes|exec-max-lines|exec-max-bytes|turn-max-bytes N]");
            const projects = catalog();
            const limits = configuredOutputLimits(projects);
            return info(`SSH remote configuration: ${CONFIG_FILE}\nDisplay lines: ${configuredDisplayLines(projects)}\nRead output: ${limits.readMaxLines} lines / ${formatSize(limits.readMaxBytes)}\nExec output: ${limits.execMaxLines} lines / ${formatSize(limits.execMaxBytes)}\nPer-turn output: ${formatSize(limits.turnMaxBytes)}\nSaved projects: ${Object.keys(projects.projects).length} (see /remote list)`);
          }
          default:
            throw new Error(REMOTE_USAGE);
        }
      } catch (error) {
        if (sub === "connect" || sub === "ssh" || sub === "focus") status(ctx);
        fail(error);
      }
    },
  });

  // ---- events ------------------------------------------------------------------------------------------

  pi.on("turn_start", () => { turnBudget.used = 0; });
  pi.on("session_start", async (event, ctx) => {
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    localBash = withContext(createBashTool(ctx.cwd, {
      shellPath: settings.getShellPath(),
      commandPrefix: settings.getShellCommandPrefix(),
    }));
    currentCtx = ctx;
    sessionReady = true;
    ctx.ui.addAutocompleteProvider(suppressRemoteCompletionsBeforeSuffix);
    for (const warning of startupWarnings.splice(0)) ctx.ui.notify(warning, warning.includes("migrated to projects") ? "info" : "warning");

    // Startup and resume never connect: the session's projects come back disconnected with focus local.
    // Reload, /new and fork carry the previous process's connections and, on a TUI host that can answer
    // prompts, re-establish them.
    const carry = event.reason === "reload" || event.reason === "new" || event.reason === "fork";
    const cached = carry ? credentialCache.projectsResume : undefined;
    credentialCache.projectsResume = undefined;
    const saved = loadSessionState(ctx);
    const target: SessionState | undefined = saved ?? (cached ? {
      version: 2, focus: cached.focus, projects: cached.projects.map(({ name, cwd, connected }) => ({ name, cwd, connected })),
    } : undefined);
    session.length = 0;
    focus = LOCAL_FOCUS;
    if (!target) return status(ctx);
    const saveable = catalog().projects;
    const dropped: string[] = [];
    for (const project of target.projects) {
      if (saveable[project.name]) session.push({ name: project.name, cwd: project.cwd, connected: false });
      else dropped.push(project.name);
    }
    if (dropped.length) ctx.ui.notify(`Remote project(s) no longer saved, dropped from this session: ${dropped.join(", ")}`, "warning");
    status(ctx);
    if (!carry || ctx.mode !== "tui") return;

    restoringSessionState = true;
    try {
      for (const project of target.projects.filter((p) => p.connected && findSession(p.name))) {
        try {
          const rt = await connectProject(project.name, ctx, { focus: false });
          const forwardValues = cached?.projects.find((p) => p.name === project.name)?.forwards ?? [];
          if (forwardValues.length) await startForwards(rt, forwardValues, ctx);
        } catch (error) {
          ctx.ui.notify(`SSH remote session restore failed for ${project.name}: ${firstLine((error as Error).message)}`, "error");
        }
      }
      if (target.focus !== LOCAL_FOCUS && findSession(target.focus)?.connected) focus = target.focus;
    } finally {
      restoringSessionState = false;
    }
    status(ctx);
    if (!saved) persistSessionState();
  });
  pi.on("session_shutdown", async (event) => {
    sessionReady = false;
    const preserve = event.reason === "reload" || event.reason === "new" || event.reason === "fork";
    if (preserve && session.length) {
      credentialCache.projectsResume = {
        focus,
        projects: session.map(({ name, cwd, connected }) => ({ name, cwd, connected, forwards: forwardsOf(name) })),
      };
    } else {
      credentialCache.projectsResume = undefined;
    }
    await stopForwards();
    for (const project of session) project.connected = false;
    contextCache.clear();
    contextAttempts.clear();
    pool.closeAll();
  });
  pi.on("user_bash", async (event, ctx) => {
    if (focus === LOCAL_FOCUS) return undefined;
    const rt = focusedProject();
    const failure = (message: string) => ({ result: { output: message, exitCode: 1, cancelled: false, truncated: false } });
    try {
      if (!rt) throw new Error(`Remote project ${focus} is not connected; reconnect with remote(action="connect", name="${focus}") or switch focus to local`);
      requireConnected(rt);
    } catch (error) { return failure((error as Error).message); }
    const cdTarget = standaloneCdTarget(event.command);
    if (cdTarget === undefined) return { operations: remoteBashOps(rt) };
    try {
      const resolved = await changeCwd(rt, cdTarget, ctx);
      return { result: { output: resolved, exitCode: 0, cancelled: false, truncated: false } };
    } catch (error) {
      return failure((error as Error).message);
    }
  });
  pi.on("before_agent_start", async (event) => {
    const host = event as unknown as PromptSectionHost;
    const sections: Record<string, string> = {};
    const projects = catalog().projects;
    sections.ssh_remote = remotePrompt(view(projects));
    // Project context (remote instruction files and project memory) is added only while the focus is a connected
    // remote project. Nothing here may throw or wait on the user: failures leave the prompt without that part.
    const focused = focusedProject()?.connected ? focusedProject() : undefined;
    let instructions: InstructionFile[] = [];
    if (focused) {
      try { sections.ssh_remote_project_memory = projectMemorySection(focused.name, memorySnapshot(focused.name, projects[focused.name]?.ssh)); }
      catch { /* the prompt goes ahead without the memory section */ }
      try { instructions = await ensureFreshContext(focused); }
      catch { /* keep going without instruction files */ }
    }
    const options = host.systemPromptOptions;
    if (options?.sections) {
      Object.assign(options.sections, sections);
      if (focused) {
        options.cwd = focused.cwd;
        // Keep the local files: the local project stays relevant. Remote ones are labelled ssh://<project>/<path>.
        options.contextFiles = [...(options.contextFiles ?? []), ...toContextFiles(focused.name, instructions)];
      }
      return undefined;
    }
    // Hosts that start the agent without structured prompt options (for example omp, which loads
    // Pi extensions through a legacy Pi shim) expose only the rendered system prompt and replace it
    // wholesale with the blocks they handed out. Append the same sections as tagged blocks.
    if (focused && instructions.length) {
      sections.ssh_remote_project_instructions = `Project instructions for ${focused.name} (apply while working on this project):\n${renderInstructionBlocks(focused.name, instructions)}`;
    }
    const blocks = renderPromptSections(sections);
    if (blocks.length === 0) return undefined;
    const rendered = host.systemPrompt;
    const systemPrompt = Array.isArray(rendered)
      ? [...rendered, ...blocks]
      : typeof rendered === "string"
        ? [rendered, ...blocks].join("\n\n")
        : undefined;
    // The Pi handler contract declares a string prompt; those hosts accept the block array.
    return systemPrompt === undefined ? undefined : { systemPrompt } as unknown as BeforeAgentStartEventResult;
  });
}
