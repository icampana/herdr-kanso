import assert from "node:assert/strict";
import test from "node:test";
import { load, context } from "./helpers.mjs";

test("Pull request panel lists the repository's open ones, by anyone, and shows the one you pick", async () => {
  const url = (n) => `https://github.com/o/here/pull/${n}`;
  const prs = {
    [url(1)]: { number: 1, title: "Branch work", url: url(1), author: { login: "me" }, headRefName: "feat", updatedAt: "2026-10-01T00:00:00Z" },
    [url(2)]: { number: 2, title: "Other work", url: url(2), author: { login: "me" }, headRefName: "other", updatedAt: "2026-10-02T00:00:00Z" },
    [url(3)]: { number: 3, title: "Bump a dependency", url: url(3), author: { login: "app/dependabot" }, headRefName: "deps", updatedAt: "2026-10-03T00:00:00Z" },
  };
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "git") {
      const out = { "rev-parse": "/repo\n", branch: "feat\n", remote: "git@github.com:o/here.git\n" }[args[0]];
      return { code: 0, stdout: out, stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(Object.values(prs)), stderr: "" };
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(prs[args[2] === "--json" ? url(1) : args[2]]), stderr: "" };
    if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "me\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "offline" };
  };
  const { PullRequest } = await load("kanso-panel/pr.js", ["PullRequest"], {
    exec, key: () => "repo", location: () => ({ cwd: "/repo", on: null }),
  });
  const panel = new PullRequest();
  Object.assign(panel, { expanded: {}, openPrs: [], selected: null, threads: [] });
  const { cx, drain } = context();
  panel.refresh(cx); await drain();
  assert.equal(panel.pr.number, 1);
  assert.deepEqual([...panel.openPrs].map((p) => p.number), [3, 2, 1], "every author, newest first");
  assert.ok(calls.includes(`gh pr list --state open --limit 100 --json ${calls.find((c) => c.startsWith("gh pr list")).split("--json ")[1]}`));
  assert.ok(!calls.some((c) => c.includes("--author")), "not only yours");
  panel.choose(prs[url(3)], cx); await drain();
  assert.equal(panel.pr.number, 3, "someone else's opens too");
  assert.equal(panel.selected, url(3));
  panel.choose(prs[url(1)], cx); await drain();
  assert.equal(panel.pr.number, 1);
  assert.equal(panel.selected, null, "the branch's own follows the branch again");
});

test("Pull request panel shows a quiet placeholder outside a repository, not an error", async () => {
  const exec = async (command) => command === "git" ? { code: 128, stdout: "", stderr: "not a git repository" } : { code: 1, stdout: "", stderr: "" };
  const { PullRequest } = await load("kanso-panel/pr.js", ["PullRequest"], { exec, key: () => "home", location: () => ({ cwd: "/home", on: null }) });
  const panel = new PullRequest();
  Object.assign(panel, { expanded: {}, openPrs: [], selected: null, threads: [] });
  const { cx, drain } = context();
  panel.refresh(cx); await drain();
  assert.equal(panel.outside, true);
  assert.equal(panel.error, null);
});
