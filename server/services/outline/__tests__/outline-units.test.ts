/**
 * Pure parts of the outline storage layer: link extraction, generated names and the store
 * selection rules. No database.
 */
import { describe, expect, test } from "bun:test";
import { isShortId, isSpaceKey } from "@shared/outline";
import { newOutlineKey, newOutlineSid } from "../keys";
import { contentLinks, dependsLinks, linkKey, linkTarget, tagLinks } from "../links";
import { resolveOutlineStore } from "../store";
import type { OutlineStore } from "../store/port";
import { sqliteOutlineStore } from "../store/sqlite-store";

describe("link extraction", () => {
	test("addresses are block targets, everything else is text", () => {
		expect(linkTarget(" sp1/abc123 ")).toEqual({ targetKind: "block", targetRef: "sp1/abc123" });
		expect(linkTarget("Some Title")).toEqual({ targetKind: "text", targetRef: "Some Title" });
		expect(linkTarget("Q17")).toEqual({ targetKind: "text", targetRef: "Q17" });
		expect(linkTarget("a/b/c")).toEqual({ targetKind: "text", targetRef: "a/b/c" });
	});

	test("content: mentions are links, a standalone embed is an embed, code is not searched", () => {
		expect(contentLinks("see [[k/abc]] and [[Title|shown]] `[[not/me]]` [[k/abc]]")).toEqual([
			{ kind: "link", targetKind: "block", targetRef: "k/abc" },
			{ kind: "link", targetKind: "text", targetRef: "Title" },
		]);
		expect(contentLinks("![[k/xyz]]")).toEqual([
			{ kind: "embed", targetKind: "block", targetRef: "k/xyz" },
		]);
		expect(contentLinks("```\n[[k/abc]]\n```")).toEqual([]);
		expect(contentLinks("| a | [[k/t]] |\n| - | - |\n| [[Cell]] | b |")).toEqual([
			{ kind: "link", targetKind: "block", targetRef: "k/t" },
			{ kind: "link", targetKind: "text", targetRef: "Cell" },
		]);
	});

	test("depends and tags", () => {
		expect(
			dependsLinks({
				status: "todo",
				assignee: null,
				depends: [
					{ target: "k/a", label: null },
					{ target: "Step", label: "s" },
					{ target: "k/a", label: "again" },
				],
			}),
		).toEqual([
			{ kind: "depends", targetKind: "block", targetRef: "k/a" },
			{ kind: "depends", targetKind: "text", targetRef: "Step" },
		]);
		expect(dependsLinks(null)).toEqual([]);
		expect(tagLinks(["Design", "k/t", "Design"])).toEqual([
			{ kind: "tag", targetKind: "text", targetRef: "Design" },
			{ kind: "tag", targetKind: "block", targetRef: "k/t" },
		]);
		// The same target under different kinds is a different link row.
		expect(linkKey({ kind: "tag", targetKind: "text", targetRef: "x" })).not.toBe(
			linkKey({ kind: "link", targetKind: "text", targetRef: "x" }),
		);
	});
});

describe("generated names", () => {
	test("space keys and sids are address tokens made of letters and digits", () => {
		for (let i = 0; i < 2000; i++) {
			const key = newOutlineKey();
			const sid = newOutlineSid();
			expect(isSpaceKey(key) && /^[A-Za-z0-9]{8}$/.test(key)).toBe(true);
			expect(isShortId(sid) && /^[A-Za-z0-9]{8}$/.test(sid)).toBe(true);
		}
	});
});

describe("outline store selection", () => {
	const injected = new Proxy({} as OutlineStore, {
		get: () => () => Promise.reject(new Error("stand-in: not callable")),
	});

	test("anything but an exact postgres selection is SQLite", () => {
		expect(resolveOutlineStore({}, undefined)).toBe(sqliteOutlineStore);
		for (const value of ["sqlite", "", "POSTGRES", "postgresql", 42, null]) {
			expect(resolveOutlineStore({ writeBackend: value }, injected)).toBe(sqliteOutlineStore);
		}
	});

	test("postgres resolves to the injected store, and never falls back without one", () => {
		expect(
			resolveOutlineStore({ writeBackend: "postgres", readBackend: "postgres" }, injected),
		).toBe(injected);
		expect(() =>
			resolveOutlineStore({ writeBackend: "postgres", readBackend: "postgres" }, undefined),
		).toThrow();
	});

	test("writing one database while reading another is refused", () => {
		expect(() => resolveOutlineStore({ writeBackend: "postgres" }, injected)).toThrow();
	});
});
