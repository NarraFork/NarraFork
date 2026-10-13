import { describe, expect, test } from "bun:test";
import {
	describeIntelligentUiKitCatalog,
	INTELLIGENT_UI_KIT_LIMITS,
	intelligentUiKitBundleName,
	parseIntelligentUiKitManifest,
	readIntelligentUiKitNotice,
	renderIntelligentUiKitEntry,
	renderIntelligentUiKitViteConfig,
} from "./intelligent-ui-kit";

const MANIFEST = {
	version: 1,
	setup: "./setup.tsx",
	styles: ["@/index.css"],
	components: [
		{ name: "Button", from: "@/components/Button", description: "Pill button" },
		{ name: "Card", from: "@/components/Card", export: "default", props: "title: string" },
		{ name: "Ui", from: "@acme/ui", export: "*", example: "<Ui.Badge>new</Ui.Badge>" },
	],
};

describe("component kit manifest", () => {
	test("normalises defaults: root, styles and the export name", () => {
		const manifest = parseIntelligentUiKitManifest({
			version: 1,
			components: [{ name: "Button", from: "./Button" }],
		});
		expect(manifest).toEqual({
			version: 1,
			root: ".",
			styles: [],
			components: [{ name: "Button", from: "./Button", export: "Button" }],
		});
		expect(parseIntelligentUiKitManifest({ ...MANIFEST, root: "apps\\web/" }).root).toBe(
			"apps/web",
		);
	});

	test("rejects what could not be built or would escape the workspace", () => {
		const bad: Array<[unknown, string]> = [
			[null, "JSON object"],
			[{ version: 2, components: [] }, "version"],
			[{ version: 1, components: [] }, "non-empty"],
			[{ version: 1, components: [{ name: "button", from: "./b" }] }, "PascalCase"],
			[{ version: 1, components: [{ name: "A", from: "" }] }, "module specifier"],
			[{ version: 1, components: [{ name: "A", from: "./a\nimport x" }] }, "module specifier"],
			[{ version: 1, components: [{ name: "A", from: "./a", export: "a-b" }] }, "export"],
			[
				{
					version: 1,
					components: [
						{ name: "A", from: "./a" },
						{ name: "A", from: "./b" },
					],
				},
				"Duplicate",
			],
			[{ ...MANIFEST, root: "../outside" }, "root"],
			[{ ...MANIFEST, root: "/abs" }, "root"],
			[{ ...MANIFEST, root: "C:\\abs" }, "root"],
			[{ ...MANIFEST, styles: "a.css" }, "styles"],
			[
				{
					version: 1,
					components: Array.from({ length: INTELLIGENT_UI_KIT_LIMITS.components + 1 }, (_, i) => ({
						name: `C${i}`,
						from: "./c",
					})),
				},
				"more than",
			],
		];
		for (const [value, message] of bad)
			expect(() => parseIntelligentUiKitManifest(value)).toThrow(message);
	});

	test("the generated entry is plain TypeScript with every specifier JSON-quoted", () => {
		const entry = renderIntelligentUiKitEntry(
			parseIntelligentUiKitManifest({
				...MANIFEST,
				components: [...MANIFEST.components, { name: "Odd", from: 'a"; throw 1; //' }],
			}),
		);
		expect(entry).toContain('import "@/index.css";');
		expect(entry).toContain('import Setup from "./setup.tsx";');
		expect(entry).toContain('import { Button as C0 } from "@/components/Button";');
		expect(entry).toContain('import C1 from "@/components/Card";');
		expect(entry).toContain('import * as C2 from "@acme/ui";');
		// A hostile specifier stays inside its string literal.
		expect(entry).toContain('from "a\\"; throw 1; //";');
		expect(entry).toContain("Button: C0, Card: C1, Ui: C2, Odd: C3");
		expect(entry).toContain("__nfKit = Object.freeze({");
		expect(entry).toContain("Setup: Setup,");
		// No JSX element: the entry must build before any project JSX configuration applies.
		expect(entry).not.toMatch(/<[A-Z]/);
		const bare = renderIntelligentUiKitEntry(
			parseIntelligentUiKitManifest({ version: 1, components: [{ name: "A", from: "./a" }] }),
		);
		expect(bare).toContain("Setup: null,");
		expect(bare).not.toContain("import Setup");
	});

	test("the Vite config builds one self-contained IIFE and drops application entry points", () => {
		const name = intelligentUiKitBundleName("0123456789abcdef0123");
		expect(name).toBe("kit-0123456789ab");
		const config = renderIntelligentUiKitViteConfig("../../..", name);
		expect(config).toContain('resolve(here, "../../..")');
		expect(config).toContain("loadConfigFromFile(env, undefined, root)");
		expect(config).toContain('formats: ["iife"]');
		expect(config).toContain('fileName: () => "kit-0123456789ab.js"');
		expect(config).toContain('cssFileName: "kit-0123456789ab"');
		// Vite writes to a staging directory it may empty. The served dist/ is elsewhere.
		expect(config).toContain('resolve(here, ".staging")');
		expect(config).toContain("emptyOutDir: true");
		expect(config).toContain("delete merged.build.rollupOptions;");
		expect(config).toContain("delete merged.build.rolldownOptions;");
		expect(config).toContain('"process.env.NODE_ENV": JSON.stringify("production")');
		// The name is spliced into generated code: only the host's own shape is accepted.
		for (const bad of ["kit", 'kit-";process.exit()//', "../kit-0123456789ab", "kit-XYZ"])
			expect(() => renderIntelligentUiKitViteConfig(".", bad)).toThrow("Invalid kit bundle name");
	});

	test("the catalog is bounded and tells the model how a namespace is used", () => {
		const catalog = describeIntelligentUiKitCatalog(parseIntelligentUiKitManifest(MANIFEST));
		expect(catalog).toContain("<Button> — Pill button");
		expect(catalog).toContain("props: title: string");
		expect(catalog).toContain("<Ui.*>");
		const huge = describeIntelligentUiKitCatalog(
			parseIntelligentUiKitManifest({
				version: 1,
				components: Array.from({ length: 150 }, (_, i) => ({
					name: `Widget${i}`,
					from: "./w",
					description: "d".repeat(300),
				})),
			}),
		);
		expect(huge.length).toBeLessThan(INTELLIGENT_UI_KIT_LIMITS.catalogChars + 400);
		expect(huge).toContain("more components in kit.json");
	});

	test("a kit notice is read only from well-formed host metadata", () => {
		expect(
			readIntelligentUiKitNotice({
				state: "stale",
				request: { id: "r1", kind: "update", state: "pending", extra: 1 },
			}),
		).toEqual({ state: "stale", request: { id: "r1", kind: "update", state: "pending" } });
		expect(readIntelligentUiKitNotice({ state: "ready", request: { id: 5 } })).toEqual({
			state: "ready",
		});
		for (const value of [null, "ready", [], { state: "approved" }, {}])
			expect(readIntelligentUiKitNotice(value)).toBeNull();
	});
});
