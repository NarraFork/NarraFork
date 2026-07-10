import { describe, expect, it } from "bun:test";
import { SETTING_DOCS } from "../../../server/lib/settings/defaults";
import { codexTierOrderSchema } from "../../../server/lib/validators";

const COMPLETE_TIER_ORDER = ["pro", "prolite", "plus", "team", "k12", "free", "other"];

describe("Settings Codex tier order", () => {
	it("accepts the complete K12 tier order and rejects unknown tiers", () => {
		expect(codexTierOrderSchema.safeParse({ tierOrder: COMPLETE_TIER_ORDER }).success).toBe(true);
		expect(codexTierOrderSchema.safeParse({ tierOrder: ["pro", "enterprise"] }).success).toBe(
			false,
		);
	});

	it("wires the shared tier-order schema into the generic settings route", async () => {
		const source = await Bun.file(
			new URL("../../../server/routes/settings.ts", import.meta.url),
		).text();

		expect(source).toMatch(
			/import\s*\{[\s\S]*\bcodexTierOrderSchema\b[\s\S]*\}\s*from\s*["']\.\.\/lib\/validators["'];/,
		);
		expect(source).toContain("tierOrder: codexTierOrderSchema.shape.tierOrder.optional(),");
		expect(source).not.toMatch(/tierOrder:\s*z\s*\.\s*array/);
	});

	it("documents the K12 default order and all valid tier values", () => {
		const docs = SETTING_DOCS["codex.tierOrder"];

		expect(docs?.desc).toContain('["pro", "prolite", "plus", "team", "k12", "free"]');
		expect(docs?.valid).toContain('"k12"');
		expect(docs?.valid).toContain('"other"');
	});
});
