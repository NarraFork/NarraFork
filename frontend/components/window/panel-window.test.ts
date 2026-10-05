import { describe, expect, test } from "bun:test";
import { defaultParseSearch } from "@tanstack/react-router";
import type { PluginUiSessionContext } from "../plugins/PluginUiSurfaceContext";
import { type PluginDockPanelParams, parsePluginDockPanelParams } from "../plugins/protocol";
import {
	buildPanelWindowHref,
	normalizePanelWindowDescriptor,
	openPanelInWindow,
	PANEL_WINDOW_DESCRIPTOR_MAX_BYTES,
	type PanelWindowDescriptor,
	panelWindowTitle,
	parsePanelWindowDescriptor,
} from "./panel-window";

function roundtrip(descriptor: PanelWindowDescriptor): PanelWindowDescriptor | null {
	const href = buildPanelWindowHref(descriptor);
	const d = new URL(href, "https://example.test").searchParams.get("d");
	const expected = parsePanelWindowDescriptor(d ?? undefined);
	// The window route receives JSON-decoded values, not URLSearchParams strings.
	const search = defaultParseSearch(new URL(href, "https://example.test").search) as Record<
		string,
		unknown
	>;
	expect(parsePanelWindowDescriptor(search.d)).toEqual(expected);
	return expected;
}

describe("buildPanelWindowHref + parsePanelWindowDescriptor", () => {
	test("round-trips a narrator-bound chat descriptor (and the workspace 'narrator' alias)", () => {
		expect(roundtrip({ panelType: "chat", narratorId: "n1" })).toEqual({
			panelType: "chat",
			narratorId: "n1",
		});
		// Workspace narrator cells open the same chat window.
		expect(normalizePanelWindowDescriptor({ panelType: "narrator", narratorId: "n1" })).toEqual({
			panelType: "chat",
			narratorId: "n1",
		});
	});

	test("round-trips every narrator-bound singleton kind", () => {
		for (const panelType of [
			"details",
			"spec",
			"git",
			"browser",
			"tasks",
			"search",
			"userchat",
			"appearance",
			"filetree",
		] as const) {
			expect(roundtrip({ panelType, narratorId: "n1", chapterId: "c1" })).toEqual({
				panelType,
				narratorId: "n1",
				chapterId: "c1",
			});
		}
	});

	test("round-trips narrator-bound and config-bound terminals", () => {
		expect(roundtrip({ panelType: "terminal", narratorId: "n1" })).toEqual({
			panelType: "terminal",
			narratorId: "n1",
		});
		expect(roundtrip({ panelType: "terminal", terminalConfig: { cwd: "/tmp" } })).toEqual({
			panelType: "terminal",
			terminalConfig: { cwd: "/tmp" },
		});
	});

	test("round-trips subagent / file / knowledge / webview / narrator-tool", () => {
		expect(
			roundtrip({ panelType: "subagent", subagentNarratorId: "s1", hostNarratorId: "h1" }),
		).toEqual({ panelType: "subagent", subagentNarratorId: "s1", hostNarratorId: "h1" });
		expect(roundtrip({ panelType: "file", filePath: "/a b/文件.ts", deviceId: "local" })).toEqual({
			panelType: "file",
			filePath: "/a b/文件.ts",
			deviceId: "local",
		});
		expect(roundtrip({ panelType: "knowledge", entryId: "e1", scope: "personal" })).toEqual({
			panelType: "knowledge",
			entryId: "e1",
			scope: "personal",
		});
		expect(
			roundtrip({ panelType: "webview", webviewConfig: { url: "https://example.com" } }),
		).toEqual({ panelType: "webview", webviewConfig: { url: "https://example.com" } });
		expect(roundtrip({ panelType: "narrator-tool", toolType: "git", narratorId: "n1" })).toEqual({
			panelType: "narrator-tool",
			toolType: "git",
			narratorId: "n1",
		});
	});

	test("strips transient and surface-bookkeeping fields", () => {
		// highlightMessageId/highlightRequestId are one-shot jump requests — a window
		// opened from a layout restore must not re-run them.
		expect(
			normalizePanelWindowDescriptor({
				panelType: "subagent",
				subagentNarratorId: "s1",
				highlightMessageId: "m1",
				highlightRequestId: "h7",
			}),
		).toEqual({ panelType: "subagent", subagentNarratorId: "s1" });
		// panelRowId is workspace membership bookkeeping, meaningless in a window.
		expect(
			normalizePanelWindowDescriptor({
				panelType: "terminal",
				panelRowId: "row1",
				terminalConfig: { narratorId: "n1" },
			}),
		).toEqual({ panelType: "terminal", terminalConfig: { narratorId: "n1" } });
	});

	test("rejects mock, unknown panel types, and missing identity", () => {
		expect(normalizePanelWindowDescriptor({ panelType: "mock", narratorId: "n1" })).toBe(null);
		expect(normalizePanelWindowDescriptor({ panelType: "nope", narratorId: "n1" })).toBe(null);
		expect(normalizePanelWindowDescriptor({ panelType: "chat" })).toBe(null);
		expect(normalizePanelWindowDescriptor({ panelType: "file" })).toBe(null);
		expect(
			normalizePanelWindowDescriptor({
				panelType: "narrator-tool",
				toolType: "mock",
				narratorId: "n1",
			}),
		).toBe(null);
		expect(normalizePanelWindowDescriptor("chat")).toBe(null);
		expect(normalizePanelWindowDescriptor(null)).toBe(null);
	});

	test("plugin descriptors go through the zod schema verbatim", () => {
		const plugin = {
			panelType: "plugin",
			schemaVersion: 1,
			pluginId: "p1",
			contributionId: "c1",
			panelInstanceId: "i1",
			binding: { kind: "global" },
		} as const;
		expect(normalizePanelWindowDescriptor(plugin)).toEqual(plugin);
		expect(normalizePanelWindowDescriptor({ panelType: "plugin" })).toBe(null);
	});

	test("parsePanelWindowDescriptor rejects garbage and oversized input", () => {
		expect(parsePanelWindowDescriptor(undefined)).toBe(null);
		expect(parsePanelWindowDescriptor("not json")).toBe(null);
		for (const value of [null, 42, true, [], {}, { panelType: "chat" }]) {
			expect(parsePanelWindowDescriptor(value)).toBeNull();
		}
		expect(
			parsePanelWindowDescriptor({
				panelType: "file",
				filePath: "文".repeat(PANEL_WINDOW_DESCRIPTOR_MAX_BYTES),
			}),
		).toBeNull();
		expect(parsePanelWindowDescriptor(`"${"x".repeat(PANEL_WINDOW_DESCRIPTOR_MAX_BYTES)}"`)).toBe(
			null,
		);
	});
});

const plugin = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "p1",
	contributionId: "c1",
	panelInstanceId: "i1",
	binding: { kind: "global" },
} as const;

describe("plugin window host context", () => {
	const cases: Array<{
		binding: PluginDockPanelParams["binding"];
		hostContext: PluginUiSessionContext;
	}> = [
		{
			binding: { kind: "focus-current-narrator", narratorId: "n1" },
			hostContext: { surface: "focus", narratorId: "n1", chapterId: null, projectId: "p1" },
		},
		{
			binding: { kind: "workspace", workspaceId: "w1" },
			hostContext: { surface: "workspace", workspaceId: "w1", presentation: "grid" },
		},
		{
			binding: { kind: "workspace-narrator", workspaceId: "w1", ownerNarratorId: "n1" },
			hostContext: {
				surface: "director",
				workspaceId: "w1",
				narratorId: "n1",
				chapterId: "ch1",
				presentation: "director",
			},
		},
		{ binding: { kind: "global" }, hostContext: { surface: "settings" } },
		{
			binding: { kind: "host-surface", surface: "focus" },
			hostContext: { surface: "graph", narratorId: "n1", projectId: "p1" },
		},
		{
			binding: { kind: "host-surface", surface: "provider-settings" },
			hostContext: { surface: "provider-settings" },
		},
		{
			binding: { kind: "host-surface", surface: "focus" },
			hostContext: { surface: "focus", narratorId: "_n1", chapterId: "-c1", projectId: "_p1" },
		},
	];
	test.each(cases)("round-trips a strict hostContext for %j", ({ binding, hostContext }) => {
		const descriptor = normalizePanelWindowDescriptor({
			...plugin,
			binding,
			hostContext,
			panelRowId: "row1",
		});
		expect(descriptor).toEqual({ ...plugin, binding, hostContext });
		if (descriptor) expect(roundtrip(descriptor)).toEqual(descriptor);
	});

	test("rejects context that disagrees with explicit binding identity", () => {
		for (const [binding, hostContext] of [
			[
				{ kind: "focus-current-narrator", narratorId: "n1" },
				{ surface: "focus", narratorId: "n2" },
			],
			[
				{ kind: "workspace", workspaceId: "w1" },
				{ surface: "workspace", workspaceId: "w2" },
			],
			[{ kind: "global" }, { surface: "focus", narratorId: "n1" }],
		]) {
			expect(normalizePanelWindowDescriptor({ ...plugin, binding, hostContext })).toBeNull();
		}
	});

	test("drops only known bookkeeping without relaxing plugin params", () => {
		expect(normalizePanelWindowDescriptor({ ...plugin, panelRowId: "row1" })).toEqual(plugin);
		expect(normalizePanelWindowDescriptor({ ...plugin, unknownParameter: true })).toBeNull();
		expect(
			parsePluginDockPanelParams({ ...plugin, hostContext: { surface: "settings" } }),
		).toBeNull();
		for (const hostContext of [
			null,
			{},
			{ surface: "focus" },
			{ surface: "workspace" },
			{ surface: "bogus" },
			{ surface: "focus", narratorId: 7 },
			{ surface: "workspace", presentation: "bogus" },
			{ surface: "settings", isAdmin: true },
			{ surface: "focus", narratorId: "n".repeat(129) },
		]) {
			expect(normalizePanelWindowDescriptor({ ...plugin, hostContext })).toBeNull();
			expect(parsePanelWindowDescriptor(JSON.stringify({ ...plugin, hostContext }))).toBeNull();
		}
	});
});

describe("shared UTF-8 descriptor budget", () => {
	test("accepts legal 9000-character and exact-16KiB Unicode plugin state", () => {
		for (const text of [
			"x".repeat(9000),
			`${"界".repeat(5456)}xxxxx`,
			`${"😀".repeat(4092)}xxxxx`,
		]) {
			const descriptor = { ...plugin, viewState: { text } };
			expect(new TextEncoder().encode(JSON.stringify(descriptor.viewState)).byteLength).toBe(
				text.startsWith("x") ? 9011 : 16 * 1024,
			);
			expect(parsePluginDockPanelParams(descriptor)).not.toBeNull();
			expect(normalizePanelWindowDescriptor(descriptor)).toEqual(descriptor);
			expect(roundtrip(descriptor)).toEqual(descriptor);
		}
	});

	test("counts UTF-8 bytes at the exact 32KiB boundary on send and receive", () => {
		expect(PANEL_WINDOW_DESCRIPTOR_MAX_BYTES).toBe(32 * 1024);
		const fixed = { panelType: "file" as const, filePath: "" };
		const overhead = new TextEncoder().encode(JSON.stringify(fixed)).byteLength;
		const room = 32 * 1024 - overhead;
		const path = "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3);
		const exact = { ...fixed, filePath: path };
		const tooLarge = { ...fixed, filePath: `${path}x` };
		expect(roundtrip(exact)).toEqual(exact);
		expect(normalizePanelWindowDescriptor(tooLarge)).toBeNull();
		expect(parsePanelWindowDescriptor(JSON.stringify(tooLarge))).toBeNull();
		expect(() => buildPanelWindowHref(tooLarge)).toThrow();
		const original = Object.getOwnPropertyDescriptor(globalThis, "window");
		let opens = 0;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { open: () => opens++ },
		});
		try {
			expect(openPanelInWindow(tooLarge)).toBe(false);
			expect(opens).toBe(0);
			expect(openPanelInWindow(exact)).toBe(true);
			expect(opens).toBe(1);
		} finally {
			if (original) Object.defineProperty(globalThis, "window", original);
			else Reflect.deleteProperty(globalThis, "window");
		}
	});
});

describe("panelWindowTitle", () => {
	test("prefers resource identity over the generic kind title", () => {
		expect(panelWindowTitle({ panelType: "file", filePath: "/src/app.ts", fileName: "App" })).toBe(
			"App",
		);
		expect(panelWindowTitle({ panelType: "file", filePath: "/src/app.ts" })).toBe("app.ts");
		expect(
			panelWindowTitle({
				panelType: "webview",
				webviewConfig: { url: "https://example.com", title: "Docs" },
			}),
		).toBe("Docs");
		expect(panelWindowTitle({ panelType: "chat", narratorId: "n1" })).toBe("Chat");
		expect(
			panelWindowTitle({ panelType: "narrator-tool", toolType: "git", narratorId: "n1" }),
		).toBe("Git");
	});
});
