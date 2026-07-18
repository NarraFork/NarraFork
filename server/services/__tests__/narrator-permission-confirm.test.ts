import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";
import type { DangerInfo, PermissionResult } from "../../lib/agent";
import type { ExecutionBackend, ReadBytesOptions } from "../../lib/agent/execution/backend";
import { localBackend, setRemoteBackendResolver } from "../../lib/agent/execution/registry";
import type { ToolExecutionTarget } from "../../lib/agent/types";
import type { PendingDangerReflection } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
const realNarratorServiceModule = { ...(await import("../narrator-service")) };
const events: Array<{ type: string; decision?: string }> = [];

mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWsModule,
	broadcastToNarrator: (_narratorId: string, message: { type: string; decision?: string }) => {
		events.push(message);
	},
}));
mock.module("../narrator-service", () => ({
	...realNarratorServiceModule,
	narratorService: {
		...realNarratorServiceModule.narratorService,
		updateStatus: async () => {},
	},
}));

const {
	confirmDangerReflection,
	handlePermission,
	reprocessAllPendingPermissions,
	resolvePermission,
} = await import("../narrator-permission");
const { activeNarrators, pendingDangerReflections, pendingPermissions } = await import(
	"../narrator-session-state"
);

const narratorId = "confirm-order-narrator";
const messageId = "confirm-order-message";
const toolCallId = "confirm-order-tool-call";
const toolUseId = "confirm-order-tool-use";

const danger: DangerInfo = {
	severity: "high",
	summary: "Dangerous command",
	consequences: ["May modify files"],
	saferAlternatives: ["Inspect first"],
};

function now(): string {
	return "2026-07-17T00:00:00.000Z";
}

async function seedToolCall(): Promise<void> {
	await db.insert(narrators).values({
		id: narratorId,
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: now(),
	});
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId,
		toolUseId,
		toolName: "Bash",
		status: "pending",
		permissionSuggestions: [
			{
				type: "danger_reflection",
				status: "running",
				requestId: toolCallId,
			},
		],
		createdAt: now(),
	});
}

type PermissionSeed = {
	narratorId: string;
	messageId: string;
	toolCallId: string;
	toolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
	permissionMode?: "default" | "bypassPermissions";
	relaxedPlan?: boolean;
	traits?: string[];
	planFileId?: string;
	executionDeviceId?: string;
	executionCwd?: string;
	resolvedFilePath?: string;
	deviceSelectionSource?: "explicit" | "session_default" | "local_default";
};

async function seedPermissionRequest(seed: PermissionSeed): Promise<void> {
	await db.insert(narrators).values({
		id: seed.narratorId,
		permissionMode: seed.permissionMode ?? "default",
		relaxedPlan: seed.relaxedPlan ?? false,
		traits: seed.traits,
		planFileId: seed.planFileId,
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narratorMessages).values({
		id: seed.messageId,
		narratorId: seed.narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: now(),
	});
	await db.insert(narratorToolCalls).values({
		id: seed.toolCallId,
		narratorId: seed.narratorId,
		messageId: seed.messageId,
		toolUseId: seed.toolUseId,
		toolName: seed.toolName,
		inputJson: seed.input,
		executionDeviceId: seed.executionDeviceId,
		executionCwd: seed.executionCwd,
		resolvedFilePath: seed.resolvedFilePath,
		deviceSelectionSource: seed.deviceSelectionSource,
		status: "initializing",
		createdAt: now(),
	});
}

function makeRemotePlanBackend(planPath: string, content: string) {
	const calls = {
		stat: [] as string[],
		read: [] as string[],
		expectedResolvedPath: [] as Array<string | undefined>,
	};
	const backend = {
		deviceId: "remote-plan-device",
		kind: "remote" as const,
		defaultCwd: "/remote/work",
		platform: { os: "linux", arch: "x64" },
		supportsFsStatResolvedPath: true,
		supportsFsReadAtomicResolvedPath: true,
		statFile: async (path: string) => {
			calls.stat.push(path);
			if (path === planPath) {
				return {
					isFile: true,
					isDirectory: false,
					size: Buffer.byteLength(content),
					resolvedPath: path,
				};
			}
			if (path === "/remote/work") {
				return { isFile: false, isDirectory: true, size: 0, resolvedPath: path };
			}
			return null;
		},
		readFileBytes: async (path: string, options?: ReadBytesOptions) => {
			calls.read.push(path);
			calls.expectedResolvedPath.push(options?.expectedResolvedPath);
			const bytes = new TextEncoder().encode(content);
			return {
				bytes,
				truncated: false,
				totalSize: bytes.byteLength,
				resolvedPath: options?.expectedResolvedPath,
			};
		},
	} as unknown as ExecutionBackend;
	return { backend, calls };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for permission state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(() => {
	events.length = 0;
	pendingDangerReflections.clear();
	pendingPermissions.clear();
	activeNarrators.clear();
	setRemoteBackendResolver(null);
	sqlite.run("DELETE FROM narrator_tool_calls");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.restore();
});

describe("confirmDangerReflection ordering", () => {
	test("broadcasts confirmed before resolving the original tool permission", async () => {
		await seedToolCall();
		let resolvedResult: PermissionResult | undefined;
		pendingDangerReflections.set(toolCallId, {
			narratorId,
			requestId: toolCallId,
			toolCallId,
			toolUseId,
			toolName: "Bash",
			broadcastTargetId: narratorId,
			input: { command: "bun test" },
			fingerprint: "fingerprint",
			danger,
			startedAt: Date.now(),
			resolve: (result) => {
				events.push({ type: "permission_resolved" });
				resolvedResult = result;
			},
			cleanup: () => {},
		} satisfies PendingDangerReflection);

		expect(await confirmDangerReflection(toolCallId, "confirmed by reflection")).toBe(true);
		expect(events.map((event) => event.type)).toEqual([
			"danger_reflection_resolved",
			"permission_resolved",
		]);
		expect(events[0]?.decision).toBe("allow");
		expect(resolvedResult).toMatchObject({ behavior: "allow" });

		const row = await db.query.narratorToolCalls.findFirst();
		expect(row?.status).toBe("running");
		expect((row?.permissionSuggestions as Array<{ status?: string }>)[0]?.status).toBe("confirmed");
	});
});

describe("pending permission execution identity", () => {
	test("reprocesses a remote ExitPlanMode only through its frozen remote backend", async () => {
		const localRoot = mkdtempSync(join(tmpdir(), "narrafork-permission-reprocess-"));
		const remotePath = "/remote/work/.narrafork/plan-remote-cycle.md";
		const remoteContent = "# Remote plan\n\nRead from the executor.";
		const localContent = "# LOCAL FALLBACK MUST NOT BE READ";
		const localPlanPath = join(localRoot, ".narrafork", "plan-remote-cycle.md");
		mkdirSync(join(localRoot, ".narrafork"), { recursive: true });
		writeFileSync(localPlanPath, localContent, "utf8");
		const { backend, calls } = makeRemotePlanBackend(remotePath, remoteContent);
		const id = "remote-reprocess-narrator";
		const message = "remote-reprocess-message";
		const toolCall = "remote-reprocess-tool-call";
		const toolUse = "remote-reprocess-tool-use";
		const controller = new AbortController();
		const target: ToolExecutionTarget = {
			deviceId: "remote-plan-device",
			backendKind: "remote",
			cwd: "/remote/work",
			resolvedFilePath: remotePath,
			selectionSource: "explicit",
		};

		try {
			setRemoteBackendResolver((deviceId) => (deviceId === backend.deviceId ? backend : null));
			await seedPermissionRequest({
				narratorId: id,
				messageId: message,
				toolCallId: toolCall,
				toolUseId: toolUse,
				toolName: "ExitPlanMode",
				input: {},
				traits: ["plan"],
				planFileId: "remote-cycle",
				executionDeviceId: backend.deviceId,
				executionCwd: "/remote/work",
				resolvedFilePath: remotePath,
				deviceSelectionSource: "explicit",
			});
			activeNarrators.set(id, { _planFileId: "remote-cycle" } as never);

			const permissionPromise = handlePermission(
				id,
				controller.signal,
				"ExitPlanMode",
				{},
				toolUse,
				localRoot,
				"en",
				undefined,
				{ executionBackend: backend, executionTarget: target },
			);
			await waitFor(() => pendingPermissions.has(toolCall));
			const firstPending = pendingPermissions.get(toolCall);
			expect(firstPending?.input.plan).toBe(remoteContent);
			expect(firstPending?.executionTarget).toEqual(target);
			expect(Object.isFrozen(firstPending?.executionTarget)).toBe(true);
			const readsBeforeReprocess = calls.read.length;

			await db
				.update(narrators)
				.set({ permissionMode: "bypassPermissions", relaxedPlan: true })
				.where(eq(narrators.id, id));
			expect(reprocessAllPendingPermissions(id)).toBe(1);
			await waitFor(() => pendingPermissions.has(toolCall));
			const reprocessed = pendingPermissions.get(toolCall);
			expect(reprocessed?.input.plan).toBe(remoteContent);
			expect(reprocessed?.input.plan).not.toBe(localContent);
			expect(calls.read.length).toBeGreaterThan(readsBeforeReprocess);
			expect(calls.read.every((path) => path === remotePath)).toBe(true);

			expect(await resolvePermission(toolCall, "allow")).toBe(true);
			expect(await permissionPromise).toMatchObject({ behavior: "allow" });
		} finally {
			controller.abort();
			rmSync(localRoot, { recursive: true, force: true });
		}
	});

	test("reprocesses a relaxed custom plan path with the same frozen provenance", async () => {
		const customInputPath = "plans/custom-plan.md";
		const customPath = "/remote/work/plans/custom-plan.md";
		const customContent = "# Custom remote plan\n\nKeep this source.";
		const { backend, calls } = makeRemotePlanBackend(customPath, customContent);
		const id = "remote-custom-reprocess-narrator";
		const message = "remote-custom-reprocess-message";
		const toolCall = "remote-custom-reprocess-tool-call";
		const toolUse = "remote-custom-reprocess-tool-use";
		const controller = new AbortController();
		const target: ToolExecutionTarget = {
			deviceId: backend.deviceId,
			backendKind: "remote",
			cwd: "/remote/work",
			resolvedFilePath: customPath,
			selectionSource: "explicit",
		};

		try {
			setRemoteBackendResolver((deviceId) => (deviceId === backend.deviceId ? backend : null));
			await seedPermissionRequest({
				narratorId: id,
				messageId: message,
				toolCallId: toolCall,
				toolUseId: toolUse,
				toolName: "ExitPlanMode",
				input: { plan_file_path: customInputPath },
				traits: ["plan"],
				planFileId: "designated-cycle",
				relaxedPlan: true,
				executionDeviceId: backend.deviceId,
				executionCwd: "/remote/work",
				resolvedFilePath: customPath,
				deviceSelectionSource: "explicit",
			});
			activeNarrators.set(id, { _planFileId: "designated-cycle" } as never);

			const permissionPromise = handlePermission(
				id,
				controller.signal,
				"ExitPlanMode",
				{ plan_file_path: customInputPath },
				toolUse,
				"/local/should-not-be-used",
				"en",
				undefined,
				{ executionBackend: backend, executionTarget: target },
			);
			await waitFor(() => pendingPermissions.has(toolCall));
			const firstPending = pendingPermissions.get(toolCall);
			expect(firstPending?.input.plan).toBe(customContent);
			expect(firstPending?.input.plan_file_path).toBeUndefined();
			expect(firstPending?.planSource).toEqual({
				kind: "file",
				path: customPath,
				resolvedPath: customPath,
				custom: true,
			});
			const readsBeforeReprocess = calls.read.length;

			await db
				.update(narrators)
				.set({ permissionMode: "bypassPermissions" })
				.where(eq(narrators.id, id));
			expect(reprocessAllPendingPermissions(id)).toBe(1);
			await waitFor(() => pendingPermissions.has(toolCall));
			const reprocessed = pendingPermissions.get(toolCall);
			expect(reprocessed?.input.plan).toBe(customContent);
			expect(reprocessed?.planSource).toEqual(firstPending?.planSource);
			expect(reprocessed?.executionTarget).toEqual(target);
			expect(calls.read.length).toBeGreaterThan(readsBeforeReprocess);
			expect(calls.read.every((path) => path === customPath)).toBe(true);
			expect(calls.expectedResolvedPath.every((path) => path === customPath)).toBe(true);

			expect(await resolvePermission(toolCall, "allow")).toBe(true);
			expect(await permissionPromise).toMatchObject({ behavior: "allow" });
		} finally {
			controller.abort();
		}
	});

	test("fails a pending remote plan closed when its device goes offline", async () => {
		const remotePath = "/remote/work/.narrafork/plan-offline-cycle.md";
		const { backend, calls } = makeRemotePlanBackend(remotePath, "# Remote plan");
		const id = "remote-offline-narrator";
		const message = "remote-offline-message";
		const toolCall = "remote-offline-tool-call";
		const toolUse = "remote-offline-tool-use";
		const controller = new AbortController();
		try {
			setRemoteBackendResolver((deviceId) => (deviceId === backend.deviceId ? backend : null));
			await seedPermissionRequest({
				narratorId: id,
				messageId: message,
				toolCallId: toolCall,
				toolUseId: toolUse,
				toolName: "ExitPlanMode",
				input: {},
				traits: ["plan"],
				planFileId: "offline-cycle",
				executionDeviceId: backend.deviceId,
				executionCwd: "/remote/work",
				resolvedFilePath: remotePath,
				deviceSelectionSource: "explicit",
			});
			activeNarrators.set(id, { _planFileId: "offline-cycle" } as never);
			const permissionPromise = handlePermission(
				id,
				controller.signal,
				"ExitPlanMode",
				{},
				toolUse,
				"/local/should-not-be-used",
				"en",
				undefined,
				{
					executionBackend: backend,
					executionTarget: {
						deviceId: backend.deviceId,
						backendKind: "remote",
						cwd: "/remote/work",
						resolvedFilePath: remotePath,
						selectionSource: "explicit",
					},
				},
			);
			await waitFor(() => pendingPermissions.has(toolCall));
			const readsBeforeOffline = calls.read.length;
			setRemoteBackendResolver(null);
			await db
				.update(narrators)
				.set({ permissionMode: "bypassPermissions", relaxedPlan: true })
				.where(eq(narrators.id, id));
			expect(reprocessAllPendingPermissions(id)).toBe(1);

			const result = await permissionPromise;
			expect(result.behavior).toBe("deny");
			if (result.behavior !== "deny") throw new Error("Expected remote reprocessing to deny");
			expect(result.message).toContain("remote-plan-device");
			expect(result.message).toContain("was not run locally");
			expect(calls.read.length).toBe(readsBeforeOffline);
			expect(pendingPermissions.has(toolCall)).toBe(false);
			const row = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, toolCall),
			});
			expect(row?.status).toBe("fail");
			expect(row?.errorMessage).toContain("Permission reprocessing failed");
		} finally {
			controller.abort();
		}
	});

	test("keeps an ordinary local permission request working after reprocessing", async () => {
		const id = "local-reprocess-narrator";
		const message = "local-reprocess-message";
		const toolCall = "local-reprocess-tool-call";
		const toolUse = "local-reprocess-tool-use";
		const controller = new AbortController();
		const localTarget: ToolExecutionTarget = {
			deviceId: "local",
			backendKind: "local",
			cwd: "/local/work",
			selectionSource: "local_default",
		};
		try {
			await seedPermissionRequest({
				narratorId: id,
				messageId: message,
				toolCallId: toolCall,
				toolUseId: toolUse,
				toolName: "WebFetch",
				input: { url: "https://example.com" },
			});
			const permissionPromise = handlePermission(
				id,
				controller.signal,
				"WebFetch",
				{ url: "https://example.com" },
				toolUse,
				"/local/work",
				"en",
				undefined,
				{ executionBackend: localBackend, executionTarget: localTarget },
			);
			await waitFor(() => pendingPermissions.has(toolCall));
			await db
				.update(narrators)
				.set({ permissionMode: "bypassPermissions" })
				.where(eq(narrators.id, id));
			expect(reprocessAllPendingPermissions(id)).toBe(1);

			expect(await permissionPromise).toMatchObject({ behavior: "allow" });
			expect(pendingPermissions.has(toolCall)).toBe(false);
		} finally {
			controller.abort();
		}
	});
});
