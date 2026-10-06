import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { ensureNotificationsTableForTests, NOTIFICATION_RETENTION_MAX_AGE_MS } = await import(
	"../notification-center-service"
);
const {
	startNotificationCenterMaintenance,
	stopNotificationCenterMaintenance,
	runNotificationCenterMaintenanceTick,
	NOTIFICATION_MAINTENANCE_DELETE_PER_TICK,
	NOTIFICATION_MAINTENANCE_DELETE_PER_USER,
	NOTIFICATION_MAINTENANCE_USERS_PER_TICK,
} = await import("../notification-center-maintenance");
let now = Date.now();
function user(id: string) {
	sqlite.run("INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)", [
		id,
		id,
		"x",
		new Date(now).toISOString(),
	]);
}
function events(userId: string, count: number, time = now) {
	const insert = sqlite.prepare(
		"INSERT INTO notifications (id,user_id,kind,source_key,created_at,title,preview,link_json) VALUES (?,?,'chat_message',?,?,'','','{}')",
	);
	for (let i = 0; i < count; i++)
		insert.run(`${userId}-${time}-${i.toString().padStart(4, "0")}`, userId, `${time}-${i}`, time);
}
function count(userId: string) {
	return (
		sqlite.query("SELECT count(*) AS count FROM notifications WHERE user_id=?").get(userId) as {
			count: number;
		}
	).count;
}

beforeEach(async () => {
	await stopNotificationCenterMaintenance();
	cleanDb(sqlite);
	ensureNotificationsTableForTests(sqlite);
	now = Date.now();
});
afterEach(async () => {
	await stopNotificationCenterMaintenance();
});
afterAll(() => {
	mock.restore();
	mock.module("../../db", () => realDb);
	cleanDb(sqlite);
});

test("maintenance removes age and count overflow with stable timestamp ties", async () => {
	user("a");
	events("a", 510);
	events("a", 20, now - NOTIFICATION_RETENTION_MAX_AGE_MS - 1);
	startNotificationCenterMaintenance();
	let deleted = 0;
	for (let i = 0; i < 3; i++) deleted += (await runNotificationCenterMaintenanceTick()).deleted;
	expect(deleted).toBe(30);
	expect(count("a")).toBe(500);
	expect(
		sqlite
			.query(
				"SELECT id FROM notifications WHERE user_id='a' ORDER BY created_at ASC,id ASC LIMIT 1",
			)
			.get(),
	).toEqual({ id: `a-${now}-0010` });
});

test("fixed user/delete budgets, finite SQL batches, and keyset fairness across hot restart", async () => {
	for (let i = 0; i < 12; i++) {
		const id = `user-${i.toString().padStart(2, "0")}`;
		user(id);
		events(id, 700);
	}
	const runSpy = spyOn(db, "run");
	try {
		startNotificationCenterMaintenance();
		const first = await runNotificationCenterMaintenanceTick();
		expect(first.users).toBeLessThanOrEqual(NOTIFICATION_MAINTENANCE_USERS_PER_TICK);
		expect(first.deleted).toBeLessThanOrEqual(NOTIFICATION_MAINTENANCE_DELETE_PER_TICK);
		expect(first.deleted).toBeGreaterThan(0);
		// Replacing the hot-safe timer must preserve the keyset, not starve later users.
		startNotificationCenterMaintenance();
		for (let i = 0; i < 16 && count("user-11") === 700; i++)
			await runNotificationCenterMaintenanceTick();
		expect(count("user-11")).toBeLessThan(700);
		const dialect = new SQLiteSyncDialect();
		for (const [query] of runSpy.mock.calls) {
			const rendered = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
			expect(rendered.params.length).toBeLessThanOrEqual(
				NOTIFICATION_MAINTENANCE_DELETE_PER_USER + 1,
			);
			expect(rendered.sql).not.toContain("RETURNING");
		}
	} finally {
		runSpy.mockRestore();
	}
});

test("non-reentrancy and stop drain prevent work after shutdown", async () => {
	// Sort beyond the previous test's cursor: hot restart intentionally preserves it.
	user("zz-a");
	user("zz-b");
	events("zz-a", 1000);
	events("zz-b", 1000);
	startNotificationCenterMaintenance();
	const pending = runNotificationCenterMaintenanceTick();
	expect((await runNotificationCenterMaintenanceTick()).skipped).toBe(true);
	await stopNotificationCenterMaintenance();
	const result = await pending;
	expect(result.users).toBeLessThanOrEqual(1);
	const remaining = count("zz-a") + count("zz-b");
	expect((await runNotificationCenterMaintenanceTick()).skipped).toBe(true);
	expect(count("zz-a") + count("zz-b")).toBe(remaining);
});

test("time budget gives up the current tick and resumes with the next user", async () => {
	user("zzz-a");
	user("zzz-b");
	events("zzz-a", 700);
	events("zzz-b", 700);
	startNotificationCenterMaintenance();
	let call = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => (call++ < 2 ? 0 : 100));
	try {
		expect((await runNotificationCenterMaintenanceTick()).users).toBe(1);
	} finally {
		clock.mockRestore();
	}
	for (let i = 0; i < 4; i++) await runNotificationCenterMaintenanceTick();
	expect(count("zzz-a")).toBeLessThan(700);
	expect(count("zzz-b")).toBeLessThan(700);
});
