import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { act } from "react";
import { ApiError, api } from "../../frontend/lib/api";
import type { MemoryDetail, MemorySummary } from "../../frontend/lib/api/context-memory";
import { click, createHarness, input, settle } from "./context-memory-harness";

let harness: ReturnType<typeof createHarness>;
const spies: Array<{ mockRestore(): void }> = [];
let accepted = false;
let confirmCount = 0;
let confirmDecision: () => Promise<boolean> = async () => accepted;
const memory: MemoryDetail = {
	id: "m1",
	key: "test preference",
	scope: "user",
	version: 3,
	status: "candidate",
	effectiveStatus: "candidate",
	content: "Full private memory body",
	contentHash: "hash",
	ownerUserId: "u1",
	projectId: null,
	narratorId: null,
	expiresAt: null,
	updatedAt: "2026-01-01T00:00:00.000Z",
	createdAt: "2026-01-01T00:00:00.000Z",
	confirmedAt: null,
	createdByKind: "user",
	sourceNarratorId: "source",
	sourceMessageId: "message",
};
const summary: MemorySummary = { ...memory, excerpt: "Short excerpt" };
let list: ReturnType<typeof spyOn<typeof api, "listContextMemories">>;
let detail: ReturnType<typeof spyOn<typeof api, "getContextMemory">>;
let decide: ReturnType<typeof spyOn<typeof api, "decideContextMemory">>;
let forget: ReturnType<typeof spyOn<typeof api, "forgetContextMemory">>;
let revise: ReturnType<typeof spyOn<typeof api, "reviseContextMemory">>;
let propose: ReturnType<typeof spyOn<typeof api, "proposeContextMemory">>;
beforeEach(() => {
	accepted = false;
	confirmCount = 0;
	confirmDecision = async () => accepted;
	harness = createHarness(async () => {
		confirmCount++;
		return confirmDecision();
	});
	list = spyOn(api, "listContextMemories").mockResolvedValue({
		items: [summary],
		nextCursor: "next",
	});
	detail = spyOn(api, "getContextMemory").mockResolvedValue(memory);
	decide = spyOn(api, "decideContextMemory").mockResolvedValue({
		...memory,
		version: 4,
		status: "confirmed",
		effectiveStatus: "confirmed",
	});
	forget = spyOn(api, "forgetContextMemory").mockResolvedValue({ deleted: true });
	revise = spyOn(api, "reviseContextMemory").mockResolvedValue({ ...memory, version: 4 });
	propose = spyOn(api, "proposeContextMemory").mockResolvedValue(memory);
	spies.push(
		list,
		detail,
		decide,
		forget,
		revise,
		propose,
		spyOn(api, "getContextMemoryEvents").mockResolvedValue([
			{
				id: "audit",
				version: 3,
				action: "revise",
				actorKind: "user",
				actorUserId: "u1",
				contentHash: "hash",
				createdAt: memory.updatedAt,
			},
		]),
		spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected real network")),
	);
});
afterEach(async () => {
	await harness.close();
	for (const spy of spies.splice(0)) spy.mockRestore();
});
async function load() {
	expect(
		existsSync(
			new URL("../../frontend/components/context-memory/ContextMemoryManager.tsx", import.meta.url),
		),
	).toBe(true);
	return (await import("../../frontend/components/context-memory/ContextMemoryManager"))
		.ContextMemoryManager;
}

describe("memory management", () => {
	test("lists summaries only, opens full details on demand and passes the displayed version", async () => {
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		expect(harness.container.textContent).toContain("Short excerpt");
		expect(detail).not.toHaveBeenCalled();
		await click(harness.container, "Review");
		expect(harness.container.textContent).toContain(memory.content);
		expect(harness.container.textContent).toContain("source");
		await click(harness.container, "Confirm memory");
		expect(decide.mock.calls).toEqual([["m1", { action: "confirm", expectedVersion: 3 }]]);
	});
	test("conflict keeps the current draft and blocks blind resubmission until reload", async () => {
		decide.mockRejectedValue(new ApiError("changed", 409, { code: "MEMORY_VERSION_CONFLICT" }));
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		await click(harness.container, "Review");
		await click(harness.container, "Confirm memory");
		expect(harness.container.textContent).toContain("changed elsewhere");
		await click(harness.container, "Confirm memory");
		expect(decide).toHaveBeenCalledTimes(1);
		detail.mockResolvedValue({ ...memory, version: 9 });
		await click(harness.container, "Reload memory");
		await click(harness.container, "Confirm memory");
		expect(decide.mock.calls.at(-1)?.[1].expectedVersion).toBe(9);
	});
	test("forget is cancelled by default and deletes only after explicit confirmation", async () => {
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		await click(harness.container, "Review");
		await click(harness.container, "Forget memory");
		expect(confirmCount).toBe(1);
		expect(forget).not.toHaveBeenCalled();
		accepted = true;
		list.mockResolvedValue({ items: [], nextCursor: null });
		await click(harness.container, "Forget memory");
		expect(forget.mock.calls).toEqual([["m1", 3]]);
		expect(harness.container.textContent).not.toContain(memory.content);
	});
	test("edit submits the full detail as a candidate and never confirms it automatically", async () => {
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		await click(harness.container, "Review");
		await click(harness.container, "Edit memory");
		await click(harness.container, "Save candidate");
		expect(revise.mock.calls[0]).toEqual([
			"m1",
			{ expectedVersion: 3, content: memory.content, expiresAt: null },
		]);
		expect(decide).not.toHaveBeenCalled();
	});
	test("scope changes clear details and reset pagination; another user sees no stale body", async () => {
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		await click(harness.container, "Next page");
		expect(list.mock.calls.at(-1)?.[1]).toBe("next");
		await click(harness.container, "Review");
		const scopeField = harness.container.querySelector<HTMLSelectElement>('[name="scope"]');
		expect(scopeField).not.toBeNull();
		await act(() => {
			if (scopeField) {
				for (const option of scopeField.options) option.removeAttribute("selected");
				scopeField.querySelector('option[value="project"]')?.setAttribute("selected", "");
				scopeField.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await input(harness.container, "scopeId", "project-one");
		list.mockResolvedValue({ items: [], nextCursor: null });
		await click(harness.container, "Load scope");
		expect(list.mock.calls.at(-1)?.slice(0, 2)).toEqual([
			{ kind: "project", id: "project-one" },
			undefined,
		]);
		expect(harness.container.textContent).not.toContain(memory.content);
		await harness.render(<Manager userId="u2" />);
		expect(harness.container.textContent).not.toContain("Short excerpt");
	});
	test("revoked or failed detail reads hide previously cached content", async () => {
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		await click(harness.container, "Review");
		detail.mockRejectedValue(new ApiError("not found", 404));
		await act(async () => {
			await harness.client.invalidateQueries({ queryKey: ["context-memory"] });
		});
		await settle();
		expect(harness.container.textContent).not.toContain(memory.content);
		expect(harness.container.textContent).toContain("Unable to load memory");
	});
	test("manual proposal requires content and creates a candidate in the selected scope", async () => {
		const Manager = await load();
		await harness.render(<Manager userId="u1" />);
		await click(harness.container, "New memory");
		await input(harness.container, "memoryKey", "build");
		await input(harness.container, "memoryContent", "Only related tests");
		await click(harness.container, "Save candidate");
		expect(propose.mock.calls[0]).toEqual([
			{ scope: { kind: "user" }, key: "build", content: "Only related tests", expiresAt: null },
		]);
		expect(decide).not.toHaveBeenCalled();
	});
});

test("a late destructive confirmation cannot submit after the user or view changes", async () => {
	const Manager = await load();
	await harness.render(<Manager userId="u1" />);
	await click(harness.container, "Review");
	let resolve!: (accepted: boolean) => void;
	confirmDecision = () =>
		new Promise<boolean>((done) => {
			resolve = done;
		});
	await click(harness.container, "Forget memory");
	await harness.render(<Manager userId="u2" />);
	await act(async () => resolve(true));
	await settle();
	expect(forget).not.toHaveBeenCalled();
});

test.each(["reject", "archive"] as const)("%s uses the reviewed version", async (action) => {
	const Manager = await load();
	await harness.render(<Manager userId="u1" />);
	await click(harness.container, "Review");
	await click(harness.container, action === "reject" ? "Reject memory" : "Archive memory");
	expect(decide.mock.calls).toEqual([["m1", { action, expectedVersion: 3 }]]);
});
