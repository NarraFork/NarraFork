import { afterEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import {
	type CapabilityAuthorizationDecision,
	type CapabilityAuthorizationRequest,
	type CapabilityBroker,
	createCommandRequest,
	createCorePluginPublicApiAdapters,
	createQueryRequest,
	type HostCallContext,
	type NarratorSessionFacade,
	PluginPublicApi,
	type PluginPublicApiAdapters,
	PluginPublicApiError,
} from "@server/services/plugin-public-api";
import { chapters, narratorMessages, narrators, projects } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const CURSOR_SECRET = "public-api-narrator-test-cursor-secret-32-bytes";
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
			pluginId: "com.example.team",
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

function buildApi(options: { broker?: FakeBroker; adapters?: PluginPublicApiAdapters } = {}) {
	const broker = options.broker ?? new FakeBroker();
	const api = new PluginPublicApi({
		capabilityBroker: broker,
		adapters: options.adapters,
		cursorSecret: CURSOR_SECRET,
	});
	return { api, broker };
}

function narratorRow(
	id: string,
	overrides: Partial<{
		chapterId: string | null;
		projectId: string | null;
		title: string | null;
		handle: string | null;
		variant: string;
		type: string;
		status: string;
		substatus: string[];
		model: string | null;
		permissionMode: string | null;
		messageCount: number;
		lastMessageAt: string | null;
		createdAt: string;
		updatedAt: string;
	}> = {},
) {
	const now = "2026-07-16T12:00:00.000Z";
	return {
		id,
		chapterId: null,
		projectId: null,
		title: null,
		handle: null,
		variant: "primary",
		type: "primary",
		status: "idle",
		substatus: [],
		model: null,
		permissionMode: null,
		messageCount: 0,
		lastMessageAt: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function afterUpdatedAt(
	row: { id: string; updatedAt: string },
	after: { id: string; updatedAt: string } | undefined,
): boolean {
	return (
		!after ||
		row.updatedAt < after.updatedAt ||
		(row.updatedAt === after.updatedAt && row.id < after.id)
	);
}

describe("narrafork.narrators.list (public API surface)", () => {
	test("paginates with LIMIT n+1 and returns bounded summaries", async () => {
		const requestedLimits: number[] = [];
		const adapters: PluginPublicApiAdapters = {
			narrators: {
				async list(input) {
					requestedLimits.push(input.limit);
					return [
						narratorRow("n-c", {
							projectId: "p1",
							chapterId: "ch1",
							updatedAt: "2026-07-16T03:00:00.000Z",
						}),
						narratorRow("n-b", {
							projectId: "p1",
							chapterId: "ch1",
							updatedAt: "2026-07-16T02:00:00.000Z",
						}),
						narratorRow("n-a", {
							projectId: "p1",
							chapterId: "ch1",
							updatedAt: "2026-07-16T01:00:00.000Z",
						}),
					]
						.filter((row) => afterUpdatedAt(row, input.after))
						.slice(0, input.limit);
				},
				async listMessages() {
					return [];
				},
			},
		};
		const { api } = buildApi({ adapters });
		const firstContext = context();
		const first = await api.query(
			firstContext,
			createQueryRequest(firstContext, "narrafork.narrators.list", { limit: 2 }),
		);
		expect(first.status).toBe("succeeded");
		if (first.status !== "succeeded") throw new Error("first page failed");
		const firstData = first.data as { items: Array<{ id: string }> };
		expect(firstData.items.map((item) => item.id)).toEqual(["n-c", "n-b"]);
		expect(first.page?.hasMore).toBe(true);
		expect(first.page?.nextCursor).toBeTruthy();
		expect(requestedLimits).toEqual([3]);

		const secondContext = context();
		const second = await api.query(
			secondContext,
			createQueryRequest(secondContext, "narrafork.narrators.list", {
				limit: 2,
				cursor: first.page?.nextCursor,
			}),
		);
		expect(second.status).toBe("succeeded");
		if (second.status !== "succeeded") throw new Error("second page failed");
		const secondData = second.data as { items: Array<{ id: string }> };
		expect(secondData.items.map((item) => item.id)).toEqual(["n-a"]);
		expect(second.page?.hasMore).toBe(false);
	});

	test("forwards filters and narrows projectId to the bound scope", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const adapters: PluginPublicApiAdapters = {
			narrators: {
				async list(input) {
					seen.push({
						projectId: input.projectId,
						chapterId: input.chapterId,
						status: input.status,
					});
					return [narratorRow("n1", { projectId: input.projectId })];
				},
				async listMessages() {
					return [];
				},
			},
		};
		const { api } = buildApi({ adapters });
		const callContext = context({ scope: { projectId: "bound-project" } });
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.narrators.list", {
				projectId: "other-project",
				chapterId: "ch-x",
				status: ["working", "idle"],
			}),
		);
		expect(result.status).toBe("succeeded");
		// The untrusted input projectId must not escape the bound scope.
		expect(seen).toEqual([
			{ projectId: "bound-project", chapterId: "ch-x", status: ["working", "idle"] },
		]);
	});

	test("fails with HOST_UNAVAILABLE when the narrator adapter is missing", async () => {
		const { api } = buildApi({ adapters: {} });
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.narrators.list", { limit: 10 }),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("HOST_UNAVAILABLE");
	});

	test("rejects unknown input fields", async () => {
		const { api } = buildApi({ adapters: {} });
		const callContext = context();
		const result = await api.query(
			callContext,
			createQueryRequest(callContext, "narrafork.narrators.list", {
				limit: 10,
				actor: "attacker",
			}),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error.code).toBe("INVALID_PARAMS");
		expect(result.diagnostics?.some((item) => item.field === "actor")).toBe(true);
	});
});

describe("narrafork.narrator.send_message (public API surface)", () => {
	test("forwards the message with plugin attribution and returns accepted", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const adapters: PluginPublicApiAdapters = {
			narratorCommands: {
				async sendMessage(input) {
					seen.push({
						narratorId: input.narratorId,
						message: input.message,
						locale: input.locale,
						replyInUserLanguage: input.replyInUserLanguage,
						pluginId: input.pluginId,
					});
					return { messageId: "msg-1" };
				},
				async interrupt() {
					return { interrupted: false };
				},
				async sendSubagentMessage() {
					return { delivered: "buffered" as const };
				},
				async createNarrator() {
					return {
						narratorId: "n-new",
						title: null,
						variant: "primary",
						type: "primary" as const,
						model: null,
						cwd: null,
						status: "idle",
					};
				},
				async deleteNarrator() {
					return { deleted: true as const };
				},
				async specTasksGet() {
					return {
						content: "",
						revisionId: null,
						compiled: { tasks: [], openCount: 0, protectedOpenCount: 0 },
					};
				},
				async specTaskAdd() {
					return { added: false, taskText: "", revisionId: null };
				},
				async specBehaviorFenceUpdate() {
					return { updated: false, revisionId: null };
				},
				async updateProfile() {
					return { updated: [] };
				},
				async specWrite() {
					return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
				},
			},
		};
		const { api, broker } = buildApi({ adapters });
		const callContext = context();
		const result = await api.command(
			callContext,
			createCommandRequest(callContext, "narrafork.narrator.send_message", {
				narratorId: "n-worker",
				message: "please review chapter 3",
				locale: "zh-CN",
				replyInUserLanguage: true,
			}),
		);
		expect(result.status).toBe("succeeded");
		expect(result.data).toEqual({ accepted: true, messageId: "msg-1" });
		expect(seen).toEqual([
			{
				narratorId: "n-worker",
				message: "please review chapter 3",
				locale: "zh-CN",
				replyInUserLanguage: true,
				pluginId: "com.example.team",
			},
		]);
		expect(broker.calls[0]).toMatchObject({
			capability: "command.narrator.send_message",
			resource: { type: "narrator", id: "n-worker" },
		});
	});

	test("denies when the capability grant is missing", async () => {
		const adapters: PluginPublicApiAdapters = {
			narratorCommands: {
				async sendMessage() {
					throw new Error("should not be reached");
				},
				async interrupt() {
					return { interrupted: false };
				},
				async sendSubagentMessage() {
					return { delivered: "buffered" as const };
				},
				async createNarrator() {
					return {
						narratorId: "n-new",
						title: null,
						variant: "primary",
						type: "primary" as const,
						model: null,
						cwd: null,
						status: "idle",
					};
				},
				async deleteNarrator() {
					return { deleted: true as const };
				},
				async specTasksGet() {
					return {
						content: "",
						revisionId: null,
						compiled: { tasks: [], openCount: 0, protectedOpenCount: 0 },
					};
				},
				async specTaskAdd() {
					return { added: false, taskText: "", revisionId: null };
				},
				async specBehaviorFenceUpdate() {
					return { updated: false, revisionId: null };
				},
				async updateProfile() {
					return { updated: [] };
				},
				async specWrite() {
					return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
				},
			},
		};
		const broker = new FakeBroker();
		broker.decision = {
			allowed: false,
			code: "PERMISSION_DENIED",
			reason: "grant denied",
			diagnostics: [{ code: "GRANT_MISSING", message: "No matching grant" }],
		};
		const { api } = buildApi({ broker, adapters });
		const callContext = context();
		const result = await api.command(
			callContext,
			createCommandRequest(callContext, "narrafork.narrator.send_message", {
				narratorId: "n-worker",
				message: "hi",
			}),
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error?.code).toBe("PERMISSION_DENIED");
	});

	test("propagates CONFLICT raised by the adapter with its retryable flag", async () => {
		const adapters: PluginPublicApiAdapters = {
			narratorCommands: {
				async sendMessage() {
					throw new PluginPublicApiError("CONFLICT", "Narrator is busy", {
						retryable: true,
					});
				},
				async interrupt() {
					return { interrupted: false };
				},
				async sendSubagentMessage() {
					return { delivered: "buffered" as const };
				},
				async createNarrator() {
					return {
						narratorId: "n-new",
						title: null,
						variant: "primary",
						type: "primary" as const,
						model: null,
						cwd: null,
						status: "idle",
					};
				},
				async deleteNarrator() {
					return { deleted: true as const };
				},
				async specTasksGet() {
					return {
						content: "",
						revisionId: null,
						compiled: { tasks: [], openCount: 0, protectedOpenCount: 0 },
					};
				},
				async specTaskAdd() {
					return { added: false, taskText: "", revisionId: null };
				},
				async specBehaviorFenceUpdate() {
					return { updated: false, revisionId: null };
				},
				async updateProfile() {
					return { updated: [] };
				},
				async specWrite() {
					return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
				},
			},
		};
		const { api } = buildApi({ adapters });

		const busyContext = context();
		const busy = await api.command(
			busyContext,
			createCommandRequest(busyContext, "narrafork.narrator.send_message", {
				narratorId: "n-busy",
				message: "hi",
			}),
		);
		expect(busy.status).toBe("failed");
		if (busy.status === "failed") {
			expect(busy.error?.code).toBe("CONFLICT");
			expect(busy.error?.retryable).toBe(true);
		}
	});
});

describe("narrafork.narrator.interrupt (public API surface)", () => {
	test("returns the interrupt result", async () => {
		const adapters: PluginPublicApiAdapters = {
			narratorCommands: {
				async sendMessage() {
					return { messageId: "msg-1" };
				},
				async interrupt(input) {
					expect(input.narratorId).toBe("n-worker");
					return { interrupted: true };
				},
				async sendSubagentMessage() {
					return { delivered: "started" as const, messageId: "msg-s1" };
				},
				async createNarrator() {
					return {
						narratorId: "n-new",
						title: null,
						variant: "primary",
						type: "primary" as const,
						model: null,
						cwd: null,
						status: "idle",
					};
				},
				async deleteNarrator() {
					return { deleted: true as const };
				},
				async specTasksGet() {
					return {
						content: "",
						revisionId: null,
						compiled: { tasks: [], openCount: 0, protectedOpenCount: 0 },
					};
				},
				async specTaskAdd() {
					return { added: false, taskText: "", revisionId: null };
				},
				async specBehaviorFenceUpdate() {
					return { updated: false, revisionId: null };
				},
				async updateProfile() {
					return { updated: [] };
				},
				async specWrite() {
					return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
				},
			},
		};
		const { api } = buildApi({ adapters });
		const callContext = context();
		const result = await api.command(
			callContext,
			createCommandRequest(callContext, "narrafork.narrator.interrupt", {
				narratorId: "n-worker",
			}),
		);
		expect(result.status).toBe("succeeded");
		expect(result.data).toEqual({ interrupted: true });
	});
});

describe("createCorePluginPublicApiAdapters (core integration)", () => {
	const { db, sqlite } = getTestDb();
	afterEach(() => cleanDb(sqlite));

	const now = "2026-07-16T12:00:00.000Z";

	function seedProject(projectId: string) {
		db.insert(projects)
			.values({
				id: projectId,
				name: `Project ${projectId}`,
				gitPath: `/repo/${projectId}`,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	function seedChapter(projectId: string, chapterId: string) {
		db.insert(chapters)
			.values({
				id: chapterId,
				projectId,
				title: `Chapter ${chapterId}`,
				branch: `chapter/${chapterId}`,
				baseBranch: "main",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	function seedNarrator(
		id: string,
		chapterId: string | null,
		overrides: Partial<typeof narrators.$inferInsert> = {},
	) {
		db.insert(narrators)
			.values({
				id,
				chapterId,
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
				status: "idle",
				substatus: "[]",
				...overrides,
			})
			.run();
	}

	test("lists narrators joined with their chapter's project", async () => {
		seedProject("p1");
		seedChapter("p1", "ch1");
		seedChapter("p1", "ch2");
		seedNarrator("n1", "ch1", { title: "Leader", updatedAt: "2026-07-16T03:00:00.000Z" });
		seedNarrator("n2", "ch2", { title: "Worker", updatedAt: "2026-07-16T02:00:00.000Z" });
		seedNarrator("n3", null, { title: "Standalone", updatedAt: "2026-07-16T01:00:00.000Z" });

		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
		});
		const narratorsAdapter = adapters.narrators;
		expect(narratorsAdapter).toBeDefined();

		// projectId filter excludes standalone narrators (no chapter → no project)
		const rows = await narratorsAdapter?.list({
			limit: 10,
			projectId: "p1",
			context: context(),
			signal: new AbortController().signal,
		});
		expect(rows?.map((row) => row.id).sort()).toEqual(["n1", "n2"]);
		expect(rows?.find((row) => row.id === "n1")).toMatchObject({
			projectId: "p1",
			chapterId: "ch1",
			title: "Leader",
			status: "idle",
		});

		// chapterId filter narrows further
		const chapterRows = await narratorsAdapter?.list({
			limit: 10,
			projectId: "p1",
			chapterId: "ch2",
			context: context(),
			signal: new AbortController().signal,
		});
		expect(chapterRows?.map((row) => row.id)).toEqual(["n2"]);

		// status filter
		seedNarrator("n4", "ch1", { status: "working", updatedAt: "2026-07-16T04:00:00.000Z" });
		const workingRows = await narratorsAdapter?.list({
			limit: 10,
			projectId: "p1",
			status: ["working"],
			context: context(),
			signal: new AbortController().signal,
		});
		expect(workingRows?.map((row) => row.id)).toEqual(["n4"]);

		// keyset pagination: (updatedAt, id) desc
		const firstPage = await narratorsAdapter?.list({
			limit: 2,
			projectId: "p1",
			context: context(),
			signal: new AbortController().signal,
		});
		expect(firstPage?.length).toBe(2);
		const last = firstPage?.[firstPage.length - 1];
		const secondPage = await narratorsAdapter?.list({
			limit: 2,
			projectId: "p1",
			after: last ? { updatedAt: last.updatedAt, id: last.id } : undefined,
			context: context(),
			signal: new AbortController().signal,
		});
		expect(secondPage?.length).toBe(1);
	});

	test("sendMessage forwards origin attribution and maps errors", async () => {
		const sent: Array<{
			narratorId: string;
			message: string;
			originLabel: string | null;
			locale: string;
		}> = [];
		const fakeSession: NarratorSessionFacade = {
			async sendSubagentMessage() {
				return { delivered: "buffered" } as never;
			},
			async createNarrator() {
				return { narratorId: "n-new" } as never;
			},
			async deleteNarrator() {
				return { deleted: true } as never;
			},
			async specTasksGet() {
				return {} as never;
			},
			async specTaskAdd() {
				return { added: false, taskText: "", revisionId: null };
			},
			async specBehaviorFenceUpdate() {
				return { updated: false, revisionId: null };
			},
			async updateProfile() {
				return { updated: [] };
			},
			async specWrite() {
				return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
			},
			async sendMessage(
				narratorId,
				message,
				_images,
				locale,
				_replyInUserLanguage,
				_commandText,
				_userId,
				_textFiles,
				_preBashCommand,
				origin,
			) {
				sent.push({
					narratorId,
					message,
					originLabel: origin?.originLabel ?? null,
					locale: locale ?? "en",
				});
				return { id: "msg-1" } as never;
			},
			interruptNarrator() {
				return false;
			},
			async getById(id) {
				return { id } as never;
			},
		};
		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
			narratorSession: fakeSession,
		});

		const result = await adapters.narratorCommands?.sendMessage({
			narratorId: "n-worker",
			message: "please review chapter 3",
			locale: "zh-CN",
			pluginId: "com.example.team",
			context: context(),
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ messageId: "msg-1" });
		expect(sent[0]).toMatchObject({
			narratorId: "n-worker",
			message: "please review chapter 3",
			originLabel: "plugin:com.example.team",
			locale: "zh-CN",
		});
	});

	test("sendMessage maps a busy narrator to retryable CONFLICT", async () => {
		const fakeSession: NarratorSessionFacade = {
			async sendSubagentMessage() {
				return { delivered: "buffered" } as never;
			},
			async createNarrator() {
				return { narratorId: "n-new" } as never;
			},
			async deleteNarrator() {
				return { deleted: true } as never;
			},
			async specTasksGet() {
				return {} as never;
			},
			async specTaskAdd() {
				return { added: false, taskText: "", revisionId: null };
			},
			async specBehaviorFenceUpdate() {
				return { updated: false, revisionId: null };
			},
			async updateProfile() {
				return { updated: [] };
			},
			async specWrite() {
				return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
			},
			async sendMessage() {
				throw new ValidationError("Narrator is already running");
			},
			interruptNarrator() {
				return false;
			},
			async getById() {
				return { id: "n-worker" } as never;
			},
		};
		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
			narratorSession: fakeSession,
		});

		await expect(
			adapters.narratorCommands?.sendMessage({
				narratorId: "n-worker",
				message: "hi",
				pluginId: "com.example.team",
				context: context(),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			retryable: true,
		});
	});

	test("sendMessage maps subagent rejection to INVALID_PARAMS", async () => {
		const fakeSession: NarratorSessionFacade = {
			async sendSubagentMessage() {
				return { delivered: "buffered" } as never;
			},
			async createNarrator() {
				return { narratorId: "n-new" } as never;
			},
			async deleteNarrator() {
				return { deleted: true } as never;
			},
			async specTasksGet() {
				return {} as never;
			},
			async specTaskAdd() {
				return { added: false, taskText: "", revisionId: null };
			},
			async specBehaviorFenceUpdate() {
				return { updated: false, revisionId: null };
			},
			async updateProfile() {
				return { updated: [] };
			},
			async specWrite() {
				return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
			},
			async sendMessage() {
				throw new ValidationError("Subagent messages must be sent through resumeSubagent");
			},
			interruptNarrator() {
				return false;
			},
			async getById() {
				return { id: "n-sub" } as never;
			},
		};
		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
			narratorSession: fakeSession,
		});

		await expect(
			adapters.narratorCommands?.sendMessage({
				narratorId: "n-sub",
				message: "hi",
				pluginId: "com.example.team",
				context: context(),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
	});

	test("interrupt resolves existence first and reports the outcome", async () => {
		const interrupts: string[] = [];
		const fakeSession: NarratorSessionFacade = {
			async sendSubagentMessage() {
				return { delivered: "buffered" } as never;
			},
			async createNarrator() {
				return { narratorId: "n-new" } as never;
			},
			async deleteNarrator() {
				return { deleted: true } as never;
			},
			async specTasksGet() {
				return {} as never;
			},
			async specTaskAdd() {
				return { added: false, taskText: "", revisionId: null };
			},
			async specBehaviorFenceUpdate() {
				return { updated: false, revisionId: null };
			},
			async updateProfile() {
				return { updated: [] };
			},
			async specWrite() {
				return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
			},
			async sendMessage() {
				throw new Error("not used");
			},
			interruptNarrator(narratorId) {
				interrupts.push(narratorId);
				return true;
			},
			async getById(id) {
				return { id } as never;
			},
		};
		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
			narratorSession: fakeSession,
		});

		const result = await adapters.narratorCommands?.interrupt({
			narratorId: "n-worker",
			context: context(),
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ interrupted: true });
		expect(interrupts).toEqual(["n-worker"]);
	});

	test("interrupt maps an unknown narrator to NOT_FOUND", async () => {
		const fakeSession: NarratorSessionFacade = {
			async sendSubagentMessage() {
				return { delivered: "buffered" } as never;
			},
			async createNarrator() {
				return { narratorId: "n-new" } as never;
			},
			async deleteNarrator() {
				return { deleted: true } as never;
			},
			async specTasksGet() {
				return {} as never;
			},
			async specTaskAdd() {
				return { added: false, taskText: "", revisionId: null };
			},
			async specBehaviorFenceUpdate() {
				return { updated: false, revisionId: null };
			},
			async updateProfile() {
				return { updated: [] };
			},
			async specWrite() {
				return { path: "tasks.json", uri: "spec://tasks.json", revisionId: null };
			},
			async sendMessage() {
				throw new Error("not used");
			},
			interruptNarrator() {
				return false;
			},
			async getById() {
				throw new NotFoundError("Narrator", "n-missing");
			},
		};
		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
			narratorSession: fakeSession,
		});

		await expect(
			adapters.narratorCommands?.interrupt({
				narratorId: "n-missing",
				context: context(),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("lists a narrator's recent messages newest-first with bounded text", async () => {
		seedNarrator("n1", null, { title: "Worker" });
		const insertMessages = async (narratorId: string, texts: string[]) => {
			for (let i = 0; i < texts.length; i++) {
				db.insert(narratorMessages)
					.values({
						id: `m-${narratorId}-${i}`,
						narratorId,
						role: i % 2 === 0 ? "user" : "assistant",
						contentJson: { type: "text", text: texts[i] },
						contentText: texts[i],
						createdAt: new Date(Date.parse(now) + i * 60_000).toISOString(),
					})
					.run();
			}
		};
		await insertMessages("n1", ["task start", "reply one", "follow up", "reply two"]);
		seedNarrator("n2", null, { title: "Other" });
		await insertMessages("n2", ["unrelated"]);

		const adapters = createCorePluginPublicApiAdapters({
			db,
			pluginManager: {
				async list() {
					return [];
				},
				async getStatus() {
					return undefined;
				},
				async enable() {
					throw new Error("not used");
				},
				async disable() {
					throw new Error("not used");
				},
			},
		});

		// Default limit, newest first, only the target narrator's messages.
		const rows = await adapters.narrators?.listMessages({
			narratorId: "n1",
			limit: 10,
			context: context(),
			signal: new AbortController().signal,
		});
		expect(rows?.map((row) => row.text)).toEqual([
			"reply two",
			"follow up",
			"reply one",
			"task start",
		]);
		expect(rows?.map((row) => row.role)).toEqual(["assistant", "user", "assistant", "user"]);

		// limit applies
		const limited = await adapters.narrators?.listMessages({
			narratorId: "n1",
			limit: 2,
			context: context(),
			signal: new AbortController().signal,
		});
		expect(limited?.length).toBe(2);

		// narrator isolation
		const other = await adapters.narrators?.listMessages({
			narratorId: "n2",
			limit: 10,
			context: context(),
			signal: new AbortController().signal,
		});
		expect(other?.map((row) => row.text)).toEqual(["unrelated"]);
	});
});
