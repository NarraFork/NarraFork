/**
 * The outline has no pages (pageless outline, D56): what its interface says to people, in both
 * languages, names no "page" / 「页」. Blocks, top-level blocks, "here", never pages.
 *
 * This guard reads every user-visible string of the outline in ALL locale files: the whole of
 * `outline.json`, and in the other files the keys of {@link OUTLINE_SURFACES} and any string
 * that names the outline (「大纲」 / "outline"). The surfaces that have not moved yet are listed
 * in {@link NOT_MIGRATED} (`file:key`, the file `outline.json` when omitted), each with the PR
 * that moves it; every later PR of the rebuild SHRINKS that list, and the last one (X2) leaves
 * it empty. A string that is not listed and says "page" fails here: reword it, do not list it.
 *
 * (Keys are not checked: `page.*` is the name of a group of strings, never shown.)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOCALES = new URL("../../locales/", import.meta.url).pathname;

/** Outline strings outside `outline.json` that do not name the outline themselves. */
const OUTLINE_SURFACES: Record<string, string[]> = {
	"narrator.json": ["spec.loss.*", "spec.outline*"],
	"narrators.json": ["workspaceAddOutline"],
	"errors.json": ["SPEC_MOVED_TO_OUTLINE", "OUTLINE_*"],
	"settings.json": ["specImportAdmin*", "outline*"],
};

/** Strings still saying "page", by `file:key` (a trailing `*` covers the keys that start so). */
const NOT_MIGRATED: Record<string, string> = {
	// The live editor is still one editor per top-level block until L4–L6.
	"editor.unsaved*": "L6 (unsaved text is kept per block)",
	"editor.tabLimit*": "L3 (live slots are counted per space)",
	"editor.tooLargePage": "L4 (no size limit of a whole top-level block; the editor's budget)",
	"editor.unavailable": "L6",
	"editor.outdated": "L6",
	// "Reload" in Chinese is 「刷新页面」: the browser's page, not an outline page.
	"editor.reload": "X2 (reword, or keep as the browser's page with a note here)",
	// The mind map of the editor.
	"map.stage": "L4 (the map is a way to draw the focused view)",
	// History, timeline and diff are F2's.
	"page.asOfBanner": "F2",
	"side.viewAt": "F2",
	"side.change.page": "X1 (a move is a move: the change kind goes away)",
	// Handing a task out names the project's task list.
	"board.handOut.*": "A2 (the task list is a block with an alias)",
	// Dynamic Spec import into the outline: its pages (tasks, notes, behavior boundary).
	"narrator.json:spec.loss.*": "A3 (spec import: the imported file is a top-level block)",
	"narrator.json:spec.outlineFence*": "A3 (the fence: the behavior boundary is a block)",
	"errors.json:SPEC_MOVED_TO_OUTLINE": "A3 (spec import)",
	"settings.json:specImportAdmin*": "A3 (spec import, admin)",
};

type Strings = Record<string, string>;

function flatten(value: unknown, prefix = "", out: Strings = {}): Strings {
	if (typeof value === "string") out[prefix] = value;
	else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			flatten(child, prefix ? `${prefix}.${key}` : key, out);
		}
	}
	return out;
}

const matches = (entry: string, key: string) =>
	entry.endsWith("*") ? key.startsWith(entry.slice(0, -1)) : key === entry;

/** `file:key` of a string; `outline.json`'s keys go without the file. */
const nameOf = (file: string, key: string) => (file === "outline.json" ? key : `${file}:${key}`);

function listed(name: string): boolean {
	return Object.keys(NOT_MIGRATED).some((entry) => matches(entry, name));
}

function load(lang: string): Record<string, Strings> {
	const out: Record<string, Strings> = {};
	for (const file of readdirSync(join(LOCALES, lang))) {
		if (file.endsWith(".json"))
			out[file] = flatten(JSON.parse(readFileSync(join(LOCALES, lang, file), "utf8")));
	}
	return out;
}

const files = { en: load("en"), "zh-CN": load("zh-CN") };
const says = {
	en: (text: string) => /\bpages?\b/i.test(text),
	"zh-CN": (text: string) => text.includes("页"),
};
const namesOutline = (text: string) => /outline/i.test(text) || text.includes("大纲");

/** The outline's strings, by name, in both languages. */
function outlineStrings(): { en: Strings; "zh-CN": Strings } {
	const out = { en: {} as Strings, "zh-CN": {} as Strings };
	const names = new Set(Object.keys(files.en));
	for (const file of Object.keys(files["zh-CN"])) names.add(file);
	for (const file of names) {
		const en = files.en[file] ?? {};
		const zh = files["zh-CN"][file] ?? {};
		for (const key of new Set([...Object.keys(en), ...Object.keys(zh)])) {
			const ofOutline =
				file === "outline.json" ||
				(OUTLINE_SURFACES[file] ?? []).some((entry) => matches(entry, key)) ||
				namesOutline(en[key] ?? "") ||
				namesOutline(zh[key] ?? "");
			if (!ofOutline) continue;
			const name = nameOf(file, key);
			if (en[key] !== undefined) out.en[name] = en[key];
			if (zh[key] !== undefined) out["zh-CN"][name] = zh[key];
		}
	}
	return out;
}

const strings = outlineStrings();

describe("the outline's interface names no page", () => {
	test.each([
		"en",
		"zh-CN",
	] as const)("%s: no string outside the listed surfaces says it", (lang) => {
		expect(Object.keys(strings[lang]).length).toBeGreaterThan(100);
		const offenders = Object.entries(strings[lang])
			.filter(([name, text]) => says[lang](text) && !listed(name))
			.map(([name, text]) => `${name}: ${text}`);
		expect(offenders).toEqual([]);
	});

	test("the guard reads beyond outline.json", () => {
		for (const name of [
			"narrators.json:workspaceAddOutline",
			"narrator.json:spec.outlineFenceHint",
			"errors.json:SPEC_MOVED_TO_OUTLINE",
		])
			expect(strings.en[name]).toBeString();
	});

	test("every listed entry still says it in some language (a migrated one must leave the list)", () => {
		const stale = Object.keys(NOT_MIGRATED).filter((entry) => {
			const names = Object.keys(strings.en).filter((name) => matches(entry, name));
			return !names.some(
				(name) => says.en(strings.en[name] ?? "") || says["zh-CN"](strings["zh-CN"][name] ?? ""),
			);
		});
		expect(stale).toEqual([]);
	});

	test("both languages have the same keys (outline.json)", () => {
		expect(Object.keys(files["zh-CN"]["outline.json"] ?? {}).sort()).toEqual(
			Object.keys(files.en["outline.json"] ?? {}).sort(),
		);
	});
});
