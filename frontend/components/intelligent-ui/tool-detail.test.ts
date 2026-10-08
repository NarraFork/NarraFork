import { describe, expect, test } from "bun:test";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { measureToolBody } from "../narrator/vlist/measure/measure-tool-call";
import { installCanvasStub } from "../narrator/vlist/measure/test-canvas-stub";
import { fileReference } from "./test-fixtures";

installCanvasStub();
describe("IntelligentUI file preview classification", () => {
	for (const action of ["create", "show"]) {
		test(`${action} reserves one small file card, without duplicating tool input/output`, () => {
			const result = classifyToolDetail({
				toolName: "IntelligentUI",
				toolUseId: fileReference.toolUseId,
				category: "generic",
				status: "completed",
				inputJson: { action, prefix: "demo", path: "App.tsx" },
				outputJson: "Done",
				metadata: { intelligentUi: { ...fileReference, narratorId: "forged" } },
			});
			expect(result?.sections).toHaveLength(1);
			const body = result?.sections[0].body;
			expect(body).toEqual({ kind: "intelligent-ui", file: fileReference });
			if (!body) throw new Error("Missing card");
			expect(measureToolBody(body, 360).height).toBe(88);
		});
	}
	test("a COW card selects its visible row without rewriting the stored file reference", () => {
		const result = classifyToolDetail({
			toolName: "IntelligentUI",
			toolUseId: fileReference.toolUseId,
			toolCallId: "visible-copy",
			category: "generic",
			metadata: { intelligentUi: fileReference },
		});
		expect(result?.sections[0].body).toEqual({
			kind: "intelligent-ui",
			file: { ...fileReference, toolCallId: "visible-copy" },
		});
		expect(fileReference.toolCallId).toBe("call/1");
	});
	test("remote create without journal exposes a rollback warning in the special card", () => {
		const result = classifyToolDetail({
			toolName: "IntelligentUI",
			toolUseId: fileReference.toolUseId,
			category: "generic",
			metadata: { intelligentUi: fileReference, fileChangeHistoryUnavailable: true },
		});
		expect(result?.sections[0].body).toMatchObject({
			kind: "intelligent-ui",
			historyUnavailable: true,
		});
	});
	test("public summaries never carry a private file reference", () => {
		const result = classifyToolDetail({
			toolName: "IntelligentUI",
			toolUseId: "public",
			category: "generic",
			publicSummary: "INTELLIGENT_UI_PRIVATE",
			metadata: { intelligentUi: fileReference },
		});
		expect(result?.sections[0].body).toEqual({
			kind: "intelligent-ui",
			file: null,
			publicSummary: true,
		});
	});
	test("legacy metadata is unavailable, not a compatibility document", () => {
		const result = classifyToolDetail({
			toolName: "IntelligentUI",
			toolUseId: "old",
			category: "generic",
			status: "completed",
			metadata: { intelligentUi: { uiId: "old", revision: "r1" } },
		});
		expect(result?.sections[0].body).toEqual({ kind: "intelligent-ui", file: null });
	});
	test("incomplete input cannot become a file capability and ordinary Read stays ordinary", () => {
		expect(
			classifyToolDetail({
				toolName: "IntelligentUI",
				toolUseId: "pending",
				category: "generic",
				status: "running",
				inputJson: { intelligentUi: fileReference },
			}),
		).toBeNull();
		const read = classifyToolDetail({
			toolName: "Read",
			toolUseId: "read",
			category: "read",
			status: "completed",
			inputJson: { file_path: ".narrafork/intelligent_ui/demo-123/App.tsx" },
			outputJson: "export default function App() { return null; }",
		});
		expect(read?.sections.some((part) => part.body.kind === "intelligent-ui")).toBe(false);
	});
});
