/**
 * Remote execution primitives: exec channels with abort/timeout handling, bounded output accumulation,
 * SFTP helpers, atomic remote writes, and model-output limiting.
 *
 * Operates on a plain ssh2 client; it knows nothing about projects or focus.
 */

import type { Client as SshClient, ClientChannel, SFTPWrapper } from "ssh2";
import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { join, posix } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { formatSize, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { MIN_MODEL_OUTPUT_BYTES } from "./catalog.ts";
import { quote } from "./shell.ts";

export const OUTPUT_FOOTER_RESERVE_BYTES = 512;
export const DEFAULT_REMOTE_TIMEOUT_SECONDS = 30;
export const REMOTE_SEARCH_TIMEOUT_SECONDS = 60;
export const MAX_REMOTE_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export function parseRemoteTimeout(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_REMOTE_TIMEOUT_SECONDS) {
    throw new Error(`Timeout must be a positive number no greater than ${MAX_REMOTE_TIMEOUT_SECONDS} seconds`);
  }
  return seconds;
}

export function withRemoteTimeout(command: string, timeoutSeconds: number): string {
  return `timeout --signal=TERM --kill-after=5s ${timeoutSeconds}s bash -lc ${quote(command)}`;
}

// `exec` replaces the login shell with `timeout`, so a TERM signal request on the channel reaches
// the whole process tree instead of only the shell.
export function remoteCommandLine(command: string, timeoutSeconds: number, cwd?: string): string {
  return `${cwd === undefined ? "" : `cd -- ${quote(cwd)} && `}exec ${withRemoteTimeout(command, timeoutSeconds)}`;
}


export function createOutputFile(): { path: string; fd: number } {
  const outputDir = mkdtempSync(join(tmpdir(), "pi-ssh-remote-output-"));
  const path = join(outputDir, "output.log");
  return { path, fd: openSync(path, "w", 0o600) };
}

export function saveOutput(output: string): string {
  const file = createOutputFile();
  try { writeSync(file.fd, output); }
  finally { closeSync(file.fd); }
  return file.path;
}

export class RemoteExecAccumulator {
  private chunks: Buffer[] = [];
  private tail = Buffer.alloc(0);
  private stderrTail = Buffer.alloc(0);
  private outputFile: { path: string; fd: number } | undefined;
  private totalBytes = 0;
  private newlineCount = 0;
  private lastByte: number | undefined;

  private maxLines: number;
  private maxBytes: number;

  constructor(maxLines: number, maxBytes: number) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (!chunk.length) return;
    this.totalBytes += chunk.length;
    for (const byte of chunk) if (byte === 10) this.newlineCount++;
    this.lastByte = chunk[chunk.length - 1];

    if (!this.outputFile && this.totalBytes > this.maxBytes) {
      this.outputFile = createOutputFile();
      for (const previous of this.chunks) writeSync(this.outputFile.fd, previous);
      this.chunks = [];
    }
    if (this.outputFile) writeSync(this.outputFile.fd, chunk);
    else this.chunks.push(chunk);

    this.tail = Buffer.concat([this.tail, chunk]);
    const tailBytes = this.maxBytes + OUTPUT_FOOTER_RESERVE_BYTES + 4096;
    if (this.tail.length > tailBytes) this.tail = this.tail.subarray(this.tail.length - tailBytes);
  }

  appendStderr(chunk: Buffer): void {
    this.stderrTail = Buffer.concat([this.stderrTail, chunk]);
    if (this.stderrTail.length > this.maxBytes) this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - this.maxBytes);
  }

  private ensureOutputFile(): string {
    if (!this.outputFile) {
      this.outputFile = createOutputFile();
      for (const chunk of this.chunks) writeSync(this.outputFile.fd, chunk);
      this.chunks = [];
    }
    return this.outputFile.path;
  }

  finish() {
    const totalLines = this.totalBytes ? this.newlineCount + (this.lastByte === 10 ? 0 : 1) : 0;
    const source = this.outputFile ? this.tail.toString("utf8") : Buffer.concat(this.chunks).toString("utf8");
    const contentBudget = Math.max(1, this.maxBytes - OUTPUT_FOOTER_RESERVE_BYTES);
    const base = truncateTail(source, { maxLines: this.maxLines, maxBytes: contentBudget });
    const truncated = this.totalBytes > contentBudget || totalLines > this.maxLines || base.truncated;
    const truncation = {
      ...base,
      truncated,
      totalLines,
      totalBytes: this.totalBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    const content = base.content || "Remote command completed.";
    let fullOutputPath: string | undefined;
    let text = content;
    if (truncated) {
      fullOutputPath = this.ensureOutputFile();
      const startLine = Math.max(1, totalLines - base.outputLines + 1);
      text += `\n\n[Showing lines ${startLine}-${totalLines} of ${totalLines} (${formatSize(this.maxBytes)} model-output limit). Full output: ${fullOutputPath}]`;
    }
    this.close();
    return { text, content, truncation, fullOutputPath };
  }

  errorMessage(): string {
    return this.stderrTail.toString("utf8").trim();
  }

  close(): void {
    if (!this.outputFile) return;
    const file = this.outputFile;
    this.outputFile = undefined;
    closeSync(file.fd);
  }
}

export function execRemote(
  client: SshClient,
  command: string,
  allowFailure = false,
  timeoutSeconds = DEFAULT_REMOTE_TIMEOUT_SECONDS,
): Promise<Buffer> {
  const resolvedTimeout = parseRemoteTimeout(timeoutSeconds);
  return new Promise((resolve, reject) => {
    client.exec(remoteCommandLine(command, resolvedTimeout), (error, stream) => {
      if (error) return reject(error);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let locallyTimedOut = false;
      const timer = setTimeout(() => {
        locallyTimedOut = true;
        stopRemoteProcess(stream);
      }, (resolvedTimeout + 8) * 1000);
      const cleanup = () => clearTimeout(timer);
      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.once("error", (streamError: Error) => {
        cleanup();
        reject(streamError);
      });
      stream.on("close", (code: number | null) => {
        cleanup();
        if (locallyTimedOut || code === 124 || code === 137) reject(new Error(`Remote command timed out after ${resolvedTimeout} seconds`));
        else if (!allowFailure && code !== 0) reject(new Error(Buffer.concat(stderr).toString().trim() || `Remote command exited with code ${code}`));
        else resolve(Buffer.concat(stdout));
      });
    });
  });
}

export const abortedError = (): Error => new Error("aborted");

// Rejects as soon as `signal` aborts, even if `promise` is still pending.
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortedError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

// Opens an exec channel; a channel that arrives after an abort is closed instead of returned.
export function openAbortableExec(client: SshClient, command: string, signal?: AbortSignal): Promise<ClientChannel> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return untilAborted(new Promise<ClientChannel>((resolve, reject) =>
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      if (signal?.aborted) {
        try { stream.close(); } catch { /* channel may already be gone */ }
        return reject(abortedError());
      }
      resolve(stream);
    })), signal);
}

// Asks the remote process to stop, then closes the channel. Closing alone never signals a
// process that has no pty, so TERM is sent first (SSH "signal" request). Commands are started
// as `exec timeout ... bash -lc CMD`: the exec makes `timeout` the channel's process, and
// `timeout` runs the command in its own process group and forwards TERM to the whole group.
// Limitation: servers older than OpenSSH 7.9 ignore signal requests; the process then keeps
// running until its own remote timeout, which still bounds it.
export function stopRemoteProcess(stream: ClientChannel): void {
  try { stream.signal("TERM"); } catch { /* channel may already be gone */ }
  try { stream.close(); } catch { /* channel may already be gone */ }
}

// Waits for an exec channel to finish. On abort (or the local safety timer) the remote
// process is signalled and the channel closed, and the call settles immediately on abort:
// `close()` is only a graceful request, and while a long remote command is still running
// the "close" event may never arrive, which would leave the tool call (and the caller's
// stop request) hanging.
export function runExecChannel(
  stream: ClientChannel,
  timeoutSeconds: number,
  onStdout: (chunk: Buffer) => void,
  onStderr: (chunk: Buffer) => void,
  signal?: AbortSignal,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopRemoteProcess(stream);
    }, (timeoutSeconds + 8) * 1000);
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stream.off("data", onStdout);
      stream.stderr.off("data", onStderr);
      finish();
    };
    const abort = () => {
      stopRemoteProcess(stream);
      settle(() => reject(abortedError()));
    };
    stream.on("data", onStdout);
    stream.stderr.on("data", onStderr);
    stream.once("error", (error: Error) => settle(() => reject(error)));
    stream.on("close", (code: number | null) => settle(() =>
      signal?.aborted ? reject(abortedError()) : resolve({ code, timedOut })));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function execRemoteLimited(
  client: SshClient,
  command: string,
  timeoutSeconds: number,
  maxLines: number,
  maxBytes: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<ReturnType<RemoteExecAccumulator["finish"]>> {
  const resolvedTimeout = parseRemoteTimeout(timeoutSeconds);
  const stream = await openAbortableExec(client, remoteCommandLine(command, resolvedTimeout, cwd), signal);
  const accumulator = new RemoteExecAccumulator(maxLines, maxBytes);
  let result: { code: number | null; timedOut: boolean };
  try {
    result = await runExecChannel(
      stream,
      resolvedTimeout,
      (chunk) => accumulator.append(chunk),
      (chunk) => accumulator.appendStderr(chunk),
      signal,
    );
  } catch (error) {
    accumulator.close();
    throw error;
  }
  const { code, timedOut } = result;
  if (timedOut || code === 124 || code === 137) {
    accumulator.close();
    throw new Error(`Remote command timed out after ${resolvedTimeout} seconds`);
  }
  if (code !== 0) {
    const message = accumulator.errorMessage() || `Remote command exited with code ${code}`;
    accumulator.close();
    throw new Error(message);
  }
  return accumulator.finish();
}

export function getSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}

export async function withSftp<T>(client: SshClient, operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const sftp = await getSftp(client);
  try { return await operation(sftp); }
  finally { sftp.end(); }
}

export const sftpCall = <T = void>(start: (done: (error?: Error | null, result?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => start((error, result) => error ? reject(error) : resolve(result as T)));

/** A private sibling name for writing `target` before it is renamed into place. */
export const remoteTempPath = (target: string): string =>
  posix.join(posix.dirname(target), `.${posix.basename(target)}.pi-tmp-${randomBytes(6).toString("hex")}`);

/** Renames `temp` over `target` with posix-rename; only a server without that extension falls back to `mv`. */
export async function renameOverRemote(client: SshClient, sftp: SFTPWrapper, temp: string, target: string): Promise<void> {
  try { await sftpCall((done) => sftp.ext_openssh_rename(temp, target, done)); }
  catch (error) {
    // A real rename failure must not fall back.
    if (!/does not support/i.test((error as Error).message)) throw error;
    await execRemote(client, `mv -f -- ${quote(temp)} ${quote(target)}`);
  }
}

// Writes through a temp sibling and renames it over the target, so an interrupted write never leaves a
// truncated file. Targets that are not regular files, and directories where a temp file cannot be created, are
// written in place.
export async function writeRemoteFileAtomic(client: SshClient, sftp: SFTPWrapper, target: string, content: string | Buffer): Promise<void> {
  const writeInPlace = () => sftpCall((done) => sftp.writeFile(target, content, done));
  let mode: number | undefined;
  try {
    const attrs = await sftpCall<any>((done) => sftp.lstat(target, done));
    if ((attrs.mode & 0o170000) !== 0o100000) return writeInPlace(); // symlink, directory (which must fail), device, ...
    mode = attrs.mode & 0o7777;
  } catch { /* new file, or unreadable metadata: the writes below report the real error */ }

  const temp = remoteTempPath(target);
  // An existing file's mode is copied after the write; until then the temp stays private to the owner.
  const tempOptions = mode === undefined ? { mode: 0o666 } : { mode: 0o600 };
  try { await sftpCall((done) => sftp.writeFile(temp, content, tempOptions, done)); }
  catch (error) {
    await sftpCall((done) => sftp.unlink(temp, done)).catch(() => {});
    if ((error as { code?: unknown }).code === 3) return writeInPlace(); // SSH_FX_PERMISSION_DENIED
    throw error;
  }
  try {
    if (mode !== undefined) await sftpCall((done) => sftp.chmod(temp, mode, done));
    await renameOverRemote(client, sftp, temp, target);
  } catch (error) {
    await sftpCall((done) => sftp.unlink(temp, done)).catch(() => {});
    throw error;
  }
}

export function isReconnectable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /channel open failure|open failed|not connected|no response|econnreset|econnrefused|etimedout|ehostunreach|epipe|connection (?:lost|closed)|socket.*closed|client is not connected/i.test(message);
}

export const isDirectoryMode = (mode: number): boolean => (mode & 0o170000) === 0o040000;
export const sftpStat = (sftp: SFTPWrapper, path: string) => sftpCall<any>((done) => sftp.stat(path, done));
// A missing path is an answer; any other failure (for example a dropped connection) must surface.
export const missingAsFalse = (error: any): false => {
  if (error?.code === 2) return false;
  throw error;
};

export interface OutputLimits { readMaxLines: number; readMaxBytes: number; execMaxLines: number; execMaxBytes: number; turnMaxBytes: number }

/** Applies the configured line/byte limits and the shared per-turn budget (`budget.used`) to a tool result. */
export function limitRemoteToolResult(
  result: any,
  kind: "read" | "exec" | "search",
  limits: OutputLimits,
  budget: { used: number },
  startLine = 1,
  requestedMaxLines?: number,
) {
  const configuredMaxBytes = kind === "exec" ? limits.execMaxBytes : limits.readMaxBytes;
  const configuredMaxLines = kind === "exec" ? limits.execMaxLines : limits.readMaxLines;
  const maxLines = Math.min(configuredMaxLines, requestedMaxLines ?? configuredMaxLines);
  const remaining = Math.max(0, limits.turnMaxBytes - budget.used);
  if (remaining < MIN_MODEL_OUTPUT_BYTES) {
    const text = `[Remote tool output omitted because this turn has used its ${formatSize(limits.turnMaxBytes)} model-output budget. Run a narrower follow-up command.]`;
    budget.used += Buffer.byteLength(text, "utf8");
    return { ...result, content: [{ type: "text", text }], details: { ...(result.details ?? {}), turnBudgetExceeded: true } };
  }

  const maxBytes = Math.min(configuredMaxBytes, remaining);
  const textIndex = result.content?.findIndex((item: any) => item.type === "text") ?? -1;
  if (textIndex < 0) return result;
  const original = result.content[textIndex].text ?? "";
  const reserveBytes = result.details?.modelLimited ? 0 : OUTPUT_FOOTER_RESERVE_BYTES;
  const contentBudget = Math.max(1, maxBytes - reserveBytes);
  const truncation = kind === "exec"
    ? truncateTail(original, { maxLines, maxBytes: contentBudget })
    : truncateHead(original, { maxLines, maxBytes: contentBudget });
  let text = truncation.content;
  let fullOutputPath = result.details?.fullOutputPath as string | undefined;
  if (truncation.firstLineExceedsLimit) {
    text = `[Line ${startLine} exceeds the ${formatSize(maxBytes)} remote read limit. Use bash with sed/head -c to inspect a bounded fragment.]`;
  } else if (truncation.truncated) {
    if (kind === "search") {
      text += `\n\n[Showing first ${truncation.outputLines} lines (${formatSize(maxBytes)} remote output limit). Narrow the pattern or path.]`;
    } else if (kind === "read") {
      const nextOffset = startLine + truncation.outputLines;
      text += `\n\n[Showing ${truncation.outputLines} lines (${formatSize(maxBytes)} remote read limit). Use offset=${nextOffset} to continue.]`;
    } else {
      fullOutputPath ??= saveOutput(original);
      text += `\n\n[Showing the last ${truncation.outputLines} lines (${formatSize(maxBytes)} remote exec limit). Full output: ${fullOutputPath}]`;
    }
  }
  const content = [...result.content];
  content[textIndex] = { ...content[textIndex], text: text || (kind === "exec" ? "Remote command completed." : "") };
  budget.used += Buffer.byteLength(content[textIndex].text, "utf8");
  return {
    ...result,
    content,
    details: {
      ...(result.details ?? {}),
      ...(truncation.truncated ? { truncation } : {}),
      ...(fullOutputPath ? { fullOutputPath } : {}),
    },
  };
}
