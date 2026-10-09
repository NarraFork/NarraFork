import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import type { ExecutionBackend } from "../../lib/agent/execution/backend";
import { localBackend } from "../../lib/agent/execution/registry";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { AgentConfig, ToolCallBinding } from "../../lib/agent/types";
import { narraforkDir, saveSettings, settings } from "../../lib/settings";
import { createExecutionTargetContext } from "../execution-policy/target-context";

const sqlite = new Database(":memory:");
const dialect = new SQLiteSyncDialect();
const tableNames: string[] = [];
// Build a test-only in-memory schema from the typed declarations. This worktree
// intentionally has no migration directory; never generate or migrate the real DB.
for (const table of Object.values(schema)) {
	let config: ReturnType<typeof getTableConfig>;
	try {
		config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
	} catch {
		continue;
	}
	if (!config?.name || !config.columns) continue;
	tableNames.push(config.name);
	const definitions = config.columns.map((column) => {
		const value = column.default;
		const defaultSql =
			value === undefined
				? ""
				: ` DEFAULT ${typeof value === "object" && value !== null && "queryChunks" in value ? dialect.sqlToQuery(value as Parameters<typeof dialect.sqlToQuery>[0]).sql : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : typeof value === "boolean" ? Number(value) : value === null ? "NULL" : typeof value === "object" ? `'${JSON.stringify(value).replaceAll("'", "''")}'` : value}`;
		return `${column.name} ${column.getSQLType()} ${column.primary ? "PRIMARY KEY" : ""}${defaultSql}`;
	});
	sqlite.run(`CREATE TABLE IF NOT EXISTS ${config.name} (${definitions.join(",")})`);
}
sqlite.run(
	"CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_rule_request_attempt ON permission_rule_requests(tool_call_id,attempt)",
);
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
function cleanDb() {
	for (const name of tableNames) sqlite.run(`DELETE FROM ${name}`);
}
for (const statement of [
	"ALTER TABLE narrators ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE narrators ADD COLUMN workspace_context TEXT",
	...["narrator_whitelist_dirs", "narrator_blacklist_dirs"].flatMap((table) => [
		`ALTER TABLE ${table} ADD COLUMN path_flavor TEXT`,
		`ALTER TABLE ${table} ADD COLUMN path_key TEXT`,
	]),
	...[
		"narrator_whitelist_dirs",
		"narrator_blacklist_dirs",
		"narrator_whitelist_cmds",
		"narrator_blacklist_cmds",
	].flatMap((table) => [
		`ALTER TABLE ${table} ADD COLUMN target_kind TEXT`,
		`ALTER TABLE ${table} ADD COLUMN target_value TEXT`,
		`ALTER TABLE ${table} ADD COLUMN updated_at TEXT`,
	]),
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_path_flavor TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN canonical_file_path TEXT",
	"ALTER TABLE narrator_tool_calls ADD COLUMN runtime_generation INTEGER",
	"ALTER TABLE narrator_tool_calls ADD COLUMN execution_targets_json TEXT",
]) {
	try {
		sqlite.run(statement);
	} catch (error) {
		if (!String(error).includes("duplicate column name")) throw error;
	}
}
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
const wsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({ ...wsModule, broadcastToNarrator: () => {} }));
const narratorModule = { ...(await import("../narrator-service")) };
mock.module("../narrator-service", () => ({
	...narratorModule,
	narratorService: { ...narratorModule.narratorService, updateStatus: async () => {} },
}));
const service = await import("../permission-rule-request-service");
const permission = await import("../narrator-permission");
test("explicit worktree tools enforce destination write ACLs without expanding receipt paths", () => {
	for (const toolName of ["ListWorktrees", "GetWorktreeOperation"]) {
		const input = toolName === "ListWorktrees" ? {} : { operationId: "receipt" };
		expect(permission.extractToolPaths(toolName, input)).toEqual([]);
		for (const permMode of ["default", "readOnly"] as const) {
			expect(
				permission.resolvePermissionDecision({ toolName, input, permMode, cwd: "/local/work" }),
			).toBe("allow");
		}
		expect(
			permission.resolvePermissionDecision({
				toolName,
				input,
				permMode: "bypassPermissions",
				planMode: true,
				cwd: "/local/work",
			}),
		).toBe("allow");
	}
	for (const toolName of ["CreateWorktree", "AttachWorktree"]) {
		const opts = {
			toolName,
			input: { branchName: "feature", destinationPath: "/outside/worktree" },
			cwd: "/local/work",
		};
		expect(permission.extractToolPaths(toolName, opts.input)).toEqual(["/outside/worktree"]);
		expect(
			permission.resolvePermissionDecision({
				...opts,
				permMode: "bypassPermissions",
				blacklistDirs: [{ path: "/outside", denyLevel: "denyWrite", enabled: true }],
			}),
		).toBe("deny");
		expect(
			permission.resolvePermissionDecision({
				...opts,
				permMode: "default",
				whitelistDirs: [{ path: "/outside", accessLevel: "readOnly", enabled: true }],
			}),
		).toBe("ask");
		expect(
			permission.resolvePermissionDecision({
				...opts,
				permMode: "default",
				whitelistDirs: [{ path: "/outside", accessLevel: "readWrite", enabled: true }],
			}),
		).toBe("allow");
		expect(
			permission.resolvePermissionDecision({
				...opts,
				input: { ...opts.input, destinationPath: "/local/work/.git/new" },
				permMode: "bypassPermissions",
			}),
		).toBe("deny");
		for (const permMode of [
			"default",
			"acceptEdits",
			"readOnly",
			"dontAsk",
			"bypassPermissions",
		] as const) {
			expect(permission.resolvePermissionDecision({ ...opts, permMode })).toBe(
				permission.resolvePermissionDecision({
					...opts,
					toolName: "Worktree",
					input: { action: "create" },
					permMode,
				}),
			);
		}
		expect(
			permission.resolvePermissionDecision({
				...opts,
				permMode: "bypassPermissions",
				reviewReadOnlyBash: true,
			}),
		).toBe("deny");
		expect(
			permission.resolvePermissionDecision({
				...opts,
				permMode: "bypassPermissions",
				planMode: true,
			}),
		).toBe("deny");
	}
});
const { requestPermissionRuleTool } = await import("../../lib/agent/tools/request-permission-rule");
const { toolRegistry, resolveToolJsonSchema, zodToJsonSchema } = await import(
	"../../lib/agent/tool-registry"
);
toolRegistry.register(requestPermissionRuleTool);
const { pendingPermissions, pendingDangerReflections } = await import("../narrator-session-state");
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { executionPolicyRepository } = await import("../execution-policy/repository");
const { permissionRuleService } = await import("../permission-rule-service");
const { isPermissionRuleAutoApproveMutation, narraforkAdminTool } = await import(
	"../../lib/agent/tools/narrafork-admin"
);
const { dangerConfirmTool, dangerCancelTool } = await import(
	"../../lib/agent/tools/danger-reflection"
);
let reflectionScenario: "confirm" | "text" | "throw" | "cancel" | "confirmError" = "confirm";
const providerModule = { ...(await import("../../lib/agent/provider")) };
const fakeProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		if (reflectionScenario === "throw") throw new Error("strict provider exploded");
		if (reflectionScenario === "text") {
			yield { text: "<DangerConfirm> I confirm this operation. </DangerConfirm>" };
			return;
		}
		yield {
			toolUses: [
				{
					name: reflectionScenario === "cancel" ? "DangerCancel" : "DangerConfirm",
					toolUseId: "real-strict-confirm",
					input: { confirm: true, reflection: "Single scoped rule needed for the task" },
				},
			],
		};
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
mock.module("../../lib/agent/provider", () => ({
	...providerModule,
	getProvider: () => fakeProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: fakeProvider,
		model: "test:model",
	}),
}));
const { resolveDangerReflectionDecision } = await import("../../lib/agent/loop");
toolRegistry.register(dangerCancelTool);
toolRegistry.register({
	...dangerConfirmTool,
	async execute(args, ctx) {
		const result = await dangerConfirmTool.execute(args, ctx);
		if (reflectionScenario === "confirmError")
			throw new Error("Decision tool crashed after recording candidate");
		return result;
	},
});
const { executeTool } = await import("../../lib/agent/tool-executor");
const { buildFinalToolStartAuthorization } = await import("../tool-final-start-authorization");
const { narratorPersistence } = await import("../narrator-persistence");
const finalTestDirectories: string[] = [];
for (const withHook of [true, false]) {
	test(`real executor validation ${withHook ? "uses tool feedback hook" : "retains default feedback"} without dispatch`, async () => {
		const name = withHook
			? "__ValidationFeedbackFixtureHook"
			: "__ValidationFeedbackFixtureDefault";
		const execute = mock(async () => ({ output: "must not run" }));
		const formatValidationError = mock(() => "Concrete branchName correction required");
		toolRegistry.register({
			name,
			description: "Validation feedback regression fixture",
			parameters: z.strictObject({ branchName: z.string() }),
			...(withHook ? { formatValidationError } : {}),
			execute,
		});
		try {
			const fixture = await finalExecutionFixture(name, false, undefined, {});
			fixture.config.permissionHandler = async () => ({ behavior: "allow" });
			const result = await executeTool(fixture.tu, fixture.config, {
				toolCallBinding: fixture.binding,
			});
			expect(result.isError).toBe(true);
			expect(result.output).toContain(
				withHook ? "Concrete branchName correction required" : "Invalid parameters:",
			);
			expect(execute).toHaveBeenCalledTimes(0);
			expect(formatValidationError).toHaveBeenCalledTimes(withHook ? 1 : 0);
		} finally {
			toolRegistry.unregister(name);
		}
	});
}
test("provider public tool set exposes four explicit worktree tools and retains hidden legacy execution", () => {
	const names = toolRegistry
		.all()
		.filter((tool) => !tool.isAvailable || tool.isAvailable())
		.map((tool) => tool.name);
	for (const name of ["ListWorktrees", "CreateWorktree", "AttachWorktree", "GetWorktreeOperation"])
		expect(names).toContain(name);
	expect(names).not.toContain("Worktree");
	expect(toolRegistry.get("Worktree")).toBeDefined();
});
test("real provider formatters preserve flat worktree parameters and required fields", async () => {
	const { OpenAIProvider } = await import("../../lib/agent/openai-provider");
	const { AnthropicProvider } = await import("../../lib/agent/anthropic-provider");
	const { GeminiProvider } = await import("../../lib/agent/gemini-provider");
	const config = {
		id: "worktree-schema",
		name: "worktree-schema",
		prefix: "fixture",
		apiKey: "unused",
		baseUrl: "https://example.invalid",
		defaultModel: "fixture",
	};
	const definitions = [
		// Query fields stay optional; only the compatibility placeholder is required.
		{
			name: "ListWorktrees",
			required: ["confirm"],
			properties: ["limit", "cursor", "sort", "order", "search", "confirm"],
		},
		{
			name: "CreateWorktree",
			required: ["branchName", "destinationPath"],
			properties: ["branchName", "destinationPath", "baseRef"],
		},
		{
			name: "AttachWorktree",
			required: ["branchName", "destinationPath"],
			properties: ["branchName", "destinationPath"],
		},
		{ name: "GetWorktreeOperation", required: ["operationId"], properties: ["operationId"] },
	];
	const tools = definitions.map(({ name }) => {
		const tool = toolRegistry.get(name);
		if (!tool || typeof tool.description !== "string") throw new Error(`Missing tool ${name}`);
		return { ...tool, description: tool.description };
	});
	for (const provider of [
		new OpenAIProvider({ ...config, apiMode: "responses" }),
		new OpenAIProvider({ ...config, apiMode: "completions" }),
		new AnthropicProvider(config),
		new GeminiProvider(config),
	]) {
		const formatted = provider.formatTools(tools) as Record<string, unknown>[];
		const declarations = (formatted[0]?.functionDeclarations ?? formatted) as Record<
			string,
			unknown
		>[];
		for (const [index, expected] of definitions.entries()) {
			const entry = declarations[index];
			const declaration = (entry?.function ?? entry) as Record<string, unknown>;
			expect(declaration.name).toBe(expected.name);
			const schema = (declaration.parameters ?? declaration.input_schema ?? {}) as Record<
				string,
				unknown
			>;
			expect(schema.required ?? []).toEqual(expected.required);
			expect(Object.keys((schema.properties ?? {}) as object)).toEqual(expected.properties);
			expect(schema.oneOf).toBeUndefined();
			expect(schema.anyOf).toBeUndefined();
		}
	}
});
const now = () => new Date().toISOString();
let seq = 0;
async function seed(
	mode: "default" | "bypassPermissions" | "readOnly" | "dontAsk" = "default",
	parent?: string,
) {
	const narratorId = `rule-narrator-${++seq}`;
	await db.insert(schema.narrators).values({
		id: narratorId,
		permissionMode: mode,
		cwd: "/tmp",
		variant: parent ? "subagent:general" : "primary",
		parentNarratorId: parent,
		createdAt: now(),
		updatedAt: now(),
	});
	return call(narratorId);
}
async function call(narratorId: string) {
	const id = `rule-call-${++seq}`,
		toolUseId = `use-${seq}`,
		messageId = `message-${seq}`;
	await db
		.insert(schema.narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: now() });
	await db
		.insert(schema.narratorMessageRefs)
		.values({ id: `ref-${seq}`, narratorId, messageId, seq });
	await db.insert(schema.narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId,
		toolName: "RequestPermissionRule",
		status: "pending",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now(),
	});
	const binding: ToolCallBinding = { toolCallId: id, attempt: 1 };
	const context = await createExecutionTargetContext({
		backend: localBackend,
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd: "/tmp",
			selectionSource: "local_default",
		},
	});
	return { narratorId, toolUseId, binding, context };
}
async function finalExecutionFixture(
	kind:
		| "Write"
		| "Bash"
		| "Edit"
		| "StructSed"
		| "Read"
		| "RequestPermissionRule"
		| "Worktree"
		| "__ValidationFeedbackFixtureHook"
		| "__ValidationFeedbackFixtureDefault",
	child: boolean,
	before?: () => Promise<void>,
	overrideInput?: Record<string, unknown>,
) {
	settings.agent.dangerReflectionLevel = "off";
	const directory = mkdtempSync(join(tmpdir(), "narrafork-final-policy-"));
	finalTestDirectories.push(directory);
	const parent = await seed("bypassPermissions");
	const actor = child ? await seed("bypassPermissions", parent.narratorId) : parent;
	await db
		.update(schema.narrators)
		.set({ cwd: directory })
		.where(eq(schema.narrators.id, actor.narratorId));
	const userId = `${actor.narratorId}-owner`;
	await db.insert(schema.users).values({
		id: userId,
		username: userId,
		passwordHash: "not-a-real-password",
		role: "admin",
		createdAt: now(),
	});
	await db
		.update(schema.narrators)
		.set({ ownerUserId: userId })
		.where(eq(schema.narrators.id, actor.narratorId));
	const marker = join(directory, "actual-side-effect.txt");
	const input: Record<string, unknown> =
		overrideInput ??
		(kind === "Write"
			? { file_path: marker, content: "actually written" }
			: { command: `printf actual > '${marker}'`, description: "Write a test marker" });
	await db
		.update(schema.narratorToolCalls)
		.set({ toolName: kind, status: "initializing", inputJson: input })
		.where(eq(schema.narratorToolCalls.id, actor.binding.toolCallId));
	const config: AgentConfig = {
		narratorId: actor.narratorId,
		conversationId: "real-final-policy",
		model: "test:model",
		provider: "test",
		cwd: directory,
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requireToolCallBinding: true,
		permissionHandler: async (name, args, id, options) => {
			const result = await permission.handlePermission(
				actor.narratorId,
				config.signal,
				name,
				args,
				id,
				directory,
				"en",
				undefined,
				options,
			);
			if (result.behavior === "allow")
				await db
					.update(schema.narratorToolCalls)
					.set({ inputJson: result.updatedInput ?? args })
					.where(
						eq(
							schema.narratorToolCalls.id,
							options?.toolCallBinding?.toolCallId ?? actor.binding.toolCallId,
						),
					);
			return result;
		},
		onExecutionTargetResolved: (id, target, binding) =>
			narratorPersistence.updateToolCallExecutionTarget(actor.narratorId, id, target, binding),
		onExecutionPlanResolved: (id, plan, binding) =>
			narratorPersistence.updateToolCallExecutionPlan(actor.narratorId, id, plan, binding),
		onToolExecutionStarting: (id, binding, startedAt) =>
			narratorPersistence.claimToolCallExecution(actor.narratorId, id, binding, startedAt),
		onToolExecutionBefore: before,
	};
	config.onToolExecutionFinalAuthorization = buildFinalToolStartAuthorization(config);
	return {
		actor,
		parent,
		config,
		marker,
		directory,
		tu: { name: kind, toolUseId: actor.toolUseId, input },
		binding: actor.binding,
	};
}
async function installRealOAuthFinalAuthority(
	fixture: Awaited<ReturnType<typeof finalExecutionFixture>>,
) {
	const userId = fixture.config.userId;
	if (!userId) throw new Error("missing fixture owner");
	const clientId = `${fixture.actor.narratorId}-client`,
		grantId = `${fixture.actor.narratorId}-grant`,
		deviceId = `${fixture.actor.narratorId}-device`,
		projectId = `${fixture.actor.narratorId}-project`;
	const policy = {
		defaultPermissionMode: "bypassPermissions" as const,
		allowedPermissionModes: ["bypassPermissions" as const],
		systemPromptMode: "append" as const,
		maxSystemPromptChars: 100,
		allowGlobalDevice: true,
		allowKnowledgeWrite: false,
		allowDangerReflectionPrompt: false,
		maxDangerReflectionPromptChars: 0,
		allowRobotDiagnosticPreset: false,
		deviceAccess: {
			host: "readWrite" as const,
			global: "readWrite" as const,
			selfRegistered: "readWrite" as const,
		},
		messageDetail: "summary" as const,
	};
	await db
		.insert(schema.projects)
		.values({ id: projectId, name: "OAuth final policy", createdAt: now(), updatedAt: now() });
	await db.insert(schema.oauthClients).values({
		id: clientId,
		clientId,
		name: "Final policy client",
		redirectUris: [],
		scopes: ["narrator.send_message"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		policyJson: policy,
		createdBy: userId,
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(schema.oauthGrants).values({
		id: grantId,
		oauthClientId: clientId,
		userId,
		scopes: ["narrator.send_message"],
		policyJson: policy,
		createdAt: now(),
		updatedAt: now(),
	});
	const { integrationAuthorityService } = await import("../integration-authority-service");
	const { integrationResourceBindingService } = await import(
		"../integration-resource-binding-service"
	);
	await integrationAuthorityService.create({
		id: grantId,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: clientId,
		sourceGrantId: grantId,
		ownerUserId: userId,
		policyJson: policy,
		grants: [
			{
				capabilityId: "narrator.send_message",
				scope: { type: "project", id: projectId },
				createdBy: { type: "user", id: userId },
			},
		],
	});
	await db.insert(schema.remoteDevices).values({
		id: deviceId,
		name: "Final authority device",
		slug: deviceId,
		tokenHash: "not-a-real-token",
		tokenPrefix: "test",
		connectionMode: "reverse",
		status: "offline",
		scope: "global",
		createdBy: userId,
		createdAt: now(),
		updatedAt: now(),
	});
	for (const [resourceType, resourceId] of [
		["device", deviceId],
		["narrator", fixture.actor.narratorId],
	] as const)
		await integrationResourceBindingService.create({
			resourceType,
			resourceId,
			sourceType: "oauth_client",
			sourceId: clientId,
			authorityType: "oauth_grant",
			authorityId: grantId,
			state: "active",
		});
	await db
		.update(schema.narrators)
		.set({
			defaultDeviceId: deviceId,
			oauthPolicySnapshotJson: {
				version: 3,
				policy,
				permissionMode: "bypassPermissions",
				deviceIds: [deviceId],
				defaultDeviceId: deviceId,
				systemPrompt: "",
			},
		})
		.where(eq(schema.narrators.id, fixture.actor.narratorId));
	fixture.config.defaultDeviceId = deviceId;
	fixture.config.allowLocalExecution = true;
	fixture.tu.input.device = "local";
	await db
		.update(schema.narratorToolCalls)
		.set({ inputJson: fixture.tu.input })
		.where(eq(schema.narratorToolCalls.id, fixture.binding.toolCallId));
	const { assertOAuthNarratorRuntimeActive } = await import("../oauth-narrator-runtime-policy");
	fixture.config.permissionHandler = async (name, args, id, options) => {
		const runtime = await assertOAuthNarratorRuntimeActive(fixture.actor.narratorId, userId);
		if (!runtime) throw new Error("OAuth runtime absent");
		const result = await permission.handlePermission(
			fixture.actor.narratorId,
			fixture.config.signal,
			name,
			args,
			id,
			fixture.directory,
			"en",
			undefined,
			options,
			undefined,
			{
				permissionMode: runtime.permissionMode,
				allowKnowledgeWrite: runtime.allowKnowledgeWrite,
				useRobotDiagnosticPreset: runtime.useRobotDiagnosticPreset,
				deviceAccess: runtime.policy.deviceAccess,
				oauthClientId: runtime.clientId,
				grantId: runtime.grantId,
			},
		);
		if (result.behavior === "allow")
			await db
				.update(schema.narratorToolCalls)
				.set({ inputJson: result.updatedInput ?? args })
				.where(eq(schema.narratorToolCalls.id, fixture.binding.toolCallId));
		return result;
	};
	return {
		grantId,
		clientId,
		assertActive: () => assertOAuthNarratorRuntimeActive(fixture.actor.narratorId, userId),
	};
}
async function seedChapterDenyProject() {
	await db.insert(schema.projects).values({
		id: "chapter-policy-project",
		name: "Chapter policy",
		gitPath: "/tmp/chapter-policy-repository",
		chapterSettings: {
			commandWhitelist: [{ pattern: "pwd", enabled: true }],
			commandBlacklist: [{ pattern: "pwd", enabled: true }],
			whitelistDirs: [{ path: "/tmp", accessLevel: "full", enabled: true }],
			blacklistDirs: [{ path: "/tmp/chapter-policy-private", denyLevel: "denyAll", enabled: true }],
		},
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(schema.chapters).values({
		id: "policy-chapter",
		projectId: "chapter-policy-project",
		title: "Policy",
		branch: "policy",
		baseBranch: "main",
		createdAt: now(),
		updatedAt: now(),
	});
}
async function expectProjectPolicyDeny(
	narratorId: string,
	toolName: "Bash" | "Read",
	input: Record<string, unknown>,
) {
	const identity = await call(narratorId);
	await db
		.update(schema.narratorToolCalls)
		.set({ toolName, inputJson: input })
		.where(eq(schema.narratorToolCalls.id, identity.binding.toolCallId));
	const decision = await permission.handlePermission(
		narratorId,
		new AbortController().signal,
		toolName,
		input,
		identity.toolUseId,
		"/tmp",
		"en",
		undefined,
		{
			toolCallBinding: identity.binding,
			executionBackend: identity.context.backend,
			executionTarget: identity.context.target,
		},
	);
	expect(decision.behavior).toBe("deny");
	const stored = db
		.select({
			status: schema.narratorToolCalls.status,
			reason: schema.narratorToolCalls.permissionDecisionReason,
		})
		.from(schema.narratorToolCalls)
		.where(eq(schema.narratorToolCalls.id, identity.binding.toolCallId))
		.get();
	expect(stored?.status).toBe("fail");
	expect(stored?.reason).toContain("project");
}
const proposal = {
	ruleType: "commandWhitelist" as const,
	pattern: "pwd",
	reason: "Read project state",
	scope: "narrator" as const,
};
const count = () =>
	[
		schema.narratorWhitelistDirs,
		schema.narratorBlacklistDirs,
		schema.narratorWhitelistCmds,
		schema.narratorBlacklistCmds,
	].reduce((sum, table) => sum + db.select({ id: table.id }).from(table).all().length, 0);
afterEach(() => {
	for (const pending of pendingPermissions.values()) pending.cleanup();
	for (const pending of pendingDangerReflections.values()) pending.cleanup();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	executionPolicyEngine.clear();
	for (const directory of finalTestDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	cleanDb();
});
afterAll(() => {
	mock.restore();
	sqlite.close();
});

async function waitForManual(id: string) {
	for (let i = 0; i < 100; i++) {
		if (pendingPermissions.has(id)) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Manual request was not registered");
}
async function start(identity: Awaited<ReturnType<typeof seed>>, input: Record<string, unknown>) {
	return permission.handlePermission(
		identity.narratorId,
		new AbortController().signal,
		"RequestPermissionRule",
		input,
		identity.toolUseId,
		"/tmp",
		"en",
		undefined,
		{
			toolCallBinding: identity.binding,
			executionBackend: identity.context.backend,
			executionTarget: identity.context.target,
		},
	);
}
describe("permission request tool schema compatibility", () => {
	test("exports an object root without dropping discriminated union constraints", () => {
		const original = zodToJsonSchema(service.requestPermissionRuleSchema);
		const exported = resolveToolJsonSchema(requestPermissionRuleTool);
		expect(exported.type).toBe("object");
		expect(exported).toEqual({ ...original, type: "object" });
		expect(exported.anyOf).toHaveLength(4);
	});

	test("runtime validation still accepts all four rule types and rejects unsafe inputs", () => {
		const reason = "Schema compatibility regression test";
		for (const input of [
			{ reason, ruleType: "directoryWhitelist", path: "/workspace", accessLevel: "readOnly" },
			{ reason, ruleType: "directoryBlacklist", path: "/workspace", denyLevel: "denyAll" },
			{ reason, ruleType: "commandWhitelist", pattern: "bun test *" },
			{ reason, ruleType: "commandBlacklist", pattern: "rm *" },
		]) {
			expect(requestPermissionRuleTool.parameters.safeParse(input).success).toBe(true);
		}
		for (const input of [
			{ reason, ruleType: "commandWhitelist" },
			{ reason, ruleType: "commandWhitelist", pattern: "bun test *", path: "/workspace" },
			{ reason, ruleType: "directoryWhitelist", path: "/workspace", accessLevel: "invalid" },
			{ reason, scope: "project", ruleType: "commandWhitelist", pattern: "bun test *" },
		]) {
			expect(requestPermissionRuleTool.parameters.safeParse(input).success).toBe(false);
		}
	});
});

describe("attempt-bound permission requests", () => {
	for (const kind of ["Write", "Edit", "StructSed"] as const)
		for (const symlink of [false, true])
			test(`bypass real ${kind} cannot persist host security settings${symlink ? " through symlink" : ""}`, async () => {
				saveSettings(structuredClone(settings));
				const configuration = join(narraforkDir, "settings.json");
				const original = readFileSync(configuration, "utf8");
				const fixture = await finalExecutionFixture(kind, false);
				const path = symlink ? join(fixture.directory, "alias.json") : configuration;
				if (symlink) symlinkSync(configuration, path);
				if (kind === "Edit") {
					const read = await call(fixture.actor.narratorId);
					const input = { file_path: path, offset: 1, limit: 2 };
					await db
						.update(schema.narratorToolCalls)
						.set({ toolName: "Read", inputJson: input })
						.where(eq(schema.narratorToolCalls.id, read.binding.toolCallId));
					expect(
						(
							await executeTool(
								{ name: "Read", toolUseId: read.toolUseId, input },
								fixture.config,
								{ toolCallBinding: read.binding },
							)
						).isError,
					).not.toBe(true);
				}
				fixture.tu.input =
					kind === "Write"
						? { file_path: path, content: '{"agent":{"permissionRuleAutoApprove":true}}' }
						: kind === "Edit"
							? {
									file_path: path,
									old_string: '"permissionRuleAutoApprove": false',
									new_string: '"permissionRuleAutoApprove": true',
								}
							: {
									file_path: path,
									command: "replace",
									address: "1,$",
									content: '{"agent":{"permissionRuleAutoApprove":true}}',
									dry_run: false,
								};
				await db
					.update(schema.narratorToolCalls)
					.set({ inputJson: fixture.tu.input })
					.where(eq(schema.narratorToolCalls.id, fixture.binding.toolCallId));
				const result = await executeTool(fixture.tu, fixture.config, {
					toolCallBinding: fixture.binding,
				});
				expect(result.isError).toBe(true);
				expect(result.output).toContain("host security settings");
				expect(readFileSync(configuration, "utf8")).toBe(original);
			});

	test("host settings Read and trusted saveSettings remain available; repository settings Write is unrelated", async () => {
		settings.agent.permissionRuleAutoApprove = true;
		saveSettings(structuredClone(settings));
		expect(
			JSON.parse(readFileSync(join(narraforkDir, "settings.json"), "utf8")).agent
				.permissionRuleAutoApprove,
		).toBe(true);
		const reader = await finalExecutionFixture("Read", false, undefined, {
			file_path: join(narraforkDir, "settings.json"),
			offset: 1,
			limit: 2,
		});
		expect(
			(await executeTool(reader.tu, reader.config, { toolCallBinding: reader.binding })).isError,
		).not.toBe(true);
		const writer = await finalExecutionFixture("Write", false);
		writer.tu.input.file_path = join(writer.directory, "settings.json");
		await db
			.update(schema.narratorToolCalls)
			.set({ inputJson: writer.tu.input })
			.where(eq(schema.narratorToolCalls.id, writer.binding.toolCallId));
		expect(
			(await executeTool(writer.tu, writer.config, { toolCallBinding: writer.binding })).isError,
		).not.toBe(true);
		expect(readFileSync(String(writer.tu.input.file_path), "utf8")).toBe("actually written");
	});

	test("trusted human settings PATCH can still enable opt-in", async () => {
		const { Hono } = await import("hono");
		const { settingsRoutes } = await import("../../routes/settings");
		const app = new Hono<{ Variables: { user: { sub: string; role: string } } }>();
		app.use("*", async (c, next) => {
			c.set("user", { sub: "trusted-human", role: "admin" });
			await next();
		});
		app.route("/settings", settingsRoutes);
		settings.agent.permissionRuleAutoApprove = false;
		const response = await app.request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: { permissionRuleAutoApprove: true } }),
		});
		expect(response.status).toBe(200);
		expect(settings.agent.permissionRuleAutoApprove).toBe(true);
		expect(
			JSON.parse(readFileSync(join(narraforkDir, "settings.json"), "utf8")).agent
				.permissionRuleAutoApprove,
		).toBe(true);
	});

	test("another device's identical settings path is allowed by actual permission handling", async () => {
		const identity = await seed("bypassPermissions");
		const path = join(narraforkDir, "settings.json");
		const backend = {
			...localBackend,
			kind: "remote" as const,
			deviceId: "isolated-device",
			platform: { ...localBackend.platform, os: "linux", shellType: "bash" },
			paths: localBackend.paths,
			runtimeGeneration: localBackend.runtimeGeneration,
			resolvePathIdentity: (path: string) => localBackend.resolvePathIdentity(path),
		} as ExecutionBackend;
		const context = await createExecutionTargetContext({
			backend,
			target: {
				...identity.context.target,
				deviceId: "isolated-device",
				backendKind: "remote",
				resolvedFilePath: path,
			},
		});
		await db
			.update(schema.narratorToolCalls)
			.set({ toolName: "Write", inputJson: { file_path: path, content: "remote config" } })
			.where(eq(schema.narratorToolCalls.id, identity.binding.toolCallId));
		const result = await permission.handlePermission(
			identity.narratorId,
			new AbortController().signal,
			"Write",
			{ file_path: path, content: "remote config" },
			identity.toolUseId,
			"/tmp",
			"en",
			undefined,
			{
				toolCallBinding: identity.binding,
				executionBackend: backend,
				executionTarget: context.target,
			},
		);
		expect(result.behavior).toBe("allow");
	});

	for (const mode of ["readOnly", "dontAsk"] as const)
		for (const value of [
			{ ruleType: "directoryWhitelist", path: "/tmp", accessLevel: "full" },
			{ ruleType: "directoryBlacklist", path: "/tmp", denyLevel: "denyWrite" },
			{ ruleType: "commandWhitelist", pattern: "pwd" },
			{ ruleType: "commandBlacklist", pattern: "rm *", denyPrompt: "Do not delete" },
		])
			test(`production ${mode} explicit human ${value.ruleType} receipt reaches applied`, async () => {
				const fixture = await finalExecutionFixture("RequestPermissionRule", false, undefined, {
					...value,
					reason: "Human scoped decision",
				});
				await db
					.update(schema.narrators)
					.set({ permissionMode: mode })
					.where(eq(schema.narrators.id, fixture.actor.narratorId));
				const running = executeTool(fixture.tu, fixture.config, {
					toolCallBinding: fixture.binding,
				});
				await waitForManual(fixture.binding.toolCallId);
				expect(
					await permission.resolvePermission(fixture.binding.toolCallId, "allow", {
						decidedBy: "user",
						userId: fixture.config.userId ?? undefined,
					}),
				).toBe(true);
				const result = await running;
				expect(result.isError).not.toBe(true);
				expect(JSON.parse(result.output).status).toBe("applied");
				expect(count()).toBe(1);
			});

	for (const mode of ["readOnly", "dontAsk"] as const)
		test(`production ${mode} stale human receipt cannot authorize rule creation`, async () => {
			const fixture = await finalExecutionFixture(
				"RequestPermissionRule",
				false,
				async () => {
					await db
						.update(schema.narrators)
						.set({ permissionMode: "default" })
						.where(eq(schema.narrators.id, fixture.actor.narratorId));
				},
				proposal,
			);
			await db
				.update(schema.narrators)
				.set({ permissionMode: mode })
				.where(eq(schema.narrators.id, fixture.actor.narratorId));
			const running = executeTool(fixture.tu, fixture.config, { toolCallBinding: fixture.binding });
			await waitForManual(fixture.binding.toolCallId);
			await permission.resolvePermission(fixture.binding.toolCallId, "allow", {
				decidedBy: "user",
				userId: fixture.config.userId ?? undefined,
			});
			expect((await running).isError).toBe(true);
			expect(count()).toBe(0);
		});

	for (const strictPlan of [false, true])
		test(`production Worktree list is read-only${strictPlan ? " in strict plan" : ""}; create and malformed actions fail closed`, async () => {
			const { workspaceContextService } = await import("../workspace-context-service");
			const fixture = await finalExecutionFixture("Worktree", false, undefined, {
				action: "list",
				workspaceKey: "placeholder",
			});
			await db
				.update(schema.narrators)
				.set({ cwd: process.cwd(), permissionMode: "readOnly", traits: strictPlan ? ["plan"] : [] })
				.where(eq(schema.narrators.id, fixture.actor.narratorId));
			fixture.config.cwd = process.cwd();
			const context = await workspaceContextService.get(fixture.actor.narratorId);
			if (!context.git) throw new Error("Test requires the current repository worktree");
			fixture.tu.input.workspaceKey = context.git.workspaceKey;
			await db
				.update(schema.narratorToolCalls)
				.set({ inputJson: fixture.tu.input })
				.where(eq(schema.narratorToolCalls.id, fixture.binding.toolCallId));
			const result = await executeTool(fixture.tu, fixture.config, {
				toolCallBinding: fixture.binding,
			});
			expect(result.isError).not.toBe(true);
			expect(
				JSON.parse(result.output).entries.some(
					(entry: { path: string }) => entry.path === process.cwd(),
				),
			).toBe(true);
			for (const action of ["create", "unknown", null, {}]) {
				const other = await finalExecutionFixture("Worktree", false, undefined, {
					action,
					workspaceKey: context.git.workspaceKey,
					expectedRevision: 0,
					requestId: "read-only-create",
					destinationPath: join(fixture.directory, "never-created"),
					branch: { kind: "new", name: "never-created" },
				});
				await db
					.update(schema.narrators)
					.set({ permissionMode: "readOnly" })
					.where(eq(schema.narrators.id, other.actor.narratorId));
				expect(
					(await executeTool(other.tu, other.config, { toolCallBinding: other.binding })).isError,
				).toBe(true);
				expect(existsSync(String(other.tu.input.destinationPath))).toBe(false);
			}
		});

	test("dedicated rule request does not bypass strict plan ceiling", async () => {
		const fixture = await finalExecutionFixture(
			"RequestPermissionRule",
			false,
			undefined,
			proposal,
		);
		await db
			.update(schema.narrators)
			.set({ permissionMode: "readOnly", traits: ["plan"], relaxedPlan: false })
			.where(eq(schema.narrators.id, fixture.actor.narratorId));
		const result = await executeTool(fixture.tu, fixture.config, {
			toolCallBinding: fixture.binding,
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Strict plan");
		expect(count()).toBe(0);
	});

	for (const corruption of ["cancel", "fake", "newdeny", "reflectionOff"] as const)
		test(`production final dedicated receipt fails closed after ${corruption}`, async () => {
			let fixture: Awaited<ReturnType<typeof finalExecutionFixture>>;
			fixture = await finalExecutionFixture(
				"RequestPermissionRule",
				false,
				async () => {
					const requestId = `${fixture.binding.toolCallId}:${fixture.binding.attempt}`;
					if (corruption === "cancel")
						service.terminatePermissionRuleRequest({
							narratorId: fixture.actor.narratorId,
							toolCallId: fixture.binding.toolCallId,
							attempt: 1,
							status: "cancelled",
							reason: "Human revoked approval before execution",
						});
					if (corruption === "fake")
						await db
							.update(schema.permissionRuleRequests)
							.set({ approvalUserId: null })
							.where(eq(schema.permissionRuleRequests.id, requestId));
					if (corruption === "reflectionOff") {
						await db
							.update(schema.permissionRuleRequests)
							.set({ approvalSource: "reflection", approvalUserId: null })
							.where(eq(schema.permissionRuleRequests.id, requestId));
						settings.agent.permissionRuleAutoApprove = false;
					}
					if (corruption === "newdeny")
						await permissionRuleService.createNarratorRule(fixture.actor.narratorId, {
							ruleType: "directoryBlacklist",
							value: {
								path: fixture.directory,
								denyLevel: "denyWrite",
								selector: { kind: "host" },
							},
						});
				},
				proposal,
			);
			fixture.tu.input = {
				ruleType: "directoryWhitelist",
				path: fixture.directory,
				accessLevel: "full",
				reason: "Scoped directory request",
			};
			await db
				.update(schema.narratorToolCalls)
				.set({ inputJson: fixture.tu.input })
				.where(eq(schema.narratorToolCalls.id, fixture.binding.toolCallId));
			const running = executeTool(fixture.tu, fixture.config, { toolCallBinding: fixture.binding });
			await waitForManual(fixture.binding.toolCallId);
			await permission.resolvePermission(fixture.binding.toolCallId, "allow", {
				decidedBy: "user",
				userId: fixture.config.userId ?? undefined,
			});
			const result = await running;
			expect(result.isError).toBe(true);
			expect(count()).toBe(corruption === "newdeny" ? 1 : 0);
			if (corruption === "newdeny") {
				// executeTool's real terminal hook already closed the approved receipt; a
				// delayed duplicate callback must not rewrite the durable failure.
				expect(
					service.terminatePermissionRuleRequest({
						narratorId: fixture.actor.narratorId,
						toolCallId: fixture.binding.toolCallId,
						attempt: fixture.binding.attempt,
						status: "failed",
						reason: result.output,
					}),
				).toBe(false);
				const failed = db
					.select()
					.from(schema.permissionRuleRequests)
					.where(
						eq(
							schema.permissionRuleRequests.id,
							`${fixture.binding.toolCallId}:${fixture.binding.attempt}`,
						),
					)
					.get();
				expect(failed?.status).toBe("failed");
				expect(failed?.approvalSource).toBe("user");
				expect(failed?.error).toMatch(/blacklist/i);
			}
		});

	test("consumption racing terminal CAS cannot leave a rule", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(
			prepared.requestId,
			"allow",
			"user",
			"actual-human",
		);
		const consuming = service.consumePermissionRuleRequest(
			identity,
			prepared.input,
			identity.context,
		);
		expect(
			service.terminatePermissionRuleRequest({
				narratorId: identity.narratorId,
				toolCallId: identity.binding.toolCallId,
				attempt: 1,
				status: "cancelled",
				reason: "Cancelled during live validation",
			}),
		).toBe(true);
		await expect(consuming).rejects.toThrow();
		expect(count()).toBe(0);
		expect(
			db
				.select()
				.from(schema.permissionRuleRequests)
				.where(eq(schema.permissionRuleRequests.id, prepared.requestId))
				.get()?.status,
		).toBe("cancelled");
	});

	test("exact attempt terminal CAS preserves approval source, retries, and applied receipts", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(
			prepared.requestId,
			"allow",
			"user",
			"actual-human",
		);
		const terminal = {
			narratorId: identity.narratorId,
			toolCallId: identity.binding.toolCallId,
			attempt: 1,
			status: "failed" as const,
			reason: "Latest final deny",
		};
		expect(service.terminatePermissionRuleRequest({ ...terminal, attempt: 2 })).toBe(false);
		expect(service.terminatePermissionRuleRequest(terminal)).toBe(true);
		expect(service.terminatePermissionRuleRequest({ ...terminal, status: "cancelled" })).toBe(
			false,
		);
		const failed = db
			.select()
			.from(schema.permissionRuleRequests)
			.where(eq(schema.permissionRuleRequests.id, prepared.requestId))
			.get();
		expect(failed?.status).toBe("failed");
		expect(failed?.approvalUserId).toBe("actual-human");
		expect(failed?.error).toBe("Latest final deny");
		const other = await seed();
		const applied = await service.preparePermissionRuleRequest(other, proposal, other.context);
		service.recordPermissionRuleRequestDecision(applied.requestId, "allow", "user", "actual-human");
		await service.consumePermissionRuleRequest(other, applied.input, other.context);
		expect(
			service.terminatePermissionRuleRequest({
				...terminal,
				narratorId: other.narratorId,
				toolCallId: other.binding.toolCallId,
			}),
		).toBe(false);
	});

	test("bounded restart recovery cancels pending and approved but never applied", async () => {
		const pending = await seed();
		const first = await service.preparePermissionRuleRequest(pending, proposal, pending.context);
		const approved = await seed();
		const second = await service.preparePermissionRuleRequest(approved, proposal, approved.context);
		service.recordPermissionRuleRequestDecision(second.requestId, "allow", "user", "actual-human");
		const thirdIdentity = await seed();
		const third = await service.preparePermissionRuleRequest(
			thirdIdentity,
			proposal,
			thirdIdentity.context,
		);
		service.recordPermissionRuleRequestDecision(third.requestId, "allow", "user", "actual-human");
		await service.consumePermissionRuleRequest(thirdIdentity, third.input, thirdIdentity.context);
		let after: string | undefined;
		let terminated = 0;
		do {
			const page = service.recoverPermissionRuleRequests({
				after,
				limit: 1,
				reason: "Server restarted before tool completion",
			});
			terminated += page.terminated;
			after = page.nextCursor;
		} while (after);
		expect(terminated).toBe(2);
		const get = (id: string) =>
			db
				.select()
				.from(schema.permissionRuleRequests)
				.where(eq(schema.permissionRuleRequests.id, id))
				.get();
		expect(get(first.requestId)?.status).toBe("cancelled");
		expect(get(first.requestId)?.approvalSource).toBeNull();
		expect(get(second.requestId)?.approvalUserId).toBe("actual-human");
		expect(get(third.requestId)?.status).toBe("applied");
	});

	test("recovery closes obsolete requests without touching a newer retry; expiry keeps fresh receipts", async () => {
		const identity = await seed();
		const old = await service.preparePermissionRuleRequest(identity, proposal, identity.context);
		await db
			.update(schema.narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(schema.narratorToolCalls.id, identity.binding.toolCallId));
		const retry = { ...identity, binding: { ...identity.binding, attempt: 2 } };
		const fresh = await service.preparePermissionRuleRequest(retry, proposal, retry.context);
		await db
			.update(schema.permissionRuleRequests)
			.set({
				createdAt: new Date(Date.now() - service.PERMISSION_RULE_REQUEST_TTL_MS - 1).toISOString(),
			})
			.where(eq(schema.permissionRuleRequests.id, old.requestId));
		expect(
			service.terminatePermissionRuleRequest({
				narratorId: identity.narratorId,
				toolCallId: identity.binding.toolCallId,
				attempt: 1,
				status: "failed",
				reason: "Late old callback",
			}),
		).toBe(false);
		expect(
			service.recoverPermissionRuleRequests({ expiredOnly: true, reason: "Receipt expired" })
				.terminated,
		).toBe(1);
		const get = (id: string) =>
			db
				.select()
				.from(schema.permissionRuleRequests)
				.where(eq(schema.permissionRuleRequests.id, id))
				.get();
		expect(get(old.requestId)?.status).toBe("cancelled");
		expect(get(fresh.requestId)?.status).toBe("pending");
		expect(
			db
				.select()
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, identity.binding.toolCallId))
				.get()?.executionAttempt,
		).toBe(2);
	});

	test("real startup audit hook cancels pending requests without fabricating human approval", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		const { recoverPermissionRuleRequestAuditsOnStartup } = await import("../narrator-session");
		await recoverPermissionRuleRequestAuditsOnStartup();
		const recovered = db
			.select()
			.from(schema.permissionRuleRequests)
			.where(eq(schema.permissionRuleRequests.id, prepared.requestId))
			.get();
		expect(recovered?.status).toBe("cancelled");
		expect(recovered?.approvalSource).toBeNull();
		expect(recovered?.error).toBe("Interrupted by server restart");
	});

	test("terminal request CAS DB failure leaves no fabricated terminal status", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		sqlite.run(
			"CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON permission_rule_requests WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'terminal storage failed'); END",
		);
		try {
			expect(() =>
				service.terminatePermissionRuleRequest({
					narratorId: identity.narratorId,
					toolCallId: identity.binding.toolCallId,
					attempt: 1,
					status: "failed",
					reason: "Executor error",
				}),
			).toThrow("terminal storage failed");
			expect(
				db
					.select()
					.from(schema.permissionRuleRequests)
					.where(eq(schema.permissionRuleRequests.id, prepared.requestId))
					.get()?.status,
			).toBe("pending");
		} finally {
			sqlite.run("DROP TRIGGER fail_terminal");
		}
	});
	for (const kind of ["Write", "Bash"] as const)
		test(`real production final guard permits actual ${kind} when policy stays authorized`, async () => {
			const fixture = await finalExecutionFixture(kind, false);
			const result = await executeTool(fixture.tu, fixture.config, {
				toolCallBinding: fixture.binding,
			});
			expect(result.isError).not.toBe(true);
			expect(existsSync(fixture.marker)).toBe(true);
		});
	for (const addDeny of [false, true])
		test(`real bound human Write approval ${addDeny ? "cannot override a new deny" : "is preserved without asking again"}`, async () => {
			let enteredResolve = () => {},
				release = () => {};
			const entered = new Promise<void>((resolve) => {
				enteredResolve = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const fixture = await finalExecutionFixture("Write", false, async () => {
				enteredResolve();
				await held;
			});
			await db
				.update(schema.narrators)
				.set({ permissionMode: "default" })
				.where(eq(schema.narrators.id, fixture.actor.narratorId));
			const running = executeTool(fixture.tu, fixture.config, { toolCallBinding: fixture.binding });
			try {
				await waitForManual(fixture.binding.toolCallId);
				expect(
					await permission.resolvePermission(fixture.binding.toolCallId, "allow", {
						decidedBy: "user",
						userId: fixture.config.userId ?? undefined,
					}),
				).toBe(true);
				await entered;
				if (addDeny)
					await permissionRuleService.createNarratorRule(fixture.actor.narratorId, {
						ruleType: "directoryBlacklist",
						value: { path: fixture.directory, selector: { kind: "host" } },
					});
				release();
				const result = await running;
				expect(result.isError === true).toBe(addDeny);
				expect(existsSync(fixture.marker)).toBe(!addDeny);
				expect(pendingPermissions.has(fixture.binding.toolCallId)).toBe(false);
			} finally {
				release();
				await running;
			}
		});
	test("real policy fence rejects a new deny added after async final authorization returns", async () => {
		const fixture = await finalExecutionFixture("Write", false);
		const realFinal = fixture.config.onToolExecutionFinalAuthorization;
		if (!realFinal) throw new Error("missing production final guard");
		fixture.config.onToolExecutionFinalAuthorization = async (context) => {
			const fence = await realFinal(context);
			await permissionRuleService.createNarratorRule(fixture.actor.narratorId, {
				ruleType: "directoryBlacklist",
				value: { path: fixture.directory, selector: { kind: "host" } },
			});
			return fence;
		};
		const result = await executeTool(fixture.tu, fixture.config, {
			toolCallBinding: fixture.binding,
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("authorization changed");
		expect(existsSync(fixture.marker)).toBe(false);
	});
	for (const child of [false, true])
		for (const kind of ["Write", "Bash"] as const)
			test(`real ${child ? "child" : "primary"} ${kind} allowed then snapshot wait rejects new inherited blacklist with zero side effect`, async () => {
				let enteredResolve = () => {},
					release = () => {};
				const entered = new Promise<void>((resolve) => {
					enteredResolve = resolve;
				});
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				const fixture = await finalExecutionFixture(kind, child, async () => {
					enteredResolve();
					await held;
				});
				const running = executeTool(fixture.tu, fixture.config, {
					toolCallBinding: fixture.binding,
				});
				try {
					await Promise.race([
						entered,
						running.then((result) => {
							throw new Error(`Tool finished before snapshot hold: ${result.output}`);
						}),
					]);
					const row = db
						.select({
							decidedBy: schema.narratorToolCalls.permissionDecidedBy,
							status: schema.narratorToolCalls.status,
						})
						.from(schema.narratorToolCalls)
						.where(eq(schema.narratorToolCalls.id, fixture.binding.toolCallId))
						.get();
					expect(row?.decidedBy).toBe("auto");
					expect(row?.status).toBe("running");
					expect(existsSync(fixture.marker)).toBe(false);
					if (kind === "Write")
						await permissionRuleService.createNarratorRule(fixture.parent.narratorId, {
							ruleType: "directoryBlacklist",
							value: { path: fixture.directory, denyLevel: "denyAll", selector: { kind: "host" } },
						});
					else
						await permissionRuleService.createNarratorRule(fixture.parent.narratorId, {
							ruleType: "commandBlacklist",
							value: { pattern: "printf", selector: { kind: "host" } },
						});
					release();
					const result = await running;
					expect(result.isError).toBe(true);
					expect(result.output).toContain("Final tool permission denied");
					expect(existsSync(fixture.marker)).toBe(false);
				} finally {
					release();
					await running;
				}
			});

	for (const kind of ["Write", "Bash"] as const)
		test(`real live OAuth producer executes ${kind} with a valid grant and host capability`, async () => {
			const fixture = await finalExecutionFixture(kind, false);
			const authority = await installRealOAuthFinalAuthority(fixture);
			expect((await authority.assertActive())?.grantId).toBe(authority.grantId);
			const result = await executeTool(fixture.tu, fixture.config, {
				toolCallBinding: fixture.binding,
			});
			expect(result.isError).not.toBe(true);
			expect(existsSync(fixture.marker)).toBe(true);
		});
	for (const kind of ["Write", "Bash"] as const)
		test(`real live OAuth grant does not bypass ${kind} blacklist added during snapshot wait`, async () => {
			let enteredResolve = () => {},
				release = () => {};
			const entered = new Promise<void>((resolve) => {
				enteredResolve = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const fixture = await finalExecutionFixture(kind, false, async () => {
				enteredResolve();
				await held;
			});
			const authority = await installRealOAuthFinalAuthority(fixture);
			const running = executeTool(fixture.tu, fixture.config, { toolCallBinding: fixture.binding });
			try {
				await Promise.race([
					entered,
					running.then((result) => {
						throw new Error(`OAuth finished before hold: ${result.output}`);
					}),
				]);
				expect((await authority.assertActive())?.grantId).toBe(authority.grantId);
				if (kind === "Write")
					await permissionRuleService.createNarratorRule(fixture.actor.narratorId, {
						ruleType: "directoryBlacklist",
						value: { path: fixture.directory, selector: { kind: "host" } },
					});
				else
					await permissionRuleService.createNarratorRule(fixture.actor.narratorId, {
						ruleType: "commandBlacklist",
						value: { pattern: "printf", selector: { kind: "host" } },
					});
				release();
				const result = await running;
				expect(result.isError).toBe(true);
				expect(result.output).toContain("Final tool permission denied");
				expect(existsSync(fixture.marker)).toBe(false);
			} finally {
				release();
				await running;
			}
		});
	test("real OAuth fence rejects authority revocation after asynchronous policy preparation", async () => {
		const fixture = await finalExecutionFixture("Write", false);
		const authority = await installRealOAuthFinalAuthority(fixture);
		const realFinal = fixture.config.onToolExecutionFinalAuthorization;
		if (!realFinal) throw new Error("missing real final guard");
		fixture.config.onToolExecutionFinalAuthorization = async (context) => {
			const fence = await realFinal(context);
			await db
				.update(schema.integrationAuthorities)
				.set({ state: "revoked" })
				.where(eq(schema.integrationAuthorities.id, authority.grantId));
			return fence;
		};
		const result = await executeTool(fixture.tu, fixture.config, {
			toolCallBinding: fixture.binding,
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("OAuth authority was revoked");
		expect(existsSync(fixture.marker)).toBe(false);
	});
	for (const layer of ["global", "project"] as const)
		for (const kind of ["Write", "Bash"] as const)
			test(`real final guard sees latest ${layer} ${kind} blacklist added during snapshot wait`, async () => {
				let enteredResolve = () => {},
					release = () => {};
				const entered = new Promise<void>((resolve) => {
					enteredResolve = resolve;
				});
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				const fixture = await finalExecutionFixture(kind, false, async () => {
					enteredResolve();
					await held;
				});
				if (layer === "project") {
					await db.insert(schema.projects).values({
						id: "final-policy-project",
						name: "Final policy",
						gitPath: fixture.directory,
						chapterSettings: {},
						createdAt: now(),
						updatedAt: now(),
					});
					await db
						.update(schema.narrators)
						.set({ contextProjectId: "final-policy-project" })
						.where(eq(schema.narrators.id, fixture.actor.narratorId));
				}
				const running = executeTool(fixture.tu, fixture.config, {
					toolCallBinding: fixture.binding,
				});
				try {
					await Promise.race([
						entered,
						running.then((result) => {
							throw new Error(`Finished before hold: ${result.output}`);
						}),
					]);
					const rules =
						kind === "Write"
							? {
									blacklistDirs: [
										{ path: fixture.directory, denyLevel: "denyAll" as const, enabled: true },
									],
								}
							: { commandBlacklist: [{ pattern: "printf", enabled: true }] };
					if (layer === "project")
						await db
							.update(schema.projects)
							.set({ chapterSettings: rules })
							.where(eq(schema.projects.id, "final-policy-project"));
					else {
						Object.assign(settings.agent, rules);
						saveSettings(structuredClone(settings));
					}
					release();
					const result = await running;
					expect(result.isError).toBe(true);
					expect(result.output).toContain("Final tool permission denied");
					expect(existsSync(fixture.marker)).toBe(false);
				} finally {
					release();
					await running;
				}
			});
	for (const value of [
		{ ruleType: "directoryWhitelist", path: "/tmp", accessLevel: "readWrite" },
		{ ruleType: "directoryBlacklist", path: "/tmp", denyLevel: "denyAll" },
		{ ruleType: "commandWhitelist", pattern: "pwd" },
		{ ruleType: "commandBlacklist", pattern: "rm *" },
	])
		test(`real strict loop applies ${value.ruleType} only after genuine successful decision tool`, async () => {
			reflectionScenario = "confirm";
			settings.agent.permissionRuleAutoApprove = true;
			const identity = await seed("bypassPermissions");
			const pause = await start(identity, { ...value, reason: "Task needs one scoped rule" });
			if (pause.behavior !== "dangerReflection") throw new Error("missing strict pause");
			const config = {
				narratorId: identity.narratorId,
				conversationId: "real-reflection",
				model: "test:model",
				provider: "test",
				cwd: "/tmp",
				signal: new AbortController().signal,
				permissionHandler: async () => ({
					behavior: "deny",
					message: "No tools outside reflection",
				}),
			} as AgentConfig;
			const decision = await resolveDangerReflectionDecision(config, [], pause, {
				name: "RequestPermissionRule",
				toolUseId: identity.toolUseId,
				input: pause.input,
			});
			expect(decision.behavior).toBe("allow");
			expect(count()).toBe(0);
			const result = await requestPermissionRuleTool.execute(pause.input, {
				narratorId: identity.narratorId,
				cwd: "/tmp",
				signal: config.signal,
				locale: "en",
				toolCallBinding: identity.binding,
				currentToolUseId: identity.toolUseId,
				executionTarget: identity.context.target,
				resolveBackend: () => identity.context.backend,
				recheckAuthorization: async () => {},
				requestPermission: async () => decision,
			});
			expect(result.isError).not.toBe(true);
			expect(count()).toBe(1);
			expect(JSON.parse(result.output).status).toBe("applied");
		});
	for (const scenario of ["text", "throw", "cancel", "confirmError"] as const)
		test(`real strict loop ${scenario} cannot apply a rule`, async () => {
			reflectionScenario = scenario;
			settings.agent.permissionRuleAutoApprove = true;
			const identity = await seed("bypassPermissions");
			const pause = await start(identity, proposal);
			if (pause.behavior !== "dangerReflection") throw new Error("missing strict pause");
			const config = {
				narratorId: identity.narratorId,
				conversationId: "strict-failure",
				model: "test:model",
				provider: "test",
				cwd: "/tmp",
				signal: new AbortController().signal,
				permissionHandler: async () => ({ behavior: "deny", message: "No ordinary permission" }),
			} as AgentConfig;
			const result = await resolveDangerReflectionDecision(config, [], pause, {
				name: "RequestPermissionRule",
				toolUseId: identity.toolUseId,
				input: pause.input,
			});
			expect(result.behavior).toBe("deny");
			expect(count()).toBe(0);
			await expect(
				service.consumePermissionRuleRequest(identity, pause.input, identity.context),
			).rejects.toThrow("approval receipt");
			expect(pendingDangerReflections.has(identity.binding.toolCallId)).toBe(false);
		});
	test("expired receipts cannot apply and are audited as failures", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
		await db
			.update(schema.permissionRuleRequests)
			.set({
				createdAt: new Date(Date.now() - service.PERMISSION_RULE_REQUEST_TTL_MS - 1).toISOString(),
			})
			.where(eq(schema.permissionRuleRequests.id, prepared.requestId));
		await expect(
			service.consumePermissionRuleRequest(identity, prepared.input, identity.context),
		).rejects.toThrow("expired");
		expect(count()).toBe(0);
	});
	test("approved allow rules never override catastrophe or protected git paths", async () => {
		const identity = await seed();
		await permissionRuleService.createNarratorRule(identity.narratorId, {
			ruleType: "commandWhitelist",
			value: { pattern: "*", selector: { kind: "host" } },
		});
		await permissionRuleService.createNarratorRule(identity.narratorId, {
			ruleType: "directoryWhitelist",
			value: { path: "/tmp", accessLevel: "full", selector: { kind: "host" } },
		});
		const policy = await executionPolicyEngine.compile(identity.narratorId, identity.context);
		const { analyzeShellCommand } = await import("../../lib/agent/bash-analyze");
		const analysis = await analyzeShellCommand("rm -rf /", "/tmp", "bash", false);
		expect(
			permission.resolvePermissionDecision({
				toolName: "Bash",
				input: { command: "rm -rf /" },
				permMode: "bypassPermissions",
				cwd: "/tmp",
				bashAnalysis: analysis,
				compiledPolicy: policy,
				executionContext: identity.context,
			}),
		).toBe("fatal");
		expect(
			permission.resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: "/tmp/.git/config", content: "change" },
				permMode: "bypassPermissions",
				cwd: "/tmp",
				compiledPolicy: policy,
				executionContext: identity.context,
			}),
		).toBe("deny");
	});
	test("tool authorization revoked before consumption fails closed and audits failure", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
		const result = await requestPermissionRuleTool.execute(prepared.input, {
			narratorId: identity.narratorId,
			cwd: "/tmp",
			signal: new AbortController().signal,
			locale: "en",
			toolCallBinding: identity.binding,
			currentToolUseId: identity.toolUseId,
			executionTarget: identity.context.target,
			resolveBackend: () => identity.context.backend,
			recheckAuthorization: async () => {
				throw new Error("Turn authorization revoked");
			},
			requestPermission: async () => ({ behavior: "allow" }),
		});
		expect(result.isError).toBe(true);
		expect(count()).toBe(0);
		expect(service.listPermissionRuleRequests(identity.narratorId).items[0]?.status).toBe("failed");
	});
	test("child project context cannot erase its ancestor project blacklist", async () => {
		const parent = await seed(),
			child = await seed("default", parent.narratorId);
		for (const [id, commandBlacklist] of [
			["parent-project", [{ pattern: "pwd", enabled: true }]],
			["child-project", []],
		] as const) {
			await db.insert(schema.projects).values({
				id,
				name: id,
				chapterSettings: { commandBlacklist },
				createdAt: now(),
				updatedAt: now(),
			});
		}
		await db
			.update(schema.narrators)
			.set({ contextProjectId: "parent-project" })
			.where(eq(schema.narrators.id, parent.narratorId));
		await db
			.update(schema.narrators)
			.set({ contextProjectId: "child-project" })
			.where(eq(schema.narrators.id, child.narratorId));
		const policy = await executionPolicyEngine.compile(child.narratorId, child.context);
		expect(policy.projectId).toBe("child-project");
		expect(policy.evaluateCommands([["pwd"]]).decision).toBe("deny");
	});
	test("strict schema refuses foreign scopes/selectors/edit flags and requires reason", () => {
		for (const extra of [
			{ narratorId: "other" },
			{ scope: "global" },
			{ selector: { kind: "all" } },
			{ enabled: false },
			{ action: "update" },
			{ deviceScope: "all" },
		])
			expect(service.requestPermissionRuleSchema.safeParse({ ...proposal, ...extra }).success).toBe(
				false,
			);
		expect(
			service.requestPermissionRuleSchema.safeParse({ ...proposal, reason: " " }).success,
		).toBe(false);
	});
	for (const value of [
		{ ruleType: "directoryWhitelist", path: "/tmp", accessLevel: "full" },
		{ ruleType: "directoryBlacklist", path: "/tmp", denyLevel: "denyWrite" },
		{ ruleType: "commandWhitelist", pattern: "pwd" },
		{ ruleType: "commandBlacklist", pattern: "rm *", denyPrompt: "Do not delete" },
	])
		test(`human approval inserts one ${value.ruleType}`, async () => {
			const identity = await seed();
			const running = start(identity, { ...value, reason: "Scoped task requirement" });
			await waitForManual(identity.binding.toolCallId);
			expect(
				await permission.resolvePermission(identity.binding.toolCallId, "allow", {
					decidedBy: "user",
					userId: "human-admin",
				}),
			).toBe(true);
			const result = await running;
			expect(result.behavior).toBe("allow");
			if (result.behavior !== "allow") throw new Error("not approved");
			expect(count()).toBe(0);
			const saved = await service.consumePermissionRuleRequest(
				identity,
				result.updatedInput,
				identity.context,
			);
			expect(saved.status).toBe("applied");
			expect(count()).toBe(1);
			expect(
				(
					await service.consumePermissionRuleRequest(
						identity,
						result.updatedInput,
						identity.context,
					)
				).ruleId,
			).toBe(saved.ruleId);
		});
	test("bypass with opt-in disabled still requires a human and refuses proxy/auto", async () => {
		const identity = await seed("bypassPermissions");
		settings.agent.permissionRuleAutoApprove = false;
		const running = start(identity, proposal);
		await waitForManual(identity.binding.toolCallId);
		expect(
			await permission.resolvePermission(identity.binding.toolCallId, "allow", {
				decidedBy: "auto",
			}),
		).toBe(false);
		expect(
			await permission.resolvePermission(identity.binding.toolCallId, "deny", {
				decidedBy: "user",
				userId: "human",
			}),
		).toBe(true);
		expect((await running).behavior).toBe("deny");
		expect(count()).toBe(0);
	});
	test("non-bypass with opt-in enabled remains manual", async () => {
		settings.agent.permissionRuleAutoApprove = true;
		const identity = await seed();
		const running = start(identity, proposal);
		await waitForManual(identity.binding.toolCallId);
		await permission.resolvePermission(identity.binding.toolCallId, "deny", {
			decidedBy: "user",
			userId: "human",
		});
		expect((await running).behavior).toBe("deny");
		expect(count()).toBe(0);
	});
	test("strict confirm is only a candidate; off/light do not weaken it", async () => {
		for (const level of ["off", "light"] as const) {
			settings.agent.permissionRuleAutoApprove = true;
			settings.agent.dangerReflectionLevel = level;
			const identity = await seed("bypassPermissions");
			const pause = await start(identity, proposal);
			expect(pause.behavior).toBe("dangerReflection");
			if (pause.behavior !== "dangerReflection") throw new Error("not reflection");
			expect(pause.reflectionLevel).toBe("strict");
			expect(pause.purpose).toBe("permissionRuleRequest");
			expect(
				await permission.confirmDangerReflection(pause.requestId, "Needed for this task"),
			).toBe(true);
			expect(count()).toBe(level === "off" ? 0 : 1);
			await expect(
				service.consumePermissionRuleRequest(identity, pause.input, identity.context),
			).rejects.toThrow("approval receipt");
			expect(
				await permission.completePermissionRuleRequestReflection(pause.requestId, {
					completedNormally: true,
					validToolDecision: true,
				}),
			).toBe(true);
			expect((await pause.decision).behavior).toBe("allow");
			await service.consumePermissionRuleRequest(identity, pause.input, identity.context);
		}
		expect(count()).toBe(2);
	});
	for (const result of [
		{ completedNormally: false, validToolDecision: true },
		{ completedNormally: true, validToolDecision: false },
		{ completedNormally: true, validToolDecision: true, usedTextFallback: true },
	])
		test(`invalid strict completion ${JSON.stringify(result)} never applies`, async () => {
			const identity = await seed("bypassPermissions");
			settings.agent.permissionRuleAutoApprove = true;
			const pause = await start(identity, proposal);
			if (pause.behavior !== "dangerReflection") throw new Error("not reflection");
			await permission.confirmDangerReflection(pause.requestId, "candidate");
			expect(
				await permission.completePermissionRuleRequestReflection(pause.requestId, result),
			).toBe(false);
			expect((await pause.decision).behavior).toBe("deny");
			expect(count()).toBe(0);
		});
	test("fake confirm without a live request cannot create a receipt", async () => {
		expect(await permission.confirmDangerReflection("not-a-request", "yes")).toBe(false);
		const identity = await seed("bypassPermissions");
		settings.agent.permissionRuleAutoApprove = true;
		const pause = await start(identity, proposal);
		if (pause.behavior !== "dangerReflection") throw new Error("not reflection");
		expect(
			await permission.completePermissionRuleRequestReflection(pause.requestId, {
				completedNormally: true,
				validToolDecision: true,
			}),
		).toBe(false);
		expect((await pause.decision).behavior).toBe("deny");
		expect(count()).toBe(0);
	});
	test("cancel and abort never create a rule", async () => {
		const identity = await seed("bypassPermissions");
		settings.agent.permissionRuleAutoApprove = true;
		const pause = await start(identity, proposal);
		if (pause.behavior !== "dangerReflection") throw new Error("not reflection");
		await permission.confirmDangerReflection(pause.requestId, "candidate");
		await permission.cancelDangerReflection(pause.requestId, "Cancelled");
		expect((await pause.decision).behavior).toBe("deny");
		expect(count()).toBe(0);
	});
	for (const broken of [{ ruleId: null }, { approvalSource: null }, { approvalUserId: null }])
		test(`malformed applied receipt ${JSON.stringify(broken)} never reports success`, async () => {
			const identity = await seed();
			const prepared = await service.preparePermissionRuleRequest(
				identity,
				proposal,
				identity.context,
			);
			service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
			await service.consumePermissionRuleRequest(identity, prepared.input, identity.context);
			await db
				.update(schema.permissionRuleRequests)
				.set(broken)
				.where(eq(schema.permissionRuleRequests.id, prepared.requestId));
			await expect(
				service.consumePermissionRuleRequest(identity, prepared.input, identity.context),
			).rejects.toThrow();
			expect(count()).toBe(1);
		});
	test("identical concurrent commits yield at most one inserted rule and terminal status", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		expect(
			service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human"),
		).toBe(true);
		const results = await Promise.all([
			service.consumePermissionRuleRequest(identity, prepared.input, identity.context),
			service.consumePermissionRuleRequest(identity, prepared.input, identity.context),
		]);
		expect(results[0].ruleId).toBe(results[1].ruleId);
		expect(count()).toBe(1);
	});
	test("same request id different proposal hash conflicts", async () => {
		const identity = await seed();
		await service.preparePermissionRuleRequest(identity, proposal, identity.context);
		await expect(
			service.preparePermissionRuleRequest(
				identity,
				{ ...proposal, pattern: "ls" },
				identity.context,
			),
		).rejects.toThrow("different proposal");
		expect(count()).toBe(0);
	});
	test("fully identical enabled rule returns alreadyExists; different level/disabled rule conflicts", async () => {
		const identity = await seed();
		await permissionRuleService.createNarratorRule(identity.narratorId, {
			ruleType: "commandWhitelist",
			value: { pattern: "pwd", selector: { kind: "host" } },
		});
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
		expect(
			(await service.consumePermissionRuleRequest(identity, prepared.input, identity.context))
				.status,
		).toBe("alreadyExists");
		expect(count()).toBe(1);
		const other = await call(identity.narratorId);
		await permissionRuleService.createNarratorRule(identity.narratorId, {
			ruleType: "directoryWhitelist",
			value: { path: "/tmp", accessLevel: "readOnly", selector: { kind: "host" }, enabled: false },
		});
		const next = await service.preparePermissionRuleRequest(
			other,
			{ ruleType: "directoryWhitelist", path: "/tmp", accessLevel: "full", reason: "upgrade" },
			other.context,
		);
		service.recordPermissionRuleRequestDecision(next.requestId, "allow", "user", "human");
		await expect(
			service.consumePermissionRuleRequest(other, next.input, other.context),
		).rejects.toThrow("conflicts");
		expect(count()).toBe(2);
	});
	for (const change of [
		"permissionMode",
		"cwd",
		"workspaceRevision",
		"defaultDeviceId",
		"setting",
	] as const)
		test(`waiting ${change} drift fails closed`, async () => {
			const identity = await seed("bypassPermissions");
			settings.agent.permissionRuleAutoApprove = true;
			const prepared = await service.preparePermissionRuleRequest(
				identity,
				proposal,
				identity.context,
			);
			service.recordPermissionRuleRequestDecision(
				prepared.requestId,
				"allow",
				"reflection",
				undefined,
				"candidate",
			);
			service.completePermissionRuleRequestReflection(prepared.requestId, {
				completedNormally: true,
				validToolDecision: true,
			});
			if (change === "setting") settings.agent.permissionRuleAutoApprove = false;
			else
				await db
					.update(schema.narrators)
					.set(
						change === "permissionMode"
							? { permissionMode: "default" }
							: change === "cwd"
								? { cwd: "/var" }
								: change === "workspaceRevision"
									? { workspaceRevision: 1 }
									: { defaultDeviceId: "another" },
					)
					.where(eq(schema.narrators.id, identity.narratorId));
			await expect(
				service.consumePermissionRuleRequest(identity, prepared.input, identity.context),
			).rejects.toThrow("changed while waiting");
			expect(count()).toBe(0);
		});
	test("insert failure rolls back terminal CAS and never leaves a rule", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
		sqlite.run(
			"CREATE TRIGGER reject_rule_insert BEFORE INSERT ON narrator_whitelist_cmds BEGIN SELECT RAISE(ABORT,'write failed'); END",
		);
		try {
			await expect(
				service.consumePermissionRuleRequest(identity, prepared.input, identity.context),
			).rejects.toThrow("write failed");
			expect(count()).toBe(0);
			expect(
				db
					.select()
					.from(schema.permissionRuleRequests)
					.where(eq(schema.permissionRuleRequests.id, prepared.requestId))
					.get()?.status,
			).toBe("failed");
		} finally {
			sqlite.run("DROP TRIGGER reject_rule_insert");
		}
	});
	test("approval persistence failure denies instead of generic confirm's permissive catch", async () => {
		const identity = await seed("bypassPermissions");
		settings.agent.permissionRuleAutoApprove = true;
		const pause = await start(identity, proposal);
		if (pause.behavior !== "dangerReflection") throw new Error("not reflection");
		sqlite.run(
			"CREATE TRIGGER reject_request_update BEFORE UPDATE ON permission_rule_requests BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
		);
		try {
			expect(await permission.confirmDangerReflection(pause.requestId, "candidate")).toBe(false);
			expect((await pause.decision).behavior).toBe("deny");
			expect(count()).toBe(0);
		} finally {
			sqlite.run("DROP TRIGGER reject_request_update");
		}
	});
	test("subagent appends its own rules, inherits parent denies and never writes siblings", async () => {
		const parent = await seed(),
			child = await seed("default", parent.narratorId),
			sibling = await seed("default", parent.narratorId);
		await permissionRuleService.createNarratorRule(parent.narratorId, {
			ruleType: "commandBlacklist",
			value: { pattern: "pwd", selector: { kind: "host" } },
		});
		const before = await executionPolicyEngine.compile(child.narratorId, child.context);
		expect(before.evaluateCommands([["pwd"]]).decision).toBe("deny");
		const prepared = await service.preparePermissionRuleRequest(child, proposal, child.context);
		service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
		await service.consumePermissionRuleRequest(child, prepared.input, child.context);
		const after = await executionPolicyEngine.compile(child.narratorId, child.context);
		expect(after.revision).not.toBe(before.revision);
		expect(after.evaluateCommands([["pwd"]]).decision).toBe("deny");
		expect(
			(await executionPolicyRepository.load(sibling.narratorId)).commandWhitelist,
		).toHaveLength(0);
		expect(
			(await permissionRuleService.listNarratorRules(parent.narratorId)).commandWhitelist,
		).toHaveLength(0);
	});
	test("local exact host selector never matches another device", async () => {
		const identity = await seed();
		const prepared = await service.preparePermissionRuleRequest(
			identity,
			proposal,
			identity.context,
		);
		service.recordPermissionRuleRequestDecision(prepared.requestId, "allow", "user", "human");
		await service.consumePermissionRuleRequest(identity, prepared.input, identity.context);
		const remote = {
			...identity.context,
			target: { ...identity.context.target, deviceId: "remote", backendKind: "remote" as const },
			backend: {
				...identity.context.backend,
				deviceId: "remote",
				kind: "remote",
			} as ExecutionBackend,
		};
		const { compileExecutionPolicy } = await import("../execution-policy/compiler");
		expect(
			compileExecutionPolicy(await executionPolicyRepository.load(identity.narratorId), remote)
				.commandWhitelist,
		).toHaveLength(0);
		await expect(
			service.preparePermissionRuleRequest(
				await call(identity.narratorId),
				{ ...proposal, device: "remote" },
				identity.context,
			),
		).rejects.toThrow("Device differs");
	});
	test("chapter-bound narrator with null contextProjectId enforces project directory and command denies in bypass", async () => {
		await seedChapterDenyProject();
		const identity = await seed("bypassPermissions");
		await db
			.update(schema.narrators)
			.set({ chapterId: "policy-chapter", contextProjectId: null })
			.where(eq(schema.narrators.id, identity.narratorId));
		const loaded = db.transaction((tx) =>
			executionPolicyRepository.loadNow(identity.narratorId, tx),
		);
		expect(loaded.projectId).toBe("chapter-policy-project");
		expect(loaded.projectGitPath).toBe("/tmp/chapter-policy-repository");
		expect(loaded.commandBlacklist).toHaveLength(1);
		expect(loaded.directoryBlacklist).toHaveLength(1);
		await expectProjectPolicyDeny(identity.narratorId, "Bash", { command: "pwd" });
		await expectProjectPolicyDeny(identity.narratorId, "Read", {
			file_path: "/tmp/chapter-policy-private/secret",
		});
	});
	test("chapter project takes precedence over a permissive explicit context project", async () => {
		await seedChapterDenyProject();
		await db.insert(schema.projects).values({
			id: "permissive-explicit-project",
			name: "Other",
			chapterSettings: { commandWhitelist: [{ pattern: "pwd", enabled: true }] },
			createdAt: now(),
			updatedAt: now(),
		});
		const identity = await seed("bypassPermissions");
		await db
			.update(schema.narrators)
			.set({ chapterId: "policy-chapter", contextProjectId: "permissive-explicit-project" })
			.where(eq(schema.narrators.id, identity.narratorId));
		expect(executionPolicyRepository.loadNow(identity.narratorId).projectId).toBe(
			"chapter-policy-project",
		);
		await expectProjectPolicyDeny(identity.narratorId, "Bash", { command: "pwd" });
	});
	test("child and nested subagent inherit chapter ancestor project denies without explicit project context", async () => {
		await seedChapterDenyProject();
		const parent = await seed("bypassPermissions");
		await db
			.update(schema.narrators)
			.set({ chapterId: "policy-chapter", contextProjectId: null })
			.where(eq(schema.narrators.id, parent.narratorId));
		const child = await seed("bypassPermissions", parent.narratorId),
			nested = await seed("bypassPermissions", child.narratorId);
		for (const actor of [child, nested]) {
			expect(executionPolicyRepository.loadNow(actor.narratorId).projectId).toBe(
				"chapter-policy-project",
			);
			await permissionRuleService.createNarratorRule(actor.narratorId, {
				ruleType: "commandWhitelist",
				value: { pattern: "pwd", selector: { kind: "host" } },
			});
			await expectProjectPolicyDeny(actor.narratorId, "Bash", { command: "pwd" });
			await expectProjectPolicyDeny(actor.narratorId, "Read", {
				file_path: "/tmp/chapter-policy-private/secret",
			});
		}
	});
	test("standalone explicit project retains deny policy in actual bypass permission handling", async () => {
		await seedChapterDenyProject();
		const identity = await seed("bypassPermissions");
		await db
			.update(schema.narrators)
			.set({ chapterId: null, contextProjectId: "chapter-policy-project" })
			.where(eq(schema.narrators.id, identity.narratorId));
		expect(executionPolicyRepository.loadNow(identity.narratorId).projectId).toBe(
			"chapter-policy-project",
		);
		await expectProjectPolicyDeny(identity.narratorId, "Bash", { command: "pwd" });
		await expectProjectPolicyDeny(identity.narratorId, "Read", {
			file_path: "/tmp/chapter-policy-private/secret",
		});
	});
	test("standalone cwd alone never selects a project and dangling chapter fails closed", async () => {
		await seedChapterDenyProject();
		const identity = await seed("bypassPermissions");
		await db
			.update(schema.narrators)
			.set({ cwd: "/tmp/chapter-policy-repository", chapterId: null, contextProjectId: null })
			.where(eq(schema.narrators.id, identity.narratorId));
		expect(executionPolicyRepository.loadNow(identity.narratorId).projectId).toBeNull();
		await db
			.update(schema.narrators)
			.set({ chapterId: "missing-policy-chapter", contextProjectId: "chapter-policy-project" })
			.where(eq(schema.narrators.id, identity.narratorId));
		expect(() => executionPolicyRepository.loadNow(identity.narratorId)).toThrow(
			"chapter context no longer exists",
		);
	});
	test("standalone contextProjectId supplies project deny layers", async () => {
		const identity = await seed();
		await db.insert(schema.projects).values({
			id: "ctx-project",
			name: "Context",
			chapterSettings: { commandBlacklist: [{ pattern: "pwd", enabled: true }] },
			createdAt: now(),
			updatedAt: now(),
		});
		await db
			.update(schema.narrators)
			.set({ contextProjectId: "ctx-project" })
			.where(eq(schema.narrators.id, identity.narratorId));
		const policy = await executionPolicyEngine.compile(identity.narratorId, identity.context);
		expect(policy.projectId).toBe("ctx-project");
		expect(policy.evaluateCommands([["pwd"]]).decision).toBe("deny");
	});
	test("review and OAuth identities cannot obtain a mutable receipt", async () => {
		for (const update of [
			{ variant: "subagent:review" },
			{ oauthPolicySnapshotJson: { mode: "readOnly" } },
		]) {
			const identity = await seed();
			await db
				.update(schema.narrators)
				.set(update)
				.where(eq(schema.narrators.id, identity.narratorId));
			await expect(
				service.preparePermissionRuleRequest(identity, proposal, identity.context),
			).rejects.toThrow("ceilings");
		}
		expect(count()).toBe(0);
	});
	test("summary paging is bounded and excludes proposal bodies", async () => {
		const identity = await seed();
		await service.preparePermissionRuleRequest(identity, proposal, identity.context);
		const other = await call(identity.narratorId);
		await service.preparePermissionRuleRequest(other, proposal, other.context);
		const first = service.listPermissionRuleRequests(identity.narratorId, { limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).not.toBeNull();
		expect(first.items[0]).not.toHaveProperty("proposalJson");
		expect(
			service.listPermissionRuleRequests(identity.narratorId, {
				limit: 1,
				cursor: first.nextCursor,
			}).items,
		).toHaveLength(1);
		expect(() => service.listPermissionRuleRequests(identity.narratorId, { limit: 101 })).toThrow();
	});
	test("NarraForkAdmin cannot enable opt-in through direct or ancestor update/reset", async () => {
		for (const [action, path, value] of [
			["update_settings", undefined, { agent: { permissionRuleAutoApprove: true } }],
			["update_settings", undefined, { agent: null }],
			["update_settings", undefined, { "agent.permissionRuleAutoApprove": true }],
			["reset_setting", "agent", undefined],
			["reset_setting", "agent.permissionRuleAutoApprove", undefined],
			["reset_setting", "", undefined],
		] as const) {
			expect(
				isPermissionRuleAutoApproveMutation(action, path, value as Record<string, unknown>),
			).toBe(true);
			const result = await narraforkAdminTool.execute({ action, path, value }, {
				narratorId: "admin-agent",
				cwd: "/tmp",
				signal: new AbortController().signal,
				locale: "en",
				requestPermission: async () => {
					throw new Error("must not ask");
				},
			} as Parameters<typeof narraforkAdminTool.execute>[1]);
			expect(result.isError).toBe(true);
		}
		expect(
			isPermissionRuleAutoApproveMutation("update_settings", undefined, {
				agent: { maxTurns: 100 },
			}),
		).toBe(false);
	});
});
