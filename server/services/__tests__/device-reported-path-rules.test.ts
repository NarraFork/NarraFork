/**
 * Handshake-reported path rules.
 *
 * The drift badge in the UI is drawn from this column, so the three states have to
 * stay distinguishable: "did not report" (older executor) must not look like
 * "reported no rules", or every legacy device would show a false "not applied"
 * warning. Rules also arrive from a remote peer, so malformed entries must degrade
 * the display rather than corrupt stored JSON.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import type { DeviceHelloFrame } from "../../lib/agent/execution/rpc-types";
import { generateId } from "../../lib/id";
import { normalizeReportedPathRules } from "../device-connection-service";
import { getDevice } from "../device-service";

/** Minimal hello frame; only the path-rule fields matter for these assertions. */
function hello(overrides: Partial<DeviceHelloFrame> = {}): DeviceHelloFrame {
	return {
		type: "hello",
		protocolVersion: 1,
		deviceRef: "dev",
		agentVersion: "0.5.24",
		platform: { os: "linux", arch: "amd64" },
		capabilities: { git: true, ripgrep: true, pty: true },
		...overrides,
	};
}

const created: string[] = [];

async function makeDevice(): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(remoteDevices).values({
		id,
		name: `Reported ${id.slice(0, 6)}`,
		slug: `reported-${id.slice(0, 8).toLowerCase()}`,
		tokenHash: "hash",
		tokenPrefix: "rdev_bbb",
		connectionMode: "reverse",
		createdBy: "user-reported",
		createdAt: now,
		updatedAt: now,
	});
	created.push(id);
	return id;
}

/** Writes the column the way markOnline does, then reads it back through the view. */
async function persistReported(
	id: string,
	rules: Array<{ action: "allow" | "deny"; path: string }> | null,
) {
	await db
		.update(remoteDevices)
		.set({ reportedPathRulesJson: rules })
		.where(eq(remoteDevices.id, id));
	return (await getDevice(id))?.reportedPathRules;
}

beforeEach(() => {
	created.length = 0;
});

afterEach(async () => {
	if (created.length > 0) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, created));
	}
});

describe("normalizeReportedPathRules", () => {
	test("an executor predating the field reports nothing, which stays null", () => {
		// Must be null and not []: a legacy device would otherwise be rendered as
		// "reported unrestricted" and could trigger a false drift warning.
		expect(normalizeReportedPathRules(hello())).toBeNull();
	});

	test("an explicit unrestricted flag becomes an empty list", () => {
		expect(normalizeReportedPathRules(hello({ pathRulesUnrestricted: true }))).toEqual([]);
	});

	test("reported rules keep their order", () => {
		const rules = [
			{ action: "allow" as const, path: "/srv/work" },
			{ action: "deny" as const, path: "/srv/work/secrets" },
		];
		expect(normalizeReportedPathRules(hello({ pathRules: rules }))).toEqual(rules);
	});

	test("malformed entries are dropped rather than stored", () => {
		const result = normalizeReportedPathRules(
			hello({
				pathRules: [
					{ action: "allow", path: "/srv/ok" },
					{ action: "sideways", path: "/srv/bad-action" },
					{ action: "deny", path: "" },
					// biome-ignore lint/suspicious/noExplicitAny: simulating a hostile peer
					{ action: "deny", path: 42 as any },
					// biome-ignore lint/suspicious/noExplicitAny: simulating a hostile peer
					null as any,
				],
			}),
		);
		expect(result).toEqual([{ action: "allow", path: "/srv/ok" }]);
	});

	test("a non-array value does not throw or become a bogus list", () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating a hostile peer
		expect(normalizeReportedPathRules(hello({ pathRules: "nope" as any }))).toBeNull();
	});

	test("an empty reported array stays an empty list", () => {
		expect(normalizeReportedPathRules(hello({ pathRules: [] }))).toEqual([]);
	});
});

describe("reported path rules round trip", () => {
	test("a device that never reported reads back as null, not an empty list", async () => {
		const id = await makeDevice();
		expect((await getDevice(id))?.reportedPathRules).toBeNull();
	});

	test("an explicitly unrestricted report is stored as an empty list", async () => {
		const id = await makeDevice();
		// Distinct from null: the device said "I have no rules", which is a real
		// answer and should not be shown as "unknown".
		expect(await persistReported(id, [])).toEqual([]);
	});

	test("reported rule order is preserved", async () => {
		const id = await makeDevice();
		const rules = [
			{ action: "allow" as const, path: "/srv/work" },
			{ action: "deny" as const, path: "/srv/work/secrets" },
			{ action: "allow" as const, path: "/srv/work/secrets/public" },
		];
		expect(await persistReported(id, rules)).toEqual(rules);
	});

	test("windows paths survive storage unchanged", async () => {
		const id = await makeDevice();
		const rules = [
			{ action: "allow" as const, path: "C:\\work" },
			{ action: "deny" as const, path: 'C:\\we"ird\\path' },
		];
		expect(await persistReported(id, rules)).toEqual(rules);
	});
});
