import { fileReferenceContentForDisplay } from "../../../shared/file-reference";
import { projectToolIO } from "../../../shared/pretext-layout/tool-io-projection";
import { OUTLINE_EDIT_TOOL } from "../agent/tools/outline-names";
import { toolCallWithExecutionTargets } from "../tool-execution-target-projection";
import type { NarratorDisplayMessage, NarratorDisplayToolCall } from "./display-page-protocol";

const PRESERVE_ALL = new Set(["ExitPlanMode"]);
/** Kept whole like `SKIP_INPUT_TRUNCATE_TOOLS` in `narrator-messages.ts`. */
const PRESERVE_INPUT = new Set(["Agent", "Task", "Send", OUTLINE_EDIT_TOOL]);

function preserveInput(toolName: string, input: unknown): boolean {
	if (PRESERVE_ALL.has(toolName) || PRESERVE_INPUT.has(toolName)) return true;
	if ((toolName !== "Write" && toolName !== "Edit") || !input || typeof input !== "object")
		return false;
	const record = input as Record<string, unknown>;
	return (record.file_path ?? record.filePath ?? record.path) === "spec://tasks.json";
}

function projectInput(toolName: string, input: unknown, ioBudget: number): unknown {
	return preserveInput(toolName, input)
		? input
		: projectToolIO(input, { leafBudget: ioBudget, markdownBudget: ioBudget });
}

/** Pure transport projection; never pass this result to provider/model history. */
export function stripDisplayProviderMetadata(
	block: Record<string, unknown>,
): Record<string, unknown> {
	const metadata = block.providerMetadata;
	if (!metadata || typeof metadata !== "object") return block;
	const hadEncrypted =
		(metadata as Record<string, unknown>).hasEncryptedReasoning === true ||
		Object.values(metadata).some((value) => {
			if (!value || typeof value !== "object") return false;
			const encrypted = (value as Record<string, unknown>).reasoningEncryptedContent;
			return typeof encrypted === "string" && encrypted.length > 0;
		});
	const { providerMetadata: _dropped, ...rest } = block;
	return hadEncrypted ? { ...rest, providerMetadata: { hasEncryptedReasoning: true } } : rest;
}

function projectContent(content: unknown, ioBudget: number): unknown {
	const display = fileReferenceContentForDisplay(content);
	if (!Array.isArray(display)) return display;
	return display.map((item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const block = stripDisplayProviderMetadata(item as Record<string, unknown>);
		if (block.type !== "tool_use") return block;
		const toolName = typeof block.name === "string" ? block.name : "";
		// The block's provider input is a SECOND copy of tool I/O. Merely projecting
		// toolCalls leaves that huge copy in transport, even after main-side enrich.
		return {
			...block,
			...(Object.hasOwn(block, "input") && {
				input: projectInput(toolName, block.input, ioBudget),
			}),
			...(Object.hasOwn(block, "inputJson") && {
				inputJson: projectInput(toolName, block.inputJson, ioBudget),
			}),
			...(Object.hasOwn(block, "outputJson") && {
				outputJson: PRESERVE_ALL.has(toolName)
					? block.outputJson
					: projectToolIO(block.outputJson, { leafBudget: ioBudget, markdownBudget: ioBudget }),
			}),
		};
	});
}

/** Same display selection order as latestToolCallAttempts, never execution authority. */
export function latestDisplayToolAttempts(
	toolCalls: readonly NarratorDisplayToolCall[],
): NarratorDisplayToolCall[] {
	const selected = new Map<string, NarratorDisplayToolCall>();
	for (const row of toolCalls) {
		const previous = selected.get(row.toolUseId);
		if (
			!previous ||
			(row.executionAttempt ?? 0) > (previous.executionAttempt ?? 0) ||
			((row.executionAttempt ?? 0) === (previous.executionAttempt ?? 0) &&
				((row.createdAt ?? "") > (previous.createdAt ?? "") ||
					(row.createdAt === previous.createdAt && row.id > previous.id)))
		)
			selected.set(row.toolUseId, row);
	}
	return [...selected.values()];
}

export function projectDisplayToolCall(
	row: NarratorDisplayToolCall,
	ioBudget: number,
): NarratorDisplayToolCall {
	const withTargets = toolCallWithExecutionTargets(row);
	if (PRESERVE_ALL.has(row.toolName)) return withTargets;
	return {
		...withTargets,
		inputJson: projectInput(row.toolName, row.inputJson, ioBudget),
		outputJson: projectToolIO(row.outputJson, { leafBudget: ioBudget, markdownBudget: ioBudget }),
	};
}

export function projectNarratorDisplayMessage(
	row: NarratorDisplayMessage,
	ioBudget: number,
): NarratorDisplayMessage {
	return {
		...row,
		contentJson: projectContent(row.contentJson, ioBudget),
		...(Object.hasOwn(row, "originalContentJson") && {
			originalContentJson: projectContent(row.originalContentJson, ioBudget),
		}),
		toolCalls: latestDisplayToolAttempts(row.toolCalls).map((tc) =>
			projectDisplayToolCall(tc, ioBudget),
		),
		creator: row.creator
			? {
					id: row.creator.id,
					username: row.creator.username,
					avatarColor: row.creator.avatarColor,
					avatarImageId: row.creator.avatarImageId,
				}
			: null,
	};
}
