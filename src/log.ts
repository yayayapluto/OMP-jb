import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

const PLUGIN = "omp-jailbreak";
const VERSION = "0.2.0";
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential/i;
const MAX_DEPTH = 3;
const MAX_STRING = 200;

export function defaultStateDir(): string {
	return process.env.OMP_JAILBREAK_DIR ?? join(homedir(), ".omp", "jailbreak-omp");
}

export function pluginLogPath(): string {
	return join(defaultStateDir(), "plugin.log");
}


function safeValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		if (depth >= MAX_DEPTH) return [];
		return value.map(item => safeValue(item, depth + 1));
	}
	if (value && typeof value === "object") {
		if (depth >= MAX_DEPTH) return {};
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (SENSITIVE_KEY.test(key) || key.toLowerCase() === "stack") continue;
			const safe = safeValue(item, depth + 1);
			if (safe !== undefined) result[key] = safe;
		}
		return result;
	}
	return undefined;
}

export function redact(metadata: Record<string, unknown> = {}): Record<string, unknown> {
	return safeValue(metadata, 0) as Record<string, unknown>;
}

export function safeErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const first = raw.split(/\r?\n/, 1)[0] ?? "";
	const cleaned = first
		.replace(/https?:\/\/\S+/gi, "[url]")
		.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/g, "[path]")
		.trim();
	const message = cleaned || "unknown_error";
	return message.length > MAX_STRING ? message.slice(0, MAX_STRING) : message;
}

export function logEvent(level: LogLevel, event: string, metadata: Record<string, unknown> = {}): void {
	if (process.env.OMP_PLUGIN_LOG === "0") return;
	try {
		const path = pluginLogPath();
		mkdirSync(dirname(path), { recursive: true });
		const entry = {
			...redact(metadata),
			ts: new Date().toISOString(),
			level,
			event,
			plugin: PLUGIN,
			version: VERSION,
		};
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// Logging must never reach plugin control flow.
	}
}
