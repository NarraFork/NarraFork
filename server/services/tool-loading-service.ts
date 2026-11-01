import { resolveMcpLoadingMode } from "@shared/mcp-loading-mode";
import { type RoutineModeConfig, resolveEffectiveToolRoutineMode } from "@shared/routine-modes";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, projects, users } from "../db/schema";
import { classifyToolAdditions, type ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import { toolRegistry } from "../lib/agent/tool-registry";
import type { ToolContext, ToolDefinition } from "../lib/agent/types";
import { getBuiltinToolNames, getBuiltinToolRoutines } from "../lib/builtin-routines";
import { ValidationError } from "../lib/errors";
import { getDisabledToolSet } from "../lib/narrator-custom-traits";
import { getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { policySourceIdOf } from "../lib/runtime-source";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorStore } from "./narrator-store";
import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";
import { runtimeToolFilter } from "./subagent-tools";
import {
	ADMIN_ONLY_LOAD_TOOLS,
	mcpServerMarker,
	mcpToolMarker,
	parseMcpServerMarker,
	parseMcpToolMarker,
} from "./tool-load-markers";
import {
	resolveEffectiveTraits,
	resolveNarratorProjectId,
	resolveNarratorRuntimePolicy,
} from "./trait-layer-service";

function toolDescription(tool: ToolDefinition | undefined): string {
	if (!tool) return "";
	// Discovery needs only metadata, never schema resolution or serialization.
	return typeof tool.description === "string" ? tool.description.slice(0, 2048) : "";
}

export interface LoadableToolGroup {
	id: string;
	description: string;
	toolNames: string[];
	marker?: string;
	/** Member documents, aligned with toolNames. The group description is indexed separately. */
	searchTexts?: string[];
}

const queues = new Map<string, Promise<unknown>>();
export async function serializeToolChanges<T>(
	id: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const previous = queues.get(id) ?? Promise.resolve();
	const pending = previous
		.catch(() => {})
		.then(() => {
			signal?.throwIfAborted();
			return operation();
		});
	queues.set(id, pending);
	const cleanup = () => {
		if (queues.get(id) === pending) queues.delete(id);
	};
	void pending.then(cleanup, cleanup);
	if (!signal) return pending;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}

interface CatalogView {
	tools: readonly ToolDefinition[];
	byName: ReadonlyMap<string, ToolDefinition>;
	allowed: (tool: ToolDefinition) => boolean;
	disabled: ReadonlySet<string>;
	isAdmin: boolean;
	globalConfig: RoutineModeConfig | undefined;
	projectConfig: RoutineModeConfig | undefined;
	mcpServers: readonly { id: string; name: string; mode?: unknown; enabled?: unknown }[];
	signal?: AbortSignal;
}

/** Build only from the resolved catalog's single raw tool view; never re-query the registry. */
async function buildCandidates(view: CatalogView): Promise<LoadableToolGroup[]> {
	const { tools, byName, allowed, globalConfig, projectConfig, mcpServers, signal } = view;
	const groups: LoadableToolGroup[] = [];
	const descriptions = new Map<string, string>();
	const describe = (name: string) => {
		const cached = descriptions.get(name);
		if (cached !== undefined) return cached;
		const value = toolDescription(byName.get(name));
		descriptions.set(name, value);
		return value;
	};
	for (const routine of getBuiltinToolRoutines()) {
		if (
			!routine.tool ||
			resolveEffectiveToolRoutineMode(routine, globalConfig, projectConfig).mode !== "auto"
		)
			continue;
		const toolNames = getBuiltinToolNames(routine.tool);
		if (
			!toolNames.every((name) => {
				const tool = byName.get(name);
				return tool && allowed(tool);
			})
		)
			continue;
		groups.push({
			id: routine.id,
			toolNames,
			description: [routine.tool.descriptionEn, routine.tool.descriptionZh]
				.filter(Boolean)
				.join(" ")
				.slice(0, 8192),
			searchTexts: toolNames.map((name) => `${name} ${describe(name)}`),
		});
	}
	const autoServers = new Map(
		mcpServers
			.filter((server) => resolveMcpLoadingMode(server) === "auto")
			.map((server) => [server.id, server]),
	);
	for (const [index, tool] of tools.entries()) {
		if (index % 32 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			signal?.throwIfAborted();
		}
		const serverId = tool.metadata?.mcpServerId;
		const server = serverId ? autoServers.get(serverId) : undefined;
		if (!server || !allowed(tool)) continue;
		groups.push({
			id: tool.name,
			marker: mcpToolMarker(server.id, tool.name),
			toolNames: [tool.name],
			description: `${tool.name} ${server.name.slice(0, 512)} ${describe(tool.name)}`,
		});
	}
	return groups;
}

function residentToolNames(view: CatalogView): Set<string> {
	const resident = new Set<string>();
	for (const routine of getBuiltinToolRoutines()) {
		if (
			routine.tool &&
			resolveEffectiveToolRoutineMode(routine, view.globalConfig, view.projectConfig).mode ===
				"resident"
		) {
			for (const name of getBuiltinToolNames(routine.tool)) {
				const tool = view.byName.get(name);
				if (tool && view.allowed(tool)) resident.add(name);
			}
		}
	}
	const servers = new Set(
		view.mcpServers
			.filter((server) => resolveMcpLoadingMode(server) === "resident")
			.map((server) => server.id),
	);
	for (const tool of view.tools) {
		if (tool.metadata?.mcpServerId && servers.has(tool.metadata.mcpServerId) && view.allowed(tool))
			resident.add(tool.name);
	}
	return resident;
}

async function resolveLoadCatalog(
	narratorId: string,
	userId?: string | null,
	context?: ToolContext,
	includeCandidates = true,
) {
	context?.signal.throwIfAborted();
	const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
	if (!narrator) throw new Error("Narrator not found");
	const projectId = await resolveNarratorProjectId(narrator);
	const traits = await resolveEffectiveTraits({
		narratorTraits: narrator.traits,
		projectId,
		actingUserId: userId ?? null,
		policySourceId: policySourceIdOf(narrator),
	});
	const disabled = getDisabledToolSet(traits.traits);
	const policy = await resolveNarratorRuntimePolicy(narratorId, userId);
	const runtimeFilter = runtimeToolFilter(policy);
	const contextFilter = context?.runtimePolicy
		? runtimeToolFilter(context.runtimePolicy)
		: undefined;
	const oauth = await assertOAuthNarratorRuntimeActive(narratorId, userId);
	const user = userId
		? await db.query.users.findFirst({ where: eq(users.id, userId), columns: { role: true } })
		: undefined;
	const enabledMcpServers = new Set(
		(settings.mcpServers ?? [])
			.filter((server) => resolveMcpLoadingMode(server) !== "disabled")
			.map((server) => server.id),
	);
	const allowed = (tool: ToolDefinition) =>
		(!tool.metadata?.mcpServerId || enabledMcpServers.has(tool.metadata.mcpServerId)) &&
		(!tool.isAvailable || tool.isAvailable()) &&
		!disabled.has(tool.name) &&
		runtimeFilter(tool) &&
		(!contextFilter || contextFilter(tool)) &&
		(!oauth || oauth.allowedTools.has(tool.name)) &&
		(!ADMIN_ONLY_LOAD_TOOLS.has(tool.name) || user?.role === "admin");
	const project = projectId
		? await db.query.projects.findFirst({
				where: eq(projects.id, projectId),
				columns: { chapterSettings: true },
			})
		: undefined;
	let projectConfig: RoutineModeConfig | undefined;
	try {
		const raw = project?.chapterSettings;
		projectConfig = (typeof raw === "string" ? JSON.parse(raw) : raw)?.routines;
	} catch {
		/* Same malformed-settings fallback as session assembly. */
	}
	const tools = toolRegistry.all();
	const view: CatalogView = {
		tools,
		byName: new Map(tools.map((tool) => [tool.name, tool])),
		allowed,
		disabled,
		isAdmin: user?.role === "admin",
		globalConfig: settings.routines,
		projectConfig,
		mcpServers: settings.mcpServers ?? [],
		...(context ? { signal: context.signal } : {}),
	};
	const candidates = includeCandidates ? await buildCandidates(view) : [];
	const resident = residentToolNames(view);
	context?.signal.throwIfAborted();
	return { narrator, candidates, resident, ...view };
}

export async function getToolSearchCandidates(
	narratorId: string,
	userId?: string | null,
	context?: ToolContext,
): Promise<LoadableToolGroup[]> {
	return (await resolveLoadCatalog(narratorId, userId, context)).candidates;
}

function localizedGroupDescription(group: LoadableToolGroup, locale: Locale): string {
	const routine = getBuiltinToolRoutines().find(
		(candidate) =>
			candidate.id === group.id ||
			(candidate.tool &&
				(candidate.tool.toolName === group.id ||
					group.toolNames.includes(candidate.tool.toolName))),
	);
	if (!routine?.tool) return group.description;
	return (
		(locale === "zh-CN" ? routine.tool.descriptionZh : undefined) ??
		routine.tool.descriptionEn ??
		group.description
	);
}

export type ToolGroupChangeStatus =
	| "loaded"
	| "already_loaded"
	| "unloaded"
	| "not_loaded"
	| "denied"
	| "denied_trait"
	| "denied_admin";

function denialReason(catalog: CatalogView, toolNames: readonly string[]): ToolGroupChangeStatus {
	if (toolNames.some((name) => catalog.disabled.has(name))) return "denied_trait";
	if (!catalog.isAdmin && toolNames.some((name) => ADMIN_ONLY_LOAD_TOOLS.has(name)))
		return "denied_admin";
	return "denied";
}

type ResolvedLoadCatalog = Awaited<ReturnType<typeof resolveLoadCatalog>>;

/** Reconcile canonical single-tool selections and explicit server-group markers. */
async function normalizePersistedToolState(
	narratorId: string,
	catalog: ResolvedLoadCatalog,
	context?: ToolContext,
) {
	const { getEnabledOptionalTools, updateActiveLoadedTools } = await import("./narrator-session");
	const persisted = Array.isArray(catalog.narrator.enabledTools)
		? catalog.narrator.enabledTools.filter((name): name is string => typeof name === "string")
		: [];
	const current = new Set(persisted.filter((name) => !name.startsWith("mcp__")));
	if (current.size !== persisted.length) {
		context?.signal.throwIfAborted();
		context?.assertFinalExecutionPermission?.();
		await db
			.update(narrators)
			.set({ enabledTools: [...current] })
			.where(eq(narrators.id, narratorId));
	}
	const active = getEnabledOptionalTools(narratorId);
	const authorized = new Set(
		catalog.tools
			.filter((tool) => {
				const serverId = tool.metadata?.mcpServerId;
				return (
					serverId &&
					catalog.allowed(tool) &&
					(current.has(mcpToolMarker(serverId, tool.name)) ||
						current.has(mcpServerMarker(serverId)) ||
						catalog.resident.has(tool.name))
				);
			})
			.map((tool) => tool.name),
	);
	const stale = [...active].filter((name) => {
		if (name.startsWith("mcp__")) return !authorized.has(name);
		const marker = parseMcpServerMarker(name) || parseMcpToolMarker(name);
		return marker ? !current.has(name) : false;
	});
	updateActiveLoadedTools(narratorId, stale, false);
	updateActiveLoadedTools(
		narratorId,
		[...current].filter((name) => !!parseMcpServerMarker(name) || !!parseMcpToolMarker(name)),
		true,
	);
	updateActiveLoadedTools(narratorId, authorized, true);
	return { active, current, updateActiveLoadedTools };
}

/** All entry points share this queue; notice + persistent state commit in one DB transaction. */
export async function changeLoadedToolGroup(
	narratorId: string,
	group: LoadableToolGroup,
	loaded: boolean,
	userId?: string | null,
	context?: ToolContext,
	locale: Locale = "en",
): Promise<ToolGroupChangeStatus> {
	return serializeToolChanges(
		narratorId,
		async () => {
			context?.signal.throwIfAborted();
			await context?.recheckAuthorization?.();
			const catalog = await resolveLoadCatalog(
				narratorId,
				userId,
				context,
				!!context && !group.marker,
			);
			if (group.marker) {
				const selection = parseMcpToolMarker(group.marker);
				const serverId = selection?.serverId ?? parseMcpServerMarker(group.marker);
				const server = catalog.mcpServers.find((item) => item.id === serverId);
				const members = selection
					? [catalog.byName.get(selection.canonicalName)].filter(
							(tool): tool is ToolDefinition => !!tool,
						)
					: catalog.tools;
				const toolNames = members
					.filter((tool) => tool.metadata?.mcpServerId === serverId && catalog.allowed(tool))
					.map((tool) => tool.name);
				if (loaded && (!server || resolveMcpLoadingMode(server) !== "auto" || !toolNames.length))
					return denialReason(catalog, group.toolNames);
				group = { ...group, toolNames };
			} else if (context) {
				const fresh = catalog.candidates.find((item) => item.id === group.id);
				if (fresh) group = fresh;
				else if (loaded) return denialReason(catalog, group.toolNames);
			}
			const containsMcpTool = group.toolNames.some(
				(name) => name.startsWith("mcp__") || !!catalog.byName.get(name)?.metadata?.mcpServerId,
			);
			if (!group.marker && containsMcpTool) return denialReason(catalog, group.toolNames);
			if (
				loaded &&
				!context &&
				!group.marker &&
				!group.toolNames.every((name) => {
					const tool = catalog.byName.get(name);
					return tool && catalog.allowed(tool);
				})
			)
				return denialReason(catalog, group.toolNames);
			const { active, current, updateActiveLoadedTools } = await normalizePersistedToolState(
				narratorId,
				catalog,
				context,
			);
			let changed: string[] = [];
			if (group.marker) {
				// Only durable markers authorize a group. Active concrete names are derived
				// runtime state and can never suppress the commit that persists a missing marker.
				const selection = parseMcpToolMarker(group.marker);
				const exists =
					current.has(group.marker) ||
					(loaded && !!selection && current.has(mcpServerMarker(selection.serverId)));
				if (exists !== loaded) changed = [...group.toolNames];
			} else {
				for (const name of group.toolNames) {
					const exists = active.has(name) || current.has(name) || catalog.resident.has(name);
					if (exists !== loaded) changed.push(name);
				}
			}
			if (!changed.length) return loaded ? "already_loaded" : "not_loaded";

			// Freeze only the newly authorized definitions, before publishing their notice.
			// Old load events keep their own snapshot; never rebuild them from the registry.
			let definitionSnapshotRef: string | undefined;
			if (loaded) {
				const { snapshotToolDefinitions, toolLoadingEpochOf } = await import("./narrator-epochs");
				const { narratorService } = await import("./narrator-service");
				const history = await narratorService.getModelHistorySinceLastCompact(
					narratorId,
					undefined,
					{ signal: context?.signal },
				);
				const epoch = await toolLoadingEpochOf(narratorId, history);
				const { blocked } = classifyToolAdditions(epoch, changed);
				if (blocked.length) {
					throw new ValidationError(
						`This model's current prefix epoch cannot append new tool definitions: ${blocked.join(", ")}. ` +
							"Compact the conversation or switch models before loading these tools. No tools were loaded.",
					);
				}
				const { putPrefixToolDefinitions } = await import("./narrator-prefix-snapshots");
				const frozenByName = new Map<string, ToolDefinitionSnapshot>();
				if (epoch?.prefix) {
					for (const definition of epoch.definitionSnapshots ?? []) {
						if (!frozenByName.has(definition.name)) frozenByName.set(definition.name, definition);
					}
				}
				const definitions = changed.map((name) => {
					const tool = catalog.byName.get(name);
					if (!tool || !catalog.allowed(tool)) {
						throw new Error(`Tool "${name}" is no longer available for loading.`);
					}
					return tool;
				});
				definitionSnapshotRef = await putPrefixToolDefinitions(
					definitions.flatMap((tool) => {
						// Authorization is live, but reloading a name cannot revise its first declaration.
						const frozen = frozenByName.get(tool.name);
						return frozen ? [frozen] : snapshotToolDefinitions([tool]);
					}),
					context?.signal,
				);
			}
			if (group.marker) {
				if (loaded) current.add(group.marker);
				else current.delete(group.marker);
				for (const name of group.toolNames) current.delete(name);
			} else {
				for (const name of group.toolNames) {
					if (loaded) current.add(name);
					else current.delete(name);
				}
			}

			const noticeLocale: Locale = (context?.locale ?? locale) === "zh-CN" ? "zh-CN" : "en";
			const block = {
				type: loaded ? ("tool_loaded" as const) : ("tool_unloaded" as const),
				toolName: group.id,
				toolNames: changed,
				...(definitionSnapshotRef ? { definitionSnapshotRef } : {}),
				text: loaded
					? getToolMessageWithParams("toolLoaded", noticeLocale, {
							toolName: group.id,
							toolDescription: localizedGroupDescription(group, noticeLocale).slice(0, 2048),
						})
					: getToolMessageWithParams("toolUnloaded", noticeLocale, { toolName: group.id }),
			};
			context?.signal.throwIfAborted();
			context?.assertFinalExecutionPermission?.();
			const { withPrefixSnapshotPublication } = await import("./narrator-prefix-snapshots");
			const msg = await withPrefixSnapshotPublication(
				definitionSnapshotRef ? [definitionSnapshotRef] : [],
				() => {
					context?.assertFinalExecutionPermission?.();
					return narratorStore.appendToolChange(narratorId, block, undefined, [...current]);
				},
				context?.signal,
			);
			if (group.marker) {
				const selection = parseMcpToolMarker(group.marker);
				const serverId = parseMcpServerMarker(group.marker);
				const previousNames = selection
					? [selection.canonicalName]
					: catalog.tools
							.filter((tool) => tool.metadata?.mcpServerId === serverId)
							.map((tool) => tool.name);
				updateActiveLoadedTools(narratorId, [group.marker, ...previousNames], false);
				if (loaded) updateActiveLoadedTools(narratorId, [group.marker, ...group.toolNames], true);
			} else {
				updateActiveLoadedTools(narratorId, group.toolNames, loaded);
			}
			broadcastToNarrator(narratorId, {
				type: "user_message",
				narratorId,
				message: {
					id: msg.id,
					narratorId,
					role: "user",
					contentJson: msg.contentJson,
					contentText: msg.contentText,
					createdAt: msg.createdAt,
					children: [],
				},
			});
			return loaded ? "loaded" : "unloaded";
		},
		context?.signal,
	);
}
