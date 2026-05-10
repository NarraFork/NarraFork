import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorGoals, narrators } from "../db/schema";
import { narratorTraitsLock } from "../lib/async-mutex";
import { addTrait, parseTraits, removeTrait } from "../lib/narrator-utils";
import { generateWordSlug } from "../lib/words";

export interface PlanModeStateResult {
	traits: string[];
	planFileId?: string;
	previousPermissionMode?: string;
	wasPlanMode: boolean;
	changed: boolean;
	relaxedPlan: boolean;
	relaxedPlanChanged: boolean;
	activeGoalId?: string;
}

export interface EnterPlanModeOptions {
	/** Auto-enable relaxed plan when an agent enters plan mode while pursuing an active goal. */
	autoRelaxedPlanForActiveGoal?: boolean;
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

export async function enterNarratorPlanMode(
	narratorId: string,
	options: EnterPlanModeOptions = {},
): Promise<PlanModeStateResult> {
	return narratorTraitsLock.acquire(narratorId, async () => {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: {
				permissionMode: true,
				previousPermissionMode: true,
				planFileId: true,
				planMode: true,
				relaxedPlan: true,
				traits: true,
			},
		});
		const currentTraits = parseTraits(current?.traits);
		const wasPlanMode = currentTraits.includes("plan");
		const previousPermissionMode =
			current?.previousPermissionMode ?? current?.permissionMode ?? "default";
		const planFileId = current?.planFileId ?? generatePlanFileId();
		const nextTraits = wasPlanMode ? currentTraits : addTrait(currentTraits, "plan");
		const activeGoal =
			options.autoRelaxedPlanForActiveGoal && !current?.relaxedPlan
				? await db.query.narratorGoals.findFirst({
						where: and(
							eq(narratorGoals.narratorId, narratorId),
							eq(narratorGoals.status, "active"),
						),
						columns: { id: true },
					})
				: null;
		const relaxedPlanChanged = !!activeGoal;
		const relaxedPlan = current?.relaxedPlan || relaxedPlanChanged;
		const changed =
			!wasPlanMode || current?.planMode !== true || !current?.planFileId || relaxedPlanChanged;

		if (changed) {
			await db
				.update(narrators)
				.set({
					traits: nextTraits,
					planMode: true,
					previousPermissionMode,
					planFileId,
					...(relaxedPlanChanged ? { relaxedPlan: true } : {}),
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
			relaxedPlan,
			relaxedPlanChanged,
			activeGoalId: activeGoal?.id,
		};
	});
}

export async function exitNarratorPlanMode(narratorId: string): Promise<PlanModeStateResult> {
	return narratorTraitsLock.acquire(narratorId, async () => {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: {
				previousPermissionMode: true,
				planFileId: true,
				planMode: true,
				relaxedPlan: true,
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
			relaxedPlan: !!current?.relaxedPlan,
			relaxedPlanChanged: false,
		};
	});
}
