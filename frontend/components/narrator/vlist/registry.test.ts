import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("vlist registry", () => {
	it("registers every element kind with a measure fn and label", async () => {
		const { VLIST_REGISTRY, VLIST_ELEMENT_KINDS } = await import("./registry");
		expect(VLIST_ELEMENT_KINDS.length).toBeGreaterThanOrEqual(20);
		for (const kind of VLIST_ELEMENT_KINDS) {
			const entry = VLIST_REGISTRY[kind];
			expect(entry.kind).toBe(kind);
			expect(typeof entry.measure).toBe("function");
			expect(entry.label.length).toBeGreaterThan(0);
		}
	});

	it("catalog keys and entry.kind agree (no copy-paste drift)", async () => {
		const { VLIST_REGISTRY } = await import("./registry");
		for (const [key, entry] of Object.entries(VLIST_REGISTRY)) {
			expect(entry.kind).toBe(key as typeof entry.kind);
		}
	});

	it("dispatches a markdown element through measureElement", async () => {
		const { measureElement } = await import("./registry");
		const r = measureElement("markdown", "Hello world.", 600, 5);
		expect(r.height).toBeGreaterThan(0);
		expect(Array.isArray(r.blocks)).toBe(true);
	});

	it("dispatches a message-bubble element", async () => {
		const { measureElement } = await import("./registry");
		const r = measureElement("message-bubble", { role: "assistant", text: "hi" }, 600, 5);
		expect(r.height).toBeGreaterThan(0);
	});

	it("dispatches a prune-divider (no data needed)", async () => {
		const { measureElement } = await import("./registry");
		const r = measureElement("prune-divider", null, 600, 5);
		expect(r.height).toBeGreaterThan(0);
	});

	it("dispatches a web-search element", async () => {
		const { measureElement } = await import("./registry");
		const r = measureElement("web-search", { query: "cats", status: "completed" }, 600, 5);
		expect(r.height).toBeGreaterThan(0);
	});

	it("flags LOD-sensitive kinds", async () => {
		const { VLIST_REGISTRY } = await import("./registry");
		expect(VLIST_REGISTRY.reasoning.lodSensitive).toBe(true);
		expect(VLIST_REGISTRY["tool-call"].lodSensitive).toBe(true);
		expect(VLIST_REGISTRY["subagent-card"].lodSensitive).toBe(true);
		expect(VLIST_REGISTRY.markdown.lodSensitive).toBe(false);
		expect(VLIST_REGISTRY["web-search"].lodSensitive).toBe(false);
	});
});
