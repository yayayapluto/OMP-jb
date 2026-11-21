import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfile, renderInjection, type ProfileCache } from "../src/core.ts";
import { logEvent, pluginLogPath } from "../src/log.ts";

const SECRET = "sensitive_profile_payload_DO_NOT_LOG";

const originalDir = process.env.OMP_JAILBREAK_DIR;
const originalKillSwitch = process.env.OMP_PLUGIN_LOG;
let work: string | undefined;

afterEach(async () => {
	if (originalDir === undefined) delete process.env.OMP_JAILBREAK_DIR;
	else process.env.OMP_JAILBREAK_DIR = originalDir;
	if (originalKillSwitch === undefined) delete process.env.OMP_PLUGIN_LOG;
	else process.env.OMP_PLUGIN_LOG = originalKillSwitch;
	if (work) await rm(work, { recursive: true, force: true });
	work = undefined;
});

describe("plugin log", () => {
	test("writes JSONL with fixed fields and redacted metadata", async () => {
		work = await mkdtemp(join(tmpdir(), "omp-jb-log-"));
		process.env.OMP_JAILBREAK_DIR = work;
		delete process.env.OMP_PLUGIN_LOG;

		logEvent("info", "profile_injected", {
			model: "deepseek-v4.1-flash",
			credentials: SECRET,
			api_key: SECRET,
			authorization: SECRET,
			nested: { token: SECRET },
			stack: new Error(SECRET).stack,
			long: "x".repeat(250),
		});

		const raw = await readFile(pluginLogPath(), "utf8");
		const lines = raw.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]);
		expect(entry.level).toBe("info");
		expect(entry.event).toBe("profile_injected");
		expect(entry.plugin).toBe("omp-jailbreak");
		expect(entry.version).toBe("0.2.0");
		expect(entry.ts).toBe(new Date(entry.ts).toISOString());
		expect(entry.model).toBe("deepseek-v4.1-flash");
		expect(entry.long).toHaveLength(200);
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain("stack");
		expect("credentials" in entry).toBe(false);
		expect("api_key" in entry).toBe(false);
		expect("authorization" in entry).toBe(false);
		expect("token" in entry.nested).toBe(false);
	});

	test("redacts generic payload and prompt keys", async () => {
		work = await mkdtemp(join(tmpdir(), "omp-jb-log-"));
		process.env.OMP_JAILBREAK_DIR = work;
		delete process.env.OMP_PLUGIN_LOG;

		logEvent("info", "smoke", {
			model: "big-pickle",
			payload: "SECRET_PAYLOAD",
			prompt: "SECRET_PROMPT",
		});

		const raw = await readFile(pluginLogPath(), "utf8");
		const entry = JSON.parse(raw.trimEnd().split("\n")[0]);
		expect(raw).not.toContain("SECRET_PAYLOAD");
		expect(raw).not.toContain("SECRET_PROMPT");
		expect("payload" in entry).toBe(false);
		expect("prompt" in entry).toBe(false);
		expect(entry.model).toBe("big-pickle");
	});

	test("never writes profile text from an injected profile", async () => {
		work = await mkdtemp(join(tmpdir(), "omp-jb-log-"));
		process.env.OMP_JAILBREAK_DIR = work;
		delete process.env.OMP_PLUGIN_LOG;

		const repo = join(work, "repo");
		const relPath = "DeepSeek/deepseek-4-1.md";
		await mkdir(join(repo, "DeepSeek"), { recursive: true });
		await writeFile(join(repo, relPath), SECRET);
		const cache: ProfileCache = new Map();
		const profile = await readProfile(repo, relPath, cache);
		const injection = renderInjection("DeepSeek V4.1 Flash", profile.relPath, profile.text);
		expect(injection).toContain(SECRET);

		logEvent("info", "profile_injected", {
			model: "deepseek-v4.1-flash",
			rel_path: profile.relPath,
			length_bucket: injection.length < 512 ? "lt512" : "ge512",
		});

		const raw = await readFile(pluginLogPath(), "utf8");
		expect(raw).not.toContain(SECRET);
		for (const line of raw.trimEnd().split("\n")) {
			const entry = JSON.parse(line);
			expect(entry.event).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
		}
	});

	test("OMP_PLUGIN_LOG=0 disables file logging", async () => {
		work = await mkdtemp(join(tmpdir(), "omp-jb-log-"));
		process.env.OMP_JAILBREAK_DIR = work;
		process.env.OMP_PLUGIN_LOG = "0";

		logEvent("error", "extension_error", { error: "boom" });

		await expect(readFile(pluginLogPath(), "utf8")).rejects.toThrow();
	});
});
