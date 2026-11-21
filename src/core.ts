import { execFile } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { defaultStateDir, logEvent, safeErrorMessage } from "./log.ts";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

export const REPO_URL = "https://github.com/togg53192-cmd/jailbreaks.git";
export { defaultStateDir };

const run = promisify(execFile);


export function repoDir(stateDir = defaultStateDir()): string {
	return join(stateDir, "repo");
}

export type SyncStatus = "cloned" | "updated" | "current" | "offline";

export interface SyncResult {
	status: SyncStatus;
	head?: string;
	error?: string;
}

async function git(cwd: string | undefined, args: string[]): Promise<string> {
	const { stdout } = await run("git", args, {
		cwd,
		timeout: 25_000,
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
	});
	return stdout.trim();
}

/**
 * Clone the profile repo on first use, otherwise fetch and fast-forward.
 * The clone is a cache owned by this plugin, so a non-fast-forward history
 * rewrite is resolved by resetting the cache to the fetched head.
 */
export async function syncRepo(dir = repoDir(), url = REPO_URL): Promise<SyncResult> {
	const hasClone = existsSync(join(dir, ".git"));
	logEvent("info", "sync_attempted", { mode: hasClone ? "fetch" : "clone" });
	if (!hasClone) {
		await mkdir(dirname(dir), { recursive: true });
		try {
			await git(undefined, ["clone", "--depth", "1", "--single-branch", url, dir]);
			return syncSuccess({ status: "cloned", head: await git(dir, ["rev-parse", "--short", "HEAD"]) });
		} catch (error) {
			return syncFailure(error);
		}
	}

	try {
		const before = await git(dir, ["rev-parse", "HEAD"]);
		await git(dir, ["fetch", "--depth", "1", "origin", "HEAD"]);
		const fetched = await git(dir, ["rev-parse", "FETCH_HEAD"]);
		if (before === fetched) {
			return syncSuccess({ status: "current", head: before.slice(0, 7) });
		}
		try {
			await git(dir, ["merge", "--ff-only", "-q", "FETCH_HEAD"]);
		} catch {
			await git(dir, ["reset", "--hard", "-q", "FETCH_HEAD"]);
		}
		return syncSuccess({ status: "updated", head: fetched.slice(0, 7) });
	} catch (error) {
		return syncFailure(error);
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function syncSuccess(result: SyncResult): SyncResult {
	logEvent("info", "sync_succeeded", { status: result.status, head: result.head });
	return result;
}

function syncFailure(error: unknown): SyncResult {
	const errorName = error instanceof Error ? error.name : "UnknownError";
	logEvent("warn", "sync_failed", { status: "offline", reason: "git_failed", error_name: errorName });
	return { status: "offline", error: errorMessage(error) };
}

/** All profile markdown files, relative to the repo root, POSIX separators. */
export async function listProfiles(dir = repoDir()): Promise<string[]> {
	const found: string[] = [];

	async function walk(current: string, depth: number): Promise<void> {
		if (depth > 4) return;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const absolute = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(absolute, depth + 1);
				continue;
			}
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
			if (current === dir && entry.name.toLowerCase() === "readme.md") continue;
			found.push(relative(dir, absolute).split(sep).join("/"));
		}
	}

	await walk(dir, 0);
	return found.sort();
}

export interface ProfileMatch {
	relPath: string;
	score: number;
}

/**
 * Tokens that appear in profile filenames but say nothing about the target
 * model. Kept out of scoring so "agents" never beats "deepseek".
 */
const GENERIC: Record<string, true> = {
	a: true,
	agents: true,
	ai: true,
	and: true,
	assistant: true,
	build: true,
	config: true,
	deployment: true,
	file: true,
	for: true,
	guide: true,
	instructions: true,
	jailbreak: true,
	jailbreaks: true,
	md: true,
	modelfile: true,
	model: true,
	models: true,
	ollama: true,
	opencode: true,
	operating: true,
	policy: true,
	preferences: true,
	profile: true,
	prompt: true,
	prompts: true,
	setup: true,
	specification: true,
	system: true,
	the: true,
	to: true,
	use: true,
	workspace: true,
};

function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function numberGroups(value: string): number[] {
	const flat: number[] = [];
	for (const match of value.matchAll(/\d+(?:\.\d+)*/g)) {
		const group = match[0].split(".").map(Number);
		const previous = flat.slice(-group.length);
		if (previous.length === group.length && previous.every((part, index) => part === group[index])) {
			continue;
		}
		flat.push(...group);
	}
	return flat;
}

function containsRun(haystack: number[], needle: number[]): boolean {
	if (needle.length === 0) return false;
	outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
		for (let index = 0; index < needle.length; index++) {
			if (haystack[start + index] !== needle[index]) continue outer;
		}
		return true;
	}
	return false;
}

/**
 * Pick the profile whose path best matches a model signature
 * (`provider id name family revision`). Family tokens carry the match, version
 * numbers break ties and reject profiles for a plainly different release.
 */
export function resolveProfile(profiles: string[], modelSignature: string): ProfileMatch | undefined {
	const modelTokens = [...new Set(tokens(modelSignature))].filter(
		token => token.length >= 2 && !GENERIC[token] && !/^v?\d/.test(token),
	);
	const modelNumbers = numberGroups(modelSignature);

	let best: ProfileMatch | undefined;
	for (const relPath of profiles) {
		const pathTokens = [...new Set(tokens(relPath))].filter(token => !GENERIC[token]);
		const pathNumbers = numberGroups(basename(relPath));

		let score = 0;
		let strong = 0;
		for (const token of modelTokens) {
			if (pathTokens.includes(token)) {
				score += token.length >= 4 ? 5 : 2;
				if (token.length >= 4) strong++;
				continue;
			}
			if (
				token.length >= 4 &&
				pathTokens.some(
					candidate =>
						candidate.startsWith(token) || token.startsWith(candidate) || candidate.includes(token),
				)
			) {
				score += 3;
				strong++;
			}
		}
		if (strong === 0) continue;

		for (const number of modelNumbers) {
			if (pathNumbers.includes(number)) score += 1;
		}

		if (modelNumbers.length > 0 && pathNumbers.length > 0) {
			if (containsRun(pathNumbers, modelNumbers)) {
				score += 6;
			} else if (pathNumbers[0] === modelNumbers[0]) {
				score += 2;
			} else if (pathNumbers[0] > modelNumbers[0]) {
				score -= 4;
			} else {
				score -= 2;
			}
		}

		const candidate = { relPath, score };
		if (
			!best ||
			candidate.score > best.score ||
			(candidate.score === best.score && candidate.relPath < best.relPath)
		) {
			best = candidate;
		}
	}

	return best;
}

interface CachedProfile {
	mtimeMs: number;
	size: number;
	text: string;
}

export type ProfileCache = Map<string, CachedProfile>;

/** Read a profile, reusing the cached text while the file is unchanged. */
export async function readProfile(
	dir: string,
	relPath: string,
	cache: ProfileCache,
): Promise<{ text: string; relPath: string }> {
	const absolute = join(dir, ...relPath.split("/"));
	const info = await stat(absolute);
	const cached = cache.get(absolute);
	const hit = cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size;
	logEvent("info", hit ? "cache_hit" : "cache_miss", { rel_path: relPath, size: info.size });
	if (hit && cached) {
		return { text: cached.text, relPath };
	}
	const text = await readFile(absolute, "utf8");
	cache.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, text });
	return { text, relPath };
}

/** Build the block appended to the system prompt for one request. */
export function renderInjection(modelName: string, relPath: string, text: string): string {
	return [
		`<jailbreak_profile model="${modelName.replaceAll('"', "'")}" source="${relPath}">`,
		text.trim(),
		"</jailbreak_profile>",
	].join("\n");
}
