import { describe, expect, test } from "bun:test";
import { safeParseManifest } from "@server/lib/plugins/manifest";

/**
 * Size ceiling on the uninspected `permissions.network|filesystem|process` blocks.
 *
 * These three fields have no reader in the host (see the comment on
 * `uninspectedPermissionSchema`), so their *shape* is deliberately unvalidated —
 * `z.looseObject({})` accepts any keys, which is what lets an author describe intent without
 * the host pretending to enforce it.
 *
 * What is still bounded is cost. A parsed manifest is held in memory and copied into the
 * plugin state file, whose persistence is a synchronous JSON read/modify/write on the main
 * thread; with no ceiling at all a manifest could carry hundreds of kilobytes of arbitrary
 * JSON through every state write, for a field nothing reads. This is a B-class survival
 * limit in the sense of `docs/plugin-system/11-capability-policy.md` §2, not a trust limit.
 */

const fixtureDirectory = new URL("../../../fixtures/plugins/", import.meta.url);

async function baseManifest(): Promise<Record<string, unknown>> {
	return Bun.file(new URL("valid-manifest.json", fixtureDirectory)).json();
}

async function withPermission(
	field: "network" | "filesystem" | "process",
	value: unknown,
): Promise<ReturnType<typeof safeParseManifest>> {
	const manifest = await baseManifest();
	const permissions = manifest.permissions as Record<string, unknown>;
	permissions[field] = value;
	return safeParseManifest(manifest);
}

describe("Manifest uninspected permission blocks", () => {
	test("still accepts arbitrary keys, because shape is documentation not enforcement", async () => {
		for (const field of ["network", "filesystem", "process"] as const) {
			const result = await withPermission(field, {
				mode: "none",
				allow: [],
				somethingTheHostNeverReads: { nested: [1, 2, 3] },
			});
			expect(result.success, field).toBe(true);
		}
	});

	test("rejects a block that serializes past the ceiling", async () => {
		// One key holding a large string: this is why the limit is on serialized size rather
		// than a key count, which a single value can defeat.
		for (const field of ["network", "filesystem", "process"] as const) {
			const oversized = await withPermission(field, { note: "x".repeat(8 * 1024 + 1) });
			expect(oversized.success, field).toBe(false);
		}

		// And many small keys, so the bound is not escapable by spreading the payload out.
		const manyKeys = Object.fromEntries(
			Array.from({ length: 2000 }, (_, index) => [`allow${index}`, `host-${index}.example.com`]),
		);
		expect((await withPermission("network", manyKeys)).success).toBe(false);
	});

	test("leaves a realistic declaration comfortably inside the ceiling", async () => {
		// An allowlist of 40 hosts and ports is the shape a real plugin uses; the limit must
		// not be tight enough to be hit by honest manifests.
		const realistic = {
			mode: "allowlist",
			allow: Array.from({ length: 40 }, (_, index) => ({
				host: `service-${index}.example.com`,
				ports: [443],
			})),
		};
		expect(JSON.stringify(realistic).length).toBeLessThan(8 * 1024);
		expect((await withPermission("network", realistic)).success).toBe(true);
	});
});
