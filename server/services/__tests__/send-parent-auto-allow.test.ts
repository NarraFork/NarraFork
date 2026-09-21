/**
 * send-parent-auto-allow.test.ts — subagent → parent Send must auto-allow.
 *
 * Regression: `resolveSendTargetsForPermission` returned [] when the destination
 * was the team parent (primary), so `shouldAutoAllowSendWithinScope` always
 * failed for progress reports and replyTo answers. Those Sends sat in
 * `pending` with null execution_started_at, parent Agent/await leases never
 * drained, and planned updates blocked on work that would never finish.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { shouldAutoAllowSendWithinScope } = await import("../narrator-permission");

const PARENT = "auto-allow-parent";
const CHILD = "auto-allow-child";
const SIBLING = "auto-allow-sibling";
const PRIVILEGED = "auto-allow-privileged";

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

beforeEach(async () => {
	cleanDb(sqlite);
	const now = "2026-09-21T00:00:00.000Z";
	await db.insert(narrators).values([
		{
			id: PARENT,
			variant: "primary",
			type: "primary",
			permissionMode: "bypassPermissions",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: CHILD,
			variant: "subagent:explore",
			type: "subagent",
			parentNarratorId: PARENT,
			permissionMode: "default",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: SIBLING,
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: PARENT,
			permissionMode: "default",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: PRIVILEGED,
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: PARENT,
			permissionMode: "bypassPermissions",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterEach(() => {
	cleanDb(sqlite);
});

async function child() {
	const row = await db.query.narrators.findFirst({ where: (t, { eq }) => eq(t.id, CHILD) });
	if (!row) throw new Error("child narrator missing");
	return row;
}

describe("subagent → parent Send auto-allow", () => {
	test('Send({ id: "parent" }) is always in scope for a child', async () => {
		const caller = await child();
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, caller, { id: "parent", message: "hi" }),
		).toBe(true);
		expect(await shouldAutoAllowSendWithinScope(CHILD, caller, { id: "main", message: "hi" })).toBe(
			true,
		);
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, caller, { id: PARENT, message: "report" }),
		).toBe(true);
	});

	test("parent auto-allow holds even when parent has a higher permission rank", async () => {
		const caller = await child();
		// parent is bypassPermissions (rank 4), child is default (rank 2). Rank-only
		// comparison would refuse; parent delivery must still auto-allow.
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, caller, { id: "parent", message: "x" }),
		).toBe(true);
	});

	test("equal-rank sibling still auto-allows; higher-rank sibling does not", async () => {
		const caller = await child();
		expect(await shouldAutoAllowSendWithinScope(CHILD, caller, { id: SIBLING, message: "x" })).toBe(
			true,
		);
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, caller, { id: PRIVILEGED, message: "x" }),
		).toBe(false);
	});

	test("mixed parent + equal-rank sibling auto-allows; parent + higher-rank sibling does not", async () => {
		const caller = await child();
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, caller, {
				ids: ["parent", SIBLING],
				message: "x",
			}),
		).toBe(true);
		expect(
			await shouldAutoAllowSendWithinScope(CHILD, caller, {
				ids: ["parent", PRIVILEGED],
				message: "x",
			}),
		).toBe(false);
	});

	test("missing caller or empty message targets do not auto-allow", async () => {
		expect(await shouldAutoAllowSendWithinScope(CHILD, null, { id: "parent", message: "x" })).toBe(
			false,
		);
		const caller = await child();
		expect(await shouldAutoAllowSendWithinScope(CHILD, caller, { message: "x" })).toBe(false);
	});
});
