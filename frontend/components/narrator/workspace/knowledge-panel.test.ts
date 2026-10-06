import { describe, expect, test } from "bun:test";
import { workspaceKnowledgePanelId } from "./workspace-dock";

describe("workspaceKnowledgePanelId", () => {
	test("produces stable id from host + entryId", () => {
		const id = workspaceKnowledgePanelId("narrator1", "entry1");
		expect(id).toBe("wknowledge_narrator1_entry1");
	});

	test("different entries produce different ids", () => {
		const a = workspaceKnowledgePanelId("host", "entryA");
		const b = workspaceKnowledgePanelId("host", "entryB");
		expect(a).not.toBe(b);
	});

	test("same entry under different hosts produce different ids", () => {
		const a = workspaceKnowledgePanelId("hostA", "entry1");
		const b = workspaceKnowledgePanelId("hostB", "entry1");
		expect(a).not.toBe(b);
	});

	test("same host + entry always produces same id", () => {
		const id1 = workspaceKnowledgePanelId("h1", "e1");
		const id2 = workspaceKnowledgePanelId("h1", "e1");
		expect(id1).toBe(id2);
	});
});
