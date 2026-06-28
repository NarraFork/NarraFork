/**
 * Unit tests for the knowledge-base ACL decision logic.
 *
 * Focuses on the SYNCHRONOUS, pure decision functions (canWriteMain / canReview)
 * which gate the write + review paths hardened in phase 1. These take fully
 * resolved caps + entry shapes and touch no database, so they are deterministic.
 *
 * The dual-axis canRead + fail-closed rankOf path depends on the DB-backed level
 * map and is covered by integration-level checks elsewhere; here we assert the
 * capability primitives that the route/service guards rely on.
 */
import { describe, expect, test } from "bun:test";
import { type AclEntry, canReview, canWriteMain, type PrincipalCaps } from "../knowledge-acl";

function caps(overrides: Partial<PrincipalCaps> = {}): PrincipalCaps {
	return {
		userId: "u1",
		role: "user",
		isAdmin: false,
		clearanceRank: 0,
		grantedTagIds: new Set(),
		hasWriteGrant: false,
		reviewTagIds: new Set(),
		...overrides,
	};
}

function entry(overrides: Partial<AclEntry> = {}): AclEntry {
	return {
		id: "e1",
		collectionId: "c1",
		ownerUserId: null,
		classificationLevel: null,
		controlledTagsJson: null,
		reviewTagsJson: null,
		...overrides,
	};
}

describe("canWriteMain", () => {
	test("admin may always write main", () => {
		expect(canWriteMain(caps({ isAdmin: true }), entry())).toBe(true);
	});

	test("owner may write their own entry", () => {
		expect(canWriteMain(caps({ userId: "owner" }), entry({ ownerUserId: "owner" }))).toBe(true);
	});

	test("holder of a write grant may write main", () => {
		expect(canWriteMain(caps({ hasWriteGrant: true }), entry())).toBe(true);
	});

	test("a plain reader (no grant, not owner) is denied direct main writes", () => {
		expect(canWriteMain(caps(), entry({ ownerUserId: "someone-else" }))).toBe(false);
	});
});

describe("canReview", () => {
	test("admin may review anything", () => {
		expect(canReview(caps({ isAdmin: true }), entry({ reviewTagsJson: ["t1"] }))).toBe(true);
	});

	test("owner may review their own entry", () => {
		expect(canReview(caps({ userId: "owner" }), entry({ ownerUserId: "owner" }))).toBe(true);
	});

	test("entry with NO review tags is reviewable only by admin/owner (conservative)", () => {
		// A non-owner non-admin user, however privileged, cannot review an entry
		// that has no review tags configured.
		expect(
			canReview(caps({ reviewTagIds: new Set(["t1", "t2"]) }), entry({ reviewTagsJson: [] })),
		).toBe(false);
	});

	test("reviewer must hold EVERY review tag (compartment AND semantics)", () => {
		const e = entry({ reviewTagsJson: ["t1", "t2"] });
		// Holds only one of the two required review tags → denied.
		expect(canReview(caps({ reviewTagIds: new Set(["t1"]) }), e)).toBe(false);
		// Holds both → allowed.
		expect(canReview(caps({ reviewTagIds: new Set(["t1", "t2"]) }), e)).toBe(true);
	});
});
