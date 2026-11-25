/**
 * Pi UI pieces: the masked secret input and the `remote` tool's call/result renderers.
 */

import { DEFAULT_MAX_BYTES, truncateTail } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

// Bounds interactive dialogs (secret prompts, host-key trust, command input) on non-interactive hosts such
// as RPC: the host may never answer, and an unbounded wait would otherwise wedge the process.
export const NON_INTERACTIVE_DIALOG_TIMEOUT_MS = 30_000;

export function previewRemoteOutput(output: string, displayLines: number): string {
  return truncateTail(output, { maxLines: displayLines, maxBytes: DEFAULT_MAX_BYTES }).content || "Remote command completed.";
}

export class SecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  constructor(private label: string, private done: (value: string | null) => void, private renderNow: () => void) {}
  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) return this.done(this.value);
    if (matchesKey(data, Key.escape)) return this.done(null);
    if (matchesKey(data, Key.backspace)) this.value = [...this.value].slice(0, -1).join("");
    else if (matchesKey(data, Key.ctrl("u"))) this.value = "";
    else {
      const clean = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
      if ([...clean].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)) this.value += clean;
    }
    this.renderNow();
  }
  render(width: number): string[] {
    return [truncateToWidth(`${this.label}: ${"•".repeat([...this.value].length)}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`, width, "")];
  }
  invalidate(): void {}
}

export async function askSecret(ctx: any, label: string, placeholder: string): Promise<string | null> {
  if (ctx.mode !== "tui") return (await ctx.ui.input(`${label}:`, placeholder, { timeout: NON_INTERACTIVE_DIALOG_TIMEOUT_MS })) ?? null;
  return ctx.ui.custom<string | null>((tui: any, _theme: any, _keys: any, done: (value: string | null) => void) =>
    new SecretInput(label, done, () => tui.requestRender()));
}

const stringArg = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export function renderRemoteControlCall(params: any, theme: any): Component {
  const args = params ?? {};
  const action = typeof args.action === "string" && args.action ? args.action : "...";
  let operand: string | undefined;
  if (action === "chdir") operand = stringArg(args.cwd) || "...";
  else if (action === "copy") operand = stringArg(args.from) || stringArg(args.to) ? `${stringArg(args.from) ?? "..."} -> ${stringArg(args.to) ?? "..."}` : undefined;
  else if (action === "forward") operand = [stringArg(args.name), stringArg(args.forwards)].filter(Boolean).join(" ") || undefined;
  else operand = stringArg(args.name) || undefined;

  const title = theme.fg("toolTitle", theme.bold("remote"));
  const actionText = theme.fg("muted", ` ${action}`);
  const operandText = operand ? theme.fg("accent", `  ${operand}`) : "";
  return new Text(`${title}${actionText}${operandText}`, 0, 0);
}

export function renderRemoteControlResult(result: any, expanded: boolean, theme: any): Component {
  const fallback = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  const details = result.details;
  if (details?.summary) {
    // Expanded shows the full result text (for example the project instructions the agent was given).
    if (expanded && fallback.trim() !== String(details.summary).trim()) return new Text(fallback, 0, 0);
    return {
      render: (width: number) => [truncateToWidth(details.summary, width)],
      invalidate() {}, // Stateless: the summary is rendered afresh at each width.
    };
  }
  return new Text(fallback, 0, 0);
}

/** A built-in call header with a project prefix on its first line; `inner` is the built-in component. */
class PrefixedCall implements Component {
  constructor(public inner: Component, public prefix: string) {}
  render(width: number): string[] {
    const lines = this.inner.render(Math.max(1, width - visibleWidth(this.prefix)));
    return lines.length ? [this.prefix + lines[0], ...lines.slice(1)] : [this.prefix.trimEnd()];
  }
  invalidate(): void { this.inner.invalidate?.(); }
}

/**
 * Wraps a built-in `renderCall` so a call that runs on a remote project starts with an accent `[project] `.
 * The built-in renderers reuse `context.lastComponent`, so it is handed back to them unwrapped.
 * Without a label the built-in component is returned as is.
 */
export function withProjectPrefix<A, C extends { lastComponent?: Component }>(
  renderCall: (args: A, theme: any, context: C) => Component,
  labelFor: (args: A, context: any) => string | undefined,
): (args: A, theme: any, context: C) => Component {
  return (args, theme, context) => {
    const previous = context.lastComponent instanceof PrefixedCall ? context.lastComponent : undefined;
    const inner = renderCall(args, theme, previous ? { ...context, lastComponent: previous.inner } : context);
    const label = labelFor(args, context);
    if (!label) return inner;
    const prefix = theme.fg("accent", `[${label}] `);
    if (!previous) return new PrefixedCall(inner, prefix);
    previous.inner = inner;
    previous.prefix = prefix;
    return previous;
  };
}
