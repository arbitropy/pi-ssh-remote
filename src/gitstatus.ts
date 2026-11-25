/**
 * Git-aware status: a one-round-trip remote probe script and its parser, a local probe on `git` via execFile,
 * origin URL normalization, and the compact text of the "Git" block of `/remote status`.
 *
 * Read-only by construction: no fetch, and GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing the index.
 * Everything except the two small runners (`execGit`, `localProbe`) is pure.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { quote } from "./shell.ts";

export const GIT_TIMEOUT_SECONDS = 10;
export const GIT_SUBJECT_MAX = 60;
export const LOCAL_LABEL = "local";

export interface GitInfo {
  /** Undefined when HEAD is detached. */
  branch?: string;
  /** Full and abbreviated HEAD; undefined in a repository without commits. */
  sha?: string;
  short?: string;
  subject?: string;
  /** Lines of `git status --porcelain`. */
  dirty: number;
  /** Upstream ref (for example origin/main) and the commits HEAD is ahead of / behind it; both undefined without an upstream. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Normalized origin URL (host/path), never containing credentials. */
  origin?: string;
}

export type GitResult = { ok: true; info: GitInfo } | { ok: false; reason: string };

const firstLine = (text: string): string => text.split("\n")[0]!.trim();

// ---- origin URL normalization ----------------------------------------------------------------------------

/**
 * Reduces a remote URL to `host/path` so that `git@host:org/repo.git`, `ssh://git@host/org/repo` and
 * `https://user:token@host/org/repo/` compare equal. Credentials, port, trailing slashes and `.git` are dropped;
 * the host is lower-cased. A local path or `file://` URL becomes its path without a trailing `.git`.
 */
export function normalizeGitUrl(url: string | undefined): string | undefined {
  let value = (url ?? "").trim();
  if (!value) return undefined;
  const clean = (path: string): string => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const hostPath = (host: string, path: string): string => `${host.toLowerCase()}/${clean(path).replace(/^\/+/, "")}`.replace(/\/$/, "");

  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (scheme) {
    const rest = scheme[2]!;
    if (scheme[1]!.toLowerCase() === "file") return clean(rest.startsWith("/") ? rest : `/${rest.replace(/^[^/]*/, "")}`) || undefined;
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? "" : rest.slice(slash);
    const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "").replace(/^\[(.*)\]$/, "$1");
    return host ? hostPath(host, path) : undefined;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return clean(value) || undefined; // Windows drive path
  // scp-like: [user@]host:path (no slash before the colon)
  const scp = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.*)$/);
  if (scp) return hostPath(scp[1]!.replace(/^\[(.*)\]$/, "$1"), scp[2]!);
  value = clean(value);
  return value || undefined;
}

// ---- remote probe ----------------------------------------------------------------------------------------

export const newGitDelimiter = (): string => `__PI_GIT_${randomBytes(12).toString("hex")}__`;

/**
 * POSIX sh script that prints one `<delimiter> key=value` line per fact about the repository containing `cwd`,
 * then `<delimiter> end=1`. Every git call is guarded with `2>/dev/null` and the script always exits 0, so a
 * missing git or a directory that is not a repository is reported as `error=...`. The delimiter prefix lets the
 * parser ignore anything a login shell prints around the output.
 */
export function buildGitScript(cwd: string, delimiter = newGitDelimiter()): string {
  if (!/^[A-Za-z0-9_]+$/.test(delimiter)) throw new Error("Invalid delimiter");
  const g = 'git -C "$d"';
  return [
    `D=${delimiter}`,
    `d=${quote(cwd)}`,
    "export GIT_OPTIONAL_LOCKS=0",
    `emit() { printf '%s %s=%s\\n' "$D" "$1" "$2"; }`,
    `if ! command -v git >/dev/null 2>&1; then emit error 'git not installed'; emit end 1; exit 0; fi`,
    `if [ "$(${g} rev-parse --is-inside-work-tree 2>/dev/null)" != true ]; then emit error 'not a git repository'; emit end 1; exit 0; fi`,
    `emit branch "$(${g} symbolic-ref --short -q HEAD 2>/dev/null)"`,
    `emit sha "$(${g} rev-parse HEAD 2>/dev/null)"`,
    `emit short "$(${g} rev-parse --short HEAD 2>/dev/null)"`,
    `emit subject "$(${g} log -1 --format=%s 2>/dev/null)"`,
    `emit dirty "$(${g} status --porcelain 2>/dev/null | wc -l | tr -d ' ')"`,
    `emit upstream "$(${g} rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"`,
    `emit counts "$(${g} rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null)"`,
    `emit origin "$(${g} config --get remote.origin.url 2>/dev/null)"`,
    "emit end 1",
  ].join("\n");
}

const SHA = /^[0-9a-f]{7,64}$/;

/** Turns the facts of one probe (script or local) into a result. Unusable values make the whole entry unavailable. */
export function parseGitFields(fields: Record<string, string>): GitResult {
  if (fields.error) return { ok: false, reason: fields.error };
  const sha = (fields.sha ?? "").trim();
  if (sha && !SHA.test(sha)) return { ok: false, reason: "unexpected output" };
  const short = (fields.short ?? "").trim();
  const upstream = (fields.upstream ?? "").trim();
  const counts = (fields.counts ?? "").trim().match(/^(\d+)\s+(\d+)$/);
  const info: GitInfo = { dirty: Math.max(0, parseInt(fields.dirty ?? "0", 10) || 0) };
  const branch = (fields.branch ?? "").trim();
  if (branch) info.branch = branch;
  if (sha) {
    info.sha = sha;
    info.short = SHA.test(short) ? short : sha.slice(0, 7);
    info.subject = (fields.subject ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  }
  if (upstream && counts) Object.assign(info, { upstream, ahead: Number(counts[1]), behind: Number(counts[2]) });
  else if (upstream) info.upstream = upstream;
  const origin = normalizeGitUrl(fields.origin);
  if (origin) info.origin = origin;
  return { ok: true, info };
}

/** Parses the script's output. A missing `end` line (timeout, killed channel) is reported, not guessed around. */
export function parseGitScriptOutput(output: string, delimiter: string): GitResult {
  const prefix = `${delimiter} `;
  const fields: Record<string, string> = {};
  let ended = false;
  for (const raw of output.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(prefix)) continue;
    const body = line.slice(prefix.length);
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq);
    if (key === "end") ended = true;
    else if (!(key in fields)) fields[key] = body.slice(eq + 1);
  }
  if (!Object.keys(fields).length && !ended) return { ok: false, reason: "no output from the remote" };
  if (!ended) return { ok: false, reason: "incomplete output" };
  return parseGitFields(fields);
}

// ---- local probe -----------------------------------------------------------------------------------------

/**
 * Runs `git -C cwd ...`: resolves with stdout, resolves undefined when git exits non-zero, and rejects when git is
 * missing or does not answer within the timeout.
 */
export function execGit(cwd: string, args: string[], timeoutSeconds = GIT_TIMEOUT_SECONDS): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") return reject(new Error("git not installed"));
      if (failure.killed) return reject(new Error(`timed out after ${timeoutSeconds} s`));
      resolve(undefined);
    });
  });
}

/** The same facts as `buildGitScript`, gathered with execFile. Never rejects. */
export async function gatherLocalGit(cwd: string, git: (args: string[]) => Promise<string | undefined> = (args) => execGit(cwd, args)): Promise<GitResult> {
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return { ok: false, reason: "not a git repository" };
    const [branch, sha, short, subject, status, upstream, counts, origin] = await Promise.all([
      git(["symbolic-ref", "--short", "-q", "HEAD"]),
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--short", "HEAD"]),
      git(["log", "-1", "--format=%s"]),
      git(["status", "--porcelain"]),
      git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
      git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
      git(["config", "--get", "remote.origin.url"]),
    ]);
    return parseGitFields({
      branch: branch?.trim() ?? "", sha: sha?.trim() ?? "", short: short?.trim() ?? "", subject: firstLine(subject ?? ""),
      dirty: String((status ?? "").split("\n").filter(Boolean).length), upstream: upstream?.trim() ?? "", counts: counts?.trim() ?? "",
      origin: origin?.trim() ?? "",
    });
  } catch (error) {
    return { ok: false, reason: firstLine((error as Error).message) };
  }
}

// ---- comparison ------------------------------------------------------------------------------------------

/** Questions about a local repository; `localProbe` answers them with git, tests with fakes. */
export interface LocalProbe {
  /** True when `sha` names a commit that exists in the repository at `repo`. */
  hasCommit(repo: string, sha: string): Promise<boolean>;
  /** Commits only in `remoteSha` and only in `localSha`, or undefined when git cannot say. */
  counts(repo: string, remoteSha: string, localSha: string): Promise<{ remoteOnly: number; localOnly: number } | undefined>;
}

export const localProbe: LocalProbe = {
  async hasCommit(repo, sha) {
    try { return (await execGit(repo, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined; }
    catch { return false; }
  },
  async counts(repo, remoteSha, localSha) {
    try {
      const out = (await execGit(repo, ["rev-list", "--left-right", "--count", `${remoteSha}...${localSha}`]))?.trim().match(/^(\d+)\s+(\d+)$/);
      return out ? { remoteOnly: Number(out[1]), localOnly: Number(out[2]) } : undefined;
    } catch { return undefined; }
  },
};

export interface GitEntry {
  label: string;
  result: GitResult;
  /** Set on local entries: the repository path the probe runs in. */
  repo?: string;
  /** Remote entries: label of the local entry made from the project's `local` link. */
  link?: string;
}

/** `staging: 1 behind local (main 9897131)` and its siblings, for a remote HEAD that exists in the local repository. */
export function describeCounts(label: string, localLabel: string, counts: { remoteOnly: number; localOnly: number }, local: GitInfo): string {
  if (!counts.remoteOnly && !counts.localOnly) return `${label}: same commit as ${localLabel}`;
  const parts = [counts.remoteOnly ? `${counts.remoteOnly} ahead` : "", counts.localOnly ? `${counts.localOnly} behind` : ""].filter(Boolean);
  // "ahead" needs "of"; "behind" and the combined form read fine without it.
  const text = counts.localOnly ? parts.join(", ") : `${parts[0]} of`;
  return `${label}: ${text} ${localLabel} (${local.branch ?? "detached"} ${local.short})`;
}

/**
 * One line per remote entry that has something to say. Entries are grouped by normalized origin: a remote entry
 * is compared with its linked local repository, or with the session's local one, when their origins match.
 * Remote entries left without a local repository are compared with the first entry of their origin group.
 */
export async function compareGit(entries: GitEntry[], probe: LocalProbe = localProbe): Promise<string[]> {
  const locals = entries.filter((e) => e.repo !== undefined && e.result.ok);
  const remotes = entries.filter((e) => e.repo === undefined && e.result.ok);
  const unmatched: GitEntry[] = [];
  const lines = await Promise.all(remotes.map(async (remote): Promise<string | undefined> => {
    const info = (remote.result as { info: GitInfo }).info;
    const linked = remote.link ? locals.find((l) => l.label === remote.link) : undefined;
    const local = linked ?? locals.find((l) => l.label === LOCAL_LABEL);
    if (!local) { unmatched.push(remote); return undefined; }
    const localInfo = (local.result as { info: GitInfo }).info;
    if (!info.origin || info.origin !== localInfo.origin) {
      unmatched.push(remote);
      return linked ? `${remote.label}: ${local.label} has a different origin; not compared` : undefined;
    }
    if (!info.sha) return undefined; // the entry line already says "no commits yet"
    if (!localInfo.sha) return `${remote.label}: ${local.label} repo has no commits`;
    if (info.sha === localInfo.sha) return `${remote.label}: same commit as ${local.label}`;
    if (!(await probe.hasCommit(local.repo!, info.sha))) return `${remote.label}: HEAD ${info.short} not in ${local.label} repo (git fetch?)`;
    const counts = await probe.counts(local.repo!, info.sha, localInfo.sha);
    return counts ? describeCounts(remote.label, local.label, counts, localInfo) : `${remote.label}: could not compare with ${local.label}`;
  }));

  const out = lines.filter((line): line is string => line !== undefined);
  const groups = new Map<string, GitEntry[]>();
  for (const entry of remotes.filter((e) => unmatched.includes(e))) {
    const info = (entry.result as { info: GitInfo }).info;
    if (!info.origin || !info.sha) continue;
    groups.set(info.origin, [...(groups.get(info.origin) ?? []), entry]);
  }
  for (const group of groups.values()) {
    const [first, ...others] = group;
    const base = (first!.result as { info: GitInfo }).info;
    for (const other of others) {
      const info = (other.result as { info: GitInfo }).info;
      out.push(info.sha === base.sha
        ? `${other.label}: same commit as ${first!.label}`
        : `${other.label}: different commit from ${first!.label} (${info.short} vs ${base.short})`);
    }
  }
  return out;
}

// ---- formatting ------------------------------------------------------------------------------------------

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** `- staging: main 9897131 "subject"; 2 dirty; ahead 1 of origin/main; github.com/org/repo` */
export function formatGitLine(label: string, result: GitResult): string {
  if (!result.ok) return `- ${label}: git: unavailable (${result.reason})`;
  const { info } = result;
  const where = info.sha
    ? `${info.branch ?? "detached"} ${info.short} "${clip(info.subject ?? "", GIT_SUBJECT_MAX)}"`
    : `${info.branch ?? "detached"} (no commits yet)`;
  const dirty = info.dirty ? `${info.dirty} dirty` : "clean";
  let upstream = "no upstream";
  if (info.upstream) {
    if (info.ahead === undefined || info.behind === undefined) upstream = `upstream ${info.upstream}`;
    else if (!info.ahead && !info.behind) upstream = `in sync with ${info.upstream}`;
    else upstream = `${[info.ahead ? `ahead ${info.ahead}` : "", info.behind ? `behind ${info.behind}` : ""].filter(Boolean).join(", ")} of ${info.upstream}`;
  }
  return `- ${label}: ${where}; ${dirty}; ${upstream}; ${info.origin ?? "no origin"}`;
}

/** The "Git:" block: one line per entry, then one indented line per comparison. Empty when there is nothing to show. */
export function formatGitBlock(entries: GitEntry[], comparisons: string[]): string[] {
  if (!entries.length) return [];
  return ["Git:", ...entries.map((e) => formatGitLine(e.label, e.result)), ...comparisons.map((line) => `  ${line}`)];
}
