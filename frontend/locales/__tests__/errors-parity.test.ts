/**
 * Parity between the error catalog and the `errors` translations.
 *
 * Every failure mode here is silent in production: a missing key makes i18next fall back to
 * English, a mistyped placeholder renders `{{id}}` literally, and a stale key just sits there.
 * None of them throw, so without this test the localized error surface degrades one entry at a
 * time and nobody notices until a user reports "why is this one in English".
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CATALOG } from "@shared/error-catalog";
import { SUPPORTED_LOCALES } from "@shared/i18n-locales";

const LOCALES_DIR = join(import.meta.dir, "..");

type Bundle = Record<string, unknown>;

function loadErrorsBundle(locale: string): Bundle {
	return JSON.parse(readFileSync(join(LOCALES_DIR, locale, "errors.json"), "utf8")) as Bundle;
}

const bundles = new Map(SUPPORTED_LOCALES.map((locale) => [locale, loadErrorsBundle(locale)]));
const catalogKeys = Object.keys(ERROR_CATALOG).sort();

/**
 * i18next placeholders are `{{name}}`; the server-side catalog uses `{name}`. The two syntaxes
 * are intentionally different (one is rendered by i18next, the other by `interpolate`), so the
 * comparison is on the NAME SET, not on the raw text.
 */
function i18nextPlaceholders(template: string): string[] {
	return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

function catalogPlaceholders(template: string): string[] {
	return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** Message entries only — `entity`, `showOriginal`, … are UI chrome, not catalog codes. */
function messageEntries(bundle: Bundle): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(bundle)) {
		if (typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(key)) out[key] = value;
	}
	return out;
}

describe.each([...SUPPORTED_LOCALES])("errors.json (%s)", (locale) => {
	const bundle = bundles.get(locale) as Bundle;
	const messages = messageEntries(bundle);

	test("covers every catalog message code", () => {
		expect(Object.keys(messages).sort()).toEqual(catalogKeys);
	});

	test("has no message entry without a catalog entry", () => {
		const orphans = Object.keys(messages).filter((key) => !Object.hasOwn(ERROR_CATALOG, key));
		expect(orphans).toEqual([]);
	});

	test("uses exactly the placeholders its catalog template declares", () => {
		for (const [key, translation] of Object.entries(messages)) {
			const expected = catalogPlaceholders(ERROR_CATALOG[key as keyof typeof ERROR_CATALOG].en);
			expect(i18nextPlaceholders(translation), `${locale}/${key}`).toEqual(expected);
		}
	});

	test("has no empty translation", () => {
		for (const [key, translation] of Object.entries(messages)) {
			expect(translation.trim(), `${locale}/${key}`).not.toBe("");
		}
	});

	test("provides the disclosure chrome the ErrorDetail component renders", () => {
		for (const key of [
			"showOriginal",
			"hideOriginal",
			"originalMessage",
			"errorCode",
			"messageCode",
		]) {
			expect(typeof bundle[key], `${locale}/${key}`).toBe("string");
		}
	});
});

describe("cross-locale consistency", () => {
	test("all locales declare the same entity labels", () => {
		// A `NotFoundError` entity present in one language and absent in another shows a
		// half-translated sentence rather than failing, so it has to be checked.
		const keysPerLocale = SUPPORTED_LOCALES.map((locale) => {
			const entity = (bundles.get(locale) as Bundle).entity as Record<string, string>;
			return Object.keys(entity).sort();
		});
		for (const keys of keysPerLocale) expect(keys).toEqual(keysPerLocale[0]);
	});

	test("every locale is registered in the frontend namespace list", () => {
		// `errors` must be in `namespaces` and in every public-path entry, otherwise the bundle is
		// never loaded on that route and messages silently fall back to the server's English.
		const i18nSource = readFileSync(join(LOCALES_DIR, "..", "lib", "i18n.ts"), "utf8");
		expect(i18nSource).toContain('"errors"');
		const publicBlock = i18nSource.slice(
			i18nSource.indexOf("PUBLIC_PATH_NAMESPACES"),
			i18nSource.indexOf("export function getNamespacesForPath"),
		);
		for (const line of publicBlock.split("\n")) {
			if (!line.includes('["/')) continue;
			expect(line, "public path must load the errors namespace").toContain('"errors"');
		}
	});
});
