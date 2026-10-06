import { expect, test } from "bun:test";
import {
	EDITOR_MODE_PREF_KEY,
	fractionToScroll,
	readEditorModePref,
	resolveInitialMode,
	scrollFraction,
	splitRenderMode,
	writeEditorModePref,
} from "./editor-mode-prefs";

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	} as Storage;
}

test("readEditorModePref falls back to raw without storage or with an unknown value", () => {
	expect(readEditorModePref(null)).toBe("raw");
	expect(readEditorModePref(memoryStorage())).toBe("raw");
	expect(readEditorModePref(memoryStorage({ [EDITOR_MODE_PREF_KEY]: "bogus" }))).toBe("raw");
});

test("writeEditorModePref persists and reads back every mode", () => {
	const storage = memoryStorage();
	for (const mode of ["raw", "split", "preview", "node"] as const) {
		writeEditorModePref(mode, storage);
		expect(readEditorModePref(storage)).toBe(mode);
	}
});

test("resolveInitialMode only accepts defaults the file itself offers", () => {
	expect(resolveInitialMode("split", ["preview", "raw"])).toBe("split");
	expect(resolveInitialMode("split", ["raw"])).toBe("raw");
	expect(resolveInitialMode("preview", ["preview", "raw"])).toBe("preview");
	// A markdown default must not leak into a json panel (and vice versa).
	expect(resolveInitialMode("preview", ["node", "raw"])).toBe("raw");
	expect(resolveInitialMode("node", ["preview", "raw"])).toBe("raw");
	expect(resolveInitialMode("raw", ["preview", "raw"])).toBe("raw");
});

test("splitRenderMode picks the file's rendered mode", () => {
	expect(splitRenderMode(["preview", "raw"])).toBe("preview");
	expect(splitRenderMode(["node", "raw"])).toBe("node");
	expect(splitRenderMode(["raw"])).toBe("preview");
});

test("scroll fraction math round-trips and clamps empty ranges", () => {
	expect(scrollFraction(50, 200, 100)).toBe(0.5);
	expect(fractionToScroll(0.5, 200, 100)).toBe(50);
	expect(scrollFraction(0, 100, 100)).toBe(0);
	expect(fractionToScroll(0.7, 100, 100)).toBe(0);
});
