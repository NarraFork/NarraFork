import { describe, expect, test } from "bun:test";
import { CapabilityBroker as CoreCapabilityBroker } from "@server/services/plugin-capability-broker";
import {
	type CapabilityAuthorizationDecision,
	type CapabilityAuthorizationRequest,
	type CapabilityBroker,
	CommandRegistry,
	createCommandRequest,
	createQueryRequest,
	type HostCallContext,
	PluginPublicApi,
	type PluginPublicApiAdapters,
	type PluginPublicApiAuditEntry,
	QueryRegistry,
} from "@server/services/plugin-public-api";
import { z } from "zod";

const CURSOR_SECRET = "public-api-test-cursor-secret-32-bytes";
const BASE_TIME = Date.parse("2026-07-16T12:00:00.000Z");
let requestSequence = 0;

function context(
	overrides: Partial<HostCallContext> & {
		invocation?: Partial<HostCallContext["invocation"]>;
		scope?: Partial<HostCallContext["scope"]>;
		plugin?: Partial<HostCallContext["plugin"]>;
	} = {},
): HostCallContext {
	requestSequence += 1;
	const requestId = overrides.requestId ?? `request-${requestSequence}`;
	return {
		requestId,
		correlationId: overrides.correlationId ?? `correlation-${requestSequence}`,
		deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 5_000).toISOString(),
		plugin: {
			pluginId: "com.example.caller",
			packageVersion: "1.0.0",
			runtimeId: "runtime-1",
			runtimeGeneration: 1,
			installationId: "installation-1",
			...overrides.plugin,
		},
		invocation: {
			kind: "user",
			userId: "user-1",
			userRole: "admin",
			source: "command",
			...overrides.invocation,
		},
		scope: {
			...overrides.scope,
		},
	};
}

class FakeBroker implements CapabilityBroker {
	readonly calls: CapabilityAuthorizationRequest[] = [];
	decision: CapabilityAuthorizationDecision = { allowed: true };

	async authorize(
		request: CapabilityAuthorizationRequest,
	): Promise<CapabilityAuthorizationDecision> {
		this.calls.push(request);
		return this.decision;
	}
}

function pluginSource(pluginId: string, overrides: Record<string, unknown> = {}) {
	return {
		pluginId,
		version: "1.0.0",
		displayName: pluginId,
		desiredState: "disabled",
		compatibility: "compatible",
		runtimeState: "inactive",
		installed: true,
		packageStatus: "compatible",
		contributionCount: 1,
		updatedAt: "2026-07-16T10:00:00.000Z",
		diagnosticCodes: [],
		...overrides,
	};
}

function buildApi(
	options: {
		broker?: FakeBroker;
		adapters?: PluginPublicApiAdapters;
		limits?: ConstructorParameters<typeof PluginPublicApi>[0]["limits"];
		audit?: PluginPublicApiAuditEntry[];
		queryRegistry?: QueryRegistry;
		commandRegistry?: CommandRegistry;
	} = {},
) {
	const broker = options.broker ?? new FakeBroker();
	const api = new PluginPublicApi({
		capabilityBroker: broker,
		adapters: options.adapters,
		limits: options.limits,
		cursorSecret: CURSOR_SECRET,
		queryRegistry: options.queryRegistry,
		commandRegistry: options.commandRegistry,
		auditSink: options.audit
			? {
					write(entry) {
						options.audit?.push(entry);
					},
				}
			: undefined,
	});
	return { api, broker };
}

function projectRows() {
	return [
		{
			id: "project-c",
			name: "Project C",
			status: "active" as const,
			createdAt: "2026-07-14T00:00:00.000Z",
			updatedAt: "2026-07-16T03:00:00.000Z",
		},
		{
			id: "project-b",
			name: "Project B",
			status: "archived" as const,
			createdAt: "2026-07-13T00:00:00.000Z",
			updatedAt: "2026-07-16T02:00:00.000Z",
		},
		{
			id: "project-a",
			name: "Project A",
			status: "active" as const,
			createdAt: "2026-07-12T00:00:00.000Z",
			updatedAt: "2026-07-16T01:00:00.000Z",
		},
	];
}

function afterTimestamp(
	row: { id: string; updatedAt: string },
	after: { id: string; updatedAt: string } | undefined,
): boolean {
	return (
		!after ||
		row.updatedAt < after.updatedAt ||
		(row.updatedAt === after.updatedAt && row.id < after.id)
	);
}

describe("PluginPublicApi", () => {
	test("uses strict query/command registries and rejects unknown IDs", async () => {
		const { api, broker } = buildApi();
		expect(api.queries.listIds()).toEqual([
			"narrafork.chapters.list",
			"narrafork.narrators.list",
			"narrafork.plugin.getOwn",
			"narrafork.plugins.list",
			"narrafork.projects.list",
		]);
		expect(api.commands.listIds()).toEqual([
			"narrafork.narrator.interrupt",
			"narrafork.narrator.send_message",
			"narrafork.plugins.disable",
			"narrafork.plugins.enable",
		]);

		const queryContext = context();
		const query = await api.query(
			queryContext,
			createQueryRequest(queryContext, "narrafork.projects.get", {}),
		);
		expect(query.status).toBe("failed");
		if (query.status === "failed") expect(query.error.code).toBe("METHOD_NOT_FOUND");

		const commandContext = context();
		const command = await api.command(
			commandContext,
			createCommandRequest(commandContext, "narrafork.projects.delete", {}),
		);
		expect(command.status).toBe("failed");
		expect(command.error?.code).toBe("METHOD_NOT_FOUND");
		expect(broker.calls.map((call) => call.methodId)).toEqual([
			"narrafork.projects.get",
			"narrafork.projects.delete",
		]);
	});

	test("routes narrafork.plugin.getOwn through the shared plugin adapter", async () => {
		const { api } = buildApi({
			adapters: {
				plugins: {
					async getOwn(input) {
						return {
							pluginId: input.pluginId,
							desiredState: "enabled",
							compatibility: "compatible",
							runtimeState: "active",
							runtimeGeneration: 4,
							current: { version: "1.0.0", hash: "hash-1" },
							grants: { capabilities: ["query.read.audit_self"] },
						};
					},
					async list() {
						return [];
					},
				},
			},
		});
		const callContext = context();
		callContext.plugin.pluginId = "com.example.self";
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.plugin.getOwn", {}),
		);
		expect(result).toMatchObject({
			status: "succeeded",
			data: {
				pluginId: "com.example.self",
				runtimeGeneration: 4,
				current: { version: "1.0.0", hash: "hash-1" },
			},
		});
	});

	test("rejects unknown input fields instead of silently stripping them", async () => {
		const adapters: PluginPublicApiAdapters = {
			projects: {
				async list() {
					throw new Error("strict validation should stop before the adapter");
				},
			},
		};
		const { api } = buildApi({ adapters });
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.projects.list", {
				limit: 10,
				userId: "attacker-selected-user",
			}),
		);

		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("INVALID_PARAMS");
		expect(result.diagnostics?.some((item) => item.field === "userId")).toBe(true);
	});

	test("paginates with LIMIT n+1 and rejects a tampered opaque cursor", async () => {
		const requestedLimits: number[] = [];
		const adapters: PluginPublicApiAdapters = {
			projects: {
				async list(input) {
					requestedLimits.push(input.limit);
					return projectRows()
						.filter((row) => afterTimestamp(row, input.after))
						.slice(0, input.limit);
				},
			},
		};
		const { api } = buildApi({ adapters });
		const firstContext = context();
		const first = await api.query(
			firstContext,
			createQueryRequest(firstContext, "narrafork.projects.list", { limit: 2 }),
		);
		expect(first.status).toBe("succeeded");
		if (first.status !== "succeeded") throw new Error("first page failed");
		const firstData = first.data as { items: Array<{ id: string }> };
		expect(firstData.items.map((item) => item.id)).toEqual(["project-c", "project-b"]);
		expect(first.page?.hasMore).toBe(true);
		expect(first.page?.nextCursor).toBeTruthy();
		expect(requestedLimits).toEqual([3]);

		const secondContext = context();
		const second = await api.query(
			secondContext,
			createQueryRequest(secondContext, "narrafork.projects.list", {
				limit: 2,
				cursor: first.page?.nextCursor,
			}),
		);
		expect(second.status).toBe("succeeded");
		if (second.status !== "succeeded") throw new Error("second page failed");
		const secondData = second.data as { items: Array<{ id: string }> };
		expect(secondData.items.map((item) => item.id)).toEqual(["project-a"]);
		expect(second.page?.hasMore).toBe(false);

		const cursor = first.page?.nextCursor ?? "";
		const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
		const tamperedContext = context();
		const invalid = await api.query(
			tamperedContext,
			createQueryRequest(tamperedContext, "narrafork.projects.list", {
				limit: 2,
				cursor: tampered,
			}),
		);
		expect(invalid.status).toBe("failed");
		if (invalid.status === "failed") expect(invalid.error.code).toBe("INVALID_PARAMS");
		expect(invalid.diagnostics?.some((item) => item.code === "CURSOR_INVALID")).toBe(true);
	});

	test("binds cursors to trusted scope and filters", async () => {
		const adapters: PluginPublicApiAdapters = {
			projects: {
				async list(input) {
					return projectRows()
						.filter((row) => afterTimestamp(row, input.after))
						.slice(0, input.limit);
				},
			},
		};
		const { api } = buildApi({ adapters });
		const firstContext = context({ scope: { projectId: "project-c" } });
		const first = await api.query(
			firstContext,
			createQueryRequest(firstContext, "narrafork.projects.list", { limit: 1 }),
		);
		if (first.status !== "succeeded") throw new Error("first page failed");

		const changedScope = context({ scope: { projectId: "project-a" } });
		const result = await api.query(
			changedScope,
			createQueryRequest(changedScope, "narrafork.projects.list", {
				limit: 1,
				cursor: first.page?.nextCursor,
			}),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("INVALID_PARAMS");
	});

	test("enforces response byte and depth limits for injected queries", async () => {
		const queries = new QueryRegistry();
		queries.register({
			queryId: "narrafork.test.large",
			capability: "query.read.projects",
			inputSchema: z.object({}).strict(),
			handler: () => ({ data: { value: "x".repeat(1_000) } }),
		});
		const { api } = buildApi({
			queryRegistry: queries,
			limits: { maxStringBytes: 128, maxResponseBytes: 512 },
		});
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.test.large", {}),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("fails closed on authorization denial and never trusts caller identity in params", async () => {
		const broker = new FakeBroker();
		broker.decision = {
			allowed: false,
			code: "PERMISSION_DENIED",
			reason: "grant denied",
			diagnostics: [{ code: "GRANT_MISSING", message: "No matching grant" }],
		};
		let calls = 0;
		const commands = new CommandRegistry();
		commands.register({
			commandId: "narrafork.test.identity",
			capability: "command.chapter.write",
			inputSchema: z
				.object({
					pluginId: z.string(),
					userId: z.string(),
					scope: z.string(),
				})
				.strict(),
			sideEffect: "none",
			handler: () => {
				calls += 1;
				return { data: { ok: true } };
			},
		});
		const { api } = buildApi({ broker, commandRegistry: commands });
		const callContext = context();
		const result = await api.command(
			callContext,
			createCommandRequest(callContext, "narrafork.test.identity", {
				pluginId: "com.attacker.fake",
				userId: "admin-user",
				scope: "global",
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("PERMISSION_DENIED");
		expect(result.diagnostics?.map((item) => item.code)).toContain("GRANT_MISSING");
		expect(calls).toBe(0);
		expect(broker.calls[0]?.context.plugin.pluginId).toBe("com.example.caller");
		expect(broker.calls[0]?.context.invocation.userId).toBe("user-1");
	});

	test("integrates directly with the concrete CapabilityBroker contract", async () => {
		const callContext = context();
		const capability = "query.read.projects" as const;
		const broker = new CoreCapabilityBroker({
			bindings: new Map([
				[
					callContext.plugin.pluginId,
					{
						plugin: callContext.plugin,
						desiredState: "enabled",
						compatibilityState: "compatible",
						runtimeState: "active",
						manifestRequested: [capability],
						installationGrants: [{ capability, scope: { type: "global" } }],
						hostPolicy: [capability],
						currentUserAuthority: [capability],
						contributionPolicy: [capability],
						runnerEnforcement: [capability],
					},
				],
			]),
		});
		const api = new PluginPublicApi({
			capabilityBroker: broker,
			cursorSecret: CURSOR_SECRET,
			adapters: {
				projects: {
					async list(input) {
						return projectRows().slice(0, input.limit);
					},
				},
			},
		});
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.projects.list", { limit: 2 }),
		);
		expect(result.status).toBe("succeeded");
	});

	test("executes auditable plugin lifecycle commands once per scoped idempotency key", async () => {
		let enableCalls = 0;
		const audit: PluginPublicApiAuditEntry[] = [];
		const adapters: PluginPublicApiAdapters = {
			pluginLifecycle: {
				async enable(pluginId) {
					enableCalls += 1;
					return pluginSource(pluginId, { desiredState: "enabled" });
				},
				async disable(pluginId) {
					return pluginSource(pluginId, { desiredState: "disabled" });
				},
			},
		};
		const { api } = buildApi({ adapters, audit });
		const firstContext = context();
		const first = await api.command(
			firstContext,
			createCommandRequest(
				firstContext,
				"narrafork.plugins.enable",
				{ pluginId: "com.example.target" },
				{ idempotencyKey: "enable-target-v1" },
			),
		);
		expect(first.status).toBe("succeeded");

		const retryContext = context();
		const retry = await api.command(
			retryContext,
			createCommandRequest(
				retryContext,
				"narrafork.plugins.enable",
				{ pluginId: "com.example.target" },
				{ idempotencyKey: "enable-target-v1" },
			),
		);
		expect(retry.status).toBe("succeeded");
		expect(retry.requestId).toBe(retryContext.requestId);
		expect(retry.diagnostics?.some((item) => item.code === "IDEMPOTENT_REPLAY")).toBe(true);
		expect(enableCalls).toBe(1);
		expect(audit).toHaveLength(2);
		expect(audit[0]).toMatchObject({
			operation: "command",
			methodId: "narrafork.plugins.enable",
			outcome: "succeeded",
			resource: { type: "plugin", id: "com.example.target" },
		});
		expect(audit[1]?.idempotentReplay).toBe(true);
	});

	test("returns unknown on timed-out side effects and does not replay the command", async () => {
		let calls = 0;
		const commands = new CommandRegistry();
		commands.register({
			commandId: "narrafork.test.side-effect",
			capability: "command.chapter.write",
			inputSchema: z.object({ value: z.string() }).strict(),
			sideEffect: "idempotent",
			idempotency: "required",
			timeoutMs: 10,
			handler: () => {
				calls += 1;
				return new Promise<never>(() => undefined);
			},
		});
		const { api } = buildApi({ commandRegistry: commands });
		const firstContext = context({ deadlineAt: new Date(Date.now() + 1_000).toISOString() });
		const first = await api.command(
			firstContext,
			createCommandRequest(
				firstContext,
				"narrafork.test.side-effect",
				{ value: "once" },
				{ idempotencyKey: "side-effect-1" },
			),
		);
		expect(first.status).toBe("unknown");
		expect(first.error?.code).toBe("UNKNOWN_RESULT");

		const retryContext = context();
		const retry = await api.command(
			retryContext,
			createCommandRequest(
				retryContext,
				"narrafork.test.side-effect",
				{ value: "once" },
				{ idempotencyKey: "side-effect-1" },
			),
		);
		expect(retry.status).toBe("unknown");
		expect(retry.diagnostics?.some((item) => item.code === "IDEMPOTENT_REPLAY")).toBe(true);
		expect(calls).toBe(1);
	});

	test("rejects an unbounded input array even when an injected Zod schema forgot max()", async () => {
		const queries = new QueryRegistry();
		queries.register({
			queryId: "narrafork.test.unbounded",
			capability: "query.read.projects",
			inputSchema: z.object({ values: z.array(z.string()) }).strict(),
			handler: () => ({ data: { ok: true } }),
		});
		const { api } = buildApi({ queryRegistry: queries, limits: { maxArrayLength: 10 } });
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.test.unbounded", {
				values: Array.from({ length: 11 }, (_, index) => String(index)),
			}),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("redacts sensitive output fields while retaining safe diagnostics", async () => {
		const queries = new QueryRegistry();
		queries.register({
			queryId: "narrafork.test.redaction",
			capability: "query.read.projects",
			inputSchema: z.object({}).strict(),
			handler: () => ({
				data: {
					safe: "visible",
					contentJson: [{ type: "text", text: "private message" }],
					rawDumpJson: { upstream: "private raw dump" },
					outputJson: { stdout: "private output" },
					token: "super-secret-token",
					nested: { password: "secret-password", keep: true },
				},
				diagnostics: [
					{
						code: "SAFE_DIAGNOSTIC",
						message: "provider token=super-secret-token failed at /home/user/private/file",
					},
				],
			}),
		});
		const { api } = buildApi({ queryRegistry: queries });
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.test.redaction", {}),
		);
		expect(result.status).toBe("succeeded");
		if (result.status !== "succeeded") throw new Error("redaction query failed");
		expect(result.data).toEqual({ safe: "visible", nested: { keep: true } });
		expect(result.diagnostics?.map((item) => item.code)).toContain("SAFE_DIAGNOSTIC");
		expect(result.diagnostics?.map((item) => item.code)).toContain("REDACTED_FIELDS");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("private message");
		expect(serialized).not.toContain("private raw dump");
		expect(serialized).not.toContain("private output");
		expect(serialized).not.toContain("super-secret-token");
		expect(serialized).not.toContain("secret-password");
		expect(serialized).not.toContain("/home/user/private/file");
	});

	test("projects, chapters, and plugins expose allowlisted summaries only", async () => {
		const adapters: PluginPublicApiAdapters = {
			plugins: {
				async list() {
					return [
						pluginSource("com.example.safe", {
							contentJson: { private: true },
							rawDumpJson: { private: true },
							worktreePath: "/home/private/worktree",
						}) as never,
					];
				},
			},
			projects: {
				async list(input) {
					return projectRows().slice(0, input.limit);
				},
			},
			chapters: {
				async list() {
					return [
						{
							id: "chapter-1",
							projectId: "project-c",
							title: "Safe chapter",
							status: "active",
							role: "branch",
							commitCount: 3,
							createdAt: "2026-07-16T01:00:00.000Z",
							updatedAt: "2026-07-16T02:00:00.000Z",
							contentJson: { private: true },
							outputJson: { private: true },
							branch: "secret/internal-branch",
							worktreePath: "/home/private/worktree",
						} as never,
					];
				},
			},
		};
		const { api } = buildApi({ adapters });

		const pluginContext = context();
		const plugins = await api.query(
			pluginContext,
			createQueryRequest(pluginContext, "narrafork.plugins.list", { limit: 10 }),
		);
		const chapterContext = context({ scope: { projectId: "project-c" } });
		const chapters = await api.query(
			chapterContext,
			createQueryRequest(chapterContext, "narrafork.chapters.list", {
				projectId: "project-c",
				limit: 10,
			}),
		);
		const projectContext = context();
		const projects = await api.query(
			projectContext,
			createQueryRequest(projectContext, "narrafork.projects.list", { limit: 10 }),
		);

		expect(plugins.status).toBe("succeeded");
		expect(chapters.status).toBe("succeeded");
		expect(projects.status).toBe("succeeded");
		const serialized = JSON.stringify({ plugins, chapters, projects });
		expect(serialized).not.toContain("contentJson");
		expect(serialized).not.toContain("rawDumpJson");
		expect(serialized).not.toContain("outputJson");
		expect(serialized).not.toContain("secret/internal-branch");
		expect(serialized).not.toContain("/home/private/worktree");
	});

	test("rejects an adapter that violates LIMIT n+1", async () => {
		const adapters: PluginPublicApiAdapters = {
			projects: {
				async list() {
					return Array.from({ length: 4 }, (_, index) => ({
						id: `project-${index}`,
						name: `Project ${index}`,
						status: "active" as const,
						createdAt: new Date(BASE_TIME + index).toISOString(),
						updatedAt: new Date(BASE_TIME + index).toISOString(),
					}));
				},
			},
		};
		const { api } = buildApi({ adapters });
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.projects.list", { limit: 2 }),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
	});
});
