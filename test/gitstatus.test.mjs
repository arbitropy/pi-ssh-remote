// Run: node --test test/  (Node 22.18+/24 strips types)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGitScript, compareGit, describeCounts, formatGitBlock, formatGitLine, gatherLocalGit, localProbe, normalizeGitUrl, parseGitFields, parseGitScriptOutput,
} from "../src/gitstatus.ts";

test("normalizeGitUrl treats ssh, scp-like and https forms of one repository as equal", () => {
  const same = [
    "git@github.com:org/repo.git", "ssh://git@github.com/org/repo", "ssh://git@github.com:2222/org/repo.git", "https://github.com/org/repo",
    "https://user:s3cret@github.com/org/repo.git", "https://token@GitHub.com/org/repo/", "git://github.com/org/repo.git", "github.com:org/repo", "  git@github.com:org/repo.git/  ",
  ];
  for (const url of same) assert.equal(normalizeGitUrl(url), "github.com/org/repo", url);
  assert.equal(normalizeGitUrl("git@gitlab.example.com:group/sub/proj.git"), "gitlab.example.com/group/sub/proj");
  assert.equal(normalizeGitUrl("ssh://git@host:2222/~me/x.git"), "host/~me/x");
  assert.equal(normalizeGitUrl("git@host:/srv/git/x.git"), "host/srv/git/x");
  assert.equal(normalizeGitUrl("/tmp/pi-ssh-mock/flow/origin.git"), "/tmp/pi-ssh-mock/flow/origin");
  assert.equal(normalizeGitUrl("file:///tmp/pi-ssh-mock/flow/origin.git"), "/tmp/pi-ssh-mock/flow/origin");
  assert.equal(normalizeGitUrl("C:\\repos\\x.git"), "C:/repos/x");
  assert.equal(normalizeGitUrl("https://user:pw@host/a.git").includes("pw"), false);
  assert.equal(normalizeGitUrl(""), undefined);
  assert.equal(normalizeGitUrl(undefined), undefined);
  assert.notEqual(normalizeGitUrl("git@github.com:org/repo-a.git"), normalizeGitUrl("git@github.com:org/repo-b.git"));
});

const D = "__PI_GIT_test__";
const out = (...lines) => lines.map((l) => `${D} ${l}`).join("\n") + "\n";

test("parseGitScriptOutput: full output, noise, and framing", () => {
  const text = "Welcome to host\n" + out("branch=main", "sha=" + "a".repeat(40), "short=aaaaaaa", "subject=Fix = the thing", "dirty=3", "upstream=origin/main", "counts=1\t2", "origin=git@h:o/r.git", "end=1") + "motd after\n";
  const r = parseGitScriptOutput(text, D);
  assert.deepEqual(r, { ok: true, info: { dirty: 3, branch: "main", sha: "a".repeat(40), short: "aaaaaaa", subject: "Fix = the thing", upstream: "origin/main", ahead: 1, behind: 2, origin: "h/o/r" } });
});
test("parseGitScriptOutput: detached, no upstream, no origin", () => {
  const r = parseGitScriptOutput(out("branch=", "sha=" + "b".repeat(40), "short=bbbbbbb", "subject=s", "dirty=0", "upstream=", "counts=", "origin=", "end=1"), D);
  assert.equal(r.ok, true);
  assert.deepEqual(r.info, { dirty: 0, sha: "b".repeat(40), short: "bbbbbbb", subject: "s" });
});
test("parseGitScriptOutput: unborn branch, errors, truncation", () => {
  const unborn = parseGitScriptOutput(out("branch=main", "sha=", "short=", "subject=", "dirty=1", "upstream=", "counts=", "origin=", "end=1"), D);
  assert.deepEqual(unborn, { ok: true, info: { dirty: 1, branch: "main" } });
  assert.deepEqual(parseGitScriptOutput(out("error=not a git repository", "end=1"), D), { ok: false, reason: "not a git repository" });
  assert.deepEqual(parseGitScriptOutput(out("error=git not installed", "end=1"), D), { ok: false, reason: "git not installed" });
  assert.deepEqual(parseGitScriptOutput(out("branch=main", "sha=" + "a".repeat(40)), D), { ok: false, reason: "incomplete output" });
  assert.deepEqual(parseGitScriptOutput("hello\n", D), { ok: false, reason: "no output from the remote" });
  assert.deepEqual(parseGitScriptOutput(out("sha=zzzz;rm", "end=1"), D), { ok: false, reason: "unexpected output" });
  // a value cannot forge framing: only lines starting with the delimiter count
  assert.equal(parseGitScriptOutput(out("subject=x\nbranch=evil", "end=1"), D).ok, true);
});

test("the script runs under sh and its output parses (real repository)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gitstatus-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a"), "1");
    git("add", "a"); git("commit", "-q", "-m", "first commit");
    git("remote", "add", "origin", "https://u:p@example.com/o/r.git");
    writeFileSync(join(dir, "b"), "2");
    const delimiter = "__PI_GIT_abc__";
    const sh = execFileSync("sh", ["-c", buildGitScript(dir, delimiter)], { encoding: "utf8" });
    const remote = parseGitScriptOutput(sh, delimiter);
    assert.equal(remote.ok, true);
    assert.equal(remote.info.branch, "main"); assert.equal(remote.info.subject, "first commit"); assert.equal(remote.info.dirty, 1);
    assert.equal(remote.info.origin, "example.com/o/r"); assert.equal(remote.info.upstream, undefined);
    assert.equal(remote.info.sha, git("rev-parse", "HEAD").trim());
    const local = execFileSync("sh", ["-c", buildGitScript(join(dir, "nope"), delimiter)], { encoding: "utf8" });
    assert.deepEqual(parseGitScriptOutput(local, delimiter), { ok: false, reason: "not a git repository" });
    assert.deepEqual(await gatherLocalGit(dir), remote);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the script reports a missing git instead of failing", () => {
  const delimiter = "__PI_GIT_nogit__";
  const sh = execFileSync("/bin/sh", ["-c", buildGitScript("/tmp", delimiter)], { encoding: "utf8", env: { PATH: "/nonexistent" } });
  assert.deepEqual(parseGitScriptOutput(sh, delimiter), { ok: false, reason: "git not installed" });
});

test("gatherLocalGit: not a repository, git missing, timeout", async () => {
  assert.deepEqual(await gatherLocalGit("/x", async () => undefined), { ok: false, reason: "not a git repository" });
  assert.deepEqual(await gatherLocalGit("/x", async () => { throw new Error("git not installed"); }), { ok: false, reason: "git not installed" });
  assert.deepEqual(await gatherLocalGit("/x", async () => { throw new Error("timed out after 10 s"); }), { ok: false, reason: "timed out after 10 s" });
});

const entry = (label, info, extra = {}) => ({ label, result: { ok: true, info: { dirty: 0, ...info } }, ...extra });
const sha = (c) => c.repeat(40);
const fake = (known, counts) => ({ hasCommit: async (_r, s) => known.includes(s), counts: async () => counts });

test("compareGit: phrasing against a local repository", async () => {
  const local = entry("local", { branch: "main", sha: sha("9"), short: "9897131", origin: "h/o/r" }, { repo: "/l" });
  const staging = (c) => entry("staging", { sha: sha(c), short: c.repeat(7), origin: "h/o/r" });
  assert.deepEqual(await compareGit([local, staging("9")], fake([])), ["staging: same commit as local"]);
  assert.deepEqual(await compareGit([local, staging("1")], fake([sha("1")], { remoteOnly: 0, localOnly: 1 })), ["staging: 1 behind local (main 9897131)"]);
  assert.deepEqual(await compareGit([local, staging("1")], fake([sha("1")], { remoteOnly: 2, localOnly: 1 })), ["staging: 2 ahead, 1 behind local (main 9897131)"]);
  assert.deepEqual(await compareGit([local, staging("1")], fake([sha("1")], { remoteOnly: 3, localOnly: 0 })), ["staging: 3 ahead of local (main 9897131)"]);
  assert.deepEqual(await compareGit([local, staging("1")], fake([sha("1")], undefined)), ["staging: could not compare with local"]);
  assert.deepEqual(await compareGit([local, staging("a")], fake([])), ["staging: HEAD aaaaaaa not in local repo (git fetch?)"]);
});
test("compareGit: origin mismatch, unavailable, no comparison without a local repo, linked repos", async () => {
  const local = entry("local", { branch: "main", sha: sha("9"), short: "9897131", origin: "h/o/r" }, { repo: "/l" });
  const prod = entry("prod", { sha: sha("5"), short: "5555555" });
  const other = entry("other", { sha: sha("5"), short: "5555555", origin: "h/x/y" });
  const down = { label: "down", result: { ok: false, reason: "not a git repository" } };
  assert.deepEqual(await compareGit([local, prod, other, down], fake([])), []);
  // without any local repo: remotes of one origin are compared with each other
  const a = entry("a", { sha: sha("1"), short: "1111111", origin: "h/o/r" });
  const b = entry("b", { sha: sha("1"), short: "1111111", origin: "h/o/r" });
  const c = entry("c", { sha: sha("2"), short: "2222222", origin: "h/o/r" });
  assert.deepEqual(await compareGit([a, b, c, other], fake([])), ["b: same commit as a", "c: different commit from a (2222222 vs 1111111)"]);
  assert.deepEqual(await compareGit([a], fake([])), []);
  // a linked local repository is used for that project instead of the session one
  const linked = entry("local:a", { branch: "dev", sha: sha("1"), short: "1111111", origin: "h/o/r" }, { repo: "/linked" });
  const wrong = entry("local:c", { branch: "dev", sha: sha("1"), short: "1111111", origin: "h/z/z" }, { repo: "/wrong" });
  const la = { ...a, link: "local:a" }, lc = { ...c, link: "local:c" };
  assert.deepEqual(await compareGit([local, linked, wrong, la, lc], fake([])), ["a: same commit as local:a", "c: local:c has a different origin; not compared"]);
});

test("formatting", () => {
  const info = { dirty: 2, branch: "main", sha: sha("9"), short: "9897131", subject: "x".repeat(80), upstream: "origin/main", ahead: 1, behind: 0, origin: "h/o/r" };
  assert.equal(formatGitLine("local", { ok: true, info }), `- local: main 9897131 "${"x".repeat(59)}…"; 2 dirty; ahead 1 of origin/main; h/o/r`);
  assert.equal(formatGitLine("s", { ok: true, info: { dirty: 0, sha: sha("a"), short: "aaaaaaa", subject: "s", upstream: "origin/main", ahead: 0, behind: 0 } }), '- s: detached aaaaaaa "s"; clean; in sync with origin/main; no origin');
  assert.equal(formatGitLine("s", { ok: true, info: { dirty: 0, branch: "main", sha: sha("a"), short: "aaaaaaa", subject: "s" } }), '- s: main aaaaaaa "s"; clean; no upstream; no origin');
  assert.equal(formatGitLine("s", { ok: true, info: { dirty: 0, branch: "main" } }), "- s: main (no commits yet); clean; no upstream; no origin");
  assert.equal(formatGitLine("prod", { ok: false, reason: "not a git repository" }), "- prod: git: unavailable (not a git repository)");
  assert.deepEqual(formatGitBlock([], ["x"]), []);
  assert.deepEqual(formatGitBlock([{ label: "prod", result: { ok: false, reason: "r" } }], ["prod: same"]), ["Git:", "- prod: git: unavailable (r)", "  prod: same"]);
  assert.equal(describeCounts("s", "local", { remoteOnly: 0, localOnly: 0 }, {}), "s: same commit as local");
});

test("localProbe answers with real git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gitprobe-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a"), "1"); git("add", "a"); git("commit", "-q", "-m", "one");
    const one = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a"), "2"); git("commit", "-qam", "two");
    const two = git("rev-parse", "HEAD");
    assert.equal(await localProbe.hasCommit(dir, one), true);
    assert.equal(await localProbe.hasCommit(dir, "f".repeat(40)), false);
    assert.deepEqual(await localProbe.counts(dir, one, two), { remoteOnly: 0, localOnly: 1 });
    assert.deepEqual(await localProbe.counts(dir, two, one), { remoteOnly: 1, localOnly: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
