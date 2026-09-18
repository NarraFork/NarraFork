import { describe, expect, test } from "bun:test";
import { dirname, extname, join, normalize } from "node:path";
import { readVlistFile, SHELL_MODULES, shellModule, shellSource } from "./guard-source";

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
			readVlistFile(candidate);
			return candidate;
		} catch {
			// Alias imports and ordinary helpers outside this manifest are intentionally ignored.
		}
	}
	return null;
}

function relativeSiblingImports(importer: string): string[] {
	const source = readVlistFile(importer);
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

describe("vlist guard-source manifest", () => {
	test("contains unique, existing, non-empty module paths", () => {
		expect(new Set(SHELL_MODULES).size).toBe(SHELL_MODULES.length);
		for (const name of SHELL_MODULES) {
			const source = readVlistFile(name);
			expect(source.length, name).toBeGreaterThan(0);
			expect(source.trim(), name).not.toBe("");
		}
	});

	test("reads the entry and extracted modules through the real paths", () => {
		expect(shellModule("PretextExactMessageList.tsx")).toContain("forwardRef");
		expect(shellModule("ExactRow.tsx")).toContain("const ExactRow");
		expect(shellModule("vlist-exact-layout.ts")).toContain("buildExactListLayout");
	});

	test("lists only modules reachable through real relative sibling imports", () => {
		const reachable = reachableSiblingModules("PretextExactMessageList.tsx");
		for (const name of SHELL_MODULES) {
			expect(reachable.has(name), name).toBe(true);
		}
	});

	test("includes a non-vacuous banner and body for every module", () => {
		const source = shellSource();
		for (const name of SHELL_MODULES) {
			const banner = `/* ==== guard-source: ${name} ==== */`;
			expect(source).toContain(banner);
			const start = source.indexOf(banner);
			const bodyStart = start + banner.length;
			const next = source.indexOf("/* ==== guard-source:", bodyStart);
			const body = source.slice(bodyStart, next === -1 ? undefined : next);
			expect(body.trim(), name).not.toBe("");
		}
	});
});
