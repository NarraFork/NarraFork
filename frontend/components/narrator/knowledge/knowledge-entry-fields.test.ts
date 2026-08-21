/**
 * knowledge-entry-fields.test.ts — the body field differs per scope.
 *
 * The regression this pins: the panel read `entryData.content` for BOTH scopes, but a
 * global entry carries its published body in `currentContent`. Every global entry
 * therefore rendered as "(empty)" — a 46KB document looked like an empty one, and the
 * failure was silent because "no body loaded" and "an entry with an empty body" show the
 * same string.
 */

import { describe, expect, test } from "bun:test";
import type { KnowledgeEntry, KnowledgePersonalEntry } from "@frontend/lib/api/knowledge-types";
import {
	canEditKnowledgeEntry,
	knowledgeEntryContent,
	knowledgeEntryTitle,
} from "./knowledge-entry-fields";

function globalEntry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	return {
		id: "k1",
		collectionId: "c1",
		title: "charge_manager 日志说明",
		slug: "charge-manager",
		currentRevisionId: "r1",
		currentContent: "# 日志字典\n\n命中充电状态机…",
		tagsJson: null,
		keywordsJson: null,
		metadataJson: null,
		classificationLevel: null,
		controlledTagsJson: null,
		reviewTagsJson: null,
		ownerUserId: "u-owner",
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	} as KnowledgeEntry;
}

function personalEntry(over: Partial<KnowledgePersonalEntry> = {}): KnowledgePersonalEntry {
	return {
		id: "p1",
		entryId: null,
		authorUserId: "u-me",
		name: "草稿名",
		title: "我的条目",
		targetCollectionId: null,
		baseRevisionId: null,
		content: "personal body",
		contentHash: "h",
		format: "md",
		keywordsJson: null,
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	} as KnowledgePersonalEntry;
}

describe("knowledgeEntryContent", () => {
	test("a global entry's body comes from currentContent", () => {
		expect(knowledgeEntryContent("global", globalEntry())).toContain("命中充电状态机");
	});

	test("a global entry does NOT fall back to a `content` field", () => {
		// The exact bug: a shape that happens to carry `content` must not mask a missing
		// `currentContent`, or the two scopes silently swap meanings again.
		const shaped = { ...globalEntry({ currentContent: null }), content: "wrong field" };
		expect(knowledgeEntryContent("global", shaped as unknown as KnowledgeEntry)).toBeNull();
	});

	test("a personal entry's body comes from content", () => {
		expect(knowledgeEntryContent("personal", personalEntry())).toBe("personal body");
	});

	test("distinguishes 'no entry' from 'an entry with an empty body'", () => {
		expect(knowledgeEntryContent("global", null)).toBeNull();
		expect(knowledgeEntryContent("global", undefined)).toBeNull();
		expect(knowledgeEntryContent("global", globalEntry({ currentContent: "" }))).toBe("");
	});
});

describe("knowledgeEntryTitle", () => {
	test("a global entry uses its title", () => {
		expect(knowledgeEntryTitle("global", globalEntry())).toBe("charge_manager 日志说明");
	});

	test("a personal entry falls back title → name → short id", () => {
		expect(knowledgeEntryTitle("personal", personalEntry())).toBe("我的条目");
		expect(knowledgeEntryTitle("personal", personalEntry({ title: null }))).toBe("草稿名");
		expect(
			knowledgeEntryTitle("personal", personalEntry({ title: null, name: null, id: "abcdefghij" })),
		).toBe("abcdefgh");
	});

	test("returns null with no entry, leaving generic copy to the caller's i18n", () => {
		expect(knowledgeEntryTitle("global", null)).toBeNull();
	});

	test("whitespace-only titles do not win over the fallback", () => {
		expect(knowledgeEntryTitle("global", globalEntry({ title: "   " }))).toBeNull();
	});
});

describe("canEditKnowledgeEntry", () => {
	test("global: the owner and an admin may edit; nobody else", () => {
		const entry = globalEntry();
		expect(canEditKnowledgeEntry("global", entry, { id: "u-owner", role: "user" })).toBe(true);
		expect(canEditKnowledgeEntry("global", entry, { id: "u-other", role: "admin" })).toBe(true);
		expect(canEditKnowledgeEntry("global", entry, { id: "u-other", role: "user" })).toBe(false);
	});

	test("personal: always editable by whoever can read it", () => {
		expect(canEditKnowledgeEntry("personal", personalEntry(), { id: "u-me", role: "user" })).toBe(
			true,
		);
	});

	test("no entry or no user → not editable", () => {
		expect(canEditKnowledgeEntry("global", null, { id: "u1", role: "admin" })).toBe(false);
		expect(canEditKnowledgeEntry("global", globalEntry(), null)).toBe(false);
	});
});
