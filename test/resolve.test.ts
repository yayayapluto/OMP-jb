import { describe, expect, test } from "bun:test";
import { resolveProfile } from "../src/core.ts";

const PROFILES = [
	"0x8D jailbreaks/BigPickle-opencode.md",
	"Alibaba/Qwen-4-max.md",
	"Alibaba/qwen-3.7.md",
	"Alibaba/qwen-3.8.md",
	"Anthropic/opus v1.md",
	"Anthropic/Sonnet v2.md",
	"DeepSeek/deepseek v3.md",
	"DeepSeek/deepseek v4.md",
	"DeepSeek/deepseek-4-1.md",
	"DeepSeek/deepseekv4.1 and v4.1-1017.md",
	"Google/Gemini-4-Argon.md",
	"Google/Gemini-4-Carbon.md",
	"Moonshot AI/kimi-k2.md",
	"Moonshot AI/kimik3.1.md",
	"Stealth Models/spacebunny-agents.md",
	"Zhipu AI/glm-5.2.md",
	"Zhipu AI/glm-zcode-5.3.md",
	"Zhipu AI/glm-5-3-flash.md",
];

describe("resolveProfile", () => {
	test("picks the deepseek 4.1 profile over 4 and 3", () => {
		const match = resolveProfile(PROFILES, "freepi deepseek-v4.1-flash DeepSeek V4.1 Flash");
		expect(match?.relPath).toBe("DeepSeek/deepseek-4-1.md");
	});

	test("does not cross model families", () => {
		const match = resolveProfile(PROFILES, "openrouter qwen-3.8");
		expect(match?.relPath).toBe("Alibaba/qwen-3.8.md");
	});

	test("keeps same-family versions apart", () => {
		const match = resolveProfile(PROFILES, "zhipu glm-5.2");
		expect(match?.relPath).toBe("Zhipu AI/glm-5.2.md");
	});

	test("matches multi-word stealth model names", () => {
		const match = resolveProfile(PROFILES, "opencode space-bunny");
		expect(match?.relPath).toBe("Stealth Models/spacebunny-agents.md");
	});

	test("matches a concatenated stealth model filename", () => {
		const match = resolveProfile(PROFILES, "opencode big-pickle Big Pickle");
		expect(match?.relPath).toBe("0x8D jailbreaks/BigPickle-opencode.md");
	});

	test("returns undefined when nothing matches", () => {
		expect(resolveProfile(PROFILES, "acme completely-unknown-9")).toBeUndefined();
	});
});
