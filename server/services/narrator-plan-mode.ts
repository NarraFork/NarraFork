import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narrators, narratorToolCalls } from "../db/schema";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { shouldDisablePlanReflectionReview } from "../lib/agent/tools/plan-mode";
import { AsyncMutex, narratorTraitsLock } from "../lib/async-mutex";
import {
	measureSerializedCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import { AppError, NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { addTrait, parseTraits, removeTrait } from "../lib/narrator-utils";
import { forcesRelaxedPlan, resolveEffectiveRelaxedPlan } from "../lib/permission-modes";
import {
	buildPlanFileRelPath,
	type PlanFileBinding,
	resolveExistingPlanFileRelPath,
	type WorkspaceFileAccess,
} from "../lib/plan-file-path";
import { generateWordSlug } from "../lib/words";
import type { PreparedPlanMode } from "./narrator-session-state";
import { workspaceContextService } from "./workspace-context-service";
import { createNarratorWorkspaceFileAccess } from "./workspace-file-access";

/** Maximum UTF-8 byte length reserved for the human-readable plan_name prefix. */
export const PLAN_NAME_MAX_BYTES = 48;
/** Fixed alphanumeric entropy suffix appended to every plan identity. */
export const PLAN_ID_RANDOM_SUFFIX_LENGTH = 16;
const PLAN_ID_SEPARATOR = "--";

/** IDs allocated in this process remain reserved even after a failed/aborted cycle. */
const reservedPlanFileIds = new Set<string>();
/** Prepared identities are one-shot inputs; they cannot be reused after commit/failure. */
const pendingPlanFileIds = new Set<string>();
/** Pending identities grouped by narrator so an exited cycle can invalidate leftovers. */
const pendingPlanFileIdsByNarrator = new Map<string, Set<string>>();
const pendingPlanFileRecords = new Map<
	string,
	{ narratorId: string; toolCallId: string; toolUseId: string; planFileBinding?: PlanFileBinding }
>();
const planFileIdentityLock = new AsyncMutex();

function markPendingPlanFileId(
	narratorId: string,
	planFileId: string,
	toolCallId: string,
	toolUseId: string,
	planFileBinding?: PlanFileBinding,
): void {
	pendingPlanFileIds.add(planFileId);
	pendingPlanFileRecords.set(planFileId, { narratorId, toolCallId, toolUseId, planFileBinding });
	const ids = pendingPlanFileIdsByNarrator.get(narratorId) ?? new Set<string>();
	ids.add(planFileId);
	pendingPlanFileIdsByNarrator.set(narratorId, ids);
}

function consumePendingPlanFileId(narratorId: string, planFileId: string): void {
	pendingPlanFileIds.delete(planFileId);
	pendingPlanFileRecords.delete(planFileId);
	const ids = pendingPlanFileIdsByNarrator.get(narratorId);
	if (!ids) return;
	ids.delete(planFileId);
	if (ids.size === 0) pendingPlanFileIdsByNarrator.delete(narratorId);
}

function clearPendingPlanFileIds(narratorId: string): void {
	const ids = pendingPlanFileIdsByNarrator.get(narratorId);
	if (!ids) return;
	for (const planFileId of ids) {
		pendingPlanFileIds.delete(planFileId);
		pendingPlanFileRecords.delete(planFileId);
	}
	pendingPlanFileIdsByNarrator.delete(narratorId);
}

async function isPendingPlanFileIdUsable(narratorId: string, planFileId: string): Promise<boolean> {
	if (!pendingPlanFileIds.has(planFileId)) return false;
	const record = pendingPlanFileRecords.get(planFileId);
	if (!record || record.narratorId !== narratorId) {
		if (record?.narratorId) consumePendingPlanFileId(record.narratorId, planFileId);
		return false;
	}
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.id, record.toolCallId),
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, record.toolUseId),
			eq(narratorToolCalls.toolName, "EnterPlanMode"),
		),
		columns: { status: true },
	});
	if (!toolCall || !["initializing", "pending", "running"].includes(toolCall.status)) {
		consumePendingPlanFileId(narratorId, planFileId);
		return false;
	}
	return true;
}

export interface PlanModeStateResult {
	traits: string[];
	planFileId?: string;
	planFilePath?: string;
	planFileBinding?: import("../lib/plan-file-path").PlanFileBinding;
	previousPermissionMode?: string;
	wasPlanMode: boolean;
	changed: boolean;
	relaxedPlan: boolean;
	relaxedPlanChanged: boolean;
	planReflectionDisabled?: boolean;
}

export interface PlanModeWorkspaceOptions {
	userId?: string | null;
	signal?: AbortSignal;
	workspaceContext?: WorkspaceContext;
	fileAccess?: WorkspaceFileAccess;
}

export interface EnterPlanModeToolResultCommit {
	output: unknown;
	durationMs?: number;
	permissionStartedAt?: number;
	executionStartedAt?: number;
	completedAt?: number;
	brokenInputOverride?: Record<string, unknown>;
	updatedInput?: Record<string, unknown>;
}

function truncateUtf8(value: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function generatePlanIdentitySuffix(): string {
	// nanoid is cryptographically random, but its URL alphabet includes '-'/'_'.
	// Keep the suffix fixed-width and alphanumeric so the plan prefix is unambiguous.
	return generateId(PLAN_ID_RANDOM_SUFFIX_LENGTH).replace(/[^A-Za-z0-9]/g, "0");
}

function generatePlanFileId(): string {
	return `${generateWordSlug()}${PLAN_ID_SEPARATOR}${generatePlanIdentitySuffix()}`;
}

/**
 * Sanitize a user-provided plan name to a safe, readable file prefix.
 * Unicode letters/numbers are retained; path separators and other punctuation
 * become a single dash, then the prefix is truncated on UTF-8 code-point
 * boundaries so a multi-byte character can never be split.
 */
function sanitizePlanName(name: string): string | null {
	const normalized = name.normalize("NFKC").trim().toLocaleLowerCase();
	const sanitized = normalized
		.replace(/[^\p{L}\p{N}\p{M}_-]+/gu, "-")
		.replace(/[-_]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const truncated = truncateUtf8(sanitized, PLAN_NAME_MAX_BYTES).replace(/-+$/g, "");
	return truncated || null;
}

function isSafePlanFileId(value: string | null | undefined): value is string {
	return (
		!!value && Buffer.byteLength(value, "utf8") <= 256 && /^[\p{L}\p{N}\p{M}_-]+$/u.test(value)
	);
}

async function isPlanFileIdTaken(planFileId: string): Promise<boolean> {
	if (reservedPlanFileIds.has(planFileId)) return true;
	const existing = await db.query.narrators.findFirst({
		where: eq(narrators.planFileId, planFileId),
		columns: { id: true },
	});
	return !!existing;
}

/**
 * Generate a unique plan file ID. `plan_name` is only a readable prefix; every
 * identity receives a fresh random suffix. Active DB identities and identities
 * allocated earlier in this process are both treated as reserved.
 */
async function allocateUniquePlanFileId(customName?: string): Promise<string> {
	const prefix = customName ? sanitizePlanName(customName) : null;
	for (let attempt = 0; attempt < 32; attempt++) {
		const candidate = prefix
			? `${prefix}${PLAN_ID_SEPARATOR}${generatePlanIdentitySuffix()}`
			: generatePlanFileId();
		if (await isPlanFileIdTaken(candidate)) continue;
		reservedPlanFileIds.add(candidate);
		return candidate;
	}
	throw new Error("Unable to allocate a unique plan file identity");
}

async function generateUniquePlanFileId(customName?: string): Promise<string> {
	return planFileIdentityLock.acquire("plan-file-identities", () =>
		allocateUniquePlanFileId(customName),
	);
}

export async function ensureNarratorPlanFileId(
	narratorId: string,
	existingPlanFileId?: string | null,
	customPlanName?: string,
): Promise<string> {
	return planFileIdentityLock.acquire("plan-file-identities", async () => {
		if (isSafePlanFileId(existingPlanFileId)) {
			reservedPlanFileIds.add(existingPlanFileId);
			return existingPlanFileId;
		}
		const planFileId = await allocateUniquePlanFileId(customPlanName);
		await db
			.update(narrators)
			.set({ planFileId, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
		return planFileId;
	});
}

/**
 * Prepare an EnterPlanMode call without changing durable narrator state.
 * The returned identity is committed only after the matching tool_result succeeds.
 */
export async function prepareNarratorPlanMode(
	narratorId: string,
	toolCallId: string,
	toolUseId: string,
	customPlanName?: string,
	options: PlanModeWorkspaceOptions = {},
): Promise<PreparedPlanMode> {
	return narratorTraitsLock.acquire(narratorId, async () => {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: {
				permissionMode: true,
				previousPermissionMode: true,
				planFileId: true,
				planFileBinding: true,
				workspaceContext: true,
				workspaceRevision: true,
				planMode: true,
				traits: true,
			},
		});
		const currentIsPlanMode =
			current?.planMode === true || parseTraits(current?.traits).includes("plan");
		const durablePlanFileId =
			currentIsPlanMode && isSafePlanFileId(current?.planFileId) ? current.planFileId : undefined;
		if (durablePlanFileId) reservedPlanFileIds.add(durablePlanFileId);
		options.signal?.throwIfAborted();
		const planFileId = durablePlanFileId ?? (await generateUniquePlanFileId(customPlanName));
		const savedBinding =
			current?.planFileBinding?.planFileId === planFileId ? current.planFileBinding : undefined;
		if (durablePlanFileId && !savedBinding && (current?.workspaceRevision ?? 0) > 0)
			throw new AppError(
				"Original plan source is unknown after a workspace switch; exit plan mode and explicitly start a new cycle",
				409,
				"PLAN_SOURCE_UNAVAILABLE",
			);
		const workspace =
			options.workspaceContext ??
			(current?.workspaceContext?.revision === current?.workspaceRevision
				? current?.workspaceContext
				: undefined);
		const planFileBinding = savedBinding
			? structuredClone(savedBinding)
			: workspace
				? {
						workspaceContext: structuredClone(workspace),
						planFileId,
						planFilePath: buildPlanFileRelPath(planFileId),
					}
				: undefined;
		if (!durablePlanFileId)
			markPendingPlanFileId(narratorId, planFileId, toolCallId, toolUseId, planFileBinding);
		return {
			toolCallId,
			toolUseId,
			planFileId,
			planFilePath: planFileBinding?.planFilePath ?? buildPlanFileRelPath(planFileId),
			planFileBinding,
			previousPermissionMode:
				current?.previousPermissionMode ?? current?.permissionMode ?? "default",
		};
	});
}

/**
 * Commit a successful EnterPlanMode tool result and its narrator plan state together.
 * If either write fails, the SQLite transaction rolls both back.
 */
export async function commitPreparedEnterPlanModeResult(
	narratorId: string,
	prepared: PreparedPlanMode,
	result: EnterPlanModeToolResultCommit,
): Promise<PlanModeStateResult> {
	return narratorTraitsLock.acquire(narratorId, async () => {
		const state = db.transaction((tx) => {
			const current = tx.query.narrators
				.findFirst({
					where: eq(narrators.id, narratorId),
					columns: {
						permissionMode: true,
						previousPermissionMode: true,
						planFileId: true,
						planFileBinding: true,
						planMode: true,
						relaxedPlan: true,
						traits: true,
					},
				})
				.sync();
			if (!current) throw new Error(`Narrator not found: ${narratorId}`);
			const currentIsPlanMode =
				current.planMode === true || parseTraits(current.traits).includes("plan");
			const currentPlanFileId =
				currentIsPlanMode && isSafePlanFileId(current.planFileId) ? current.planFileId : undefined;
			if (
				currentPlanFileId !== prepared.planFileId &&
				!pendingPlanFileIds.has(prepared.planFileId)
			) {
				throw new Error(`Stale EnterPlanMode identity: ${prepared.planFileId}`);
			}

			const toolCall = tx.query.narratorToolCalls
				.findFirst({
					where: and(
						eq(narratorToolCalls.id, prepared.toolCallId),
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.toolUseId, prepared.toolUseId),
						eq(narratorToolCalls.toolName, "EnterPlanMode"),
					),
					columns: { id: true, messageId: true, status: true, inputJson: true },
				})
				.sync();
			if (!toolCall || !["initializing", "pending", "running"].includes(toolCall.status)) {
				throw new Error(`Stale EnterPlanMode tool call: ${prepared.toolCallId}`);
			}

			const currentTraits = parseTraits(current.traits);
			const wasPlanMode = current.planMode === true || currentTraits.includes("plan");
			const nextTraits = currentTraits.includes("plan")
				? currentTraits
				: addTrait(currentTraits, "plan");
			const previousPermissionMode =
				current.previousPermissionMode ?? current.permissionMode ?? prepared.previousPermissionMode;
			// A valid durable identity always wins. This makes concurrent prepared calls
			// converge on the first committed plan file without persisting a path-bearing ID.
			const planFileId = currentPlanFileId ?? prepared.planFileId;
			const planFileBinding =
				current.planFileBinding?.planFileId === planFileId
					? current.planFileBinding
					: prepared.planFileBinding?.planFileId === planFileId
						? prepared.planFileBinding
						: undefined;
			const relaxedPlan = resolveEffectiveRelaxedPlan(current.permissionMode, current.relaxedPlan);
			const relaxedPlanChanged = relaxedPlan !== current.relaxedPlan;
			const changed =
				!wasPlanMode ||
				current.planMode !== true ||
				current.planFileId !== planFileId ||
				relaxedPlanChanged;
			const now = new Date().toISOString();
			const completedAt =
				typeof result.completedAt === "number" ? new Date(result.completedAt).toISOString() : now;
			const inputOverride = result.brokenInputOverride ?? result.updatedInput;
			// Read the exact call's effective input, not the shared prepared plan identity.
			// Commit the override atomically: failed/denied calls must not alter reflection.
			const effectiveInput = inputOverride ?? toolCall.inputJson;
			const planReflectionDisabled =
				typeof effectiveInput === "object" &&
				effectiveInput !== null &&
				"disableReflectionReview" in effectiveInput &&
				shouldDisablePlanReflectionReview(effectiveInput.disableReflectionReview);

			tx.update(narratorToolCalls)
				.set({
					...(inputOverride
						? { inputJson: inputOverride, inputChars: measureSerializedCharacters(inputOverride) }
						: {}),
					outputJson: result.output ?? null,
					outputChars: measureSerializedCharacters(result.output ?? null),
					status: "success",
					durationMs: result.durationMs ?? null,
					permissionStartedAt:
						typeof result.permissionStartedAt === "number"
							? new Date(result.permissionStartedAt).toISOString()
							: undefined,
					executionStartedAt:
						typeof result.executionStartedAt === "number"
							? new Date(result.executionStartedAt).toISOString()
							: undefined,
					completedAt,
					errorMessage: null,
				})
				.where(eq(narratorToolCalls.id, toolCall.id))
				.run();
			tx.update(narrators)
				.set({
					traits: nextTraits,
					planMode: true,
					previousPermissionMode,
					planFileId,
					planFileBinding: planFileBinding ?? null,
					relaxedPlan,
					...(planReflectionDisabled ? { planReflectionAutoApproveOverride: "off" as const } : {}),
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			return {
				contextMessageId: toolCall.messageId,
				traits: nextTraits,
				planFileId,
				planFilePath: planFileBinding?.planFilePath ?? buildPlanFileRelPath(planFileId),
				planFileBinding,
				previousPermissionMode,
				wasPlanMode,
				changed,
				relaxedPlan,
				relaxedPlanChanged,
				planReflectionDisabled,
			};
		});
		// The in-memory identity is consumed only after SQLite commits. A transaction
		// failure leaves it pending so the same successful tool result can be retried.
		const { contextMessageId, ...resultState } = state;
		queueContextCharacterRefresh(narratorId, contextMessageId);
		consumePendingPlanFileId(narratorId, prepared.planFileId);
		return resultState;
	});
}

export async function enterNarratorPlanMode(
	narratorId: string,
	customPlanName?: string,
	preparedPlanFileId?: string,
	options: PlanModeWorkspaceOptions = {},
): Promise<PlanModeStateResult> {
	return narratorTraitsLock.acquire(narratorId, async () => {
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: {
				permissionMode: true,
				previousPermissionMode: true,
				planFileId: true,
				planFileBinding: true,
				workspaceRevision: true,
				planMode: true,
				relaxedPlan: true,
				traits: true,
			},
		});
		if (!current) throw new NotFoundError("Narrator", narratorId);
		options.signal?.throwIfAborted();
		const currentTraits = parseTraits(current.traits);
		const wasPlanMode = current.planMode === true || currentTraits.includes("plan");
		const previousPermissionMode =
			current?.previousPermissionMode ?? current?.permissionMode ?? "default";
		// Once an identity is durable it wins over any concurrently prepared slug.
		// A caller-supplied prepared ID is accepted only while it is still a one-shot
		// pending identity; stale IDs from an earlier cycle are never reused.
		const durablePlanFileId =
			wasPlanMode && isSafePlanFileId(current?.planFileId) ? current.planFileId : undefined;
		if (durablePlanFileId) reservedPlanFileIds.add(durablePlanFileId);
		const usablePreparedPlanFileId =
			preparedPlanFileId && (await isPendingPlanFileIdUsable(narratorId, preparedPlanFileId))
				? preparedPlanFileId
				: undefined;
		const planFileId =
			durablePlanFileId ??
			usablePreparedPlanFileId ??
			(await generateUniquePlanFileId(customPlanName));
		const savedBinding =
			current.planFileBinding?.planFileId === planFileId ? current.planFileBinding : undefined;
		const preparedBinding = usablePreparedPlanFileId
			? pendingPlanFileRecords.get(usablePreparedPlanFileId)?.planFileBinding
			: undefined;
		let planFileBinding = savedBinding
			? structuredClone(savedBinding)
			: preparedBinding?.planFileId === planFileId
				? structuredClone(preparedBinding)
				: undefined;
		if (!planFileBinding) {
			const workspace = options.workspaceContext
				? structuredClone(options.workspaceContext)
				: await workspaceContextService.get(narratorId, { userId: options.userId ?? null });
			if (!workspace.cwd || !targetPathSemantics(workspace.pathFlavor).isAbsolute(workspace.cwd))
				throw new AppError(
					"Configure a workspace before entering plan mode",
					409,
					"PLAN_SOURCE_UNAVAILABLE",
				);
			if (durablePlanFileId && workspace.revision > 0)
				throw new AppError(
					"Original plan source is unknown after a workspace switch; exit plan mode and explicitly start a new cycle",
					409,
					"PLAN_SOURCE_UNAVAILABLE",
				);
			let planFilePath = buildPlanFileRelPath(planFileId);
			if (durablePlanFileId) {
				const access =
					options.fileAccess ??
					createNarratorWorkspaceFileAccess(narratorId, workspace, {
						userId: options.userId ?? null,
						signal: options.signal,
					});
				planFilePath =
					(await resolveExistingPlanFileRelPath(workspace.cwd, planFileId, access)) ?? planFilePath;
			}
			planFileBinding = { workspaceContext: workspace, planFileId, planFilePath };
		}
		options.signal?.throwIfAborted();
		const nextTraits = wasPlanMode ? currentTraits : addTrait(currentTraits, "plan");
		// 全部允许权限下进入计划模式时，忽略默认宽松设置，始终启用宽松规划，防止阻塞。
		const relaxedPlanChanged = forcesRelaxedPlan(current?.permissionMode) && !current?.relaxedPlan;
		const relaxedPlan = resolveEffectiveRelaxedPlan(current?.permissionMode, current?.relaxedPlan);
		const changed =
			!wasPlanMode ||
			current.planMode !== true ||
			!durablePlanFileId ||
			relaxedPlanChanged ||
			!savedBinding;

		if (changed) {
			const updated = await db
				.update(narrators)
				.set({
					traits: nextTraits,
					planMode: true,
					previousPermissionMode,
					planFileId,
					planFileBinding,
					...(relaxedPlanChanged ? { relaxedPlan: true } : {}),
					updatedAt: new Date().toISOString(),
				})
				.where(
					savedBinding
						? eq(narrators.id, narratorId)
						: and(
								eq(narrators.id, narratorId),
								eq(narrators.workspaceRevision, planFileBinding.workspaceContext.revision),
							),
				)
				.returning({ id: narrators.id });
			if (updated.length !== 1)
				throw new AppError("Workspace changed while entering plan mode", 409, "WORKSPACE_STALE");
		}
		if (usablePreparedPlanFileId) consumePendingPlanFileId(narratorId, usablePreparedPlanFileId);

		const planFilePath = planFileBinding.planFilePath;

		return {
			traits: nextTraits,
			planFileId,
			planFilePath,
			planFileBinding,
			previousPermissionMode,
			wasPlanMode,
			changed,
			relaxedPlan,
			relaxedPlanChanged,
		};
	});
}

export async function exitNarratorPlanMode(narratorId: string): Promise<PlanModeStateResult> {
	return narratorTraitsLock.acquire(narratorId, async () => {
		// Any identities prepared for the just-finished cycle are stale after exit.
		clearPendingPlanFileIds(narratorId);
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: {
				previousPermissionMode: true,
				planFileId: true,
				planFileBinding: true,
				planMode: true,
				relaxedPlan: true,
				traits: true,
			},
		});
		const currentTraits = parseTraits(current?.traits);
		const wasPlanMode = current?.planMode === true || currentTraits.includes("plan");
		const nextTraits = currentTraits.includes("plan")
			? removeTrait(currentTraits, "plan")
			: currentTraits;
		const changed =
			wasPlanMode ||
			current?.planMode !== false ||
			!!current?.previousPermissionMode ||
			!!current?.planFileId ||
			!!current?.planFileBinding;

		if (changed) {
			await db
				.update(narrators)
				.set({
					traits: nextTraits,
					planMode: false,
					previousPermissionMode: null,
					planFileId: null,
					planFileBinding: null,
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
