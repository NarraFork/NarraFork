import { createHash } from "node:crypto";
import { db } from "@server/db";
import {
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	permissionRuleRequests,
} from "@server/db/schema";
import type { ToolCallBinding } from "@server/lib/agent/types";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { isPlanModeTrait } from "@server/lib/narrator-utils";
import { resolveEffectiveRelaxedPlan } from "@server/lib/permission-modes";
import { getSettingsRevision, settings } from "@server/lib/settings";
import {
	createBlacklistCmdSchema,
	createBlacklistDirSchema,
	createWhitelistCmdSchema,
	createWhitelistDirSchema,
} from "@server/lib/validators/narrators";
import { permissionRuleRequestResultSchema } from "@server/lib/validators/permission-rule-requests";
import type { PermissionRuleRequestResult } from "@shared/permission-rule-request";
import { and, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import { z } from "zod/v4";
import { executionPolicyEngine, executionPolicyRevision } from "./execution-policy/engine";
import { executionPolicyRepository } from "./execution-policy/repository";
import {
	createExecutionTargetContext,
	executionTargetContextKey,
} from "./execution-policy/target-context";
import type { ExecutionPermissionRule, ExecutionTargetContext } from "./execution-policy/types";
import {
	normalizePermissionRuleInput,
	PermissionRuleConflictError,
	permissionPolicyChanges,
	permissionRuleConflictKey,
	permissionRuleService,
} from "./permission-rule-service";

export const PERMISSION_RULE_REQUEST_TTL_MS = 300_000;
function requestExpired(createdAt: string): boolean {
	const started = Date.parse(createdAt);
	return !Number.isFinite(started) || Date.now() - started > PERMISSION_RULE_REQUEST_TTL_MS;
}

const common = {
	reason: z.string().trim().min(1).max(2000),
	scope: z.literal("narrator").default("narrator"),
	device: z.string().trim().min(1).max(200).optional(),
};
export const requestPermissionRuleSchema = z.discriminatedUnion("ruleType", [
	z
		.object({
			...common,
			ruleType: z.literal("directoryWhitelist"),
			...createWhitelistDirSchema.pick({ path: true, accessLevel: true }).shape,
		})
		.strict(),
	z
		.object({
			...common,
			ruleType: z.literal("directoryBlacklist"),
			...createBlacklistDirSchema.pick({ path: true, denyLevel: true }).shape,
		})
		.strict(),
	z
		.object({
			...common,
			ruleType: z.literal("commandWhitelist"),
			...createWhitelistCmdSchema.pick({ pattern: true }).shape,
		})
		.strict(),
	z
		.object({
			...common,
			ruleType: z.literal("commandBlacklist"),
			...createBlacklistCmdSchema.pick({ pattern: true, denyPrompt: true }).shape,
		})
		.strict(),
]);
export type PermissionRuleRequestInput = z.infer<typeof requestPermissionRuleSchema>;
export interface PermissionRuleRequestIdentity {
	narratorId: string;
	toolUseId: string;
	binding: ToolCallBinding;
}
export interface PreparedPermissionRuleRequest {
	requestId: string;
	proposalHash: string;
	input: PermissionRuleRequestInput;
	automatic: boolean;
	rule: ExecutionPermissionRule;
	contextRevision: string;
}
export class PermissionRuleRequestError extends AppError {
	constructor(message: string) {
		super(message, 409, "PERMISSION_RULE_REQUEST_CONFLICT");
	}
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
		.join(",")}}`;
}
function hash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const contextColumns = {
	id: narrators.id,
	permissionMode: narrators.permissionMode,
	relaxedPlan: narrators.relaxedPlan,
	cwd: narrators.cwd,
	workspaceRevision: narrators.workspaceRevision,
	contextProjectId: narrators.contextProjectId,
	parentNarratorId: narrators.parentNarratorId,
	defaultDeviceId: narrators.defaultDeviceId,
	variant: narrators.variant,
	traits: narrators.traits,
	oauthPolicySnapshotJson: narrators.oauthPolicySnapshotJson,
};
function loadIdentity(narratorId: string) {
	const row = db.select(contextColumns).from(narrators).where(eq(narrators.id, narratorId)).get();
	if (!row) throw new ValidationError("Narrator no longer exists");
	if (
		row.variant === "subagent:review" ||
		row.variant === "subagent:explore" ||
		row.variant === "subagent:plan" ||
		row.oauthPolicySnapshotJson
	) {
		throw new ValidationError(
			"Review/read-only/OAuth capability ceilings cannot request mutable policy",
		);
	}
	// readOnly/dontAsk are ordinary mode preferences: an explicit dedicated human
	// approval may add a scoped rule. Strict plan is a hard mutation boundary.
	if (
		isPlanModeTrait(row.traits) &&
		!resolveEffectiveRelaxedPlan(row.permissionMode, row.relaxedPlan)
	)
		throw new ValidationError("Strict plan capability ceiling cannot request mutable policy");
	return row;
}
async function liveRevision(
	identity: PermissionRuleRequestIdentity,
	context: ExecutionTargetContext,
) {
	const narrator = loadIdentity(identity.narratorId);
	const current = await createExecutionTargetContext({
		backend: context.backend,
		target: { ...context.target },
	});
	const policy = await executionPolicyRepository.load(identity.narratorId);
	return {
		narrator,
		revision: hash({
			narrator,
			target: executionTargetContextKey(current),
			policy: executionPolicyRevision(policy),
			settingsRevision: getSettingsRevision(),
		}),
	};
}
function assertBinding(
	identity: PermissionRuleRequestIdentity,
	store: Pick<typeof db, "select"> = db,
) {
	const row = store
		.select({
			id: narratorToolCalls.id,
			attempt: narratorToolCalls.executionAttempt,
			toolName: narratorToolCalls.toolName,
			version: narratorToolCalls.executionIdentityVersion,
			origin: narratorToolCalls.executionOriginToolCallId,
			decidedBy: narratorToolCalls.permissionDecidedBy,
			decidedAt: narratorToolCalls.permissionDecidedAt,
		})
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.id, identity.binding.toolCallId),
				eq(narratorToolCalls.narratorId, identity.narratorId),
				eq(narratorToolCalls.toolUseId, identity.toolUseId),
			),
		)
		.get();
	if (
		!row ||
		row.attempt !== identity.binding.attempt ||
		row.toolName !== "RequestPermissionRule" ||
		row.version !== 1 ||
		row.origin !== null
	)
		throw new PermissionRuleRequestError("Stale tool execution binding");
	return row;
}
export async function preparePermissionRuleRequest(
	identity: PermissionRuleRequestIdentity,
	raw: unknown,
	context: ExecutionTargetContext,
): Promise<PreparedPermissionRuleRequest> {
	assertBinding(identity);
	const input = requestPermissionRuleSchema.parse(raw);
	if (input.device && input.device !== context.target.deviceId)
		throw new ValidationError("Device differs from frozen execution target");
	if (context.paths.flavor === "spec" || ("path" in input && input.path.startsWith("spec://")))
		throw new ValidationError("Rules cannot target Dynamic Spec");
	input.device = context.target.deviceId;
	if ("path" in input)
		input.path =
			context.target.canonicalPath ??
			(
				await context.backend.resolvePathIdentity(
					context.paths.resolve(context.target.cwd, input.path),
				)
			).canonicalPath;
	const rule = normalizePermissionRuleInput({
		ruleType: input.ruleType,
		value: {
			...input,
			enabled: true,
			...("path" in input
				? { pathFlavor: context.paths.flavor, pathKey: context.paths.identityKey(input.path) }
				: {}),
			selector:
				context.target.deviceId === "local"
					? { kind: "host" }
					: { kind: "device", deviceId: context.target.deviceId },
		},
	} as Parameters<typeof normalizePermissionRuleInput>[0]);
	const state = await liveRevision(identity, context);
	const proposalHash = hash({ narratorId: identity.narratorId, input, rule });
	const requestId = `${identity.binding.toolCallId}:${identity.binding.attempt}`;
	const automatic =
		state.narrator.permissionMode === "bypassPermissions" &&
		settings.agent.permissionRuleAutoApprove === true;
	const now = new Date().toISOString();
	db.insert(permissionRuleRequests)
		.values({
			id: requestId,
			narratorId: identity.narratorId,
			toolCallId: identity.binding.toolCallId,
			toolUseId: identity.toolUseId,
			attempt: identity.binding.attempt,
			proposalJson: { input: { ...input }, rule: { ...rule } },
			proposalHash,
			reason: input.reason,
			scope: "narrator",
			deviceId: context.target.deviceId,
			contextRevision: state.revision,
			status: "pending",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.run();
	const stored = db
		.select()
		.from(permissionRuleRequests)
		.where(eq(permissionRuleRequests.id, requestId))
		.get();
	if (
		!stored ||
		stored.proposalHash !== proposalHash ||
		stored.contextRevision !== state.revision
	) {
		throw new PermissionRuleRequestError(
			"Request identity reused with a different proposal or context",
		);
	}
	return { requestId, proposalHash, input, automatic, rule, contextRevision: state.revision };
}

/** Confirm is a candidate only. No receipt exists until the loop completes normally. */
export function recordPermissionRuleRequestDecision(
	requestId: string,
	decision: "allow" | "deny",
	source: "user" | "reflection",
	userId?: string,
	conclusion?: string,
): boolean {
	if (source === "user" && !userId) return false;
	const row = db
		.select()
		.from(permissionRuleRequests)
		.where(eq(permissionRuleRequests.id, requestId))
		.get();
	if (!row || row.status !== "pending" || row.approvalSource || requestExpired(row.createdAt))
		return false;
	return db.transaction((tx) => {
		const now = new Date().toISOString();
		const changed = tx
			.update(permissionRuleRequests)
			.set({
				status: decision === "deny" ? "denied" : source === "user" ? "approved" : "pending",
				approvalSource: source,
				approvalUserId: userId ?? null,
				reflectionConclusion: conclusion?.trim().slice(0, 2000) ?? null,
				updatedAt: now,
			})
			.where(
				and(eq(permissionRuleRequests.id, requestId), eq(permissionRuleRequests.status, "pending")),
			)
			.returning({ id: permissionRuleRequests.id })
			.all();
		if (changed.length !== 1) return false;
		if (source === "user" || decision === "deny") {
			const audited = tx
				.update(narratorToolCalls)
				.set({
					status: decision === "allow" ? "running" : "fail",
					permissionDecidedBy: source,
					permissionDecidedAt: now,
					permissionDecisionReason: conclusion?.slice(0, 2000) ?? null,
				})
				.where(
					and(
						eq(narratorToolCalls.id, row.toolCallId),
						eq(narratorToolCalls.narratorId, row.narratorId),
						eq(narratorToolCalls.executionAttempt, row.attempt),
					),
				)
				.returning({ id: narratorToolCalls.id })
				.all();
			if (audited.length !== 1)
				throw new PermissionRuleRequestError("Approval lost its tool execution binding");
		}
		return true;
	});
}
export interface PermissionRuleReflectionCompletion {
	completedNormally: boolean;
	validToolDecision: boolean;
	usedTextFallback?: boolean;
}
export function completePermissionRuleRequestReflection(
	requestId: string,
	result: PermissionRuleReflectionCompletion,
): boolean {
	const row = db
		.select()
		.from(permissionRuleRequests)
		.where(eq(permissionRuleRequests.id, requestId))
		.get();
	if (!row || row.status !== "pending") return false;
	const approved =
		row.approvalSource === "reflection" &&
		result.completedNormally &&
		result.validToolDecision &&
		!result.usedTextFallback &&
		!requestExpired(row.createdAt);
	return db.transaction((tx) => {
		const now = new Date().toISOString();
		const changed = tx
			.update(permissionRuleRequests)
			.set({
				status: approved ? "approved" : "failed",
				approvalSource: "reflection",
				error: approved
					? null
					: "Strict reflection did not produce a valid completed tool decision",
				updatedAt: now,
			})
			.where(
				and(eq(permissionRuleRequests.id, requestId), eq(permissionRuleRequests.status, "pending")),
			)
			.returning({ id: permissionRuleRequests.id })
			.all();
		if (changed.length !== 1) return false;
		const audited = tx
			.update(narratorToolCalls)
			.set({
				status: approved ? "running" : "fail",
				permissionDecidedBy: "reflection",
				permissionDecidedAt: now,
				permissionDecisionReason: approved
					? "Strict rule-request reflection completed"
					: "Strict rule-request reflection failed",
			})
			.where(
				and(
					eq(narratorToolCalls.id, row.toolCallId),
					eq(narratorToolCalls.narratorId, row.narratorId),
					eq(narratorToolCalls.executionAttempt, row.attempt),
				),
			)
			.returning({ id: narratorToolCalls.id })
			.all();
		if (audited.length !== 1)
			throw new PermissionRuleRequestError("Reflection lost its tool execution binding");
		return approved;
	});
}
export interface PermissionRuleRequestTerminal {
	narratorId: string;
	toolCallId: string;
	attempt: number;
	status: "failed" | "cancelled";
	reason: string;
}

/** Exact-attempt terminal CAS. Does not invent a decision source or rewrite applied receipts. */
export function terminatePermissionRuleRequest(terminal: PermissionRuleRequestTerminal): boolean {
	return db.transaction((tx) => {
		const call = tx
			.select({ attempt: narratorToolCalls.executionAttempt })
			.from(narratorToolCalls)
			.where(
				and(
					eq(narratorToolCalls.id, terminal.toolCallId),
					eq(narratorToolCalls.narratorId, terminal.narratorId),
					eq(narratorToolCalls.toolName, "RequestPermissionRule"),
				),
			)
			.get();
		// A delayed completion belonging to an older attempt must not finish a retry.
		if (!call || call.attempt !== terminal.attempt) return false;
		return (
			tx
				.update(permissionRuleRequests)
				.set({
					status: terminal.status,
					error: terminal.reason.slice(0, 1000),
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(permissionRuleRequests.toolCallId, terminal.toolCallId),
						eq(permissionRuleRequests.narratorId, terminal.narratorId),
						eq(permissionRuleRequests.attempt, terminal.attempt),
						inArray(permissionRuleRequests.status, ["pending", "approved"]),
					),
				)
				.returning({ id: permissionRuleRequests.id })
				.all().length === 1
		);
	});
}

/** Bounded primary-key pages; the caller yields between pages during startup/expiry maintenance. */
export function recoverPermissionRuleRequests(options: {
	after?: string;
	limit?: number;
	reason: string;
	expiredOnly?: boolean;
}) {
	const limit = Number.isFinite(options.limit)
		? Math.max(1, Math.min(100, Math.trunc(options.limit as number)))
		: 100;
	const rows = db
		.select({
			id: permissionRuleRequests.id,
			narratorId: permissionRuleRequests.narratorId,
			toolCallId: permissionRuleRequests.toolCallId,
			attempt: permissionRuleRequests.attempt,
			status: permissionRuleRequests.status,
			createdAt: permissionRuleRequests.createdAt,
		})
		.from(permissionRuleRequests)
		.where(options.after ? gt(permissionRuleRequests.id, options.after) : undefined)
		.orderBy(permissionRuleRequests.id)
		.limit(limit)
		.all();
	let terminated = 0;
	for (const row of rows) {
		if (
			(row.status !== "pending" && row.status !== "approved") ||
			(options.expiredOnly && !requestExpired(row.createdAt))
		)
			continue;
		// Recovery also closes orphaned/obsolete attempts. Bind the REQUEST row exactly;
		// never touch its tool row, which may already belong to a newer retry.
		terminated += db
			.update(permissionRuleRequests)
			.set({
				status: "cancelled",
				error: options.reason.slice(0, 1000),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(permissionRuleRequests.id, row.id),
					eq(permissionRuleRequests.narratorId, row.narratorId),
					eq(permissionRuleRequests.toolCallId, row.toolCallId),
					eq(permissionRuleRequests.attempt, row.attempt),
					inArray(permissionRuleRequests.status, ["pending", "approved"]),
				),
			)
			.returning({ id: permissionRuleRequests.id })
			.all().length;
	}
	return { terminated, nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined };
}

export function failPermissionRuleRequest(
	requestId: string,
	error: string,
	narratorId?: string,
): void {
	db.transaction((tx) => {
		const now = new Date().toISOString();
		const rows = tx
			.update(permissionRuleRequests)
			.set({ status: "failed", error: error.slice(0, 1000), updatedAt: now })
			.where(
				and(
					eq(permissionRuleRequests.id, requestId),
					narratorId ? eq(permissionRuleRequests.narratorId, narratorId) : undefined,
					inArray(permissionRuleRequests.status, ["pending", "approved"]),
				),
			)
			.returning({
				toolCallId: permissionRuleRequests.toolCallId,
				narratorId: permissionRuleRequests.narratorId,
				attempt: permissionRuleRequests.attempt,
			})
			.all();
		const row = rows[0];
		if (row)
			tx.update(narratorToolCalls)
				.set({ status: "fail", errorMessage: error.slice(0, 1000) })
				.where(
					and(
						eq(narratorToolCalls.id, row.toolCallId),
						eq(narratorToolCalls.narratorId, row.narratorId),
						eq(narratorToolCalls.executionAttempt, row.attempt),
					),
				)
				.run();
	});
}

export async function consumePermissionRuleRequest(
	identity: PermissionRuleRequestIdentity,
	raw: unknown,
	context: ExecutionTargetContext,
): Promise<PermissionRuleRequestResult> {
	try {
		return await consumeBoundPermissionRuleRequest(identity, raw, context);
	} catch (error) {
		// A failed application is terminal; never leave a reusable approved receipt.
		try {
			db.update(permissionRuleRequests)
				.set({
					status: "failed",
					error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(
							permissionRuleRequests.id,
							`${identity.binding.toolCallId}:${identity.binding.attempt}`,
						),
						eq(permissionRuleRequests.narratorId, identity.narratorId),
						eq(permissionRuleRequests.status, "approved"),
					),
				)
				.run();
		} catch {
			/* Database outage: no rule was committed; the tool still fails closed. */
		}
		throw error;
	}
}

/** Validate a dedicated receipt without consuming it; used by the final execution gate. */
export async function validatePermissionRuleRequestApproval(
	identity: PermissionRuleRequestIdentity,
	raw: unknown,
	context: ExecutionTargetContext,
) {
	const call = assertBinding(identity);
	const row = db
		.select()
		.from(permissionRuleRequests)
		.where(
			eq(permissionRuleRequests.id, `${identity.binding.toolCallId}:${identity.binding.attempt}`),
		)
		.get();
	if (
		!row ||
		row.status !== "approved" ||
		row.narratorId !== identity.narratorId ||
		row.toolUseId !== identity.toolUseId ||
		row.attempt !== identity.binding.attempt ||
		row.toolCallId !== identity.binding.toolCallId ||
		requestExpired(row.createdAt)
	)
		throw new PermissionRuleRequestError("Missing, expired or terminal bound approval receipt");
	const proposal = row.proposalJson as unknown as {
		input: PermissionRuleRequestInput;
		rule: ExecutionPermissionRule;
	};
	const input = requestPermissionRuleSchema.parse(raw);
	if (
		hash(input) !== hash(proposal.input) ||
		hash({ narratorId: identity.narratorId, input: proposal.input, rule: proposal.rule }) !==
			row.proposalHash
	)
		throw new PermissionRuleRequestError("Approved proposal input changed");
	if (
		(row.approvalSource !== "user" && row.approvalSource !== "reflection") ||
		(row.approvalSource === "user" && !row.approvalUserId) ||
		call.decidedBy !== row.approvalSource ||
		!call.decidedAt
	)
		throw new PermissionRuleRequestError(
			"Approval receipt is missing its authenticated decision source",
		);
	const live = await liveRevision(identity, context);
	if (
		row.contextRevision !== live.revision ||
		row.deviceId !== context.target.deviceId ||
		(row.approvalSource === "reflection" &&
			(live.narrator.permissionMode !== "bypassPermissions" ||
				!settings.agent.permissionRuleAutoApprove))
	)
		throw new PermissionRuleRequestError(
			"Authorization, mode, directory, device or policy changed while waiting",
		);
	return row;
}

async function consumeBoundPermissionRuleRequest(
	identity: PermissionRuleRequestIdentity,
	raw: unknown,
	context: ExecutionTargetContext,
) {
	assertBinding(identity);
	const requestId = `${identity.binding.toolCallId}:${identity.binding.attempt}`;
	const row = db
		.select()
		.from(permissionRuleRequests)
		.where(eq(permissionRuleRequests.id, requestId))
		.get();
	if (!row || row.narratorId !== identity.narratorId || row.toolUseId !== identity.toolUseId)
		throw new PermissionRuleRequestError("Missing bound approval receipt");
	const proposal = row.proposalJson as unknown as {
		input: PermissionRuleRequestInput;
		rule: ExecutionPermissionRule;
	};
	const input = requestPermissionRuleSchema.parse(raw);
	if (hash(input) !== hash(proposal.input))
		throw new PermissionRuleRequestError("Approved proposal input changed");
	if (
		hash({ narratorId: identity.narratorId, input: proposal.input, rule: proposal.rule }) !==
		row.proposalHash
	)
		throw new PermissionRuleRequestError("Proposal hash mismatch");
	if (row.status === "applied" || row.status === "alreadyExists" || row.status === "approved") {
		if (
			(row.approvalSource !== "user" && row.approvalSource !== "reflection") ||
			(row.approvalSource === "user" && !row.approvalUserId)
		)
			throw new PermissionRuleRequestError(
				"Approval receipt is missing its authenticated decision source",
			);
	}
	if (row.status === "applied" || row.status === "alreadyExists")
		return permissionRuleRequestResultSchema.parse({
			requestId,
			status: row.status,
			ruleId: row.ruleId,
			proposalHash: row.proposalHash,
			scope: row.scope,
			deviceId: row.deviceId,
			approvalSource: row.approvalSource,
			approvalUserId: row.approvalUserId,
			rule: { ...proposal.rule, id: row.ruleId ?? undefined },
		});
	await validatePermissionRuleRequestApproval(identity, raw, context);
	const saved = {
		...proposal.rule,
		id: generateId(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const result = db.transaction((tx) => {
		assertBinding(identity, tx);
		const latest = tx
			.select()
			.from(permissionRuleRequests)
			.where(eq(permissionRuleRequests.id, requestId))
			.get();
		if (
			latest &&
			hash([
				latest.proposalHash,
				latest.contextRevision,
				latest.scope,
				latest.deviceId,
				latest.approvalSource,
				latest.approvalUserId,
			]) !==
				hash([
					row.proposalHash,
					row.contextRevision,
					row.scope,
					row.deviceId,
					row.approvalSource,
					row.approvalUserId,
				])
		) {
			throw new PermissionRuleRequestError("Approval receipt changed before commit");
		}
		if (latest?.status === "applied" || latest?.status === "alreadyExists") {
			permissionRuleRequestResultSchema.parse({
				requestId,
				status: latest.status,
				ruleId: latest.ruleId,
				proposalHash: latest.proposalHash,
				scope: latest.scope,
				deviceId: latest.deviceId,
				approvalSource: latest.approvalSource,
				approvalUserId: latest.approvalUserId,
				rule: { ...proposal.rule, id: latest.ruleId ?? undefined },
			});
			return latest;
		}
		if (latest?.status !== "approved")
			throw new PermissionRuleRequestError("Approval receipt already consumed");
		const commitRevision = hash({
			narrator: loadIdentity(identity.narratorId),
			target: executionTargetContextKey(context),
			policy: executionPolicyRevision(executionPolicyRepository.loadNow(identity.narratorId, tx)),
			settingsRevision: getSettingsRevision(),
		});
		if (commitRevision !== row.contextRevision)
			throw new PermissionRuleRequestError("Authorization context changed before commit");
		const table = {
			directoryWhitelist: narratorWhitelistDirs,
			directoryBlacklist: narratorBlacklistDirs,
			commandWhitelist: narratorWhitelistCmds,
			commandBlacklist: narratorBlacklistCmds,
		}[saved.ruleType];
		const rows = tx
			.select()
			.from(table)
			.where(eq(table.narratorId, identity.narratorId))
			.limit(501)
			.all();
		if (rows.length > 500) throw new ValidationError("Narrator permission rule budget exceeded");
		const conflict = rows
			.map((value) =>
				normalizePermissionRuleInput({ ruleType: saved.ruleType, value } as Parameters<
					typeof normalizePermissionRuleInput
				>[0]),
			)
			.find((existing) => permissionRuleConflictKey(existing) === permissionRuleConflictKey(saved));
		const equivalent = (rule: ExecutionPermissionRule) => {
			const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...value } = rule;
			return value;
		};
		if (conflict && hash(equivalent(conflict)) !== hash(equivalent(saved)))
			throw new PermissionRuleConflictError(permissionRuleConflictKey(saved));
		const status = conflict ? ("alreadyExists" as const) : ("applied" as const);
		const ruleId = conflict?.id ?? saved.id;
		// Validate before CAS/insert, so an invalid durable receipt cannot leave a rule.
		permissionRuleRequestResultSchema.parse({
			requestId,
			status,
			ruleId,
			proposalHash: latest.proposalHash,
			scope: latest.scope,
			deviceId: latest.deviceId,
			approvalSource: latest.approvalSource,
			approvalUserId: latest.approvalUserId,
			rule: { ...saved, id: ruleId },
		});
		const changed = tx
			.update(permissionRuleRequests)
			.set({ status, ruleId, updatedAt: saved.updatedAt })
			.where(
				and(
					eq(permissionRuleRequests.id, requestId),
					eq(permissionRuleRequests.status, "approved"),
				),
			)
			.returning({ id: permissionRuleRequests.id })
			.all();
		if (changed.length !== 1) throw new PermissionRuleRequestError("Concurrent terminal decision");
		if (!conflict) permissionRuleService.insertRule(identity.narratorId, saved, tx);
		return { ...latest, status, ruleId };
	});
	// Invalidate synchronously BEFORE any observer can react to the creation event.
	executionPolicyEngine.invalidate(identity.narratorId);
	if (result.status === "applied")
		permissionPolicyChanges.emit({
			type: "permission:policy_changed",
			narratorId: identity.narratorId,
			ruleType: saved.ruleType,
			ruleId: result.ruleId ?? saved.id,
			change: "created",
			changedAt: saved.updatedAt,
		});
	return permissionRuleRequestResultSchema.parse({
		requestId,
		status: result.status,
		ruleId: result.ruleId,
		proposalHash: row.proposalHash,
		scope: row.scope,
		deviceId: row.deviceId,
		approvalSource: row.approvalSource,
		approvalUserId: row.approvalUserId,
		rule: { ...proposal.rule, id: result.ruleId ?? undefined },
	});
}

export const permissionRuleRequestListQuerySchema = z.object({
	cursor: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});
export function listPermissionRuleRequests(narratorId: string, query: unknown = {}) {
	const { cursor, limit } = permissionRuleRequestListQuerySchema.parse(query);
	const after = cursor
		? z
				.object({ createdAt: z.string().max(40), id: z.string().max(100) })
				.strict()
				.parse(JSON.parse(cursor))
		: undefined;
	const rows = db
		.select({
			id: permissionRuleRequests.id,
			status: permissionRuleRequests.status,
			reason: permissionRuleRequests.reason,
			proposalHash: permissionRuleRequests.proposalHash,
			deviceId: permissionRuleRequests.deviceId,
			scope: permissionRuleRequests.scope,
			ruleId: permissionRuleRequests.ruleId,
			approvalSource: permissionRuleRequests.approvalSource,
			approvalUserId: permissionRuleRequests.approvalUserId,
			error: permissionRuleRequests.error,
			createdAt: permissionRuleRequests.createdAt,
		})
		.from(permissionRuleRequests)
		.where(
			and(
				eq(permissionRuleRequests.narratorId, narratorId),
				after
					? or(
							lt(permissionRuleRequests.createdAt, after.createdAt),
							and(
								eq(permissionRuleRequests.createdAt, after.createdAt),
								lt(permissionRuleRequests.id, after.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(permissionRuleRequests.createdAt), desc(permissionRuleRequests.id))
		.limit(limit + 1)
		.all();
	return {
		items: rows.slice(0, limit),
		nextCursor:
			rows.length > limit
				? JSON.stringify({ createdAt: rows[limit - 1].createdAt, id: rows[limit - 1].id })
				: null,
	};
}
