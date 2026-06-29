import { z } from "zod/v4";
import type { Principal } from "../../../services/knowledge-acl";
import { knowledgeAcl } from "../../../services/knowledge-acl";
import { packActivationService } from "../../../services/knowledge-pack-activation-service";
import { knowledgePackService } from "../../../services/knowledge-pack-service";
import { loadSettings } from "../../settings";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

/**
 * Resolve the acting principal for this loop turn from ctx.userId (per-trigger
 * authority, same model as the knowledge tools). null/anonymous → public-only.
 */
async function principalOf(ctx: ToolContext): Promise<Principal> {
	const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
	return { userId: caps.userId, role: caps.role };
}

// ─── PackList ───
export const packListTool: ToolDefinition = {
	name: "PackList",
	description:
		"List knowledge-base packs you may access (resource bundles of data/media/scripts/executables used to run a fixed procedure). Returns id, name, description, size and linked entry. Use PackActivate with an id to extract a pack into an isolated working directory and gain access to it.",
	parameters: z.object({
		entryId: z
			.string()
			.optional()
			.describe("Optional: only list packs linked to this knowledge entry id"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { entryId } = args as { entryId?: string };
		try {
			const principal = await principalOf(ctx);
			const packs = await knowledgePackService.listPacks(principal, {
				projectId: ctx.projectId ?? undefined,
				entryId,
			});
			if (packs.length === 0) {
				return { output: "No accessible packs found.", title: "PackList" };
			}
			// Mark which packs are already active for this narrator.
			const active = await packActivationService.listActive(ctx.narratorId);
			const activeIds = new Set(active.map((a) => a.packId));
			const lines = packs.map((p) => {
				const sizeKb = Math.max(1, Math.round((p.archiveSize ?? 0) / 1024));
				const activeMark = activeIds.has(p.id) ? " [active]" : "";
				const linked = p.entryId ? ` (entry: ${p.entryId})` : "";
				return `- [${p.id}] ${p.name}${activeMark}${linked} — ${sizeKb}KB${p.description ? `\n  ${p.description}` : ""}`;
			});
			return {
				output: `Found ${packs.length} pack(s):\n${lines.join("\n")}\n\nUse PackActivate with an id to extract and access a pack.`,
				title: "PackList",
				metadata: {
					tool: "PackList",
					count: packs.length,
					packs: packs.map((p) => ({ id: p.id, name: p.name, active: activeIds.has(p.id) })),
				},
			};
		} catch (err) {
			return {
				output: `PackList failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

// ─── PackActivate ───
export const packActivateTool: ToolDefinition = {
	name: "PackActivate",
	description:
		"Extract a pack into an isolated working directory and grant yourself read/write access to that directory. Returns the absolute directory path, a file listing, and any usage notes. NOTE: the directory becomes readable/writable, but RUNNING a script or executable from it (e.g. ./run.sh) still requires separate user approval — explain the purpose when you need to execute something. Use PackDeactivate when finished to release the directory.",
	parameters: z.object({
		packId: z.string().describe("The pack id to activate (from PackList)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { packId } = args as { packId: string };
		// Activation changes the narrator's directory access boundary, so it is a
		// controlled action — request user permission when configured (default true).
		if (loadSettings().knowledge.packActivateRequiresPermission) {
			const decision = await ctx.requestPermission(
				"PackActivate",
				{ packId },
				ctx.currentToolUseId ?? "",
			);
			if (decision.behavior !== "allow") {
				return { output: "PackActivate was denied by the user.", isError: true };
			}
		}
		try {
			const principal = await principalOf(ctx);
			const pack = await knowledgePackService.getPack(packId, principal);
			const result = await packActivationService.activate(ctx.narratorId, packId, principal);
			const fileBlock =
				result.files.length > 0
					? `\n\nFiles:\n${result.files.map((f) => `- ${f}`).join("\n")}`
					: "\n\n(No files found in the pack.)";
			const manifestBlock =
				result.manifest && typeof result.manifest === "object"
					? `\n\nManifest:\n${JSON.stringify(result.manifest, null, 2)}`
					: "";
			const reusedNote = result.reused ? " (already active — reused existing extraction)" : "";
			return {
				output:
					`Pack activated${reusedNote}. Extracted to:\n${result.extractDir}\n\n` +
					"This directory is now in your read/write whitelist. You can Read/Write/Edit files in it freely. " +
					"Running scripts or executables from it will still ask for user approval." +
					fileBlock +
					manifestBlock,
				title: `PackActivate: ${packId}`,
				metadata: {
					tool: "PackActivate",
					packId,
					packName: pack.name,
					extractDir: result.extractDir,
					fileCount: result.files.length,
				},
			};
		} catch (err) {
			return {
				output: `PackActivate failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

// ─── PackDeactivate ───
export const packDeactivateTool: ToolDefinition = {
	name: "PackDeactivate",
	description:
		"Release an activated pack: delete its extracted directory and revoke the directory access granted by PackActivate. Safe to call even if the pack is not active.",
	parameters: z.object({
		packId: z.string().describe("The pack id to deactivate"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { packId } = args as { packId: string };
		try {
			const res = await packActivationService.deactivate(ctx.narratorId, packId);
			return {
				output: res.released
					? `Pack ${packId} deactivated; its directory and access were removed.`
					: `Pack ${packId} was not active; nothing to release.`,
				title: `PackDeactivate: ${packId}`,
				metadata: { tool: "PackDeactivate", packId },
			};
		} catch (err) {
			return {
				output: `PackDeactivate failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
