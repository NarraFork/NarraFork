import { describe, expect, test } from "bun:test";
import {
	ERROR_CATALOG,
	interpolate,
	isErrorMessageCode,
	MAX_PARAM_KEYS,
	MAX_PARAM_VALUE_CHARS,
	readErrorPayload,
	renderErrorMessage,
	sanitizeErrorParams,
	serializeCatalogErrorMessage,
	templatePlaceholders,
} from "../error-catalog";

describe("catalog shape", () => {
	test("every entry has a status, a behaviour code and English prose", () => {
		for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
			expect(entry.status, key).toBeGreaterThanOrEqual(400);
			expect(entry.code, key).toMatch(/^[A-Z][A-Z0-9_]*$/);
			expect(entry.en.trim(), key).not.toBe("");
		}
	});

	test("message codes are distinct from the behaviour codes they map to", () => {
		// Not a style rule: the two axes are allowed to coincide (TOKEN_EXPIRED), but a catalog
		// where they ALWAYS coincide would mean nobody is using the fine-grained axis, i.e. the
		// contract collapsed back into one code.
		const distinct = Object.entries(ERROR_CATALOG).filter(([key, entry]) => key !== entry.code);
		expect(distinct.length).toBeGreaterThan(0);
	});
});

describe("templatePlaceholders", () => {
	test("returns names in first-appearance order without duplicates", () => {
		expect(templatePlaceholders("{a} and {b} and {a}")).toEqual(["a", "b"]);
	});

	test("returns nothing for a template with no placeholders", () => {
		expect(templatePlaceholders("plain sentence")).toEqual([]);
	});
});

describe("interpolate", () => {
	test("substitutes supplied params", () => {
		expect(interpolate("{entity} not found: {id}", { entity: "Chapter", id: "abc" })).toBe(
			"Chapter not found: abc",
		);
	});

	test("leaves an unsupplied placeholder verbatim", () => {
		// A missing param must stay visible. Substituting "" produces a confident but wrong
		// sentence ("Chapter not found: ") that reads like a real answer.
		expect(interpolate("{entity} not found: {id}", { entity: "Chapter" })).toBe(
			"Chapter not found: {id}",
		);
	});

	test("does not re-interpolate a param whose value looks like a placeholder", () => {
		expect(interpolate("{a}", { a: "{b}", b: "leaked" })).toBe("{b}");
	});
});

describe("sanitizeErrorParams", () => {
	test("truncates an over-long string value", () => {
		const long = "x".repeat(MAX_PARAM_VALUE_CHARS + 50);
		const result = sanitizeErrorParams({ path: long });
		expect(String(result.path).length).toBe(MAX_PARAM_VALUE_CHARS + 1);
		expect(String(result.path).endsWith("…")).toBe(true);
	});

	test("caps the number of keys", () => {
		const params: Record<string, string> = {};
		for (let i = 0; i < MAX_PARAM_KEYS + 5; i += 1) params[`k${i}`] = "v";
		expect(Object.keys(sanitizeErrorParams(params)).length).toBe(MAX_PARAM_KEYS);
	});

	test("drops non-scalar and non-finite values instead of stringifying them", () => {
		const result = sanitizeErrorParams({
			ok: "kept",
			nested: { a: 1 } as unknown as string,
			list: [1, 2] as unknown as string,
			nan: Number.NaN,
			inf: Number.POSITIVE_INFINITY,
		});
		expect(result).toEqual({ ok: "kept" });
	});

	test("keeps numbers as numbers", () => {
		expect(sanitizeErrorParams({ limit: 42 })).toEqual({ limit: 42 });
	});

	test("handles undefined", () => {
		expect(sanitizeErrorParams(undefined)).toEqual({});
	});
});

describe("renderErrorMessage", () => {
	test("renders a parameterized entry", () => {
		expect(renderErrorMessage("RESOURCE_NOT_FOUND", { entity: "Narrator", id: "n1" })).toBe(
			"Narrator not found: n1",
		);
	});

	test("renders a parameterless entry", () => {
		expect(renderErrorMessage("PODMAN_NOT_FOUND")).toBe("podman is not installed");
	});

	test("clamps params before interpolation", () => {
		const rendered = renderErrorMessage("RESOURCE_NOT_FOUND", {
			entity: "Chapter",
			id: "y".repeat(MAX_PARAM_VALUE_CHARS + 10),
		});
		expect(rendered.length).toBeLessThan(MAX_PARAM_VALUE_CHARS + 40);
	});
});

describe("serializeCatalogErrorMessage", () => {
	test("keeps a catalog key and readable prose together in a string-only carrier", () => {
		const error = Object.assign(new Error(ERROR_CATALOG.TUTORIAL_REMOVED.en), {
			messageCode: "TUTORIAL_REMOVED",
			statusCode: 410,
			code: "TUTORIAL_REMOVED",
		});
		expect(JSON.parse(serializeCatalogErrorMessage(error))).toEqual({
			type: "catalog_error",
			error: ERROR_CATALOG.TUTORIAL_REMOVED.en,
			messageCode: "TUTORIAL_REMOVED",
			messageParams: {},
		});
	});

	test("reuses the catalog's parameter bounds and never serializes arbitrary error fields", () => {
		const error = Object.assign(new Error("Readable fallback"), {
			messageCode: "RESOURCE_NOT_FOUND",
			messageParams: { id: "x".repeat(MAX_PARAM_VALUE_CHARS + 10), nested: { unused: true } },
			unused: "not for display",
		});
		const serialized = JSON.parse(serializeCatalogErrorMessage(error));
		expect(serialized.error).toBe("Readable fallback");
		expect(serialized.messageParams).toEqual({ id: `${"x".repeat(MAX_PARAM_VALUE_CHARS)}…` });
		expect(serialized.unused).toBeUndefined();
		expect(serialized.stack).toBeUndefined();
	});

	test("non-catalog errors and thrown values retain the previous string behaviour", () => {
		for (const value of [new Error("ordinary failure"), "failure", null, undefined, 42]) {
			expect(serializeCatalogErrorMessage(value)).toBe(
				value instanceof Error ? value.message : String(value),
			);
		}
		for (const messageCode of [undefined, "FROM_A_NEWER_SERVER", "constructor"]) {
			const error = Object.assign(new Error("unchanged"), { messageCode });
			expect(serializeCatalogErrorMessage(error)).toBe("unchanged");
		}
	});
});

describe("isErrorMessageCode", () => {
	test("accepts a known key and rejects everything else", () => {
		expect(isErrorMessageCode("RESOURCE_NOT_FOUND")).toBe(true);
		expect(isErrorMessageCode("NOT_A_REAL_CODE")).toBe(false);
		expect(isErrorMessageCode(undefined)).toBe(false);
		expect(isErrorMessageCode(42)).toBe(false);
	});

	test("rejects inherited Object properties", () => {
		// `"toString" in ERROR_CATALOG` is true; a prototype-walking check would accept it and
		// the client would then try to translate a key that has no entry.
		expect(isErrorMessageCode("toString")).toBe(false);
		expect(isErrorMessageCode("constructor")).toBe(false);
	});
});

describe("readErrorPayload", () => {
	test("extracts a known code with its params", () => {
		expect(
			readErrorPayload({ messageCode: "RESOURCE_NOT_FOUND", messageParams: { id: "x" } }),
		).toEqual({ messageCode: "RESOURCE_NOT_FOUND", messageParams: { id: "x" } });
	});

	test("discards an unknown code so the caller falls back to raw prose", () => {
		// A newer server may send a code this build has no translation for. Rendering the bare key
		// would be worse than showing the server's English sentence.
		expect(readErrorPayload({ messageCode: "FROM_A_NEWER_SERVER" }).messageCode).toBeUndefined();
	});

	test("tolerates a missing, null or malformed body", () => {
		expect(readErrorPayload(null).messageCode).toBeUndefined();
		expect(readErrorPayload(undefined).messageCode).toBeUndefined();
		expect(readErrorPayload({}).messageCode).toBeUndefined();
	});

	test("ignores non-object messageParams", () => {
		expect(readErrorPayload({ messageCode: "RESOURCE_NOT_FOUND", messageParams: "nope" })).toEqual({
			messageCode: "RESOURCE_NOT_FOUND",
			messageParams: {},
		});
		expect(readErrorPayload({ messageCode: "RESOURCE_NOT_FOUND", messageParams: [1] })).toEqual({
			messageCode: "RESOURCE_NOT_FOUND",
			messageParams: {},
		});
	});

	test("clamps params arriving from the wire", () => {
		const result = readErrorPayload({
			messageCode: "RESOURCE_NOT_FOUND",
			messageParams: { id: "z".repeat(MAX_PARAM_VALUE_CHARS + 100) },
		});
		expect(String(result.messageParams.id).length).toBe(MAX_PARAM_VALUE_CHARS + 1);
	});
});
