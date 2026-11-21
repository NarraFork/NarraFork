import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import type { BooleanOverride } from "../../lib/boolean-override";
import { legacyFastModeMirror } from "../../lib/fast-mode";
import { generateId } from "../../lib/id";
import { resolveNarratorFastMode } from "../narrator-fast-mode";
import { narratorService } from "../narrator-service";

// Real creation and worker reads use only the file-backed tests/preload.ts database.
const ids: string[] = [];
afterEach(async () => {
	for (const id of ids.splice(0).reverse()) await db.delete(narrators).where(eq(narrators.id, id));
});

async function primary(fastModeOverride: BooleanOverride) {
	const id = generateId();
	ids.push(id);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		cwd: process.env.HOME,
		fastModeOverride,
		fastMode: legacyFastModeMirror(fastModeOverride),
		createdAt: now,
		updatedAt: now,
	});
	return id;
}
async function child(parentNarratorId: string) {
	const created = await narratorService.createSubagent({
		parentNarratorId,
		subagentType: "general",
		subagentOriginKind: "standalone",
		cwd: process.env.HOME as string,
		// Trusted fixture ceiling permits a nested creation without exercising template policy.
		runtimePolicy: { version: 1 },
	});
	ids.push(created.id);
	return created;
}

describe("subagent creation fast-mode inheritance", () => {
	for (const override of ["inherit", "on", "off"] as const) {
		test(`new children store inherit when their primary stores ${override}`, async () => {
			const root = await primary(override);
			const created = await child(root);
			expect(created.fastModeOverride).toBe("inherit");
			expect(created.fastMode).toBe(legacyFastModeMirror("inherit"));
			expect(created.aclRootNarratorId).toBe(root);
			expect(await resolveNarratorFastMode(created.id)).toEqual({
				effectiveFastMode: override === "on",
				fastModeSource: "primary",
				fastModeSourceNarratorId: root,
			});
			expect((await narratorService.getById(root)).fastModeOverride).toBe(override);
		});
	}

	test("a nested child follows its root primary, not its parent's explicit selection", async () => {
		const root = await primary("off");
		const middle = await child(root);
		await narratorService.updateFastModeOverride(middle.id, "on");
		const nested = await child(middle.id);
		expect(nested.fastModeOverride).toBe("inherit");
		expect(nested.fastMode).toBe(false);
		expect(nested.aclRootNarratorId).toBe(root);
		expect((await resolveNarratorFastMode(nested.id)).effectiveFastMode).toBe(false);
		await narratorService.updateFastModeOverride(root, "on");
		expect((await resolveNarratorFastMode(nested.id)).effectiveFastMode).toBe(true);
		expect((await narratorService.getById(nested.id)).fastModeOverride).toBe("inherit");
	});

	test("existing child selections remain stored as-is when the primary changes", async () => {
		const root = await primary("on");
		const existing = [];
		for (const override of ["inherit", "on", "off"] as const) {
			const created = await child(root);
			await narratorService.updateFastModeOverride(created.id, override);
			existing.push({ id: created.id, override });
			await resolveNarratorFastMode(created.id);
		}
		await narratorService.updateFastModeOverride(root, "off");
		for (const { id, override } of existing) {
			const stored = await narratorService.getById(id);
			expect(stored.fastModeOverride).toBe(override);
			expect(stored.fastMode).toBe(legacyFastModeMirror(override));
			expect((await resolveNarratorFastMode(id)).effectiveFastMode).toBe(override === "on");
		}
	});

	for (const override of ["inherit", "on", "off"] as const) {
		test(`fork primary preserves its copied ${override} selection independently`, async () => {
			const root = await primary(override);
			const fork = await narratorService.forkNarrator(root, null, { inheritMode: "fresh" });
			ids.push(fork.id);
			expect(fork.type).toBe("primary");
			expect(fork.fastModeOverride).toBe(override);
			expect(fork.fastMode).toBe(legacyFastModeMirror(override));
			const before = await resolveNarratorFastMode(fork.id);
			await narratorService.updateFastModeOverride(root, override === "on" ? "off" : "on");
			expect(await resolveNarratorFastMode(fork.id)).toEqual(before);
			expect((await narratorService.getById(fork.id)).fastModeOverride).toBe(override);
		});
	}
});
