import type { BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	listProfiles,
	readProfile,
	renderInjection,
	repoDir,
	resolveProfile,
	syncRepo,
	type ProfileCache,
	type SyncResult,
} from "../src/core.ts";
import { logEvent, safeErrorMessage } from "../src/log.ts";

function modelSignature(model: NonNullable<ExtensionContext["model"]>): string {
	const identity = model.identity ?? {};
	return [
		model.provider,
		model.id,
		model.name,
		identity.class,
		identity.family,
		identity.revision,
	]
		.filter(Boolean)
		.join(" ");
}

function lengthBucket(length: number): string {
	if (length < 512) return "lt512";
	if (length < 4096) return "512-4095";
	return "ge4096";
}

export default function jailbreak(pi: ExtensionAPI) {
	const root = repoDir();
	const cache: ProfileCache = new Map();
	let profiles: string[] = [];
	let syncTask: Promise<SyncResult> | undefined;

	function logResolved(modelId: string, match: { relPath: string; score: number } | undefined): void {
		if (match) {
			logEvent("info", "profile_resolved", { model: modelId, rel_path: match.relPath, score: match.score });
			return;
		}
		logEvent("info", "profile_unmatched", { model: modelId, profile_count: profiles.length });
	}

	function sync(): Promise<SyncResult> {
		if (!syncTask) {
			syncTask = syncRepo(root).then(async result => {
				profiles = await listProfiles(root);
				return result;
			});
		}
		return syncTask;
	}

	function reportSync(result: SyncResult, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (result.status === "updated") {
			ctx.ui.notify(`Jailbreak repo updated at ${result.head}`, "info");
		} else if (result.status === "cloned") {
			ctx.ui.notify(`Jailbreak repo cloned at ${result.head}`, "info");
		} else if (result.status === "offline") {
			ctx.ui.notify(`Jailbreak repo sync failed: ${result.error ?? "unknown error"}`, "warning");
		}
	}

	pi.on("session_start", (_event, ctx) => {
		void sync()
			.then(result => {
				reportSync(result, ctx);
				const model = ctx.models.current() ?? ctx.model;
				const match = model ? resolveProfile(profiles, modelSignature(model)) : undefined;
				if (model) logResolved(model.id, match);
				if (ctx.hasUI) ctx.ui.setStatus("jailbreak", match ? "🔓 Jailbreak ON" : "🔒 Jailbreak OFF");
			})
			.catch(error => {
				pi.logger.warn(`omp-jailbreak sync: ${String(error)}`);
				logEvent("error", "extension_error", { phase: "session_start", error: safeErrorMessage(error) });
			});
	});

	pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
		try {
			if (profiles.length === 0) await sync();

			const model = ctx.models.current() ?? ctx.model;
			if (!model) {
				if (ctx.hasUI) ctx.ui.setStatus("jailbreak", "🔒 Jailbreak OFF");
				logEvent("info", "profile_unmatched", { reason: "no_model", profile_count: profiles.length });
				return undefined;
			}

			const match = resolveProfile(profiles, modelSignature(model));
			if (!match) {
				if (ctx.hasUI) ctx.ui.setStatus("jailbreak", "🔒 Jailbreak OFF");
				logResolved(model.id, match);
				return undefined;
			}

			const profile = await readProfile(root, match.relPath, cache);
			if (ctx.hasUI) ctx.ui.setStatus("jailbreak", "🔓 Jailbreak ON");
			logEvent("info", "profile_injected", {
				model: model.id,
				rel_path: profile.relPath,
				score: match.score,
				length_bucket: lengthBucket(profile.text.length),
			});

			return {
				systemPrompt: [
					...event.systemPrompt,
					renderInjection(model.name || model.id, profile.relPath, profile.text),
				],
			};
		} catch (error) {
			pi.logger.warn(`omp-jailbreak inject: ${String(error)}`);
			logEvent("error", "extension_error", { phase: "before_agent_start", error: safeErrorMessage(error) });
			return undefined;
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("jailbreak", "");
	});

	pi.registerCommand("jailbreak", {
		description: "Show the active model profile; use 'sync' to fetch the latest repo",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			logEvent("info", "command_invoked", { subcommand: command === "sync" ? "sync" : "status" });
			if (command === "sync") {
				syncTask = undefined;
				const result = await sync();
				reportSync(result, ctx);
				ctx.ui.notify(
					`Jailbreak profiles: ${profiles.length} (${result.status}${result.head ? ` ${result.head}` : ""})`,
					"info",
				);
				return;
			}

			await sync();
			const model = ctx.models.current() ?? ctx.model;
			if (!model) {
				ctx.ui.notify("No active model", "warning");
				return;
			}
			const match = resolveProfile(profiles, modelSignature(model));
			logResolved(model.id, match);
			ctx.ui.notify(
				match
					? `${model.id} -> ${match.relPath} (score ${match.score})`
					: `${model.id}: no matching profile in ${profiles.length} files`,
				match ? "info" : "warning",
			);
		},
	});
}
