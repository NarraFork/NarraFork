/**
 * Grammar store tests.
 *
 * Every download goes through an injected `fetch`, so the suite never touches the
 * network. The digest checks are the point of the file: we are fetching executable
 * WebAssembly from a third-party CDN, and "install whatever arrived" is the failure
 * mode these tests exist to prevent.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	GRAMMAR_MANIFEST,
	getGrammarEntry,
	isKnownGrammarLanguage,
	languageIdForExtension,
} from "../grammar-manifest";
import {
	clearGrammarFailureCache,
	downloadGrammar,
	grammarCachePath,
	isGrammarInstalled,
	listGrammarStatus,
	readInstalledGrammar,
	removeGrammar,
} from "../grammar-store";
import { ensureGrammarFixture } from "./grammar-fixture";

/** A language whose real bytes we never need, used purely for digest assertions. */
const LANG = "go";
const entry = getGrammarEntry(LANG);
if (!entry) throw new Error("manifest is missing the go entry the tests rely on");

const cachePath = grammarCachePath(LANG);

/** Bytes that hash to the manifest digest cannot be forged, so the tests that need
 * a genuinely valid payload reuse the host's installed grammar when there is one. */
ensureGrammarFixture(LANG);
const realBytes = existsSync(cachePath)
	? new Uint8Array(await Bun.file(cachePath).arrayBuffer())
	: null;

function stubFetch(bytes: Uint8Array, status = 200): typeof fetch {
	// `bytes.buffer` rather than the view: BodyInit accepts ArrayBuffer, and a
	// Uint8Array over a SharedArrayBuffer is not assignable to it.
	const body = status === 200 ? (bytes.slice().buffer as ArrayBuffer) : null;
	return (async () =>
		new Response(body, {
			status,
			headers: { "content-length": String(bytes.byteLength) },
		})) as unknown as typeof fetch;
}

function restoreCache(): void {
	if (realBytes) {
		mkdirSync(cachePath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
		writeFileSync(cachePath, realBytes);
	} else if (existsSync(cachePath)) {
		rmSync(cachePath, { force: true });
	}
}

beforeEach(() => {
	clearGrammarFailureCache();
	restoreCache();
});

describe("manifest", () => {
	test("every entry has a full sha256 and a positive size", () => {
		for (const item of GRAMMAR_MANIFEST) {
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.bytes).toBeGreaterThan(0);
			expect(item.extensions.length).toBeGreaterThan(0);
			for (const ext of item.extensions) expect(ext.startsWith(".")).toBe(true);
		}
	});

	test("extensions map to exactly one language each", () => {
		const seen = new Map<string, string>();
		for (const item of GRAMMAR_MANIFEST) {
			for (const ext of item.extensions) {
				expect(seen.has(ext)).toBe(false);
				seen.set(ext, item.id);
			}
		}
		expect(languageIdForExtension(".ts")).toBe("typescript");
		expect(languageIdForExtension(".TS")).toBe("typescript");
		expect(languageIdForExtension(".rs")).toBe("rust");
		expect(languageIdForExtension(".unknown")).toBeNull();
	});

	test("only manifest languages are recognized", () => {
		expect(isKnownGrammarLanguage("typescript")).toBe(true);
		// The allow-list is what stops a `:lang` route param from naming a path.
		expect(isKnownGrammarLanguage("../../etc/passwd")).toBe(false);
		expect(isKnownGrammarLanguage("cobol")).toBe(false);
	});
});

describe("download verification", () => {
	test("rejects bytes whose digest does not match the manifest", async () => {
		const wrong = new Uint8Array(entry.bytes).fill(7);
		rmSync(cachePath, { force: true });
		const result = await downloadGrammar(LANG, {
			useCache: false,
			fetchImpl: stubFetch(wrong),
			urlTemplates: ["https://example.invalid/{name}-{version}.wasm"],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("mismatch");
		// Critically: nothing was written.
		expect(existsSync(cachePath)).toBe(false);
	});

	test("rejects a payload of the wrong size before hashing", async () => {
		rmSync(cachePath, { force: true });
		const result = await downloadGrammar(LANG, {
			useCache: false,
			fetchImpl: stubFetch(new Uint8Array(16)),
			urlTemplates: ["https://example.invalid/a.wasm"],
		});
		expect(result.ok).toBe(false);
		expect(existsSync(cachePath)).toBe(false);
	});

	test("reports an unknown language instead of touching the filesystem", async () => {
		const result = await downloadGrammar("not-a-language", {
			fetchImpl: stubFetch(new Uint8Array(4)),
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unknown grammar");
	});

	test("falls through to the next URL template when the first fails", async () => {
		rmSync(cachePath, { force: true });
		let calls = 0;
		const failingThenFailing = (async () => {
			calls++;
			return new Response(null, { status: 404 });
		}) as unknown as typeof fetch;
		const result = await downloadGrammar(LANG, {
			useCache: false,
			fetchImpl: failingThenFailing,
			urlTemplates: ["https://a.invalid/{name}.wasm", "https://b.invalid/{name}.wasm"],
		});
		expect(calls).toBe(2);
		expect(result.ok).toBe(false);
	});

	test("caches a recent failure so retries do not hammer the CDN", async () => {
		rmSync(cachePath, { force: true });
		let calls = 0;
		const failing = (async () => {
			calls++;
			return new Response(null, { status: 500 });
		}) as unknown as typeof fetch;
		const opts = {
			useCache: false as const,
			fetchImpl: failing,
			urlTemplates: ["https://a.invalid/{name}.wasm"],
		};
		await downloadGrammar(LANG, opts);
		const callsAfterFirst = calls;
		const second = await downloadGrammar(LANG, opts);
		expect(second.ok).toBe(false);
		expect(second.error).toContain("recent download attempt");
		expect(calls).toBe(callsAfterFirst);
	});
});

const describeWithBytes = realBytes ? describe : describe.skip;

describeWithBytes("cache behaviour (requires the go grammar in the cache)", () => {
	test("accepts a download whose digest matches and writes it", async () => {
		rmSync(cachePath, { force: true });
		let calls = 0;
		const good = (async () => {
			calls++;
			return new Response(realBytes?.slice().buffer as ArrayBuffer, {
				status: 200,
				headers: { "content-length": String(realBytes?.byteLength ?? 0) },
			});
		}) as unknown as typeof fetch;
		const result = await downloadGrammar(LANG, {
			useCache: false,
			fetchImpl: good,
			urlTemplates: ["https://a.invalid/{name}.wasm"],
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(1);
		expect(isGrammarInstalled(LANG)).toBe(true);
	});

	test("a cache hit does not re-download", async () => {
		let calls = 0;
		const counting = (async () => {
			calls++;
			return new Response(realBytes?.slice().buffer as ArrayBuffer, { status: 200 });
		}) as unknown as typeof fetch;
		const result = await downloadGrammar(LANG, { fetchImpl: counting });
		expect(result.ok).toBe(true);
		expect(calls).toBe(0);
	});

	test("a corrupted cached file is not returned as valid", async () => {
		writeFileSync(cachePath, new Uint8Array(entry.bytes).fill(1));
		expect(await readInstalledGrammar(LANG)).toBeNull();
	});

	test("status flags a cached file whose size no longer matches", async () => {
		writeFileSync(cachePath, new Uint8Array(entry.bytes - 1));
		const statuses = await listGrammarStatus();
		const go = statuses.find((s) => s.id === LANG);
		expect(go?.installed).toBe(true);
		expect(go?.digestMismatch).toBe(true);
	});

	test("remove deletes the cached file and is a no-op afterwards", () => {
		expect(removeGrammar(LANG)).toBe(true);
		expect(isGrammarInstalled(LANG)).toBe(false);
		expect(removeGrammar(LANG)).toBe(false);
	});

	test("remove refuses an unknown language", () => {
		expect(removeGrammar("../escape")).toBe(false);
	});
});

test("cache is restored for the dev environment", () => {
	restoreCache();
	expect(realBytes ? isGrammarInstalled(LANG) : true).toBe(true);
});
