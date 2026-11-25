// Local-to-local exercises of copyFile and the copy argument parsing. Remote sides are covered by the mock-ssh harness.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFile, localSide, resolveSidePath } from "../src/transfer.ts";
import { parseCopyArgs, parseCopyEndpoint } from "../src/copy.ts";

const side = localSide();
const point = (path) => ({ side, path, label: `local:${path}` });
const tmp = () => mkdtempSync(join(tmpdir(), "copy-"));
const refused = (promise, re) => assert.rejects(promise, (e) => { assert.match(e.message, re); return true; });

test("parseCopyEndpoint / parseCopyArgs", () => {
  assert.deepEqual(parseCopyEndpoint("local:/tmp/a b", "from"), { project: "local", path: "/tmp/a b" });
  assert.deepEqual(parseCopyEndpoint(" prod:logs/x:y", "to"), { project: "prod", path: "logs/x:y" });
  for (const bad of ["", undefined, "nocolon", ":x", "prod:", "prod:  "]) assert.throws(() => parseCopyEndpoint(bad, "from"), /from must be local:<path> or <project>:<path>/);
  assert.deepEqual(parseCopyArgs(["a:x", "b:y"]), { from: "a:x", to: "b:y", overwrite: false });
  assert.deepEqual(parseCopyArgs(["--overwrite", "a:x", "b:y"]), { from: "a:x", to: "b:y", overwrite: true });
  assert.throws(() => parseCopyArgs(["a:x"]), /Usage: \/remote copy FROM TO/);
  assert.throws(() => parseCopyArgs(["a:x", "b:y", "--force"]), /Unknown option --force/);
});

test("resolveSidePath: relative, absolute, home", async () => {
  assert.equal(await resolveSidePath(side, "/w", "a/../b.txt"), "/w/b.txt");
  assert.equal(await resolveSidePath(side, "/w", "/abs/x"), "/abs/x");
  assert.match(await resolveSidePath(side, "/w", "~/x"), /\/x$/);
});

test("copyFile: new file keeps mode, no temp left, overwrite rules", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "src.txt"), "hello"); chmodSync(join(dir, "src.txt"), 0o640);
    assert.equal(await copyFile(point(join(dir, "src.txt")), point(join(dir, "dst.txt")), { overwrite: false }), 5);
    assert.equal(readFileSync(join(dir, "dst.txt"), "utf8"), "hello");
    assert.equal(statSync(join(dir, "dst.txt")).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dir).sort(), ["dst.txt", "src.txt"]);
    await refused(copyFile(point(join(dir, "src.txt")), point(join(dir, "dst.txt")), { overwrite: false }), /Destination already exists.*overwrite=true/);
    writeFileSync(join(dir, "src.txt"), "second"); chmodSync(join(dir, "dst.txt"), 0o600);
    assert.equal(await copyFile(point(join(dir, "src.txt")), point(join(dir, "dst.txt")), { overwrite: true }), 6);
    assert.equal(readFileSync(join(dir, "dst.txt"), "utf8"), "second");
    assert.equal(statSync(join(dir, "dst.txt")).mode & 0o777, 0o600, "existing target keeps its mode");
    assert.deepEqual(readdirSync(dir).sort(), ["dst.txt", "src.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("copyFile: refusals", async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "f"), "x"); symlinkSync(join(dir, "f"), join(dir, "link"));
    await refused(copyFile(point(join(dir, "sub")), point(join(dir, "o")), { overwrite: false }), /Source is a directory.*tar/);
    await refused(copyFile(point(join(dir, "nope")), point(join(dir, "o")), { overwrite: false }), /Source not found: local:/);
    await refused(copyFile(point(join(dir, "f")), point(join(dir, "sub")), { overwrite: true }), /Destination is a directory/);
    await refused(copyFile(point(join(dir, "f")), point(join(dir, "link")), { overwrite: true }), /not a regular file/);
    await refused(copyFile(point(join(dir, "f")), point(join(dir, "missing", "o")), { overwrite: false }), /Destination directory does not exist/);
    await refused(copyFile(point(join(dir, "f")), point(join(dir, "f")), { overwrite: true }), /same file/);
    assert.equal(await copyFile(point(join(dir, "link")), point(join(dir, "fromlink")), { overwrite: false }), 1, "a source symlink to a file is followed");
    writeFileSync(join(dir, "big"), ""); truncateSync(join(dir, "big"), 2000);
    await refused(copyFile(point(join(dir, "big")), point(join(dir, "o")), { overwrite: false, maxBytes: 1000, formatSize: (n) => `${n}B` }), /Source is 2000B, above the 1000B copy limit/);
    assert.equal(existsSync(join(dir, "o")), false);
    let asked = -1;
    await refused(copyFile(point(join(dir, "f")), point(join(dir, "link")), { overwrite: false, beforeWrite: async () => { asked = -2; } }), /not a regular file/);
    assert.equal(asked, -1, "the hook runs only after every check passed");
    await refused(copyFile(point(join(dir, "f")), point(join(dir, "f2")), { overwrite: false, beforeWrite: async (size) => { asked = size; throw new Error("declined"); } }), /declined/);
    assert.equal(asked, 1);
    assert.equal(existsSync(join(dir, "f2")), false);
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes("pi-tmp")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("copyFile: abort mid-copy removes the temp and leaves no target", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "big"), ""); truncateSync(join(dir, "big"), 40 * 1024 * 1024);
    const ac = new AbortController();
    const promise = copyFile(point(join(dir, "big")), point(join(dir, "out")), { overwrite: false, signal: ac.signal });
    const watch = setInterval(() => { if (readdirSync(dir).some((n) => n.includes("pi-tmp"))) { ac.abort(); clearInterval(watch); } }, 1);
    await refused(promise, /^aborted$/).finally(() => clearInterval(watch));
    assert.deepEqual(readdirSync(dir).sort(), ["big"]);
    const pre = new AbortController(); pre.abort();
    await refused(copyFile(point(join(dir, "big")), point(join(dir, "out")), { overwrite: false, signal: pre.signal }), /^aborted$/);
    assert.deepEqual(readdirSync(dir).sort(), ["big"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("copyFile: a source that grows past the cap is stopped and cleaned up", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "f"), "x".repeat(100));
    const grower = { ...side, stat: async () => ({ kind: "file", size: 10, mode: 0o644 }) }; // lies about its size
    await refused(copyFile({ side: grower, path: join(dir, "f"), label: "src" }, point(join(dir, "o")), { overwrite: false, maxBytes: 50 }), /grew beyond/);
    assert.deepEqual(readdirSync(dir).sort(), ["f"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
