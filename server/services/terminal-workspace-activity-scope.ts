import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { fileChangeScopes, projects, terminals, users } from "../db/schema";
import { resolveBackend } from "../lib/agent/execution/registry";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { getDeviceRow, requireAuthorizedDeviceForProject } from "./device-service";
import { compileExecutionPolicy } from "./execution-policy/compiler";
import {
	mergeExecutionPolicyRuleSets,
	normalizeExecutionPolicyRuleSet,
} from "./execution-policy/normalize";
import type { LegacyExecutionPolicyRuleSet } from "./execution-policy/types";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import type { NarratorPrincipal } from "./narrator-acl";
import { resolveOAuthDeviceRuntimeAuthorization } from "./oauth-device-runtime-policy";
import { loadProjectForAccess } from "./project-acl";
import { getRemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";

/** True terminal origin, never a fabricated narrator or borrowed narrator-owner authority. */
export async function resolveTerminalWorkspaceActivityScope(input: {
	principal: NarratorPrincipal;
	terminalId: string;
	workspaceContext: WorkspaceContext;
	runtimeGeneration: number;
	signal: AbortSignal;
}) {
	const frozen = Object.freeze({ ...input.workspaceContext });
	const backend = resolveBackend({ requested: frozen.deviceId });
	const generation = input.runtimeGeneration;
	const authorize = async () => {
		input.signal.throwIfAborted();
		const user = db
			.select({ role: users.role })
			.from(users)
			.where(eq(users.id, input.principal.userId))
			.get();
		if (!user || (user.role === "admin") !== input.principal.isAdmin)
			throw new Error("Terminal actor role changed");
		const row = db
			.select({
				owner: terminals.ownerUserId,
				narrator: terminals.narratorId,
				cwd: terminals.cwd,
				device: terminals.deviceId,
				revision: terminals.workspaceRevision,
				status: terminals.status,
				exit: terminals.exitCode,
				context: sql<
					| (WorkspaceContext & { terminalOrigin?: { version: number; runtimeGeneration: number } })
					| null
				>`case when octet_length(${terminals.workspaceContext}) <= ${FILE_CHANGE_LIMITS.metadataBytes} then ${terminals.workspaceContext} else null end`,
			})
			.from(terminals)
			.where(eq(terminals.id, input.terminalId))
			.get();
		const context =
			typeof row?.context === "string"
				? (JSON.parse(row.context) as WorkspaceContext & {
						terminalOrigin?: { version: number; runtimeGeneration: number };
					})
				: row?.context;
		if (
			!row ||
			row.owner !== input.principal.userId ||
			row.narrator !== null ||
			row.cwd !== frozen.cwd ||
			(row.device ?? "local") !== frozen.deviceId ||
			row.revision !== frozen.revision ||
			!context ||
			context.contextKey !== frozen.contextKey ||
			context.cwd !== frozen.cwd ||
			context.deviceId !== frozen.deviceId ||
			context.pathFlavor !== frozen.pathFlavor ||
			(context.contextProjectId ?? null) !== (frozen.contextProjectId ?? null) ||
			context.terminalOrigin?.version !== 1 ||
			context.terminalOrigin.runtimeGeneration !== generation ||
			(row.status === "exited" && row.exit !== null)
		)
			throw new Error("Actual standalone terminal origin does not match its prepared metadata");
		if (
			resolveBackend({ requested: frozen.deviceId }).runtimeGeneration !== generation ||
			backend.runtimeGeneration !== generation
		)
			throw new Error("Terminal execution generation changed");
		let projectRules: LegacyExecutionPolicyRuleSet | undefined;
		if (frozen.contextProjectId) {
			await loadProjectForAccess(frozen.contextProjectId, input.principal, "write");
			const project = db
				.select({
					settingsBytes: sql<number>`coalesce(octet_length(${projects.chapterSettings}),0)`,
					settings: sql<LegacyExecutionPolicyRuleSet | null>`case when octet_length(${projects.chapterSettings}) <= ${FILE_CHANGE_LIMITS.summaryBytes} then ${projects.chapterSettings} else null end`,
				})
				.from(projects)
				.where(eq(projects.id, frozen.contextProjectId))
				.get();
			if (!project || project.settingsBytes > FILE_CHANGE_LIMITS.summaryBytes)
				throw new Error(
					"Terminal project policy metadata is unavailable or exceeds its bounded budget",
				);
			projectRules =
				typeof project?.settings === "string"
					? (JSON.parse(project.settings) as LegacyExecutionPolicyRuleSet)
					: (project?.settings ?? undefined);
		}
		if (backend.kind === "remote") {
			await requireAuthorizedDeviceForProject(
				backend.deviceId,
				frozen.contextProjectId,
				input.principal.userId,
			);
			const device = await getDeviceRow(backend.deviceId);
			if (!device) throw new Error("Terminal device unavailable");
			const oauth = await resolveOAuthDeviceRuntimeAuthorization(device);
			if (
				!oauth.allowed ||
				(oauth.policy && oauth.policy.deviceAccess.selfRegistered !== "readWrite")
			)
				throw new Error("Terminal exceeds live device OAuth write ceiling");
		}
		const compiled = compileExecutionPolicy(
			mergeExecutionPolicyRuleSets(
				normalizeExecutionPolicyRuleSet(settings.agent, "global"),
				normalizeExecutionPolicyRuleSet(projectRules, "project"),
			),
			{
				backend,
				paths: backend.paths,
				deviceClass: backend.kind === "local" ? "host" : "global",
				target: {
					deviceId: backend.deviceId,
					backendKind: backend.kind,
					cwd: frozen.cwd,
					lexicalPath: frozen.cwd,
					canonicalPath: frozen.cwd,
					pathFlavor: backend.pathFlavor,
					runtimeGeneration: generation,
					selectionSource: "explicit",
				},
			},
		);
		if (compiled.evaluatePath({ path: frozen.cwd, operation: "write" }).decision === "deny")
			throw new Error("Terminal root denied by execution policy");
		const root = await backend.resolvePathIdentity(frozen.cwd, {
			signal: input.signal,
			timeoutMs: 5_000,
		});
		if (
			!backend.paths.equals(root.canonicalPath, frozen.cwd) ||
			root.runtimeGeneration !== generation
		)
			throw new Error("Terminal canonical root changed");
	};
	await authorize();
	if (backend.kind === "local") {
		const runtime = await getDefaultLocalFileChangeRuntime();
		const admitted = await runtime.prepareWorkspaceActivityScope({
			backend,
			cwd: frozen.cwd,
			signal: input.signal,
		});
		return {
			scope: admitted.scope,
			runtime: admitted.runtime,
			coordinator: admitted.coordinator,
			async assertCurrent() {
				await authorize();
			},
		};
	}
	if (!backend.supportsRemoteHistory || !backend.remoteHistory)
		throw new Error("Executor upgrade required for remote terminal activity scope");
	const registry = await getRemoteWorkspaceHistoryRuntime();
	const candidates = registry.options.db
		.select()
		.from(fileChangeScopes)
		.where(
			and(
				eq(fileChangeScopes.deviceId, backend.deviceId),
				eq(fileChangeScopes.canonicalRoot, frozen.cwd),
				eq(fileChangeScopes.status, "active"),
			),
		)
		.limit(2)
		.all();
	if (candidates.length > 1) throw new Error("Terminal root has ambiguous persistent scopes");
	const existing = candidates[0];
	const binding = await backend.remoteHistory(
		"open",
		{
			root: frozen.cwd,
			scopeId: existing?.id ?? generateId(),
			fence: Math.max(1, existing?.fencingToken ?? 1),
		},
		input.signal,
	);
	let scope = existing;
	if (!scope) {
		scope = registry.evidence.prepareScope({
			id: binding.scopeId,
			sourceInstanceId: binding.sourceInstanceId,
			workspaceInstanceId: binding.workspaceInstanceId,
			deviceId: backend.deviceId,
			canonicalRoot: binding.root,
			pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
		});
		scope = registry.evidence.recordScopeVerification({
			scopeId: scope.id,
			canonicalRoot: binding.root,
			rootIdentity: { object: binding.rootIdentity },
		});
		registry.options.db
			.update(fileChangeScopes)
			.set({ fencingToken: binding.fence })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
	}
	if (
		scope.sourceInstanceId !== binding.sourceInstanceId ||
		scope.workspaceInstanceId !== binding.workspaceInstanceId ||
		scope.canonicalRoot !== binding.root ||
		scope.rootIdentityJson?.object !== binding.rootIdentity
	)
		throw new Error("Terminal native root/source identity changed");
	const runtime = registry.runtimeBinding(backend.deviceId);
	if (!runtime) throw new Error("Terminal device went offline");
	return {
		scope,
		runtime,
		coordinator: registry.coordinator,
		async assertCurrent() {
			await authorize();
			const recorded = registry.evidence.getScope(binding.scopeId);
			if (
				!recorded ||
				recorded.sourceInstanceId !== binding.sourceInstanceId ||
				recorded.workspaceInstanceId !== binding.workspaceInstanceId ||
				recorded.canonicalRoot !== binding.root ||
				recorded.rootIdentityJson?.object !== binding.rootIdentity
			)
				throw new Error("Terminal recorded root/source changed");
			const current = await backend.remoteHistory?.(
				"open",
				{ root: binding.root, scopeId: binding.scopeId, fence: Math.max(1, recorded.fencingToken) },
				input.signal,
			);
			if (
				!current ||
				current.sourceInstanceId !== binding.sourceInstanceId ||
				current.workspaceInstanceId !== binding.workspaceInstanceId ||
				current.rootIdentity !== binding.rootIdentity
			)
				throw new Error("Terminal persistent root replaced");
		},
	};
}
