/**
 * Pi UI pieces: the masked secret input and the `remote` tool's call/result renderers.
 */

import { DEFAULT_MAX_BYTES, keyHint, truncateTail } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, Text, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { DEFAULT_DISPLAY_LINES } from "./catalog.ts";

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
  if (action === "exec") {
    const name = stringArg(args.name);
    operand = `${name ? `${name} ` : ""}$ ${stringArg(args.remoteCommand) || "..."}`;
  } else if (action === "chdir") operand = stringArg(args.cwd) || "...";
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
  if (details?.action !== "exec") return new Text(fallback, 0, 0);

  const output = details.output || fallback;
  const displayLines = details.displayLines || DEFAULT_DISPLAY_LINES;
  const warnings = [
    ...(details.fullOutputPath ? [`Full output: ${details.fullOutputPath}`] : []),
    ...(details.truncation?.truncated ? [`Truncated: showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines`] : []),
  ];
  const warning = warnings.length ? warnings.join(". ") : undefined;

  if (expanded) {
    return new Text(`${output}${warning ? `\n${theme.fg("warning", `[${warning}]`)}` : ""}`, 0, 0);
  }

  return {
    render(width: number) {
      const styled = output.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
      const visualLines = new Text(styled, 0, 0).render(width);
      const shown = visualLines.slice(-displayLines);
      const skipped = visualLines.length - shown.length;
      const hint = skipped > 0
        ? [theme.fg("muted", `... (${skipped} earlier lines, ${keyHint("app.tools.expand", "to expand")})`)]
        : [];
      return [...hint, ...shown, ...(warning ? [theme.fg("warning", `[${warning}]`)] : [])];
    },
    invalidate() {},
  };
}
