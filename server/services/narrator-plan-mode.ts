import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { addTrait, parseTraits, removeTrait } from "../lib/narrator-utils";
import { generateWordSlug } from "../lib/words";

export interface PlanModeStateResult {
	traits: string[];
	planFileId?: string;
	previousPermissionMode?: string;
	wasPlanMode: boolean;
	changed: boolean;
}

function generatePlanFileId(): string {
	return generateWordSlug();
}

export async function ensureNarratorPlanFileId(
	narratorId: string,
	existingPlanFileId?: string | null,
): Promise<string> {
	if (existingPlanFileId) return existingPlanFileId;
	const planFileId = generatePlanFileId();
	await db
		.update(narrators)
		.set({ planFileId, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, narratorId));
	return planFileId;
}

export async function enterNarratorPlanMode(narratorId: string): Promise<PlanModeStateResult> {
	const current = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			permissionMode: true,
			previousPermissionMode: true,
			planFileId: true,
			planMode: true,
			traits: true,
		},
	});
	const currentTraits = parseTraits(current?.traits);
	const wasPlanMode = currentTraits.includes("plan");
	const previousPermissionMode =
		current?.previousPermissionMode ?? current?.permissionMode ?? "default";
	const planFileId = current?.planFileId ?? generatePlanFileId();
	const nextTraits = wasPlanMode ? currentTraits : addTrait(currentTraits, "plan");
	const changed = !wasPlanMode || current?.planMode !== true || !current?.planFileId;

	if (changed) {
		await db
			.update(narrators)
			.set({
				traits: nextTraits,
				planMode: true,
				previousPermissionMode,
				planFileId,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, narratorId));
	}

	return {
		traits: nextTraits,
		planFileId,
		previousPermissionMode,
		wasPlanMode,
		changed,
	};
}

export async function exitNarratorPlanMode(narratorId: string): Promise<PlanModeStateResult> {
	const current = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			previousPermissionMode: true,
			planFileId: true,
			planMode: true,
			traits: true,
		},
	});
	const currentTraits = parseTraits(current?.traits);
	const wasPlanMode = currentTraits.includes("plan");
	const nextTraits = wasPlanMode ? removeTrait(currentTraits, "plan") : currentTraits;
	const changed =
		wasPlanMode ||
		current?.planMode !== false ||
		!!current?.previousPermissionMode ||
		!!current?.planFileId;

	if (changed) {
		await db
			.update(narrators)
			.set({
				traits: nextTraits,
				planMode: false,
				previousPermissionMode: null,
				planFileId: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, narratorId));
	}

	return {
		traits: nextTraits,
		wasPlanMode,
		changed,
	};
}
