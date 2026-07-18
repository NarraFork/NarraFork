import { describe, expect, test } from "bun:test";
import { bundledLanguagesAlias, bundledLanguagesInfo } from "shiki";
import { createShikiLanguageAliasMap } from "../../frontend/build/shiki-language-aliases";
import {
	createShikiLanguageEnsurer,
	resolveShikiLanguage,
} from "../../frontend/lib/shiki-language-loader";

const aliases = createShikiLanguageAliasMap(bundledLanguagesInfo, bundledLanguagesAlias);

describe("Shiki language aliases", () => {
	test("generates canonical ids from Shiki's build-time registries", () => {
		expect(aliases.cpp).toBe("cpp");
		expect(aliases["c++"]).toBe("cpp");
		expect(aliases.csharp).toBe("csharp");
		expect(aliases["c#"]).toBe("csharp");
		expect(Object.values(aliases).every((value) => typeof value === "string")).toBe(true);
		expect(JSON.stringify(aliases).length).toBeLessThan(20 * 1024);
	});

	test("resolves known aliases and rejects unknown or path-like labels", () => {
		expect(resolveShikiLanguage(" C++ ", aliases)).toBe("cpp");
		expect(resolveShikiLanguage("c#", aliases)).toBe("csharp");
		expect(resolveShikiLanguage("not-a-shiki-language", aliases)).toBeNull();
		expect(resolveShikiLanguage("../typescript", aliases)).toBeNull();
		expect(resolveShikiLanguage("langs/typescript", aliases)).toBeNull();
		expect(resolveShikiLanguage("text", aliases)).toBeNull();
		expect(resolveShikiLanguage("plaintext", aliases)).toBeNull();
	});

	test("shares one canonical request and promise across repeated aliases", async () => {
		const requested: string[] = [];
		const registered: unknown[] = [];
		const ensureLanguage = createShikiLanguageEnsurer(
			aliases,
			async (canonicalId) => {
				requested.push(canonicalId);
				return { default: { id: canonicalId } };
			},
			(language) => {
				registered.push(language);
			},
		);

		const fromAlias = ensureLanguage("c++");
		const fromCanonical = ensureLanguage("cpp");
		const repeatedAlias = ensureLanguage("C++");

		expect(fromAlias).toBe(fromCanonical);
		expect(fromCanonical).toBe(repeatedAlias);
		expect(await fromAlias).toBe("cpp");
		expect(requested).toEqual(["cpp"]);
		expect(registered).toEqual([{ id: "cpp" }]);
	});

	test("does not request or cache unknown/path labels", async () => {
		let requests = 0;
		const ensureLanguage = createShikiLanguageEnsurer(
			aliases,
			async () => {
				requests++;
				return {};
			},
			() => {},
		);

		expect(await ensureLanguage("unknown-language")).toBeNull();
		expect(await ensureLanguage("../../cpp")).toBeNull();
		expect(await ensureLanguage("unknown-language")).toBeNull();
		expect(requests).toBe(0);
	});

	test("evicts a failed canonical request so it can be retried", async () => {
		let requests = 0;
		const ensureLanguage = createShikiLanguageEnsurer(
			aliases,
			async () => {
				requests++;
				throw new Error("temporary failure");
			},
			() => {},
		);

		expect(await ensureLanguage("c#")).toBeNull();
		expect(await ensureLanguage("csharp")).toBeNull();
		expect(requests).toBe(2);
	});
});
