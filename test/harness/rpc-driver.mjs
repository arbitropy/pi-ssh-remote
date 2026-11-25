#!/usr/bin/env node
// RPC driver for the real pi (`pi --mode rpc`) running in the isolated mock env (see pi.sh).
//
// Usage: node rpc-driver.mjs script.json [--out events.jsonl] [-- extra pi args...]
//
// Script format:
//   {
//     "args": ["--no-session"],                 // extra pi args (after --mode rpc)
//     "timeoutMs": 600000,                      // hard per-step timeout (default 600000)
//     "ui": { "autoConfirm": true,              // answer confirm dialogs (omit => leave unanswered)
//             "inputs":  { "<title/placeholder substring>": "value" },   // input + editor dialogs
//             "selects": { "<title substring>": "<option substring>" },  // select dialogs
//             "cancel":  ["<title substring>"] },                        // answer cancelled:true
//     "steps": [
//       { "command": "/remote ssh mock-prod" },     // extension slash command (sent as `prompt`)
//       { "prompt": "free text (calls the model!)" },
//       { "abort_after_ms": 3000, "prompt": "..." },// send prompt, then `abort` after N ms
//       { "wait_idle": true },
//       { "get_state": true },
//       { "get_commands": true },
//       { "sleep_ms": 500 }
//     ]
//   }
// Every step may also carry "timeoutMs". Exit codes: 0 ok, 1 a step failed, 3 timeout, 2 usage/startup error.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_SH = process.env.PI_SH || path.join(HERE, "pi.sh");
const ROOT = process.env.MOCK_ROOT || "/tmp/pi-ssh-mock";
const GRACE_MS = Number(process.env.RPC_GRACE_MS || 750);

// ---- args ----
const argv = process.argv.slice(2);
let scriptPath, outPath;
const extraArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--") { extraArgs.push(...argv.slice(i + 1)); break; }
  else if (argv[i] === "--out") outPath = argv[++i];
  else if (!scriptPath) scriptPath = argv[i];
  else { console.error(`unexpected argument: ${argv[i]}`); process.exit(2); }
}
if (!scriptPath) { console.error("usage: rpc-driver.mjs script.json [--out events.jsonl] [-- pi args...]"); process.exit(2); }
const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
const defaultTimeout = script.timeoutMs ?? 600000;
const ui = script.ui ?? {};
if (!outPath) { fs.mkdirSync(path.join(ROOT, "out"), { recursive: true }); outPath = path.join(ROOT, "out", `rpc-${Date.now()}.jsonl`); }
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
const out = fs.createWriteStream(outPath, { flags: "w" });

// ---- single-instance lock (never more than one pi at a time) ----
fs.mkdirSync(ROOT, { recursive: true });
const LOCK = path.join(ROOT, "rpc-driver.lock");
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" }); return; }
    catch {
      let pid = NaN;
      try { pid = Number(fs.readFileSync(LOCK, "utf8")); } catch { /* raced */ }
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* stale */ } }
      if (alive) { console.error(`another rpc-driver (pid ${pid}) is running; refusing to start a second pi`); process.exit(2); }
      try { fs.unlinkSync(LOCK); } catch { /* ignore */ }
    }
  }
  console.error("could not acquire lock"); process.exit(2);
}
acquireLock();
const releaseLock = () => { try { if (fs.readFileSync(LOCK, "utf8") === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* ignore */ } };

// ---- helpers ----
const t0 = Date.now();
const trunc = (s, n) => { s = String(s).replace(/\x1b\[[0-9;]*m/g, "").replace(/\n/g, "\\n"); return s.length > n ? s.slice(0, n) + `...(+${s.length - n})` : s; };
const say = (s) => process.stdout.write(s + "\n");
const textOf = (content) => Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("") : String(content ?? "");
const log = (rec) => out.write(JSON.stringify({ _ts: Date.now() - t0, ...rec }) + "\n");

// ---- spawn pi ----
say(`# spawning: ${PI_SH} --mode rpc ${[...(script.args ?? []), ...extraArgs].join(" ")}`);
const child = spawn(PI_SH, ["--mode", "rpc", ...(script.args ?? []), ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
const stderrPath = outPath + ".stderr";
const stderrOut = fs.createWriteStream(stderrPath);
child.stderr.pipe(stderrOut);
let childExited = false, childExitCode = null;
child.on("exit", (code, sig) => { childExited = true; childExitCode = code ?? sig; wake(); });
child.on("error", (e) => { console.error("spawn error:", e.message); releaseLock(); process.exit(2); });

// ---- state ----
let running = false;          // agent run active (agent_start .. agent_settled)
let startSeq = 0, settledSeq = 0;
let lastAssistantText = "", lastAssistantError = "";
const pending = new Map();    // request id -> {resolve}
const waiters = new Set();
const wake = () => { for (const w of [...waiters]) w(); };
let nextId = 1;

function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
function request(cmd) {
  const id = `r${nextId++}`;
  return new Promise((resolve) => { pending.set(id, resolve); send({ id, ...cmd }); });
}
function waitFor(pred, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (pred()) { cleanup(); resolve(); }
      else if (childExited) { cleanup(); reject(new Error(`pi exited (${childExitCode}) while waiting for ${what}`)); }
    };
    const timer = setTimeout(() => { cleanup(); const e = new Error(`timeout after ${timeoutMs}ms waiting for ${what}`); e.timeout = true; reject(e); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); waiters.delete(check); };
    waiters.add(check);
    check();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- UI request handling ----
const lc = (s) => String(s ?? "").toLowerCase();
function matchKey(map, hay) {
  for (const [k, v] of Object.entries(map ?? {})) if (lc(hay).includes(lc(k))) return { k, v };
  return undefined;
}
function handleUiRequest(r) {
  const label = `${r.title ?? ""} ${r.message ?? ""} ${r.placeholder ?? ""}`;
  switch (r.method) {
    case "notify": say(`  NOTIFY[${r.notifyType ?? "info"}] ${trunc(r.message, 300)}`); return;
    case "setStatus": say(`  STATUS ${r.statusKey}: ${r.statusText === undefined ? "(cleared)" : trunc(r.statusText, 300)}`); return;
    case "setWidget": say(`  WIDGET ${r.widgetKey}: ${r.widgetLines ? trunc(r.widgetLines.join(" | "), 300) : "(cleared)"}`); return;
    case "setTitle": case "set_editor_text": return;
    case "select": case "confirm": case "input": case "editor": break;
    default: say(`  UI ${r.method} (ignored)`); return;
  }
  let answer, how;
  const cancelHit = (ui.cancel ?? []).find((c) => lc(label).includes(lc(c)));
  if (cancelHit) { answer = { cancelled: true }; how = "cancelled"; }
  else if (r.method === "confirm" && typeof ui.autoConfirm === "boolean") { answer = { confirmed: ui.autoConfirm }; how = `confirmed=${ui.autoConfirm}`; }
  else if (r.method === "input" || r.method === "editor") {
    const m = matchKey(ui.inputs, label);
    if (m) { answer = { value: String(m.v) }; how = `value from inputs["${m.k}"]`; }
  } else if (r.method === "select") {
    const m = matchKey(ui.selects, label);
    if (m) {
      const opt = (r.options ?? []).find((o) => lc(typeof o === "string" ? o : o?.label ?? o?.value).includes(lc(m.v)));
      if (opt !== undefined) { answer = { value: typeof opt === "string" ? opt : opt.value ?? opt.label }; how = `selected "${answer.value}"`; }
    }
  }
  say(`  UI ${r.method} "${trunc(r.title ?? "", 120)}"${r.message ? ` msg="${trunc(r.message, 200)}"` : ""}${r.options ? ` options=${trunc(JSON.stringify(r.options), 150)}` : ""}${r.timeout ? ` timeout=${r.timeout}ms` : ""} -> ${answer ? how : "UNANSWERED"}`);
  if (answer) send({ type: "extension_ui_response", id: r.id, ...answer });
}

// ---- event handling ----
function handleRecord(rec) {
  log(rec);
  switch (rec.type) {
    case "response": {
      const res = pending.get(rec.id);
      if (res) { pending.delete(rec.id); res(rec); }
      else if (!rec.success) say(`  RESPONSE-ERROR ${rec.command}: ${rec.error}`);
      break;
    }
    case "extension_ui_request": handleUiRequest(rec); break;
    case "agent_start": running = true; startSeq++; break;
    case "agent_settled": running = false; settledSeq++; say(`  (agent_settled aborted=${rec.aborted})`); break;
    case "tool_execution_start": say(`  TOOL ${rec.toolName} ${trunc(JSON.stringify(rec.args), 200)}`); break;
    case "tool_execution_end": say(`    -> ${trunc(textOf(rec.result?.content), 300)}${rec.isError ? "  [isError]" : ""}  (${rec.durationMs ?? "?"}ms, isError=${!!rec.isError})`); break;
    case "message_end":
      if (rec.message?.role === "assistant") {
        const t = textOf(rec.message.content);
        if (t) lastAssistantText = t;
        if (rec.message.stopReason === "error" || rec.message.errorMessage) { lastAssistantError = rec.message.errorMessage || "error"; say(`  ASSISTANT-ERROR ${trunc(lastAssistantError, 300)}`); }
      }
      break;
    case "extension_error": say(`  EXTENSION-ERROR ${trunc(JSON.stringify(rec), 400)}`); break;
    case "auto_retry_start": case "compaction_start": say(`  (${rec.type})`); break;
    default: break;
  }
  wake();
}
let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(0x0a)) >= 0) {
    let line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try { handleRecord(JSON.parse(line)); } catch { log({ type: "driver_unparsed", line }); say(`  (unparsed stdout: ${trunc(line, 200)})`); }
  }
});

// ---- steps ----
let failed = false;
const extensionCommands = new Set();
async function loadCommands(timeout) {
  const r = await Promise.race([request({ type: "get_commands" }), sleep(timeout).then(() => undefined)]);
  if (r?.success) for (const c of r.data.commands) extensionCommands.add(c.name);
  return r;
}

async function doPrompt(message, step, timeout) {
  const baseStart = startSeq;
  lastAssistantText = ""; lastAssistantError = "";
  const isSlash = message.startsWith("/");
  if (isSlash && !message.startsWith("/skill:")) {
    // An unknown slash command would fall through to the MODEL as free text. Refuse that.
    if (extensionCommands.size === 0) await loadCommands(Math.min(timeout, 15000));
    const name = message.slice(1).split(/\s+/)[0];
    if (!extensionCommands.has(name)) throw new Error(`unknown slash command "/${name}" (refusing to send it as model text); known: ${[...extensionCommands].join(", ")}`);
  }
  const baseSettled = settledSeq;
  let abortTimer;
  if (step.abort_after_ms) abortTimer = setTimeout(() => { say(`  >> abort after ${step.abort_after_ms}ms`); send({ type: "abort" }); }, step.abort_after_ms);
  // For a handled extension command the response arrives only AFTER the handler finishes,
  // so UI dialogs are answered concurrently by handleUiRequest while we wait here.
  const resp = await Promise.race([
    request({ type: "prompt", message }),
    sleep(timeout).then(() => { const e = new Error(`timeout after ${timeout}ms waiting for prompt response`); e.timeout = true; throw e; }),
  ]);
  if (!resp.success) { clearTimeout(abortTimer); throw new Error(`prompt rejected: ${resp.error}`); }
  const disposition = resp.data?.disposition;
  say(`  (prompt response disposition=${disposition})`);
  const remaining = Math.max(1000, timeout - 0);
  if (disposition === "started" || disposition === "queued") {
    await waitFor(() => settledSeq > baseSettled && !running, remaining, "agent_settled");
  } else {
    // "handled": an extension command ran. It may have triggered an agent turn (sendMessage) - give it a moment.
    await sleep(GRACE_MS);
    if (startSeq > baseStart || running) await waitFor(() => !running, remaining, "agent_settled after command");
  }
  clearTimeout(abortTimer);
  if (lastAssistantText) say(`  ASSISTANT: ${trunc(lastAssistantText, 2000)}`);
}

async function runStep(step, idx) {
  const timeout = step.timeoutMs ?? defaultTimeout;
  if (step.prompt !== undefined) await doPrompt(step.prompt, step, timeout);
  else if (step.command !== undefined) await doPrompt(step.command, step, timeout);
  else if (step.wait_idle) { await sleep(GRACE_MS); await waitFor(() => !running, timeout, "idle"); }
  else if (step.get_state) {
    const r = await request({ type: "get_state" });
    const d = r.data ?? {};
    say(`  STATE ${r.success ? "" : "(failed) "}model=${d.model?.provider}/${d.model?.id} streaming=${d.isStreaming} messages=${d.messageCount} session=${d.sessionFile ?? "(none)"}`);
  } else if (step.get_commands) {
    const r = await loadCommands(Math.min(timeout, 30000));
    say(`  COMMANDS ${[...extensionCommands].join(", ")}`);
    if (!r?.success) throw new Error("get_commands failed");
  } else if (step.sleep_ms) await sleep(step.sleep_ms);
  else throw new Error(`unrecognized step: ${JSON.stringify(step)}`);
}

async function shutdown() {
  if (childExited) return;
  try { child.stdin.end(); } catch { /* ignore */ }
  await Promise.race([new Promise((r) => child.once("exit", r)), sleep(10000)]);
  if (!childExited) { child.kill("SIGTERM"); await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]); }
  if (!childExited) child.kill("SIGKILL");
}
function hardKill() { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { hardKill(); releaseLock(); process.exit(130); });
process.on("exit", () => { hardKill(); releaseLock(); });

let exitCode = 0;
try {
  // Wait for RPC to be live (get_state answers once input is attached).
  const ready = await Promise.race([request({ type: "get_state" }), sleep(60000).then(() => undefined)]);
  if (!ready) throw Object.assign(new Error("pi did not answer get_state within 60s"), { timeout: true });
  await loadCommands(15000);
  const steps = script.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    say(`[step ${i + 1}/${steps.length}] ${trunc(JSON.stringify(step), 200)}`);
    log({ type: "driver_step", index: i, step });
    const s0 = Date.now();
    try { await runStep(step, i); }
    catch (e) {
      say(`  STEP-ERROR ${e.message}`);
      log({ type: "driver_step_error", index: i, error: e.message });
      if (e.timeout) { exitCode = 3; say(`  step took ${Date.now() - s0}ms`); throw e; }
      failed = true;
    }
    say(`  step took ${Date.now() - s0}ms`);
  }
  if (failed) exitCode = 1;
} catch (e) {
  if (!exitCode) exitCode = 1;
  say(`# aborting run: ${e.message}`);
  if (e.timeout) { hardKill(); }
}
await shutdown();
await new Promise((r) => out.end(r));
say(`# pi exit: ${childExitCode}; total ${Date.now() - t0}ms; events: ${outPath}; stderr: ${stderrPath}`);
if (exitCode === 0 && childExitCode !== 0 && childExitCode !== null) exitCode = 1;
releaseLock();
process.exit(exitCode);
