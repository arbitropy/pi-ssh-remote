/**
 * File transfer for `copy`: one regular file streamed from one side (the local disk or an SFTP session) to the
 * other through a temp sibling that is renamed over the target, so an interrupted copy never leaves a truncated
 * target. Remote to remote relays through this machine. A side knows nothing about projects or guards.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Client as SshClient, SFTPWrapper } from "ssh2";
import { abortedError, renameOverRemote, sftpCall } from "./exec.ts";
import { copyDirectoryMessage, copyTooLargeMessage, MAX_COPY_BYTES } from "./copy.ts";

export interface FileStat { kind: "file" | "directory" | "other"; size: number; mode: number }

/** The operations `copyFile` needs on one side. Paths are in that side's own syntax. */
export interface FileSide {
  /** "local" or a project name; two sides with the same key and path are the same file. */
  key: string;
  path: Pick<typeof nodePath.posix, "dirname" | "basename" | "join" | "normalize" | "isAbsolute">;
  home(): Promise<string>;
  /** Follows symlinks; undefined when the path does not exist. */
  stat(path: string): Promise<FileStat | undefined>;
  /** Does not follow symlinks (a link reports kind "other"). */
  lstat(path: string): Promise<FileStat | undefined>;
  read(path: string): Readable;
  /** Exclusive create (fails when the path exists). */
  write(path: string, mode: number): Writable;
  chmod(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  /** Renames `temp` to `target`; without `overwrite` an existing target must make it fail. */
  move(temp: string, target: string, overwrite: boolean): Promise<void>;
}

/** A user-facing refusal (as opposed to an I/O failure). */
export class CopyRefused extends Error {}

const kindOfMode = (mode: number): FileStat["kind"] => (mode & 0o170000) === 0o100000 ? "file" : (mode & 0o170000) === 0o040000 ? "directory" : "other";
const missing = (error: any): boolean => error?.code === "ENOENT" || error?.code === 2;

/** Resolves `input` against `cwd` in the side's syntax; `~` and `~/x` mean the side's home directory. */
export async function resolveSidePath(side: FileSide, cwd: string, input: string): Promise<string> {
  if (input === "~" || input.startsWith("~/")) return side.path.normalize(side.path.join(await side.home(), input.slice(1)));
  return side.path.isAbsolute(input) ? side.path.normalize(input) : side.path.normalize(side.path.join(cwd, input));
}

export function localSide(): FileSide {
  const describe = (s: import("node:fs").Stats): FileStat => ({ kind: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other", size: s.size, mode: s.mode });
  const absent = (error: any): undefined => { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined; throw error; };
  return {
    key: "local",
    path: nodePath,
    home: async () => homedir(),
    stat: (path) => stat(path).then(describe, absent),
    lstat: (path) => lstat(path).then(describe, absent),
    read: (path) => createReadStream(path),
    write: (path, mode) => createWriteStream(path, { flags: "wx", mode }),
    chmod: (path, mode) => chmod(path, mode),
    remove: (path) => unlink(path),
    move: async (temp, target, overwrite) => {
      // The pre-check ran before the transfer; look again so a file that appeared meanwhile is not replaced.
      if (!overwrite && await lstat(target).then(() => true, () => false)) throw new CopyRefused(`Destination already exists: ${target}`);
      await rename(temp, target);
    },
  };
}

export function remoteSide(key: string, client: SshClient, sftp: SFTPWrapper): FileSide {
  const describe = (attrs: any): FileStat => ({ kind: kindOfMode(attrs.mode), size: Number(attrs.size), mode: attrs.mode });
  const absent = (error: any): undefined => { if (missing(error)) return undefined; throw error; };
  return {
    key,
    path: nodePath.posix,
    home: () => sftpCall<string>((done) => sftp.realpath(".", done)),
    stat: (path) => sftpCall<any>((done) => sftp.stat(path, done)).then(describe, absent),
    lstat: (path) => sftpCall<any>((done) => sftp.lstat(path, done)).then(describe, absent),
    read: (path) => sftp.createReadStream(path) as unknown as Readable,
    write: (path, mode) => sftp.createWriteStream(path, { flags: "wx", mode }) as unknown as Writable,
    chmod: (path, mode) => sftpCall((done) => sftp.chmod(path, mode, done)),
    remove: (path) => sftpCall((done) => sftp.unlink(path, done)),
    move: async (temp, target, overwrite) => {
      if (overwrite) return renameOverRemote(client, sftp, temp, target);
      // Plain SFTP rename fails when the target exists, which keeps a file that appeared meanwhile intact.
      try { await sftpCall((done) => sftp.rename(temp, target, done)); }
      catch (error) {
        if (await sftpCall<any>((done) => sftp.lstat(target, done)).then(() => true, () => false)) throw new CopyRefused(`Destination already exists: ${target}`);
        throw error;
      }
    },
  };
}

export interface CopyPoint { side: FileSide; path: string; label: string }

export interface CopyOptions {
  overwrite: boolean;
  signal?: AbortSignal;
  /** Override for tests. */
  maxBytes?: number;
  /** Called with the source size once every check has passed and before anything is written (the guard hook). */
  beforeWrite?: (size: number) => Promise<void>;
  /** Formats sizes for messages. */
  formatSize?: (bytes: number) => string;
}

/** Returns a function that waits (at most `ms`) for the stream's "close"; a close that already happened is remembered. */
function watchClose(stream: Writable): (ms: number) => Promise<void> {
  let closed = false;
  const event = new Promise<void>((resolve) => stream.once("close", () => { closed = true; resolve(); }));
  return (ms) => {
    if (closed) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([event, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
  };
}

/** Copies one regular file; resolves with the number of bytes copied. */
export async function copyFile(from: CopyPoint, to: CopyPoint, options: CopyOptions): Promise<number> {
  const { signal, overwrite } = options;
  const maxBytes = options.maxBytes ?? MAX_COPY_BYTES;
  const size = options.formatSize ?? ((bytes: number) => `${bytes} bytes`);
  const checkAborted = () => { if (signal?.aborted) throw abortedError(); };
  checkAborted();

  const source = await from.side.stat(from.path);
  if (!source) throw new CopyRefused(`Source not found: ${from.label}`);
  if (source.kind === "directory") throw new CopyRefused(copyDirectoryMessage(from.label));
  if (source.kind !== "file") throw new CopyRefused(`Source is not a regular file: ${from.label}`);
  if (source.size > maxBytes) throw new CopyRefused(copyTooLargeMessage(from.label, size(source.size), size(maxBytes)));
  if (from.side.key === to.side.key && from.path === to.path) throw new CopyRefused("Source and destination are the same file");

  const parent = to.side.path.dirname(to.path);
  const parentStat = await to.side.stat(parent);
  if (!parentStat) throw new CopyRefused(`Destination directory does not exist: ${parent}`);
  if (parentStat.kind !== "directory") throw new CopyRefused(`Destination parent is not a directory: ${parent}`);
  const existing = await to.side.lstat(to.path);
  if (existing?.kind === "directory") throw new CopyRefused(`Destination is a directory: ${to.label}. Give the full destination file path.`);
  if (existing && existing.kind !== "file") throw new CopyRefused(`Destination exists and is not a regular file: ${to.label}`);
  if (existing && !overwrite) throw new CopyRefused(`Destination already exists: ${to.label}. Pass overwrite=true (or --overwrite) to replace it.`);

  await options.beforeWrite?.(source.size);
  checkAborted();

  const temp = to.side.path.join(parent, `.${to.side.path.basename(to.path)}.pi-tmp-${randomBytes(6).toString("hex")}`);
  // A new file takes the source's permission bits; an existing target keeps its own (applied once the data is in).
  const tempMode = existing ? 0o600 : source.mode & 0o777;
  let copied = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      copied += chunk.length;
      if (copied > maxBytes) return done(new CopyRefused(`${from.label} grew beyond the ${size(maxBytes)} copy limit while copying`));
      done(null, chunk);
    },
  });
  const reader = from.side.read(from.path);
  const writer = to.side.write(temp, tempMode);
  const waitClosed = watchClose(writer);
  try {
    await pipeline(reader, counter, writer, signal ? { signal } : {});
    await waitClosed(5000); // ssh2 reports the handle closed only after the server answered
    if (existing) await to.side.chmod(temp, existing.mode & 0o7777);
    checkAborted();
    await to.side.move(temp, to.path, overwrite);
    return copied;
  } catch (error) {
    reader.destroy();
    writer.destroy();
    await waitClosed(1500); // let a pending open/close settle so the temp exists before it is removed
    await to.side.remove(temp).catch(() => {});
    if (signal?.aborted) throw abortedError();
    throw error;
  }
}
