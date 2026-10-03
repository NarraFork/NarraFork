import { EventEmitter } from "node:events";
import { db } from "@server/db";
import {
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
} from "@server/db/schema";
import { AppError, NotFoundError, ValidationError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { and, eq } from "drizzle-orm";
import { executionPolicyEngine } from "./execution-policy/engine";
import {
	normalizeCommandBlacklistRule,
	normalizeCommandWhitelistRule,
	normalizeDirectoryBlacklistRule,
	normalizeDirectoryWhitelistRule,
} from "./execution-policy/normalize";
import { selectorConflictKey, selectorToStorage } from "./execution-policy/selector";
import type {
	ExecutionPermissionRule,
	ExecutionPolicyRuleSet,
	LegacyCommandBlacklistEntry,
	LegacyCommandWhitelistEntry,
	LegacyDirectoryBlacklistEntry,
	LegacyDirectoryWhitelistEntry,
} from "./execution-policy/types";

export type PermissionRuleType = ExecutionPermissionRule["ruleType"];

export type PermissionRuleInput =
	| { ruleType: "directoryWhitelist"; value: LegacyDirectoryWhitelistEntry }
	| { ruleType: "directoryBlacklist"; value: LegacyDirectoryBlacklistEntry }
	| { ruleType: "commandWhitelist"; value: LegacyCommandWhitelistEntry }
	| { ruleType: "commandBlacklist"; value: LegacyCommandBlacklistEntry };

export interface PermissionPolicyChangeEvent {
	type: "permission:policy_changed";
	narratorId: string;
	ruleType: PermissionRuleType;
	ruleId: string;
	change: "created" | "updated" | "deleted";
	changedAt: string;
}

export class PermissionRuleConflictError extends AppError {
	constructor(public readonly conflictKey: string) {
		super(`Permission rule conflicts with an existing rule: ${conflictKey}`, 409, "RULE_CONFLICT");
		this.name = "PermissionRuleConflictError";
	}
}

class PermissionPolicyChangeEmitter {
	private readonly emitter = new EventEmitter();

	on(handler: (event: PermissionPolicyChangeEvent) => void): () => void {
		this.emitter.on("changed", handler);
		return () => this.emitter.off("changed", handler);
	}

	emit(event: PermissionPolicyChangeEvent): void {
		// Observers may immediately launch their next call; clear first, never after broadcast.
		executionPolicyEngine.invalidate(event.narratorId);
		for (const listener of this.emitter.listeners("changed")) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Permission policy observer failed after commit", {
					narratorId: event.narratorId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

/** Local typed event source; routes/websocket integration can bridge this to eventBus later. */
export const permissionPolicyChanges = new PermissionPolicyChangeEmitter();

export function normalizePermissionRuleInput(input: PermissionRuleInput): ExecutionPermissionRule {
	switch (input.ruleType) {
		case "directoryWhitelist":
			return normalizeDirectoryWhitelistRule(input.value, "narrator");
		case "directoryBlacklist":
			return normalizeDirectoryBlacklistRule(input.value, "narrator");
		case "commandWhitelist":
			return normalizeCommandWhitelistRule(input.value, "narrator");
		case "commandBlacklist":
			return normalizeCommandBlacklistRule(input.value, "narrator");
	}
}

export function permissionRuleConflictKey(rule: ExecutionPermissionRule): string {
	const selector = selectorConflictKey(rule.selector);
	switch (rule.ruleType) {
		case "directoryWhitelist":
		case "directoryBlacklist":
			return `${rule.ruleType}:${rule.pathFlavor}:${rule.pathKey}:${selector}`;
		case "commandWhitelist":
		case "commandBlacklist":
			return `${rule.ruleType}:${rule.pattern}:${selector}`;
	}
}

export function findPermissionRuleConflict(
	rules: readonly ExecutionPermissionRule[],
	candidate: ExecutionPermissionRule,
	excludeId?: string,
): ExecutionPermissionRule | undefined {
	const key = permissionRuleConflictKey(candidate);
	return rules.find((rule) => rule.id !== excludeId && permissionRuleConflictKey(rule) === key);
}

export function assertNoPermissionRuleConflict(
	rules: readonly ExecutionPermissionRule[],
	candidate: ExecutionPermissionRule,
	excludeId?: string,
): void {
	if (findPermissionRuleConflict(rules, candidate, excludeId)) {
		throw new PermissionRuleConflictError(permissionRuleConflictKey(candidate));
	}
}

function rulesFromSet(set: ExecutionPolicyRuleSet): ExecutionPermissionRule[] {
	return [
		...set.directoryWhitelist,
		...set.directoryBlacklist,
		...set.commandWhitelist,
		...set.commandBlacklist,
	];
}

class PermissionRuleService {
	async listNarratorRules(narratorId: string): Promise<ExecutionPolicyRuleSet> {
		const [whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist] = await Promise.all([
			db
				.select()
				.from(narratorWhitelistDirs)
				.where(eq(narratorWhitelistDirs.narratorId, narratorId)),
			db
				.select()
				.from(narratorBlacklistDirs)
				.where(eq(narratorBlacklistDirs.narratorId, narratorId)),
			db
				.select()
				.from(narratorWhitelistCmds)
				.where(eq(narratorWhitelistCmds.narratorId, narratorId)),
			db
				.select()
				.from(narratorBlacklistCmds)
				.where(eq(narratorBlacklistCmds.narratorId, narratorId)),
		]);
		return {
			directoryWhitelist: whitelistDirs.map((row) =>
				normalizeDirectoryWhitelistRule(row, "narrator"),
			),
			directoryBlacklist: blacklistDirs.map((row) =>
				normalizeDirectoryBlacklistRule(row, "narrator"),
			),
			commandWhitelist: commandWhitelist.map((row) =>
				normalizeCommandWhitelistRule(row, "narrator"),
			),
			commandBlacklist: commandBlacklist.map((row) =>
				normalizeCommandBlacklistRule(row, "narrator"),
			),
		};
	}

	async createNarratorRule(
		narratorId: string,
		input: PermissionRuleInput,
	): Promise<ExecutionPermissionRule> {
		const normalized = normalizePermissionRuleInput(input);
		const current = rulesFromSet(await this.listNarratorRules(narratorId));
		assertNoPermissionRuleConflict(current, normalized);
		const id = generateId();
		const now = new Date().toISOString();
		await this.insertRule(narratorId, { ...normalized, id, createdAt: now, updatedAt: now });
		const saved = { ...normalized, id, createdAt: now, updatedAt: now };
		permissionPolicyChanges.emit({
			type: "permission:policy_changed",
			narratorId,
			ruleType: saved.ruleType,
			ruleId: id,
			change: "created",
			changedAt: now,
		});
		return saved;
	}

	async updateNarratorRule(
		narratorId: string,
		input: PermissionRuleInput & { value: { id?: string } },
	): Promise<ExecutionPermissionRule> {
		const normalized = normalizePermissionRuleInput(input);
		if (!normalized.id) throw new ValidationError("Permission rule id is required");
		const current = rulesFromSet(await this.listNarratorRules(narratorId));
		if (
			!current.some((rule) => rule.ruleType === normalized.ruleType && rule.id === normalized.id)
		) {
			throw new NotFoundError("Permission rule", normalized.id);
		}
		assertNoPermissionRuleConflict(current, normalized, normalized.id);
		const now = new Date().toISOString();
		await this.replaceRule(narratorId, { ...normalized, updatedAt: now });
		const saved = { ...normalized, updatedAt: now };
		permissionPolicyChanges.emit({
			type: "permission:policy_changed",
			narratorId,
			ruleType: saved.ruleType,
			ruleId: normalized.id,
			change: "updated",
			changedAt: now,
		});
		return saved;
	}

	async deleteNarratorRule(
		narratorId: string,
		ruleType: PermissionRuleType,
		ruleId: string,
	): Promise<void> {
		const deleted = await this.deleteRuleRow(narratorId, ruleType, ruleId);
		if (!deleted) throw new NotFoundError("Permission rule", ruleId);
		const now = new Date().toISOString();
		permissionPolicyChanges.emit({
			type: "permission:policy_changed",
			narratorId,
			ruleType,
			ruleId,
			change: "deleted",
			changedAt: now,
		});
	}

	/** Synchronous insert for the bounded request terminal-CAS transaction. */
	insertRule(
		narratorId: string,
		rule: ExecutionPermissionRule,
		store: Pick<typeof db, "insert"> = db,
	): void {
		if (!rule.id || !rule.createdAt || !rule.updatedAt) {
			throw new ValidationError("Permission rule storage metadata is incomplete");
		}
		const target = selectorToStorage(rule.selector);
		switch (rule.ruleType) {
			case "directoryWhitelist":
				store
					.insert(narratorWhitelistDirs)
					.values({
						id: rule.id,
						narratorId,
						path: rule.path,
						pathFlavor: rule.pathFlavor,
						pathKey: rule.pathKey,
						accessLevel: rule.accessLevel,
						enabled: rule.enabled,
						...target,
						createdAt: rule.createdAt,
						updatedAt: rule.updatedAt,
					})
					.run();
				return;
			case "directoryBlacklist":
				store
					.insert(narratorBlacklistDirs)
					.values({
						id: rule.id,
						narratorId,
						path: rule.path,
						pathFlavor: rule.pathFlavor,
						pathKey: rule.pathKey,
						denyLevel: rule.denyLevel,
						enabled: rule.enabled,
						...target,
						createdAt: rule.createdAt,
						updatedAt: rule.updatedAt,
					})
					.run();
				return;
			case "commandWhitelist":
				store
					.insert(narratorWhitelistCmds)
					.values({
						id: rule.id,
						narratorId,
						pattern: rule.pattern,
						enabled: rule.enabled,
						...target,
						createdAt: rule.createdAt,
						updatedAt: rule.updatedAt,
					})
					.run();
				return;
			case "commandBlacklist":
				store
					.insert(narratorBlacklistCmds)
					.values({
						id: rule.id,
						narratorId,
						pattern: rule.pattern,
						denyPrompt: rule.denyPrompt,
						enabled: rule.enabled,
						...target,
						createdAt: rule.createdAt,
						updatedAt: rule.updatedAt,
					})
					.run();
		}
	}

	private async replaceRule(narratorId: string, rule: ExecutionPermissionRule): Promise<void> {
		if (!rule.id || !rule.updatedAt) throw new ValidationError("Permission rule id is required");
		const target = selectorToStorage(rule.selector);
		const where = (column: typeof narratorWhitelistDirs.id) =>
			and(eq(column, rule.id as string), eq(narratorWhitelistDirs.narratorId, narratorId));
		switch (rule.ruleType) {
			case "directoryWhitelist":
				await db
					.update(narratorWhitelistDirs)
					.set({
						path: rule.path,
						pathFlavor: rule.pathFlavor,
						pathKey: rule.pathKey,
						accessLevel: rule.accessLevel,
						enabled: rule.enabled,
						...target,
						updatedAt: rule.updatedAt,
					})
					.where(where(narratorWhitelistDirs.id));
				return;
			case "directoryBlacklist":
				await db
					.update(narratorBlacklistDirs)
					.set({
						path: rule.path,
						pathFlavor: rule.pathFlavor,
						pathKey: rule.pathKey,
						denyLevel: rule.denyLevel,
						enabled: rule.enabled,
						...target,
						updatedAt: rule.updatedAt,
					})
					.where(
						and(
							eq(narratorBlacklistDirs.id, rule.id),
							eq(narratorBlacklistDirs.narratorId, narratorId),
						),
					);
				return;
			case "commandWhitelist":
				await db
					.update(narratorWhitelistCmds)
					.set({
						pattern: rule.pattern,
						enabled: rule.enabled,
						...target,
						updatedAt: rule.updatedAt,
					})
					.where(
						and(
							eq(narratorWhitelistCmds.id, rule.id),
							eq(narratorWhitelistCmds.narratorId, narratorId),
						),
					);
				return;
			case "commandBlacklist":
				await db
					.update(narratorBlacklistCmds)
					.set({
						pattern: rule.pattern,
						denyPrompt: rule.denyPrompt,
						enabled: rule.enabled,
						...target,
						updatedAt: rule.updatedAt,
					})
					.where(
						and(
							eq(narratorBlacklistCmds.id, rule.id),
							eq(narratorBlacklistCmds.narratorId, narratorId),
						),
					);
		}
	}

	private async deleteRuleRow(
		narratorId: string,
		ruleType: PermissionRuleType,
		ruleId: string,
	): Promise<boolean> {
		switch (ruleType) {
			case "directoryWhitelist":
				return (
					(
						await db
							.delete(narratorWhitelistDirs)
							.where(
								and(
									eq(narratorWhitelistDirs.id, ruleId),
									eq(narratorWhitelistDirs.narratorId, narratorId),
								),
							)
							.returning({ id: narratorWhitelistDirs.id })
					).length > 0
				);
			case "directoryBlacklist":
				return (
					(
						await db
							.delete(narratorBlacklistDirs)
							.where(
								and(
									eq(narratorBlacklistDirs.id, ruleId),
									eq(narratorBlacklistDirs.narratorId, narratorId),
								),
							)
							.returning({ id: narratorBlacklistDirs.id })
					).length > 0
				);
			case "commandWhitelist":
				return (
					(
						await db
							.delete(narratorWhitelistCmds)
							.where(
								and(
									eq(narratorWhitelistCmds.id, ruleId),
									eq(narratorWhitelistCmds.narratorId, narratorId),
								),
							)
							.returning({ id: narratorWhitelistCmds.id })
					).length > 0
				);
			case "commandBlacklist":
				return (
					(
						await db
							.delete(narratorBlacklistCmds)
							.where(
								and(
									eq(narratorBlacklistCmds.id, ruleId),
									eq(narratorBlacklistCmds.narratorId, narratorId),
								),
							)
							.returning({ id: narratorBlacklistCmds.id })
					).length > 0
				);
		}
	}
}

export const permissionRuleService = new PermissionRuleService();
