/**
 * Per-narrator AskUserQuestion reflection override.
 *
 * The permission gate resolves `narrator.questionReflectionOverride` against
 * `settings.agent.questionReflectionEnabled` (see
 * `shouldScheduleQuestionReflection` in narrator-permission), so this suite pins:
 *  - the tri-state column's default and per-narrator isolation through the service
 *  - the resolve semantics the gate relies on (inherit = follow the global default)
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { resolveBooleanOverride } from "../../lib/boolean-override";
import { narratorService } from "../narrator-service";

async function readOverride(id: string) {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { questionReflectionOverride: true },
	});
	return row?.questionReflectionOverride;
}

describe("question reflection override storage", () => {
	test("new narrators inherit the global default", async () => {
		const narrator = await narratorService.create({ title: "question-reflection-default" });
		expect(narrator.questionReflectionOverride).toBe("inherit");
		expect(await readOverride(narrator.id)).toBe("inherit");
	});

	test("an explicit override is carried into the narrator row", async () => {
		const on = await narratorService.create({
			title: "question-reflection-on",
			questionReflectionOverride: "on",
		});
		expect(await readOverride(on.id)).toBe("on");

		const off = await narratorService.create({
			title: "question-reflection-off",
			questionReflectionOverride: "off",
		});
		expect(await readOverride(off.id)).toBe("off");
	});

	test("updates affect only the targeted narrator and can return to inherit", async () => {
		const target = await narratorService.create({ title: "question-reflection-target" });
		const other = await narratorService.create({ title: "question-reflection-other" });

		await narratorService.updateReflectionOverrides(target.id, {
			questionReflectionOverride: "on",
		});
		expect(await readOverride(target.id)).toBe("on");
		expect(await readOverride(other.id)).toBe("inherit");

		await narratorService.updateReflectionOverrides(target.id, {
			questionReflectionOverride: "off",
		});
		expect(await readOverride(target.id)).toBe("off");

		await narratorService.updateReflectionOverrides(target.id, {
			questionReflectionOverride: "inherit",
		});
		expect(await readOverride(target.id)).toBe("inherit");
	});

	test("changing one override leaves the other reflection overrides untouched", async () => {
		const narrator = await narratorService.create({
			title: "question-reflection-isolation",
			planReflectionAutoApproveOverride: "on",
			dangerReflectionOverride: "strict",
		});
		await narratorService.updateReflectionOverrides(narrator.id, {
			questionReflectionOverride: "off",
		});
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narrator.id),
			columns: {
				planReflectionAutoApproveOverride: true,
				dangerReflectionOverride: true,
				questionReflectionOverride: true,
			},
		});
		expect(row?.planReflectionAutoApproveOverride).toBe("on");
		expect(row?.dangerReflectionOverride).toBe("strict");
		expect(row?.questionReflectionOverride).toBe("off");
	});
});

describe("question reflection override resolution", () => {
	test("inherit follows the instance default", () => {
		expect(resolveBooleanOverride("inherit", true)).toBe(true);
		expect(resolveBooleanOverride("inherit", false)).toBe(false);
		expect(resolveBooleanOverride(undefined, true)).toBe(true);
	});

	test("explicit values win over the instance default", () => {
		expect(resolveBooleanOverride("on", false)).toBe(true);
		expect(resolveBooleanOverride("off", true)).toBe(false);
	});
});
