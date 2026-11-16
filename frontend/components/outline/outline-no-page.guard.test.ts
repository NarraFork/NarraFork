/**
 * The outline has no pages (pageless outline, D56): what its interface says to people, in both
 * languages, names no "page" / 「页」. Blocks, top-level blocks, "here", never pages.
 *
 * This guard reads the outline's own strings (`locales/{en,zh-CN}/outline.json`). The surfaces
 * that have not moved yet are listed in {@link NOT_MIGRATED}, each with the PR that moves it;
 * every later PR of the rebuild SHRINKS that list, and the last one (X2) leaves it empty. A
 * string that is not listed and says "page" fails here: reword it, do not list it.
 *
 * (Keys are not checked: `page.*` is the name of a group of strings, never shown.)
 */
import { describe, expect, test } from "bun:test";
import en from "../../locales/en/outline.json";
import zh from "../../locales/zh-CN/outline.json";

/** Strings still saying "page", by key (a trailing `*` covers the keys that start so). */
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
};

function flatten(value: unknown, prefix = "", out: Record<string, string> = {}) {
	if (typeof value === "string") out[prefix] = value;
	else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			flatten(child, prefix ? `${prefix}.${key}` : key, out);
		}
	}
	return out;
}

function listed(key: string): boolean {
	return Object.keys(NOT_MIGRATED).some((entry) =>
		entry.endsWith("*") ? key.startsWith(entry.slice(0, -1)) : key === entry,
	);
}

const strings = { en: flatten(en), "zh-CN": flatten(zh) };
const says = {
	en: (text: string) => /\bpages?\b/i.test(text),
	"zh-CN": (text: string) => text.includes("页"),
};

describe("the outline's interface names no page", () => {
	test.each([
		"en",
		"zh-CN",
	] as const)("%s: no string outside the listed surfaces says it", (lang) => {
		const offenders = Object.entries(strings[lang])
			.filter(([key, text]) => says[lang](text) && !listed(key))
			.map(([key, text]) => `${key}: ${text}`);
		expect(offenders).toEqual([]);
	});

	test("every listed entry still says it in some language (a migrated one must leave the list)", () => {
		const stale = Object.keys(NOT_MIGRATED).filter((entry) => {
			const keys = Object.keys(strings.en).filter((key) =>
				entry.endsWith("*") ? key.startsWith(entry.slice(0, -1)) : key === entry,
			);
			return !keys.some(
				(key) => says.en(strings.en[key] ?? "") || says["zh-CN"](strings["zh-CN"][key] ?? ""),
			);
		});
		expect(stale).toEqual([]);
	});

	test("both languages have the same keys", () => {
		expect(Object.keys(strings["zh-CN"]).sort()).toEqual(Object.keys(strings.en).sort());
	});
});
