/**
 * SSH connection pool. Connections are keyed by host identity including the jump chain, so projects on the
 * same host share one client. Host-key trust, authentication, and credential caching are delegated to
 * src/ssh; interactive prompts go through the injected `ConnectUi`, so this module has no Pi dependency.
 */

import type { Client as SshClient } from "ssh2";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execRemote } from "./exec.ts";
import { quote } from "./shell.ts";
import { HOME_CWD } from "./catalog.ts";
import { poolKey, type ParsedSsh } from "./ssh/config.ts";
import { jumpSocket, probeFingerprint } from "./ssh/connection.ts";
import type { createSshAuthenticator } from "./ssh/auth.ts";

export interface ConnectUi {
  confirm(title: string, message: string): Promise<boolean>;
  secret(label: string, placeholder: string): Promise<string | null>;
}

export interface PoolConn { key: string; parsed: ParsedSsh; client: SshClient }

export function createKnownHosts(file: string) {
  const load = (): Record<string, string> => {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch { return {}; }
  };
  const save = (key: string, fingerprint: string): void => {
    const hosts = load();
    hosts[key] = fingerprint;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(hosts, null, 2) + "\n", { mode: 0o600 });
  };
  return { load, save };
}

const displayFingerprint = (hex: string): string => `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`;

/** Resolves a project directory to an absolute path, falling back to the home directory when it is unavailable. */
export async function resolveCwd(client: SshClient, cwd: string): Promise<{ cwd: string; unavailableCwd?: string }> {
  const cd = (target: string) => target === HOME_CWD ? "cd -- ~" : `cd -- ${quote(target)}`;
  try { return { cwd: (await execRemote(client, `${cd(cwd)} && pwd -P`)).toString().trim() }; }
  catch (error) {
    if (cwd === HOME_CWD) throw error;
    return { cwd: (await execRemote(client, "cd -- ~ && pwd -P")).toString().trim(), unavailableCwd: cwd };
  }
}

export function createPool(deps: {
  auth: Pick<ReturnType<typeof createSshAuthenticator>, "authenticateHop">;
  knownHosts: ReturnType<typeof createKnownHosts>;
  /** Called when a pooled client closes without the pool having closed it. */
  onClose: (conn: PoolConn) => void;
}) {
  const conns = new Map<string, PoolConn>();
  const pending = new Map<string, Promise<PoolConn>>();

  // Connects every hop in turn. Without `ui` only already-trusted hosts and cached credentials work.
  async function connectRoute(parsed: ParsedSsh, ui?: ConnectUi): Promise<SshClient> {
    const clients: SshClient[] = [];
    let connectingHop = parsed;
    let closed = false;
    const closeRoute = () => {
      if (closed) return;
      closed = true;
      for (const client of [...clients].reverse()) client.destroy();
    };
    try {
      for (const hop of [...(parsed.jumps ?? []), parsed]) {
        connectingHop = hop;
        const parent = clients.at(-1);
        const socket = () => parent ? jumpSocket(parent, hop) : Promise.resolve(undefined);
        const key = `${hop.host}:${hop.port}`;
        let fingerprint = deps.knownHosts.load()[key];
        if (ui) {
          const probed = await probeFingerprint(hop, await socket());
          if (fingerprint !== probed) {
            const trusted = await ui.confirm(
              fingerprint ? "SSH host key changed" : "Trust SSH host",
              fingerprint
                ? `${hop.label}\nPrevious key: ${displayFingerprint(fingerprint)}\nNew key: ${displayFingerprint(probed)}\nVerify the server identity. Update the saved key and continue?`
                : `${hop.label}\nHost key: ${displayFingerprint(probed)}\nTrust and save this key?`,
            );
            if (!trusted) throw new Error(`The host key for ${hop.label} was not trusted`);
            deps.knownHosts.save(key, probed);
          }
          fingerprint = probed;
        }
        if (!fingerprint) throw new Error(`Host ${key} is not trusted; connect interactively with /remote first`);
        const client = await deps.auth.authenticateHop(hop, fingerprint, socket, ui ? (label, placeholder) => ui.secret(label, placeholder) : undefined);
        if (closed) { client.destroy(); throw new Error("SSH jump connection closed during connection setup"); }
        clients.push(client);
        client.once("close", closeRoute);
      }
      return clients.at(-1)!;
    } catch (error) {
      closeRoute();
      throw new Error(`SSH hop ${connectingHop.label}: ${(error as Error).message}`);
    }
  }

  async function open(parsed: ParsedSsh, key: string, ui?: ConnectUi): Promise<PoolConn> {
    let client: SshClient;
    try { client = await connectRoute(parsed, ui); }
    catch (error) { throw new Error(`${(error as Error).message}\nSSH command: ${parsed.command}`); }
    const conn: PoolConn = { key, parsed, client };
    conns.set(key, conn);
    client.on("close", () => {
      if (conns.get(key) !== conn) return;
      conns.delete(key);
      deps.onClose(conn);
    });
    return conn;
  }

  const connecting = (parsed: ParsedSsh, key: string, ui?: ConnectUi): Promise<PoolConn> => {
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const next = open(parsed, key, ui).finally(() => pending.delete(key));
    pending.set(key, next);
    return next;
  };

  return {
    get: (key: string): PoolConn | undefined => conns.get(key),
    /** Returns the live connection for the host, connecting when there is none. */
    acquire(parsed: ParsedSsh, ui?: ConnectUi): Promise<PoolConn> {
      const key = poolKey(parsed);
      return Promise.resolve(conns.get(key) ?? connecting(parsed, key, ui));
    },
    /** Replaces a dead connection. A connection that already differs from `stale` is returned as is. */
    reconnect(parsed: ParsedSsh, stale?: SshClient, ui?: ConnectUi): Promise<PoolConn> {
      const key = poolKey(parsed);
      const current = conns.get(key);
      if (current && current.client !== stale) return Promise.resolve(current);
      if (current) { conns.delete(key); current.client.end(); }
      return connecting(parsed, key, ui);
    },
    /** Closes a connection on purpose; `onClose` is not called. */
    close(key: string): void {
      const conn = conns.get(key);
      conns.delete(key);
      conn?.client.end();
    },
    closeAll(): void {
      for (const key of [...conns.keys()]) this.close(key);
    },
  };
}

export type Pool = ReturnType<typeof createPool>;
