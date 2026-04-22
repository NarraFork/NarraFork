import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, overseers, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	buildOverseerSystemPrompt,
	getOverseerTitle,
	type Locale,
	type OverseerScope as OverseerScopeI18n,
} from "../lib/prompt-i18n";
import { resolveEffectiveModel, settings } from "../lib/settings";

// === Types ===

export type OverseerScope = OverseerScopeI18n;

export interface OverseerPolicy {
	handleEvents: {
		permissionRequests: boolean;
		loopDone: boolean;
		errors: boolean;
	};
	decisionTimeoutSec: number;
}

const DEFAULT_POLICY: OverseerPolicy = {
	handleEvents: {
		permissionRequests: true,
		loopDone: false,
		errors: false,
	},
	decisionTimeoutSec: 120,
};

export type Overseer = typeof overseers.$inferSelect;

// === CRUD ===

export async function createOverseer(input: {
	scope: OverseerScope;
	projectId?: string;
	model?: string;
	systemPrompt?: string;
	policy?: Partial<OverseerPolicy>;
	locale?: Locale;
}): Promise<Overseer> {
	// Validate scope constraints
	if (input.scope === "project") {
		if (!input.projectId) {
			throw new ValidationError("projectId is required for project-scoped overseer");
		}
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, input.projectId),
			columns: { id: true },
		});
		if (!project) throw new NotFoundError("Project", input.projectId ?? "unknown");

		// Check uniqueness: one per project
		const existing = await db.query.overseers.findFirst({
			where: and(eq(overseers.scope, "project"), eq(overseers.projectId, input.projectId)),
		});
		if (existing) {
			throw new ValidationError("This project already has an overseer");
		}
	} else {
		// Global: check uniqueness
		const existing = await db.query.overseers.findFirst({
			where: eq(overseers.scope, "global"),
		});
		if (existing) {
			throw new ValidationError("A global overseer already exists");
		}
	}

	const now = new Date().toISOString();
	const narratorId = generateId();
	const overseerId = generateId();

	const effectiveModel = input.model ?? resolveEffectiveModel(settings.agent?.defaultModel);

	// Resolve project name for prompt
	let projectName: string | undefined;
	if (input.scope === "project" && input.projectId) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, input.projectId),
			columns: { name: true },
		});
		projectName = project?.name;
	}

	const defaultPrompt = buildOverseerSystemPrompt(input.scope, input.locale ?? "en", projectName);

	const locale = input.locale ?? "en";

	// Create the narrator (standalone, no chapter)
	await db.insert(narrators).values({
		id: narratorId,
		type: "primary",
		title: getOverseerTitle(input.scope, locale, projectName),
		model: effectiveModel,
		systemPrompt: input.systemPrompt ?? defaultPrompt,
		permissionMode: "bypassPermissions",
		status: "idle",
		inheritMode: "fresh",
		createdAt: now,
		updatedAt: now,
	});

	const policy: OverseerPolicy = {
		...DEFAULT_POLICY,
		...input.policy,
		handleEvents: {
			...DEFAULT_POLICY.handleEvents,
			...input.policy?.handleEvents,
		},
	};

	const overseer: typeof overseers.$inferInsert = {
		id: overseerId,
		narratorId,
		scope: input.scope,
		projectId: input.scope === "project" ? (input.projectId ?? null) : null,
		enabled: input.scope === "project", // global overseer defaults to disabled
		policyJson: policy,
		createdAt: now,
		updatedAt: now,
	};

	await db.insert(overseers).values(overseer);

	eventBus.emit({
		type: "overseer:created",
		overseerId,
		scope: input.scope,
		projectId: input.projectId,
	});

	const created = await db.query.overseers.findFirst({
		where: eq(overseers.id, overseerId),
	});
	return created as typeof overseers.$inferSelect;
}

export async function getOverseer(id: string): Promise<Overseer> {
	const overseer = await db.query.overseers.findFirst({
		where: eq(overseers.id, id),
	});
	if (!overseer) throw new NotFoundError("Overseer", id);
	return overseer;
}

export async function getOverseerWithNarrator(id: string) {
	const overseer = await db.query.overseers.findFirst({
		where: eq(overseers.id, id),
		with: { narrator: true, project: { columns: { id: true, name: true } } },
	});
	if (!overseer) throw new NotFoundError("Overseer", id);
	return overseer;
}

export async function listOverseers(filter?: { scope?: OverseerScope; projectId?: string }) {
	const conditions = [];
	if (filter?.scope) conditions.push(eq(overseers.scope, filter.scope));
	if (filter?.projectId) conditions.push(eq(overseers.projectId, filter.projectId));

	return db.query.overseers.findMany({
		where: conditions.length > 0 ? and(...conditions) : undefined,
		with: { narrator: { columns: { id: true, title: true, status: true, model: true } } },
	});
}

export async function updateOverseer(
	id: string,
	input: {
		enabled?: boolean;
		policy?: Partial<OverseerPolicy>;
		model?: string;
		systemPrompt?: string;
	},
): Promise<Overseer> {
	const existing = await getOverseer(id);
	const now = new Date().toISOString();

	// Update overseer fields
	const overseerUpdate: Record<string, unknown> = { updatedAt: now };
	if (input.enabled !== undefined) {
		overseerUpdate.enabled = input.enabled;
	}
	if (input.policy) {
		const currentPolicy = (existing.policyJson as OverseerPolicy) ?? DEFAULT_POLICY;
		overseerUpdate.policyJson = {
			...currentPolicy,
			...input.policy,
			handleEvents: {
				...currentPolicy.handleEvents,
				...input.policy.handleEvents,
			},
		};
	}

	await db.update(overseers).set(overseerUpdate).where(eq(overseers.id, id));

	// Update narrator fields if provided
	if (input.model !== undefined || input.systemPrompt !== undefined) {
		const narratorUpdate: Record<string, unknown> = { updatedAt: now };
		if (input.model !== undefined) narratorUpdate.model = input.model;
		if (input.systemPrompt !== undefined) narratorUpdate.systemPrompt = input.systemPrompt;
		await db.update(narrators).set(narratorUpdate).where(eq(narrators.id, existing.narratorId));
	}

	// Emit enable/disable events
	if (input.enabled === true) eventBus.emit({ type: "overseer:enabled", overseerId: id });
	if (input.enabled === false) eventBus.emit({ type: "overseer:disabled", overseerId: id });

	return getOverseer(id);
}

export async function deleteOverseer(id: string): Promise<void> {
	const existing = await getOverseer(id);
	const wasGlobal = existing.scope === "global";

	// Archive the associated narrator
	await db
		.update(narrators)
		.set({ status: "archived", updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, existing.narratorId));

	await db.delete(overseers).where(eq(overseers.id, id));

	eventBus.emit({ type: "overseer:deleted", overseerId: id });

	// Global overseer: immediately create a fresh replacement (disabled)
	if (wasGlobal) {
		await createOverseer({ scope: "global" });
	}
}

/**
 * Ensure a global overseer exists. Called at server startup.
 * If none exists, creates one (disabled by default).
 */
export async function ensureGlobalOverseer(): Promise<void> {
	const existing = await db.query.overseers.findFirst({
		where: eq(overseers.scope, "global"),
	});
	if (existing) return;
	await createOverseer({ scope: "global" });
}

// === Core: find responsible overseer (bubble-up) ===

/**
 * Find the overseer responsible for handling events from a given narrator.
 * Implements the bubble-up mechanism:
 *   1. Project-level overseer (if narrator belongs to a chapter in a project)
 *   2. Global overseer
 *
 * Returns null if no active overseer is found (falls back to user).
 *
 * Excludes:
 * - The narrator itself (overseer can't handle its own events)
 * - Overseers whose narrator is not in a usable state
 * - Disabled overseers
 */
export async function findResponsibleOverseer(
	narratorId: string,
): Promise<(Overseer & { narrator: typeof narrators.$inferSelect }) | null> {
	// Resolve the narrator's project context
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true, chapterId: true, parentNarratorId: true },
	});
	if (!narrator) return null;

	// For subagents, trace up to the root narrator to get the real context
	let effectiveNarratorId = narratorId;
	let chapterId = narrator.chapterId;
	if (narrator.parentNarratorId) {
		// Walk up the parent chain to find the root narrator
		let current = narrator;
		while (current.parentNarratorId) {
			const parent = await db.query.narrators.findFirst({
				where: eq(narrators.id, current.parentNarratorId),
				columns: { id: true, chapterId: true, parentNarratorId: true },
			});
			if (!parent) break;
			current = parent;
		}
		effectiveNarratorId = current.id;
		chapterId = current.chapterId;
	}

	let projectId: string | null = null;
	if (chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, chapterId),
			columns: { projectId: true },
		});
		projectId = chapter?.projectId ?? null;
	}

	// 1. Try project-level overseer
	if (projectId) {
		const projectOverseer = await db.query.overseers.findFirst({
			where: and(
				eq(overseers.scope, "project"),
				eq(overseers.projectId, projectId),
				eq(overseers.enabled, true),
			),
			with: { narrator: true },
		});
		if (projectOverseer && isOverseerUsable(projectOverseer, effectiveNarratorId)) {
			return projectOverseer;
		}
	}

	// 2. Try global overseer
	const globalOverseer = await db.query.overseers.findFirst({
		where: and(eq(overseers.scope, "global"), eq(overseers.enabled, true)),
		with: { narrator: true },
	});
	if (globalOverseer && isOverseerUsable(globalOverseer, effectiveNarratorId)) {
		return globalOverseer;
	}

	return null;
}

/** Check if an overseer is usable for handling events from a given narrator */
function isOverseerUsable(
	overseer: Overseer & { narrator: typeof narrators.$inferSelect },
	sourceNarratorId: string,
): boolean {
	// Can't handle own events
	if (overseer.narratorId === sourceNarratorId) return false;

	// Narrator must be in a usable state
	const usableStatuses = new Set(["idle", "working", "waiting"]);
	if (!usableStatuses.has(overseer.narrator.status)) return false;

	return true;
}

/** Get the policy for an overseer, with defaults applied */
export function getOverseerPolicy(overseer: Overseer): OverseerPolicy {
	const raw = overseer.policyJson as Partial<OverseerPolicy> | null;
	if (!raw) return DEFAULT_POLICY;
	return {
		...DEFAULT_POLICY,
		...raw,
		handleEvents: {
			...DEFAULT_POLICY.handleEvents,
			...raw.handleEvents,
		},
	};
}

// === Managed narrators ===

/** List all narrators within an overseer's jurisdiction */
export async function listManagedNarrators(overseerId: string) {
	const overseer = await getOverseer(overseerId);

	if (overseer.scope === "project" && overseer.projectId) {
		// Project-scoped: narrators belonging to chapters in this project
		const projectChapters = await db.query.chapters.findMany({
			where: eq(chapters.projectId, overseer.projectId),
			columns: { id: true },
		});
		const chapterIds = projectChapters.map((c) => c.id);
		if (chapterIds.length === 0) return [];

		const result = await db.query.narrators.findMany({
			where: eq(narrators.variant, "primary"),
			columns: {
				id: true,
				title: true,
				status: true,
				chapterId: true,
				model: true,
			},
		});

		// Filter in JS: exclude overseer's own narrator, keep only project chapters
		const chapterIdSet = new Set(chapterIds);
		return result.filter(
			(n) => n.id !== overseer.narratorId && n.chapterId && chapterIdSet.has(n.chapterId),
		);
	}

	// Global: all primary narrators except the overseer's own
	const result = await db.query.narrators.findMany({
		where: eq(narrators.variant, "primary"),
		columns: {
			id: true,
			title: true,
			status: true,
			chapterId: true,
			model: true,
		},
	});
	return result.filter((n) => n.id !== overseer.narratorId);
}

/** Get decision history for an overseer */
export async function getOverseerDecisions(overseerId: string, limit = 50) {
	const overseer = await getOverseer(overseerId);
	const { narratorToolCalls } = await import("../db/schema");

	return db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.permissionOverseerNarratorId, overseer.narratorId),
		orderBy: (tc, { desc }) => [desc(tc.createdAt)],
		limit,
		columns: {
			id: true,
			narratorId: true,
			toolName: true,
			toolUseId: true,
			permissionDecidedBy: true,
			permissionDecidedAt: true,
			permissionDenyMessage: true,
			status: true,
			createdAt: true,
		},
	});
}

// === Auto-replace overseer when its narrator is archived ===

/**
 * When an overseer's narrator is archived, delete the overseer record and
 * create a fresh replacement that inherits scope, projectId and policy.
 * This mirrors the replacement logic already present in `deleteOverseer`
 * for the global scope, but generalises it to project-scoped overseers too.
 */
eventBus.on("narrator:status_changed", async (event) => {
	if (event.status !== "archived") return;

	const overseer = await db.query.overseers.findFirst({
		where: eq(overseers.narratorId, event.narratorId),
	});
	if (!overseer) return;

	logger.info("Overseer narrator archived, creating replacement", {
		overseerId: overseer.id,
		scope: overseer.scope,
		projectId: overseer.projectId,
	});

	const savedPolicy = overseer.policyJson as OverseerPolicy | null;
	const savedScope = overseer.scope as OverseerScope;
	const savedProjectId = overseer.projectId;
	const wasEnabled = overseer.enabled;

	// Read the old narrator's model and systemPrompt so the replacement inherits them
	const oldNarrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, event.narratorId),
		columns: { model: true, systemPrompt: true },
	});

	const oldOverseerId = overseer.id;

	// Remove the old overseer record (narrator is already archived)
	await db.delete(overseers).where(eq(overseers.id, overseer.id));
	eventBus.emit({ type: "overseer:deleted", overseerId: overseer.id });

	// Create a fresh replacement, inheriting model and systemPrompt from the old narrator
	const replacement = await createOverseer({
		scope: savedScope,
		projectId: savedProjectId ?? undefined,
		policy: savedPolicy ?? undefined,
		model: oldNarrator?.model ?? undefined,
		systemPrompt: oldNarrator?.systemPrompt ?? undefined,
	});

	// Restore enabled state — createOverseer defaults global to disabled,
	// project to enabled, so we explicitly sync the original value.
	if (replacement.enabled !== wasEnabled) {
		await updateOverseer(replacement.id, { enabled: wasEnabled });
	}

	eventBus.emit({
		type: "overseer:replaced",
		oldOverseerId,
		newOverseerId: replacement.id,
		scope: savedScope,
		projectId: savedProjectId,
	});
});
