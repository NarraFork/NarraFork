import { describe, expect, mock, test } from "bun:test";
import { rowWithElements } from "../narrator-blocks/message-blocks";
import { clearedToolOutput } from "../storage-retention";
import {
	type AdapterContext,
	type AdapterToolItem,
	adaptActivityUnit,
	adaptSegment,
} from "./segment-adapter";

const SECRET = "PRE_CLEANUP_PRIVATE_FILE_BODY";
const label = "工具调用详情已清理";
const marker = clearedToolOutput("2026-01-01T00:00:00.000Z");
const oldInput = {
	file_path: `/private/${SECRET}`,
	content: SECRET,
	old_string: SECRET,
	new_string: SECRET,
	message: SECRET,
	prompt: SECRET,
	action: "render",
	source: SECRET,
};
const oldOutput = {
	_text: SECRET,
	_metadata: { diffBefore: SECRET, diffAfter: SECRET, genUi: { path: SECRET } },
};

function fixture(
	toolName: string,
	source: "native-output" | "dto" | "current-block",
): AdapterToolItem {
	const toolUseId = `cleared-${toolName}`;
	const currentBlock = {
		type: "tool_use",
		id: toolUseId,
		name: toolName,
		inputJson: null,
		outputJson: source === "current-block" ? marker : oldOutput,
	};
	return {
		blockIndex: 0,
		isSubagent: toolName === "Agent",
		msg: rowWithElements({ id: "message", role: "assistant" }, [currentBlock]),
		tc: {
			id: "persisted-row",
			messageId: "message",
			executionAttempt: 1,
			toolUseId,
			toolName,
			status: "completed",
			inputJson: oldInput,
			outputJson: source === "native-output" ? marker : oldOutput,
			...(source === "dto" ? { payloadCleared: true } : {}),
			_metadata: { result: SECRET, diffBefore: SECRET, diffAfter: SECRET },
		},
	};
}

describe("cleared tool payloads outrank hydration and specialized renderers", () => {
	for (const toolName of ["Write", "Read", "Edit", "GenUI", "Send", "Agent"]) {
		for (const source of ["native-output", "dto", "current-block"] as const) {
			for (const view of ["card", "trace", "compact-card", "compact-trace"] as const) {
				test(`${toolName} ${source} ${view} never consults full input/output or displays old relation data`, () => {
					const item = fixture(toolName, source);
					const resolveFullToolInput = mock(() => oldInput);
					const resolveFullToolOutput = mock(() => oldOutput);
					const resolveToolSummary = mock(() => SECRET);
					const resolveToolTitle = mock(() => SECRET);
					const ctx: AdapterContext = {
						lod: view.endsWith("card") ? 5 : 2,
						compactAuxiliaryContent: view.startsWith("compact"),
						labels: { toolDetailsCleared: label },
						resolveFullToolInput,
						resolveFullToolOutput,
						resolveToolSummary,
						resolveToolTitle,
						resolveToolCategory: () => "file",
						isExpanded: () => true,
						isRowExpanded: () => true,
					};
					const specs = view.endsWith("card")
						? adaptSegment(
								{ kind: "tool-run", items: [item], sourceMessages: item.msg ? [item.msg] : [] },
								ctx,
							)
						: [adaptActivityUnit([{ ...item, kind: "tool" }], "folded", ctx)];
					const serialized = JSON.stringify(specs);
					expect(serialized).toContain(label);
					expect(serialized).not.toContain(SECRET);
					expect(serialized).not.toContain("textTruncated");
					expect(resolveFullToolInput).not.toHaveBeenCalled();
					expect(resolveFullToolOutput).not.toHaveBeenCalled();
					expect(resolveToolSummary).not.toHaveBeenCalled();
					expect(resolveToolTitle).not.toHaveBeenCalled();
					expect(item.tc.inputJson).toBe(oldInput);
				});
			}
		}
	}

	test("a fetched output tombstone prevents input hydration before specialized Write projection", () => {
		const item = fixture("Write", "dto");
		item.tc.payloadCleared = false;
		item.tc.outputJson = { _truncated: true, preview: "old output", fullLength: 9000 };
		const resolveFullToolInput = mock(() => oldInput);
		const resolveFullToolOutput = mock(() => marker);
		const specs = adaptSegment(
			{ kind: "tool-run", items: [item], sourceMessages: [] },
			{
				lod: 5,
				labels: { toolDetailsCleared: label },
				resolveFullToolInput,
				resolveFullToolOutput,
				resolveToolCategory: () => "file",
			},
		);
		expect(resolveFullToolInput).not.toHaveBeenCalled();
		expect(JSON.stringify(specs)).toContain(label);
		expect(JSON.stringify(specs)).not.toContain(SECRET);
	});
});
