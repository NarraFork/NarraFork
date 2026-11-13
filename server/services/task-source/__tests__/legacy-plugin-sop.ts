/**
 * A plugin's SOP in an outline root session's old `spec://behavior_fence`, written as the plugin's
 * fence command wrote it before outline P2 PR 12a (the command now writes the plugin's block on
 * the behavior page). For the PR 4 tests of what the import and the behavior view do with an SOP
 * a session still has in its fence.
 */
import {
	fenceWithoutFirstPluginSop,
	TEAM_SOP_CLOSE,
	TEAM_SOP_OPEN,
} from "../../behavior-fence-sop";
import { readSpecFileContentIfExists, writeSpecFile } from "../../spec-vfs-service";

export async function seedLegacyPluginSop(narratorId: string, text: string): Promise<void> {
	const current = (await readSpecFileContentIfExists(narratorId, "spec://behavior_fence")) ?? "";
	const kept = fenceWithoutFirstPluginSop(current);
	const section = `${TEAM_SOP_OPEN}\n${text.trim()}\n${TEAM_SOP_CLOSE}`;
	await writeSpecFile(
		narratorId,
		"spec://behavior_fence",
		kept ? `${kept}\n\n${section}` : section,
		{ actor: "agent", allowFenceMutation: true, createdBy: "assistant", pluginSop: true },
	);
}
