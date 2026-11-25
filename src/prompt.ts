/**
 * Model- and user-facing text: the `ssh_remote` prompt section, memory instructions, and project listings.
 * Pure module (no Pi runtime): callers pass a plain view of the catalog and the session.
 */

import { LOCAL_FOCUS, type Project } from "./catalog.ts";

export interface SessionView { name: string; cwd: string; connected: boolean }

export interface RemoteView {
  projects: Record<string, Project>;
  session: SessionView[];
  focus: string;
  localCwd: string;
}

const sshOf = (view: RemoteView, name: string): string => view.projects[name]?.ssh ?? "(not saved)";

/** The single, stable `ssh_remote` system-prompt section. */
export function remotePrompt(view: RemoteView): string {
  const saved = Object.keys(view.projects).length;
  if (!view.session.length) {
    return saved
      ? `Working locally. ${saved} saved remote project${saved === 1 ? "" : "s"}; call remote(action="list") when the user refers to a remote project or server.`
      : `No remote projects are saved; the user can add one with /remote add or ask you to (remote action="add").`;
  }
  const focused = view.session.find((p) => p.name === view.focus);
  const focusText = focused ? `${focused.name} (${sshOf(view, focused.name)}, ${focused.cwd})` : `local (${view.localCwd})`;
  const lines = [`Focus: ${focusText}. read, write, edit, bash, grep, find, and ls run there.`];
  if (focused && !focused.connected) lines[0] = `Focus: ${focusText}, NOT CONNECTED: those tools fail until you reconnect or focus local.`;
  lines.push("Remote projects in this session:");
  for (const p of view.session) {
    const project = view.projects[p.name];
    lines.push(p.connected
      ? `- ${p.name}: ${sshOf(view, p.name)}, ${p.cwd}. Connected.${project?.guard ? ` Guard: ${project.guard}.` : ""}${project?.note ? ` Note: ${project.note}` : ""}`
      : `- ${p.name}: ${sshOf(view, p.name)}, ${p.cwd}. Disconnected; reconnect with remote(action="connect", name="${p.name}").`);
  }
  if (view.session.some((p) => p.connected)) {
    lines.push('Pass target="<name>" (or "local") to read/write/edit/bash/grep/find/ls to act on another connected project without switching focus. Connect first: remote(action="connect", name, focus=false).');
  }
  const more = Object.keys(view.projects).filter((name) => !view.session.some((p) => p.name === name)).length;
  lines.push(`Switch with remote(action="focus", name="<name>" | "local").${more ? ` ${more} more saved: remote(action="list").` : ""}`);
  return lines.join("\n");
}

export function memoryManagementPrompt(path: string, project: string): string {
  return `Persistent memory for remote project ${project} is a local JSON file at ${path}: {"project":"${project}","entries":[{"id":"unique-id","content":"text"}]}. This exact path is always handled by the local read, write, and edit tools, even while other tools run on the remote. Read it before changing it; preserve valid JSON and every unrelated entry; add by appending an object with a unique id; update only the matching id. Delete an entry only when the user explicitly asks to delete, remove, or forget it: read the file, identify the exact id, and ask if the target is ambiguous. A correction or replacement is never permission to delete.`;
}

/** The single `ssh_remote_project_memory` section: the entries to apply plus how to manage them. */
export function projectMemorySection(project: string, memory: { path: string; entries: unknown[]; error?: string }): string {
  const state = memory.error
    ? `The project-memory JSON file is invalid and must not be applied until repaired: ${memory.error}`
    : memory.entries.length
      ? `User-configured persistent memory for this remote project; apply it while working on the project:\n${JSON.stringify(memory.entries, null, 2)}`
      : "No memory entries are saved for this project.";
  return `${state}\n\n${memoryManagementPrompt(memory.path, project)}`;
}

/** Renders prompt sections as tagged blocks for hosts that expose only the rendered system prompt. */
export function renderPromptSections(sections: Record<string, string>): string[] {
  return Object.entries(sections)
    .filter(([, content]) => content)
    .map(([name, content]) => `<${name}>\n${content}\n</${name}>`);
}

export function focusLabel(view: RemoteView): string {
  const focused = view.session.find((p) => p.name === view.focus);
  return focused ? `${focused.name} (${focused.cwd})` : LOCAL_FOCUS;
}

/** Compact catalog listing: `name | ssh | cwd | state | note`, with guard/local on the following line when set. */
export function formatProjectList(view: RemoteView): string {
  const names = Object.keys(view.projects);
  const head = `Focus: ${focusLabel(view)}`;
  if (!names.length) return `${head}\nNo remote projects are saved. Add one with /remote add NAME SSH CWD.`;
  const rows = names.map((name) => {
    const project = view.projects[name]!;
    const session = view.session.find((p) => p.name === name);
    const state = name === view.focus ? "focus" : session ? (session.connected ? "connected" : "disconnected in session") : "saved";
    const line = `${name} | ${project.ssh} | ${session?.cwd ?? project.cwd} | ${state} | ${project.note ?? ""}`.replace(/ \| $/, "");
    const extra = [project.guard ? `guard: ${project.guard}` : "", project.local ? `local: ${project.local}` : ""].filter(Boolean);
    return extra.length ? `${line}\n  ${extra.join("; ")}` : line;
  });
  return `${head}\n${rows.join("\n")}`;
}
