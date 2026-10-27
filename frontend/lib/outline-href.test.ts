/**
 * Outline places as URLs: what is an outline link of this app (and what is not), and that
 * building then parsing a target gives the same target, with or without a mount prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { outlineAddressPath, outlineCommitPath } from "@shared/outline-links";
import { resetAppBaseForTest } from "./base-path";
import {
	isOutlineReferenceHref,
	type OutlineHrefTarget,
	outlineTargetPath,
	parseOutlineHref,
} from "./outline-href";

const ORIGIN = "http://nf.local:7778";

afterEach(() => resetAppBaseForTest());

describe("parseOutlineHref", () => {
	const targets: OutlineHrefTarget[] = [
		{ kind: "home" },
		{ kind: "space", spaceId: "spaceAbc_-1" },
		{ kind: "block", spaceId: "S1", blockId: "B1" },
		{ kind: "block", spaceId: "S1", blockId: "B1", view: "all", asOf: 12 },
		{ kind: "ref", ref: "Kx81mPqa/Ab3dEf9Q" },
		{ kind: "ref", ref: "Ab3dEf9Q", space: "Kx81mPqa" },
		{ kind: "commit", space: "Kx81mPqa", seq: 4 },
	];

	test("every target survives building its path and parsing it back", () => {
		for (const target of targets) {
			expect(parseOutlineHref(outlineTargetPath(target), ORIGIN)).toEqual(target);
		}
	});

	test("absolute URLs of this origin are links; other origins and relative paths are not", () => {
		expect(parseOutlineHref(`${ORIGIN}/outline/S1/B1?asOf=3`, ORIGIN)).toEqual({
			kind: "block",
			spaceId: "S1",
			blockId: "B1",
			asOf: 3,
		});
		expect(parseOutlineHref("https://evil.example/outline/S1/B1", ORIGIN)).toBeNull();
		expect(parseOutlineHref("//evil.example/outline/S1/B1", ORIGIN)).toBeNull();
		expect(parseOutlineHref("outline/S1/B1", ORIGIN)).toBeNull();
		expect(parseOutlineHref("/outlines/S1", ORIGIN)).toBeNull();
		expect(parseOutlineHref("/narrators/abc", ORIGIN)).toBeNull();
		expect(parseOutlineHref("/outline/S1/B1/extra", ORIGIN)).toBeNull();
		expect(parseOutlineHref("/outline/S%2F1/B1", ORIGIN)).toBeNull();
		expect(parseOutlineHref("/outline/ref", ORIGIN)).toBeNull();
		expect(parseOutlineHref("/outline/ref?commit=4", ORIGIN)).toBeNull();
		expect(parseOutlineHref(`/outline/ref?a=${"x".repeat(301)}`, ORIGIN)).toBeNull();
	});

	test("ill-formed time and view are dropped, not trusted", () => {
		expect(parseOutlineHref("/outline/S1/B1?asOf=-1&view=weird", ORIGIN)).toEqual({
			kind: "block",
			spaceId: "S1",
			blockId: "B1",
		});
	});

	test("a path under the app's mount prefix parses the same", () => {
		const saved = {
			document: Object.getOwnPropertyDescriptor(globalThis, "document"),
			location: Object.getOwnPropertyDescriptor(globalThis, "location"),
		};
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { baseURI: "http://nf.local:7778/proxy/7778/" },
		});
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { href: "http://nf.local:7778/proxy/7778/outline/S1/B1" },
		});
		try {
			resetAppBaseForTest();
			expect(parseOutlineHref("/proxy/7778/outline/S1/B1", ORIGIN)).toEqual({
				kind: "block",
				spaceId: "S1",
				blockId: "B1",
			});
			// Agents write paths without the prefix; those are recognised too.
			expect(parseOutlineHref("/outline/S1", ORIGIN)).toEqual({ kind: "space", spaceId: "S1" });
		} finally {
			for (const [key, descriptor] of Object.entries(saved)) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
			resetAppBaseForTest();
		}
	});
});

describe("tool card paths", () => {
	test("only a key/sid address and a commit seq make a path, and they parse as references", () => {
		expect(outlineAddressPath("Kx81mPqa/Ab3dEf9Q")).toBe("/outline/ref?a=Kx81mPqa%2FAb3dEf9Q");
		expect(outlineAddressPath("Kx81mPqa/")).toBeNull();
		expect(outlineAddressPath("Ab3dEf9Q")).toBeNull();
		expect(outlineAddressPath("Kx81mPqa/a title")).toBeNull();
		expect(outlineCommitPath("Kx81mPqa", 4)).toBe("/outline/ref?space=Kx81mPqa&commit=4");
		expect(outlineCommitPath("Kx81mPqa", -1)).toBeNull();
		expect(isOutlineReferenceHref(outlineAddressPath("Kx81mPqa/Ab3dEf9Q"))).toBe(true);
		expect(isOutlineReferenceHref(outlineCommitPath("Kx81mPqa", 4))).toBe(true);
		expect(isOutlineReferenceHref("/outline/S1/B1")).toBe(false);
	});
});
