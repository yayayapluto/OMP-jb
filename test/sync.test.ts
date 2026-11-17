import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProfiles, syncRepo } from "../src/core.ts";

const work = await mkdtemp(join(tmpdir(), "omp-jailbreak-sync-"));
afterAll(() => rm(work, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	}).trim();
}

test("clone then pull an updated profile repo", async () => {
	const source = join(work, "source");
	const origin = join(work, "origin.git");
	const cache = join(work, "cache");

	git(work, "init", "-b", "main", source);
	await writeFile(join(source, "deepseek-4-1.md"), "first\n");
	git(source, "add", ".");
	git(source, "commit", "-m", "first");
	git(work, "init", "--bare", "-b", "main", origin);
	git(source, "remote", "add", "origin", origin);
	git(source, "push", "origin", "main");

	const cloned = await syncRepo(cache, origin);
	expect(cloned.status).toBe("cloned");
	expect(await listProfiles(cache)).toEqual(["deepseek-4-1.md"]);

	await writeFile(join(source, "qwen-3.8.md"), "second\n");
	git(source, "add", ".");
	git(source, "commit", "-m", "second");
	git(source, "push", "origin", "main");

	const updated = await syncRepo(cache, origin);
	expect(updated.status).toBe("updated");
	expect(await listProfiles(cache)).toEqual(["deepseek-4-1.md", "qwen-3.8.md"]);

	const current = await syncRepo(cache, origin);
	expect(current.status).toBe("current");
});
