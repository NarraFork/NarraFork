import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NarratorAclRow, NarratorPrincipal } from "../narrator-acl";
import type { CapabilityAuthorizationRequest } from "../plugin-capability-broker";
import type {
	PluginStorageEntry,
	PluginStorageGetInput,
	PluginStorageSetInput,
} from "../plugin-storage";
import { PluginStorageFactory } from "../plugin-storage";
import {
	STEWARD_BIND_COMMAND_ID,
	STEWARD_BINDING_KEY,
	STEWARD_MAX_MESSAGE_LENGTH,
	STEWARD_PLUGIN_ID,
	STEWARD_READ_BINDING_COMMAND_ID,
	STEWARD_SEND_TOOL_ID,
	type StewardAuditRecord,
	type StewardBindingStorage,
	type StewardHostContext,
	StewardNarratorService,
	type StewardNarratorServiceOptions,
	type StewardSendAdapter,
} from "../steward-narrator-service";

const NOW = new Date("2030-01-01T12:00:00.000Z");
function context(
	operation: "bind" | "read" | "send",
	narratorId = "steward-a",
	userId = "user-a",
): StewardHostContext {
	return {
		requestId: `request-${operation}`,
		correlationId: "correlation-a",
		deadlineAt: new Date(NOW.getTime() + 60_000).toISOString(),
		plugin: {
			pluginId: STEWARD_PLUGIN_ID,
			packageVersion: "1.0.0",
			runtimeId: "runtime-a",
			runtimeGeneration: 1,
			installationId: "installation-a",
			contributionId:
				operation === "bind"
					? STEWARD_BIND_COMMAND_ID
					: operation === "send"
						? STEWARD_SEND_TOOL_ID
						: STEWARD_READ_BINDING_COMMAND_ID,
		},
		invocation: {
			kind: "user",
			userId,
			userRole: "user",
			source: operation === "send" ? "internal" : "ui",
			narratorId,
		},
		scope: { userId, narratorId },
	};
}
function row(id: string, ownerUserId = "user-a"): NarratorAclRow {
	return {
		id,
		ownerUserId,
		visibility: "private",
		writeAudience: "owner",
		type: "primary",
		aclRootNarratorId: null,
	};
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
class MemoryStorage implements StewardBindingStorage {
	entries = new Map<string, PluginStorageEntry>();
	reads: PluginStorageGetInput[] = [];
	writes: PluginStorageSetInput[] = [];
	conflicts = 0;
	getKey(input: PluginStorageGetInput): string {
		return JSON.stringify(input.scope);
	}
	async get(input: PluginStorageGetInput): Promise<PluginStorageEntry | null> {
		this.reads.push(structuredClone(input));
		return structuredClone(this.entries.get(this.getKey(input)) ?? null);
	}
	async set(
		input: PluginStorageSetInput,
		options?: Parameters<StewardBindingStorage["set"]>[1],
	): Promise<PluginStorageEntry> {
		options?.signal?.throwIfAborted();
		this.writes.push(structuredClone(input));
		const previous = this.entries.get(this.getKey(input));
		if (this.conflicts-- > 0 || (previous?.revision ?? 0) !== input.expectedRevision)
			throw Object.assign(new Error("CAS conflict"), { reason: "REVISION_CONFLICT" });
		const entry: PluginStorageEntry = {
			pluginId: STEWARD_PLUGIN_ID,
			scope: { type: "user", id: (input.scope as { id: string }).id },
			key: STEWARD_BINDING_KEY,
			value: input.value as PluginStorageEntry["value"],
			valueBytes: JSON.stringify(input.value).length,
			revision: (previous?.revision ?? 0) + 1,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		};
		await options?.beforeCommit?.();
		options?.commitGuard?.();
		options?.signal?.throwIfAborted();
		this.entries.set(this.getKey(input), structuredClone(entry));
		return structuredClone(entry);
	}
	corrupt(mutator: (entry: PluginStorageEntry) => void, userId = "user-a") {
		const entry = this.entries.get(JSON.stringify({ type: "user", id: userId }));
		if (!entry) throw new Error("Binding fixture does not exist");
		mutator(entry);
	}
}
function fixture() {
	const storage = new MemoryStorage();
	const audit: StewardAuditRecord[] = [];
	const deliveries: Array<Parameters<StewardSendAdapter["sendMessage"]>[0]> = [];
	const capabilities: CapabilityAuthorizationRequest[] = [];
	const principals: NarratorPrincipal[] = [];
	const rows = new Map(["steward-a", "steward-b", "target-a"].map((id) => [id, row(id)]));
	const readOnly = new Set<string>();
	let now = new Date(NOW);
	const options: StewardNarratorServiceOptions = {
		storageFactory: {
			get(pluginId) {
				expect(pluginId).toBe(STEWARD_PLUGIN_ID);
				return storage;
			},
		},
		authorize: async (input) => {
			capabilities.push(input);
			return { allowed: true };
		},
		lookupNarrator: async (id) => rows.get(id),
		resolveUserPrincipal: async (userId) => ({ userId, isAdmin: false }),
		canWriteNarrator: async (principal, narrator) => {
			principals.push(principal);
			return (
				!readOnly.has(narrator.id) &&
				(principal.isAdmin || principal.userId === narrator.ownerUserId)
			);
		},
		sendAdapter: {
			async sendMessage(input) {
				deliveries.push(input);
				return { messageId: "message-a" };
			},
		},
		auditSink: async (record) => {
			audit.push(record);
		},
		clock: () => now,
	};
	const service = new StewardNarratorService(options);
	return {
		service,
		options,
		storage,
		audit,
		deliveries,
		capabilities,
		principals,
		rows,
		readOnly,
		setNow(value: Date) {
			now = value;
		},
		bind: (id = "steward-a", userId = "user-a") =>
			service.bindCurrentNarrator(context("bind", id, userId)),
		send: (
			input: unknown = { targetNarratorId: "target-a", message: "secret body" },
			host = context("send"),
			signal?: AbortSignal,
		) => service.send(host, input, signal),
	};
}
async function rejected(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ code });
}

describe("StewardNarratorService", () => {
	test("bind commit guard rejects cancellation during storage I/O and preserves old binding", async () => {
		const f = fixture();
		await f.bind();
		const controller = new AbortController();
		const started = deferred();
		const release = deferred();
		f.options.storageFactory = () => ({
			get: (input) => f.storage.get(input),
			async set(input, guards) {
				started.resolve();
				await release.promise;
				return f.storage.set(input, guards);
			},
		});
		const binding = f.service.bindCurrentNarrator(context("bind", "steward-b"), controller.signal);
		await started.promise;
		controller.abort();
		release.resolve();
		await rejected(binding, "CANCELLED");
		expect((await f.service.readBinding(context("read")))?.stewardNarratorId).toBe("steward-a");
		expect((await f.service.readBinding(context("read")))?.revision).toBe(1);
	});

	test("bind beforeCommit rechecks ACL revocation and deadline after storage awaits", async () => {
		const f = fixture();
		await f.bind();
		f.options.storageFactory = () => ({
			get: (input) => f.storage.get(input),
			async set(input, guards) {
				f.readOnly.add("steward-b");
				return f.storage.set(input, guards);
			},
		});
		await rejected(f.bind("steward-b"), "NARRATOR_WRITE_DENIED");
		expect((await f.service.readBinding(context("read")))?.revision).toBe(1);
		f.readOnly.clear();
		f.options.storageFactory = () => ({
			get: (input) => f.storage.get(input),
			async set(input, guards) {
				f.setNow(new Date(NOW.getTime() + 120_000));
				return f.storage.set(input, guards);
			},
		});
		await rejected(f.bind("steward-b"), "TIMEOUT");
		f.setNow(NOW);
		expect((await f.service.readBinding(context("read")))?.revision).toBe(1);
	});

	test("post-commit cancellation cannot misreport successfully bound revision", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.options.storageFactory = () => ({
			get: (input) => f.storage.get(input),
			async set(input, guards) {
				const stored = await f.storage.set(input, guards);
				controller.abort();
				return stored;
			},
		});
		expect((await f.service.bindCurrentNarrator(context("bind"), controller.signal)).revision).toBe(
			1,
		);
		expect(f.audit.at(-1)?.outcome).toBe("succeeded");
	});

	test("post-commit audit failure cannot turn delivered send or bound revision into rejection", async () => {
		const f = fixture();
		f.options.auditSink = async (record) => {
			if (record.outcome === "succeeded") throw new Error("post-commit sink failure");
			f.audit.push(record);
		};
		expect((await f.bind()).revision).toBe(1);
		expect(await f.send()).toEqual({ messageId: "message-a" });
		expect(f.deliveries).toHaveLength(1);
		expect(f.audit.every((record) => record.outcome === "allowed")).toBe(true);
	});

	test("host-only commit revalidation works under send mutex without recursive deadlock", async () => {
		const f = fixture();
		await f.bind();
		f.options.sendAdapter = {
			async sendMessage(input) {
				await f.service.revalidateDelivery(input.stewardProvenance, input.context, input.signal);
				f.deliveries.push(input);
				return { messageId: "revalidated" };
			},
		};
		expect(await f.send()).toEqual({ messageId: "revalidated" });
		expect(f.deliveries).toHaveLength(1);
		expect(
			f.audit.some(
				(record) => record.operation === "revalidateDelivery" && record.outcome === "allowed",
			),
		).toBe(true);
	});

	test("durable replay revalidates binding revision and current write ACL instead of trusting old envelope", async () => {
		const f = fixture();
		await f.bind();
		await f.send();
		const provenance = f.deliveries[0]?.stewardProvenance;
		await f.service.revalidateDelivery(provenance, context("send"));
		f.readOnly.add("target-a");
		await rejected(
			f.service.revalidateDelivery(provenance, context("send")),
			"NARRATOR_WRITE_DENIED",
		);
		f.readOnly.clear();
		await f.bind();
		await rejected(f.service.revalidateDelivery(provenance, context("send")), "BINDING_REPLACED");
		expect(f.deliveries).toHaveLength(1);
	});

	test("durable replay rejects altered original identity and runtime capability revocation", async () => {
		const f = fixture();
		await f.bind();
		await f.send();
		const provenance = f.deliveries[0]?.stewardProvenance;
		await rejected(
			f.service.revalidateDelivery({ ...provenance, userId: "victim" }, context("send")),
			"PROVENANCE_IDENTITY_MISMATCH",
		);
		await rejected(
			f.service.revalidateDelivery({ ...provenance, message: "secret" }, context("send")),
			"INVALID_PROVENANCE",
		);
		f.options.authorize = async () => ({ allowed: false });
		await rejected(f.service.revalidateDelivery(provenance, context("send")), "CAPABILITY_DENIED");
		expect(f.deliveries).toHaveLength(1);
	});

	test("uses real PluginStorage persisted user scope, CAS, and restored service instance", async () => {
		const root = await mkdtemp(join(tmpdir(), "steward-storage-"));
		try {
			const f = fixture();
			f.options.storageFactory = new PluginStorageFactory({ root, now: () => NOW });
			const one = await f.bind();
			expect(one.revision).toBe(1);
			const restored = new StewardNarratorService({
				...f.options,
				storageFactory: new PluginStorageFactory({ root, now: () => NOW }),
			});
			expect(await restored.readBinding(context("read"))).toEqual(one);
			expect(await restored.readBinding(context("read", "steward-a", "user-b"))).toBeNull();
			const rebound = await restored.bindCurrentNarrator(context("bind", "steward-b"));
			expect(rebound.revision).toBe(2);
			await rejected(f.send(), "NOT_CURRENT_STEWARD");
			await restored.send(context("send", "steward-b"), {
				targetNarratorId: "target-a",
				message: "persisted",
			});
			expect(f.deliveries[0]?.stewardProvenance.bindingRevision).toBe(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("uses injected capabilityBroker and refuses to operate without an authority", async () => {
		const f = fixture();
		delete f.options.authorize;
		f.options.capabilityBroker = {
			async authorize() {
				return { allowed: false };
			},
		};
		await rejected(f.bind(), "CAPABILITY_DENIED");
		expect(f.storage.writes).toHaveLength(0);
		delete f.options.capabilityBroker;
		expect(() => new StewardNarratorService(f.options)).toThrow(
			"requires capability authorization",
		);
	});

	test("read binding also rejects inconsistent host narrator context", async () => {
		const f = fixture();
		await f.bind();
		const host = context("read");
		host.invocation.narratorId = "steward-b";
		await rejected(f.service.readBinding(host), "NARRATOR_SCOPE_MISMATCH");
	});

	test("binds, reads user scope, and rebinds with monotonically increasing CAS revision", async () => {
		const f = fixture();
		expect(await f.service.readBinding(context("read"))).toBeNull();
		const binding = await f.bind();
		expect(binding).toEqual({
			stewardNarratorId: "steward-a",
			userId: "user-a",
			boundByNarratorId: "steward-a",
			boundAt: NOW.toISOString(),
			revision: 1,
		});
		expect(await f.service.readBinding(context("read"))).toEqual(binding);
		expect((await f.bind("steward-b")).revision).toBe(2);
		expect(f.storage.writes.map((input) => input.expectedRevision)).toEqual([0, 1]);
		expect(
			f.storage.reads.every(
				(input) =>
					input.key === STEWARD_BINDING_KEY &&
					(input.scope as { type: string; id: string }).type === "user" &&
					(input.scope as { id: string }).id === "user-a",
			),
		).toBe(true);
	});

	test("sends direct target ID without listing, preserves host identity envelope, and never audits body", async () => {
		const f = fixture();
		await f.bind();
		expect(await f.send()).toEqual({ messageId: "message-a" });
		const delivery = f.deliveries[0];
		if (!delivery) throw new Error("Expected successful delivery");
		expect(delivery.narratorId).toBe("target-a");
		expect(delivery.message).toBe("secret body");
		expect(delivery.context.scope.narratorId).toBe("steward-a");
		expect(delivery.stewardProvenance).toEqual({
			userId: "user-a",
			pluginId: STEWARD_PLUGIN_ID,
			contributionId: STEWARD_SEND_TOOL_ID,
			requestId: "request-send",
			correlationId: "correlation-a",
			stewardNarratorId: "steward-a",
			targetNarratorId: "target-a",
			bindingRevision: 1,
		});
		expect(Object.isFrozen(delivery.context)).toBe(true);
		expect(Object.isFrozen(delivery.context.scope)).toBe(true);
		expect(Object.isFrozen(delivery.stewardProvenance)).toBe(true);
		expect(
			f.capabilities.filter((input) => input.capability === "command.narrator.send_message"),
		).toHaveLength(2);
		expect(f.audit.filter((record) => record.operation === "send").at(-1)).toMatchObject({
			userId: "user-a",
			pluginId: STEWARD_PLUGIN_ID,
			contributionId: STEWARD_SEND_TOOL_ID,
			requestId: "request-send",
			correlationId: "correlation-a",
			revision: 1,
			length: 11,
			outcome: "succeeded",
		});
		expect(JSON.stringify(f.audit)).not.toContain("secret body");
	});

	test("accepts narratorId alias and command tool source without rewriting caller scope", async () => {
		const f = fixture();
		await f.bind();
		const host = context("send");
		host.invocation.source = "command";
		await f.send({ narratorId: "target-a", message: "hello" }, host);
		expect(f.deliveries[0]?.context.invocation.narratorId).toBe("steward-a");
	});

	for (const source of ["internal", "command", "event", "schedule", "provider"] as const) {
		test(`rejects bind from ${source}, including user/admin agent invocation`, async () => {
			const f = fixture();
			const host = context("bind");
			host.invocation.source = source;
			host.invocation.userRole = "admin";
			await rejected(f.service.bindCurrentNarrator(host), "BIND_REQUIRES_UI");
			expect(f.storage.writes).toHaveLength(0);
			expect(f.audit.at(-1)?.outcome).toBe("denied");
		});
	}
	for (const kind of ["plugin_background", "system"] as const) {
		test(`rejects ${kind} as a user authority even when scope/admin fields are forged`, async () => {
			const f = fixture();
			await f.bind();
			for (const operation of ["bind", "read", "send"] as const) {
				const host = context(operation);
				host.invocation.kind = kind;
				host.invocation.userRole = "admin";
				await rejected(
					operation === "bind"
						? f.service.bindCurrentNarrator(host)
						: operation === "read"
							? f.service.readBinding(host)
							: f.send(undefined, host),
					"INVALID_CONTEXT",
				);
			}
			expect(f.deliveries).toHaveLength(0);
		});
	}

	test("valid background principal without user fields is still denied", async () => {
		const f = fixture();
		const host = context("send");
		host.invocation = { kind: "plugin_background", source: "internal" };
		await rejected(f.send(undefined, host), "USER_REQUIRED");
		expect(f.audit.at(-1)?.errorCode).toBe("USER_REQUIRED");
	});

	for (const extra of [
		{ userId: "victim" },
		{ stewardNarratorId: "steward-b" },
		{ steward: "steward-b" },
		{ pluginId: "trusted" },
		{ stewardProvenance: { userId: "victim" } },
		{ narratorId: "other" },
	]) {
		test(`strict input rejects injected fields ${Object.keys(extra).join(",")}`, async () => {
			const f = fixture();
			await f.bind();
			await rejected(
				f.send({ targetNarratorId: "target-a", message: "secret body", ...extra }),
				"INVALID_INPUT",
			);
			expect(f.deliveries).toHaveLength(0);
			expect(f.audit.at(-1)?.errorCode).toBe("INVALID_INPUT");
			expect(JSON.stringify(f.audit)).not.toContain("secret body");
		});
	}

	for (const message of ["", " \n\t", "a".repeat(STEWARD_MAX_MESSAGE_LENGTH + 1), 123]) {
		test(`rejects invalid message (type ${typeof message}, length ${String(message).length})`, async () => {
			const f = fixture();
			await f.bind();
			await rejected(f.send({ targetNarratorId: "target-a", message }), "INVALID_INPUT");
			expect(f.deliveries).toHaveLength(0);
		});
	}

	test("rejects scope user mismatch, missing narrator authority, and caller scope mismatch", async () => {
		const f = fixture();
		await f.bind();
		const wrongUser = context("send");
		wrongUser.scope.userId = "victim";
		await rejected(f.send(undefined, wrongUser), "USER_SCOPE_MISMATCH");
		const noCaller = context("send");
		delete noCaller.invocation.narratorId;
		await rejected(f.send(undefined, noCaller), "NARRATOR_SCOPE_MISMATCH");
		const wrongCaller = context("send");
		wrongCaller.invocation.narratorId = "steward-b";
		await rejected(f.send(undefined, wrongCaller), "NARRATOR_SCOPE_MISMATCH");
		expect(f.deliveries).toHaveLength(0);
	});

	test("readBinding can only read own user scope and does not imply bind/send privilege", async () => {
		const f = fixture();
		await f.bind();
		expect(await f.service.readBinding(context("read", "steward-b", "user-b"))).toBeNull();
		const invalid = context("read");
		invalid.scope.userId = "user-b";
		await rejected(f.service.readBinding(invalid), "USER_SCOPE_MISMATCH");
		await rejected(f.send(undefined, context("send", "steward-a", "user-b")), "BINDING_NOT_FOUND");
	});

	test("rejects malformed context/plugin/contribution and audits denial without touching storage", async () => {
		const f = fixture();
		const plugin = context("bind");
		plugin.plugin.pluginId = "other-plugin";
		await rejected(f.service.bindCurrentNarrator(plugin), "INVALID_CONTRIBUTION");
		const contribution = context("bind");
		contribution.plugin.contributionId = STEWARD_SEND_TOOL_ID;
		await rejected(f.service.bindCurrentNarrator(contribution), "INVALID_CONTRIBUTION");
		const raw = { ...context("bind"), userId: "victim" } as StewardHostContext;
		await rejected(f.service.bindCurrentNarrator(raw), "INVALID_CONTEXT");
		await rejected(
			f.service.bindCurrentNarrator(null as unknown as StewardHostContext),
			"INVALID_CONTEXT",
		);
		expect(f.storage.reads).toHaveLength(0);
		expect(f.audit).toHaveLength(4);
	});

	for (const mutate of [
		(entry: PluginStorageEntry) => {
			entry.value = { userId: "user-a" };
		},
		(entry: PluginStorageEntry) => {
			(entry.value as Record<string, unknown>).userId = "victim";
		},
		(entry: PluginStorageEntry) => {
			(entry.value as Record<string, unknown>).revision = 999;
		},
		(entry: PluginStorageEntry) => {
			(entry.value as Record<string, unknown>).boundByNarratorId = "other";
		},
		(entry: PluginStorageEntry) => {
			entry.pluginId = "wrong";
		},
		(entry: PluginStorageEntry) => {
			entry.scope = { type: "global" };
		},
	]) {
		test(`rejects corrupt binding ${mutate.toString().slice(0, 70)}`, async () => {
			const f = fixture();
			await f.bind();
			f.storage.corrupt(mutate);
			await rejected(f.send(), "CORRUPT_BINDING");
			await rejected(f.service.readBinding(context("read")), "CORRUPT_BINDING");
			expect(f.deliveries).toHaveLength(0);
		});
	}

	test("read-only target cannot receive even if invocation claims admin; original user is not elevated", async () => {
		const f = fixture();
		await f.bind();
		f.readOnly.add("target-a");
		const host = context("send");
		host.invocation.userRole = "admin";
		await rejected(f.send(undefined, host), "NARRATOR_WRITE_DENIED");
		expect(f.principals.every((principal) => principal.isAdmin === false)).toBe(true);
		expect(f.deliveries).toHaveLength(0);
	});

	test("legitimate host-resolved admin follows ACL but never bypasses binding or capability", async () => {
		const f = fixture();
		f.options.resolveUserPrincipal = async (userId) => ({ userId, isAdmin: true });
		f.rows.set("target-a", row("target-a", "other-user"));
		await rejected(f.send(), "BINDING_NOT_FOUND");
		await f.bind();
		await f.send();
		expect(f.deliveries).toHaveLength(1);
		f.options.authorize = async () => ({ allowed: false });
		await rejected(f.send(), "CAPABILITY_DENIED");
		expect(f.deliveries).toHaveLength(1);
	});

	test("current source ACL/existence and target ACL/existence are checked on every send", async () => {
		const f = fixture();
		await f.bind();
		f.readOnly.add("steward-a");
		await rejected(f.send(), "NARRATOR_WRITE_DENIED");
		f.readOnly.clear();
		f.rows.delete("steward-a");
		await rejected(f.send(), "NARRATOR_NOT_FOUND");
		f.rows.set("steward-a", row("steward-a"));
		f.rows.delete("target-a");
		await rejected(f.send(), "NARRATOR_NOT_FOUND");
		expect(f.deliveries).toHaveLength(0);
	});

	test("binding source must itself exist and be writable; absent target never reaches adapter", async () => {
		const f = fixture();
		f.rows.delete("steward-a");
		await rejected(f.bind(), "NARRATOR_NOT_FOUND");
		f.rows.set("steward-a", row("steward-a"));
		f.readOnly.add("steward-a");
		await rejected(f.bind(), "NARRATOR_WRITE_DENIED");
		expect(f.storage.writes).toHaveLength(0);
	});

	test("rebind immediately invalidates old steward, and revised steward can send", async () => {
		const f = fixture();
		await f.bind();
		await f.bind("steward-b");
		await rejected(f.send(), "NOT_CURRENT_STEWARD");
		await f.send(undefined, context("send", "steward-b"));
		expect(f.deliveries[0]?.stewardProvenance.bindingRevision).toBe(2);
	});

	test("rechecks revoked ACL and capability after durable preflight audit", async () => {
		const f = fixture();
		await f.bind();
		f.options.auditSink = async (record) => {
			f.audit.push(record);
			if (record.operation === "send" && record.outcome === "allowed") f.readOnly.add("target-a");
		};
		await rejected(f.send(), "NARRATOR_WRITE_DENIED");
		expect(f.deliveries).toHaveLength(0);
		f.readOnly.clear();
		let allow = true;
		f.options.authorize = async () => ({ allowed: allow });
		f.options.auditSink = async (record) => {
			f.audit.push(record);
			if (record.operation === "send" && record.outcome === "allowed") allow = false;
		};
		await rejected(f.send(), "CAPABILITY_DENIED");
		expect(f.deliveries).toHaveLength(0);
	});

	test("external binding replacement during validation is detected before delivery", async () => {
		const f = fixture();
		await f.bind();
		f.options.auditSink = async (record) => {
			f.audit.push(record);
			if (record.operation === "send" && record.outcome === "allowed")
				f.storage.corrupt((entry) => {
					entry.revision += 1;
					(entry.value as Record<string, unknown>).revision = entry.revision;
				});
		};
		await rejected(f.send(), "BINDING_REPLACED");
		expect(f.deliveries).toHaveLength(0);
	});

	test("bind final ACL revocation cannot commit following preflight", async () => {
		const f = fixture();
		f.options.auditSink = async (record) => {
			f.audit.push(record);
			if (record.operation === "bind" && record.outcome === "allowed") f.readOnly.add("steward-a");
		};
		await rejected(f.bind(), "NARRATOR_WRITE_DENIED");
		expect(f.storage.writes).toHaveLength(0);
	});

	test("concurrent service instances serialize rebinds and retry bounded CAS conflicts", async () => {
		const f = fixture();
		const second = new StewardNarratorService(f.options);
		f.storage.conflicts = 1;
		const bindings = await Promise.all([
			f.bind(),
			second.bindCurrentNarrator(context("bind", "steward-b")),
		]);
		expect(bindings.map((binding) => binding.revision)).toEqual([1, 2]);
		expect(f.storage.writes.map((input) => input.expectedRevision)).toEqual([0, 0, 1]);
		f.storage.conflicts = 20;
		await rejected(f.bind(), "REVISION_CONFLICT");
	});

	test("bind waits for in-flight send and queued old-source sends use new binding", async () => {
		const f = fixture();
		await f.bind();
		const started = deferred();
		const finish = deferred();
		f.options.sendAdapter = {
			async sendMessage(input) {
				started.resolve();
				await finish.promise;
				f.deliveries.push(input);
				return { messageId: "one" };
			},
		};
		const sending = f.send();
		await started.promise;
		let rebound = false;
		const binding = f.bind("steward-b").then((value) => {
			rebound = true;
			return value;
		});
		const queued = f.send();
		expect(rebound).toBe(false);
		finish.resolve();
		await sending;
		await binding;
		await rejected(queued, "NOT_CURRENT_STEWARD");
		expect(f.deliveries).toHaveLength(1);
	});

	test("pre-aborted and expired calls are audited and do not bind or deliver", async () => {
		const f = fixture();
		await f.bind();
		const cancelled = new AbortController();
		cancelled.abort();
		await rejected(f.send(undefined, context("send"), cancelled.signal), "CANCELLED");
		await rejected(f.service.bindCurrentNarrator(context("bind"), cancelled.signal), "CANCELLED");
		const host = context("send");
		host.deadlineAt = NOW.toISOString();
		await rejected(f.send(undefined, host), "TIMEOUT");
		expect(f.deliveries).toHaveLength(0);
		expect(f.storage.writes).toHaveLength(1);
		expect(f.audit.filter((record) => record.outcome === "cancelled")).toHaveLength(3);
	});

	test("cancellation while awaiting ACL denies before adapter invocation", async () => {
		const f = fixture();
		await f.bind();
		const abort = new AbortController();
		f.options.lookupNarrator = async (id) => {
			abort.abort();
			return f.rows.get(id);
		};
		await rejected(f.send(undefined, context("send"), abort.signal), "CANCELLED");
		expect(f.deliveries).toHaveLength(0);
	});

	test("deadline elapsed in authorization cancels without delivery", async () => {
		const f = fixture();
		await f.bind();
		f.options.authorize = async () => {
			f.setNow(new Date(NOW.getTime() + 120_000));
			return { allowed: true };
		};
		await rejected(f.send(), "TIMEOUT");
		expect(f.deliveries).toHaveLength(0);
	});

	test("linked deadline signal cancels delayed adapter without durable delivery", async () => {
		const f = fixture();
		await f.bind();
		const host = context("send");
		host.deadlineAt = new Date(NOW.getTime() + 15).toISOString();
		f.options.sendAdapter = {
			async sendMessage(input) {
				await new Promise<void>((resolve) =>
					input.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				throw new Error("cancelled before commit");
			},
		};
		await rejected(f.send(undefined, host), "TIMEOUT");
		expect(f.deliveries).toHaveLength(0);
	});

	test("audit unavailable closes mutation and send, and dependency failure audit never leaks text", async () => {
		const f = fixture();
		await f.bind();
		f.options.auditSink = async () => {
			throw new Error("sink unavailable");
		};
		await rejected(f.send(), "AUDIT_UNAVAILABLE");
		await rejected(f.bind("steward-b"), "AUDIT_UNAVAILABLE");
		expect(f.deliveries).toHaveLength(0);
		expect(f.storage.writes).toHaveLength(1);
		f.options.auditSink = async (record) => {
			f.audit.push(record);
		};
		f.options.sendAdapter = {
			async sendMessage() {
				throw Object.assign(new Error("secret body"), { code: "secret body" });
			},
		};
		await rejected(f.send(), "OPERATION_FAILED");
		expect(JSON.stringify(f.audit)).not.toContain("secret body");
		expect(f.audit.at(-1)?.outcome).toBe("failed");
	});

	test("host role resolver cannot substitute another user", async () => {
		const f = fixture();
		f.options.resolveUserPrincipal = async () => ({ userId: "victim", isAdmin: true });
		await rejected(f.bind(), "USER_AUTHORITY_DENIED");
		expect(f.storage.writes).toHaveLength(0);
	});

	test("mutating input host during async validation cannot alter final identity envelope", async () => {
		const f = fixture();
		await f.bind();
		const host = context("send");
		f.options.lookupNarrator = async (id) => {
			host.invocation.userId = "victim";
			host.plugin.pluginId = "attacker";
			host.scope.narratorId = "wrong";
			return f.rows.get(id);
		};
		await f.send(undefined, host);
		expect(f.deliveries[0]?.stewardProvenance.userId).toBe("user-a");
		expect(f.deliveries[0]?.pluginId).toBe(STEWARD_PLUGIN_ID);
		expect(f.deliveries[0]?.context.scope.narratorId).toBe("steward-a");
	});
});
