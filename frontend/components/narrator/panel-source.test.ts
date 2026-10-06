import { describe, expect, test } from "bun:test";
import { dirname, extname, join, normalize } from "node:path";
import { PANEL_MODULES, panelModule, panelSource, readNarratorFile } from "./panel-source";

const RELATIVE_IMPORT = /\b(?:from\s*|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g;
const MODULE_EXTENSIONS = [".ts", ".tsx"] as const;

function resolveSiblingImport(importer: string, specifier: string): string | null {
	const base = normalize(join(dirname(importer), specifier));
	if (base.startsWith("../") || base === "..") return null;
	const candidates = extname(base)
		? [base]
		: [...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`), `${base}/index.ts`];
	for (const candidate of candidates) {
		try {
			readNarratorFile(candidate);
			return candidate;
		} catch {
			// Alias imports and ordinary helpers outside this manifest are intentionally ignored.
		}
	}
	return null;
}

function relativeSiblingImports(importer: string): string[] {
	const source = readNarratorFile(importer);
	const imports = new Set<string>();
	for (const match of source.matchAll(RELATIVE_IMPORT)) {
		const target = resolveSiblingImport(importer, match[1]);
		if (target) imports.add(target);
	}
	return [...imports];
}

function reachableSiblingModules(entry: string): Set<string> {
	const reachable = new Set<string>([entry]);
	const pending = [entry];
	while (pending.length > 0) {
		const importer = pending.pop();
		if (!importer) continue;
		for (const target of relativeSiblingImports(importer)) {
			if (reachable.has(target)) continue;
			reachable.add(target);
			pending.push(target);
		}
	}
	return reachable;
}

describe("panel source manifest", () => {
	test("browser session updates never automatically open the browser panel", () => {
		const panel = readNarratorFile("NarratorPanel.tsx");
		expect(panel).toContain("dockSetBrowserInfo?.({");
		expect(panel).toContain("sessionCount: wsState.browserSessionCount");
		expect(panel).not.toMatch(/dockOpenToolPanel\?\.\(["']browser["']\)/);
		expect(panel).not.toContain("prevBrowserSessionCountRef");
	});

	test("keeps the global attention inbox out of the panel interaction area", () => {
		const interaction = readNarratorFile("NarratorInteractionArea.tsx");
		const panel = readNarratorFile("NarratorPanel.tsx");
		expect(interaction).not.toContain("HumanAttentionInboxButton");
		expect(interaction).not.toContain("showHumanAttentionInbox");
		expect(panel).not.toContain("useHumanAttention");
		expect(panel).not.toContain("showHumanAttentionInbox");
	});

	test("contains unique, existing, non-empty module paths", () => {
		expect(new Set(PANEL_MODULES).size).toBe(PANEL_MODULES.length);
		for (const name of PANEL_MODULES) {
			const source = readNarratorFile(name);
			expect(source.length, name).toBeGreaterThan(0);
			expect(source.trim(), name).not.toBe("");
		}
	});

	test("reads every manifest member through the real relative path", () => {
		expect(panelModule("NarratorPanel.tsx")).toContain("NarratorInteractionArea");
		expect(panelModule("interaction/SetGlobalModelModal.tsx")).toContain(
			"export function SetGlobalModelModal",
		);
		expect(panelModule("useNarratorAsyncQuestionSlots.ts")).toContain(
			"useNarratorAsyncQuestionSlots",
		);
	});

	test("lists only modules reachable through real relative sibling imports", () => {
		const reachable = reachableSiblingModules("NarratorPanel.tsx");
		for (const name of PANEL_MODULES) {
			expect(reachable.has(name), name).toBe(true);
		}
	});

	test("includes a non-vacuous banner and body for every module", () => {
		const source = panelSource();
		for (const name of PANEL_MODULES) {
			const banner = `/* ==== panel-source: ${name} ==== */`;
			expect(source).toContain(banner);
			const start = source.indexOf(banner);
			const bodyStart = start + banner.length;
			const next = source.indexOf("/* ==== panel-source:", bodyStart);
			const body = source.slice(bodyStart, next === -1 ? undefined : next);
			expect(body.trim(), name).not.toBe("");
		}
	});
});
