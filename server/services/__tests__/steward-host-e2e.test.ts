import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MessageOriginOptions, parseStewardOriginLabel } from "@shared/message-origin";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { integrationAuditEvents, narratorMessages, narrators, users } from "../../db/schema";
import { CapabilityBroker, type InvocationPrincipal } from "../plugin-capability-broker";
import { PluginPackageStore } from "../plugin-package-store";
import { PluginPermissionStore } from "../plugin-permission-store";
import { createPluginPlatformServices } from "../plugin-platform-services";
import {
	createCorePluginPublicApiAdapters,
	type NarratorSessionFacade,
} from "../plugin-public-api";
import { createPluginStateRecord, PluginStateStore } from "../plugin-state-store";
import { PluginStorageFactory } from "../plugin-storage";
import type { PluginUiSession } from "../plugin-ui-session";
import { authorizeStewardMessage } from "../steward-message-admission";
import {
	STEWARD_APPROVED_PACKAGE_HASH,
	STEWARD_APPROVED_SOURCE_HASH,
	STEWARD_APPROVED_VERSION,
	STEWARD_HOST_RUNTIME_ID,
} from "../steward-narrator-host";
import { STEWARD_PLUGIN_ID, STEWARD_SEND_TOOL_ID } from "../steward-narrator-service";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
let sequence = 0;
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "narrafork-steward-host-"));
	roots.push(root);
	const prefix = `steward-e2e-${Date.now()}-${++sequence}`;
	const userId = `${prefix}-user`;
	const sourceId = `${prefix}-source`;
	const targetId = `${prefix}-target`;
	const otherId = `${prefix}-other`;
	const installationId = `${prefix}-install`;
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: userId, username: userId, passwordHash: "test", role: "user", createdAt: now });
	await db.insert(narrators).values(
		[sourceId, targetId, otherId].map((id) => ({
			id,
			ownerUserId: userId,
			visibility: "private" as const,
			writeAudience: "owner" as const,
			createdAt: now,
			updatedAt: now,
		})),
	);
	const archive = await readFile(
		join(
			import.meta.dir,
			"../../../examples/plugins/steward-narrator/steward-narrator-0.2.0.nfplugin",
		),
	);
	expect(createHash("sha256").update(archive).digest("hex")).toBe(STEWARD_APPROVED_SOURCE_HASH);
	const packageStore = new PluginPackageStore({ root: join(root, "packages") });
	const installed = await packageStore.install(archive);
	expect(installed.hash).toBe(STEWARD_APPROVED_PACKAGE_HASH);
	expect(installed.version).toBe(STEWARD_APPROVED_VERSION);
	const stateStore = new PluginStateStore({ root: join(root, "state") });
	await stateStore.setState({
		...createPluginStateRecord(STEWARD_PLUGIN_ID),
		current: { version: installed.version, hash: installed.hash },
		installationId,
		desiredState: "enabled",
		compatibility: "compatible",
		runtimeState: "inactive",
		runtimeGeneration: 1,
	});
	const permissionStore = new PluginPermissionStore({
		root: join(root, "permissions"),
		stateStore,
	});
	const capabilities = [
		"ui.panel",
		"storage.read_self",
		"storage.write_self",
		"command.narrator.send_message",
	];
	const approve = async (selected = capabilities, installId = installationId) =>
		permissionStore.replace(
			STEWARD_PLUGIN_ID,
			installId,
			selected.map((capability) => ({
				capability,
				scope: { type: "user" as const, id: userId },
				grantedBy: userId,
			})),
		);
	await approve();
	const broker = new CapabilityBroker();
	let beforeCommit: (() => Promise<void>) | undefined;
	let deliveryOrigin: MessageOriginOptions | undefined;
	const session = {
		async sendMessage(input: Parameters<NarratorSessionFacade["sendMessage"]>[0]) {
			if (input.kind !== "user") throw new Error("expected user input");
			const { narratorId, message, userId: callerUserId, origin, signal } = input;
			deliveryOrigin = structuredClone(origin);
			await beforeCommit?.();
			await authorizeStewardMessage(narratorId, callerUserId, origin, signal);
			signal?.throwIfAborted();
			const messageId = `${prefix}-message-${++sequence}`;
			const [row] = await db
				.insert(narratorMessages)
				.values({
					id: messageId,
					narratorId,
					role: "user",
					contentText: message,
					contentJson: [{ type: "text", text: message }],
					createdBy: callerUserId,
					origin: origin?.origin ?? "user",
					originLabel: origin?.originLabel,
					createdAt: new Date().toISOString(),
				})
				.returning();
			return {
				accepted: true,
				duplicate: false,
				messageId: row!.id,
				mailboxId: `${messageId}-mailbox`,
				bufferedAt: row!.createdAt,
				state: "consumed",
				receiptDisposition: "accepted",
				delivered: "started",
				userMsg: row,
			};
		},
	} as NarratorSessionFacade;
	const adapters = createCorePluginPublicApiAdapters({
		db,
		pluginManager: {
			list: async () => [],
			getStatus: async () => undefined,
			enable: async () => undefined,
			disable: async () => undefined,
		} as never,
		narratorSession: session,
	});
	const platform = createPluginPlatformServices({
		stateStore,
		packageStore,
		permissionStore,
		capabilityBroker: broker,
		storageFactory: new PluginStorageFactory({ root: join(root, "storage") }),
		publicApiAdapters: adapters,
	});
	platform.pluginCommandRegistry.registerManifest(installed.manifest);
	platform.toolRegistry.registerManifest(installed.manifest);
	const permissionSet = await permissionStore.getSet(STEWARD_PLUGIN_ID, installationId);
	const uiSession: PluginUiSession = {
		pluginId: STEWARD_PLUGIN_ID,
		version: installed.version,
		hash: installed.hash,
		installationId,
		authorityInstallationId: installationId,
		principalId: userId,
		contributionId: "steward-panel",
		panelInstanceId: `${prefix}-panel`,
		surface: "workspace",
		surfaceScope: "narrator",
		scope: { narratorId: sourceId },
		sessionId: `${prefix}-ui`,
		connectNonce: "n".repeat(24),
		generation: 1,
		createdAt: now,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	platform.hostServices.bindRuntime({
		pluginId: STEWARD_PLUGIN_ID,
		packageVersion: installed.version,
		installationId,
		runtimeId: `ui:${uiSession.sessionId}`,
		runtimeGeneration: 1,
		grantRevision: permissionSet.revision,
		desiredState: "enabled",
		compatibilityState: "compatible",
		runtimeState: "active",
		manifestRequested: capabilities,
		grants: permissionSet.grants,
	});
	const panelCommand = (commandId: string) =>
		platform.uiHost.dispatch({
			session: uiSession,
			principalId: userId,
			userRole: "user",
			request: {
				protocol: "narrafork.ui/1",
				kind: "request",
				id: `${prefix}-ui-${++sequence}`,
				method: "commands.execute",
				params: { commandId, input: {} },
			},
		});
	const send = (source = sourceId, invocation?: InvocationPrincipal, signal?: AbortSignal) =>
		platform.toolRegistry.invoke(
			`${STEWARD_PLUGIN_ID}/${STEWARD_SEND_TOOL_ID}`,
			{ targetNarratorId: targetId, message: "secret delegated body" },
			{
				invocation: invocation ?? {
					kind: "user",
					userId,
					userRole: "user",
					source: "internal",
					narratorId: source,
				},
				scope: { userId, narratorId: source },
				requestId: `${prefix}-send-${++sequence}`,
				correlationId: `${prefix}-correlation`,
				signal,
			},
		);
	return {
		platform,
		stateStore,
		packageStore,
		installed,
		permissionStore,
		broker,
		userId,
		sourceId,
		targetId,
		otherId,
		installationId,
		approve,
		panelCommand,
		send,
		deliveryOrigin: () => deliveryOrigin,
		setBeforeCommit: (hook?: () => Promise<void>) => {
			beforeCommit = hook;
		},
		messages: () =>
			db.query.narratorMessages.findMany({ where: eq(narratorMessages.narratorId, targetId) }),
	};
}

async function bind(f: Awaited<ReturnType<typeof fixture>>) {
	const result = await f.panelCommand("steward.bind");
	expect(result).not.toHaveProperty("error");
	return result;
}

describe("steward production host composition", () => {
	test("panel bind → host tool → public command/core adapter → durable eight-field attribution and real audit", async () => {
		const f = await fixture();
		await bind(f);
		expect(await f.panelCommand("steward.binding")).not.toHaveProperty("error");
		const sent = await f.send();
		expect(JSON.parse(sent.output)).toHaveProperty("messageId");
		const rows = await f.messages();
		expect(rows).toHaveLength(1);
		expect(rows[0].createdBy).toBe(f.userId);
		expect(rows[0].origin).toBe("assistant");
		const source = parseStewardOriginLabel(rows[0].originLabel);
		expect(source).toMatchObject({
			userId: f.userId,
			pluginId: STEWARD_PLUGIN_ID,
			contributionId: STEWARD_SEND_TOOL_ID,
			stewardNarratorId: f.sourceId,
			targetNarratorId: f.targetId,
			bindingRevision: 1,
		});
		if (!source) throw new Error("Missing steward attribution");
		expect(Object.keys(source)).toHaveLength(8);
		expect(f.broker.getBinding(STEWARD_PLUGIN_ID, STEWARD_HOST_RUNTIME_ID)?.plugin?.runtimeId).toBe(
			STEWARD_HOST_RUNTIME_ID,
		);
		const audits = await db.query.integrationAuditEvents.findMany({
			where: eq(integrationAuditEvents.principalId, f.userId),
		});
		expect(
			audits.some((audit) => audit.operationId === "steward.send" && audit.outcome === "succeeded"),
		).toBe(true);
		expect(JSON.stringify(audits)).not.toContain("secret delegated body");
	});

	test("latest grants revision fence blocks first binding after stale permission read", async () => {
		const f = await fixture();
		const readPermissionSet = f.permissionStore.getSet.bind(f.permissionStore);
		let injected = false;
		f.permissionStore.getSet = async (...args) => {
			const permissionSet = await readPermissionSet(...args);
			if (!injected) {
				injected = true;
				const state = await f.stateStore.getState(STEWARD_PLUGIN_ID);
				if (!state) throw new Error("Missing installation state");
				await f.stateStore.updateState(STEWARD_PLUGIN_ID, {
					grants: { ...state.grants, revision: state.grants.revision + 1 },
				});
			}
			return permissionSet;
		};
		await expect(f.send()).rejects.toBeDefined();
		expect(f.broker.getBinding(STEWARD_PLUGIN_ID, STEWARD_HOST_RUNTIME_ID)).toBeUndefined();
		expect(await f.messages()).toHaveLength(0);
	});

	test("current grants, immutable package hash, lifecycle and installation generation fail closed", async () => {
		const f = await fixture();
		await bind(f);
		await f.approve(["ui.panel", "storage.read_self", "storage.write_self"]);
		await expect(f.send()).rejects.toBeDefined();
		await f.approve();
		for (const patch of [
			{ desiredState: "disabled" as const },
			{ runtimeState: "stopped" as const },
			{ compatibility: "incompatible" as const },
			{ current: { version: STEWARD_APPROVED_VERSION, hash: "a".repeat(64) } },
			{ current: { version: "0.1.1", hash: STEWARD_APPROVED_PACKAGE_HASH } },
		]) {
			const original = await f.stateStore.getState(STEWARD_PLUGIN_ID);
			if (!original) throw new Error("Missing installation state");
			await f.stateStore.setState({ ...original, ...patch });
			await expect(f.send()).rejects.toBeDefined();
			await f.stateStore.setState(original);
		}
		const pointer = f.installed;
		await f.packageStore.setCurrent(STEWARD_PLUGIN_ID, undefined);
		await expect(f.send()).rejects.toBeDefined();
		await f.packageStore.setCurrent(STEWARD_PLUGIN_ID, {
			version: pointer.version,
			hash: pointer.hash,
		});
		const entryPath = join(pointer.packagePath, "ui", "panel.iife.js");
		const entry = await readFile(entryPath);
		await writeFile(entryPath, "malicious edited package");
		await expect(f.send()).rejects.toBeDefined();
		await writeFile(entryPath, entry);
		await f.stateStore.updateState(STEWARD_PLUGIN_ID, {
			installationId: `${f.installationId}-new`,
			runtimeGeneration: 2,
		});
		await expect(f.send()).rejects.toBeDefined();
		expect(await f.messages()).toHaveLength(0);
	});

	test("source-narrator command grant cannot authorize a different delegated target", async () => {
		const f = await fixture();
		await bind(f);
		await f.permissionStore.replace(
			STEWARD_PLUGIN_ID,
			f.installationId,
			["ui.panel", "storage.read_self", "storage.write_self", "command.narrator.send_message"].map(
				(capability) => ({
					capability,
					scope:
						capability === "command.narrator.send_message"
							? { type: "narrator" as const, id: f.sourceId }
							: { type: "user" as const, id: f.userId },
					grantedBy: f.userId,
				}),
			),
		);
		await expect(f.send()).rejects.toBeDefined();
		expect(await f.messages()).toHaveLength(0);
	});

	test("wrong narrator/background/system/no ACL and precommit revoke/rebind/abort never persist", async () => {
		const f = await fixture();
		await bind(f);
		await expect(f.send(f.otherId)).rejects.toBeDefined();
		await expect(
			f.send(f.sourceId, {
				kind: "user",
				userId: "missing-guest",
				userRole: "user",
				source: "internal",
				narratorId: f.sourceId,
			}),
		).rejects.toBeDefined();
		await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, f.sourceId));
		await expect(f.send()).rejects.toBeDefined();
		await db.update(narrators).set({ ownerUserId: f.userId }).where(eq(narrators.id, f.sourceId));
		await expect(
			f.send(f.sourceId, { kind: "plugin_background", source: "internal" }),
		).rejects.toBeDefined();
		await expect(f.send(f.sourceId, { kind: "system", source: "internal" })).rejects.toBeDefined();
		await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, f.targetId));
		await expect(f.send()).rejects.toBeDefined();
		await db.update(narrators).set({ ownerUserId: f.userId }).where(eq(narrators.id, f.targetId));
		f.setBeforeCommit(async () => {
			await f.approve(["ui.panel", "storage.read_self", "storage.write_self"]);
		});
		await expect(f.send()).rejects.toBeDefined();
		await f.approve();
		f.setBeforeCommit(async () => {
			await f.stateStore.updateState(STEWARD_PLUGIN_ID, { runtimeGeneration: 2 });
		});
		await expect(f.send()).rejects.toBeDefined();
		await f.stateStore.updateState(STEWARD_PLUGIN_ID, { runtimeGeneration: 1 });
		f.setBeforeCommit(async () => {
			await f.stateStore.updateState(STEWARD_PLUGIN_ID, { desiredState: "disabled" });
		});
		await expect(f.send()).rejects.toBeDefined();
		await f.stateStore.updateState(STEWARD_PLUGIN_ID, { desiredState: "enabled" });
		f.setBeforeCommit(async () => {
			await f.stateStore.updateState(STEWARD_PLUGIN_ID, {
				installationId: `${f.installationId}-new`,
			});
			await f.approve(undefined, `${f.installationId}-new`);
		});
		await expect(f.send()).rejects.toBeDefined();
		await f.stateStore.updateState(STEWARD_PLUGIN_ID, { installationId: f.installationId });
		f.setBeforeCommit(undefined);
		const controller = new AbortController();
		controller.abort();
		await expect(f.send(f.sourceId, undefined, controller.signal)).rejects.toBeDefined();
		expect(await f.messages()).toHaveLength(0);
	});

	test("durable replay retains original host generation and lifecycle broker revocation is not restored by requests", async () => {
		const f = await fixture();
		await bind(f);
		await f.send();
		const origin = f.deliveryOrigin();
		if (!origin) throw new Error("Missing steward delivery snapshot");
		expect(origin.delegationHostContext).toMatchObject({
			plugin: {
				installationId: f.installationId,
				runtimeId: STEWARD_HOST_RUNTIME_ID,
				runtimeGeneration: 1,
			},
			invocation: { narratorId: f.sourceId },
			scope: { narratorId: f.sourceId },
		});
		await f.stateStore.updateState(STEWARD_PLUGIN_ID, { runtimeGeneration: 2 });
		await expect(authorizeStewardMessage(f.targetId, f.userId, origin)).rejects.toBeDefined();
		await f.stateStore.updateState(STEWARD_PLUGIN_ID, { runtimeGeneration: 1 });
		f.broker.revoke(STEWARD_PLUGIN_ID);
		await expect(f.send()).rejects.toBeDefined();
		await expect(authorizeStewardMessage(f.targetId, f.userId, origin)).rejects.toBeDefined();
		f.broker.restore(STEWARD_PLUGIN_ID);
		expect(f.broker.revokeRuntime(STEWARD_PLUGIN_ID, STEWARD_HOST_RUNTIME_ID, 1)).toBe(true);
		await expect(f.send()).rejects.toBeDefined();
		await expect(authorizeStewardMessage(f.targetId, f.userId, origin)).rejects.toBeDefined();
		expect(f.broker.getBinding(STEWARD_PLUGIN_ID, STEWARD_HOST_RUNTIME_ID)).toBeUndefined();
		expect(await f.messages()).toHaveLength(1);
	});
});
