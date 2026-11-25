/**
 * Session state: the ordered list of remote projects used in one Pi session and the current focus.
 * Stored as `pi-ssh-remote-state` custom entries; version 1 entries (single endpoint) are mapped onto
 * catalog projects when loaded. Pure module (no Pi runtime).
 */

import { LOCAL_FOCUS, type Catalog } from "./catalog.ts";
import { parseSshCommand, poolKey } from "./ssh/config.ts";

export const SESSION_STATE_ENTRY_TYPE = "pi-ssh-remote-state";

export interface SessionProjectState { name: string; cwd: string; connected: boolean }
export interface SessionState { version: 2; focus: string; projects: SessionProjectState[] }

const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object";

/** Validates a stored entry. Version 1 entries map to the catalog project with the same ssh command, or the same host and cwd. */
export function parseSessionState(data: unknown, catalog: Catalog): SessionState | undefined {
  if (!isObject(data)) return undefined;
  if (data.version === 2) {
    if (typeof data.focus !== "string" || !Array.isArray(data.projects)) return undefined;
    const projects = data.projects.filter((p): p is SessionProjectState =>
      isObject(p) && typeof p.name === "string" && typeof p.cwd === "string" && typeof p.connected === "boolean");
    return { version: 2, focus: projects.some((p) => p.name === data.focus) ? data.focus : LOCAL_FOCUS, projects };
  }
  if (data.version !== 1 || typeof data.command !== "string") return undefined;
  const cwd = typeof data.cwd === "string" ? data.cwd : undefined;
  let key: string | undefined;
  try { key = poolKey(parseSshCommand(data.command)); } catch { /* match by command only */ }
  const entries = Object.entries(catalog.projects);
  const match = entries.find(([, p]) => p.ssh === data.command)
    ?? entries.find(([, p]) => {
      try { return poolKey(parseSshCommand(p.ssh)) === key && (!cwd || p.cwd === cwd); } catch { return false; }
    });
  if (!match) return undefined;
  const [name, project] = match;
  const connected = data.connected === true;
  return {
    version: 2,
    focus: connected && data.routeRemoteTools !== false ? name : LOCAL_FOCUS,
    projects: [{ name, cwd: cwd ?? project.cwd, connected }],
  };
}
