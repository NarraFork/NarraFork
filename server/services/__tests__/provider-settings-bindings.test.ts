import { afterEach, describe, expect, test } from "bun:test";
import { providerSettingsContributionSchema } from "@shared/provider-settings";
import {
	type ProviderSettingsBindingInput,
	ProviderSettingsBindings,
	type ProviderSettingsLeaseSnapshot,
} from "../provider-settings-bindings";

const services: ProviderSettingsBindings[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});
function fixture() {
	let now = Date.now(),
		live = true,
		calls = 0;
	let reply = async () =>
		new Response('{"balance":12}', { headers: { "content-type": "application/json" } });
	const requests: Array<{ url: string; headers: Headers; signal: AbortSignal | undefined }> = [];
	const service = new ProviderSettingsBindings({
		now: () => now,
		fetch: async (url, init) => {
			calls++;
			requests.push({
				url: String(url),
				headers: new Headers(init?.headers),
				signal: init?.signal ?? undefined,
			});
			return reply();
		},
	});
	services.push(service);
	const declaration = providerSettingsContributionSchema.parse({
		id: "account",
		title: "Account",
		schemaVersion: 1,
		targetKinds: ["custom-api"],
		configSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				label: { type: "string" },
				site: { type: "string", format: "uri" },
				account: { type: "string", "x-narrafork-host-only": true },
				token: { type: "string", writeOnly: true },
			},
		},
		connections: [
			{ id: "usage", destination: "provider", method: "GET", path: "/usage", auth: "provider-key" },
			{
				id: "wallet",
				destination: "extension",
				method: "GET",
				path: "/api/user/self",
				baseUrlField: "site",
				auth: { kind: "bearer", secretField: "token" },
				headers: [{ name: "new-api-user", field: "account" }],
			},
		],
	});
	const principal = {
		pluginId: "com.example.bound",
		installationId: "installation-1",
		runtimeId: "runtime-1",
		runtimeGeneration: 1,
	};
	const snapshot: ProviderSettingsLeaseSnapshot = {
		revision: 1,
		bindingRevision: "b".repeat(64),
		publicValues: { label: "plain", site: "https://site.invalid/team" },
		values: { label: "plain", site: "https://site.invalid/team", account: "alice" },
		secrets: { token: "fixture-site-token" },
		providerRoot: "https://provider.invalid/tenant/v1",
		providerKey: "fixture-inference-key",
	};
	const capabilities: string[] = [];
	const input: ProviderSettingsBindingInput = {
		principal,
		userId: "fixture-admin",
		target: { kind: "custom-api", id: "provider-1" },
		declaration,
		revision: 1,
		bindingRevision: snapshot.bindingRevision,
		deadlineAt: now + 30000,
		signal: new AbortController().signal,
		authorize: async (capability) => {
			capabilities.push(capability);
			return live;
		},
		isCurrent: () => live,
		read: async () => snapshot,
	};
	const lease = service.issue(input);
	return {
		service,
		principal,
		snapshot,
		input,
		lease,
		capabilities,
		requests,
		setLive: (value: boolean) => {
			live = value;
		},
		setNow: (value: number) => {
			now = value;
		},
		setReply: (value: typeof reply) => {
			reply = value;
		},
		get calls() {
			return calls;
		},
	};
}
function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("runtime bound provider settings references", () => {
	test("only the exact runtime principal may read the public value projection", async () => {
		const f = fixture();
		expect(await f.service.get({ reference: f.lease.reference }, f.principal)).toEqual({
			revision: 1,
			values: f.snapshot.publicValues,
		});
		for (const patch of [
			{ pluginId: "other.plugin" },
			{ installationId: "other-installation" },
			{ runtimeId: "other-runtime" },
			{ runtimeGeneration: 2 },
		])
			await expect(
				f.service.get({ reference: f.lease.reference }, { ...f.principal, ...patch }),
			).rejects.toMatchObject({ code: "PROVIDER_SETTINGS_REFERENCE_INVALID" });
		await expect(
			f.service.get({ reference: f.lease.reference, targetId: "provider-2" }, f.principal),
		).rejects.toThrow();
		expect(f.capabilities).toEqual(["provider.settings.read_self"]);
	});
	test("provider and extension destinations preserve tenant roots and use disjoint credentials", async () => {
		const f = fixture();
		await f.service.request({ reference: f.lease.reference, connectionId: "usage" }, f.principal);
		await f.service.request({ reference: f.lease.reference, connectionId: "wallet" }, f.principal);
		expect(f.requests[0].url).toBe("https://provider.invalid/tenant/v1/usage");
		expect(f.requests[0].headers.get("authorization")).toBe("Bearer fixture-inference-key");
		expect(f.requests[0].headers.has("new-api-user")).toBe(false);
		expect(f.requests[1].url).toBe("https://site.invalid/team/api/user/self");
		expect(f.requests[1].headers.get("authorization")).toBe("Bearer fixture-site-token");
		expect(f.requests[1].headers.get("new-api-user")).toBe("alice");
		for (const patch of [
			{ url: "https://evil.invalid" },
			{ path: "/other" },
			{ query: { token: "a" } },
			{ headers: { authorization: "forged" } },
		])
			await expect(
				f.service.request(
					{ reference: f.lease.reference, connectionId: "usage", ...patch },
					f.principal,
				),
			).rejects.toThrow();
		expect(f.calls).toBe(2);
	});
	test("expiry, explicit revocation and changed configuration invalidate all late requests", async () => {
		for (const mode of ["expire", "plugin", "target", "revision", "binding"]) {
			const f = fixture();
			if (mode === "expire") f.setNow(f.input.deadlineAt + 1);
			if (mode === "plugin") f.service.revokePlugin(f.principal.pluginId);
			if (mode === "target") f.service.revokeTarget("custom-api", "provider-1");
			if (mode === "revision") f.snapshot.revision++;
			if (mode === "binding") f.snapshot.bindingRevision = "c".repeat(64);
			await expect(
				f.service.request({ reference: f.lease.reference, connectionId: "wallet" }, f.principal),
			).rejects.toThrow();
			expect(f.calls).toBe(0);
			expect(f.service.activeReferences).toBe(0);
		}
	});
	test("authority checks cannot dispatch after the host generation changes during an await", async () => {
		const f = fixture(),
			entered = gate<void>(),
			decision = gate<boolean>();
		f.lease.release();
		const lease = f.service.issue({
			...f.input,
			authorize: async () => {
				entered.resolve();
				return decision.promise;
			},
		});
		const pending = f.service.request(
			{ reference: lease.reference, connectionId: "wallet" },
			f.principal,
		);
		await entered.promise;
		f.setLive(false);
		decision.resolve(true);
		await expect(pending).rejects.toThrow();
		expect(f.calls).toBe(0);
	});
	test("revoking an in-flight request aborts upstream and rejects a late response", async () => {
		const f = fixture(),
			entered = gate<void>(),
			response = gate<Response>();
		f.setReply(async () => {
			entered.resolve();
			return response.promise;
		});
		const pending = f.service.request(
			{ reference: f.lease.reference, connectionId: "wallet" },
			f.principal,
		);
		await entered.promise;
		f.service.revokePlugin(f.principal.pluginId);
		await expect(pending).rejects.toThrow();
		expect(f.requests[0].signal?.aborted).toBe(true);
		response.resolve(new Response("late"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.service.activeReferences).toBe(0);
	});
	test("redirects, oversized bodies and reflected credentials return fixed failures", async () => {
		for (const response of [
			new Response("", { status: 302, headers: { location: "https://evil.invalid" } }),
			new Response("x".repeat(256 * 1024 + 1)),
			new Response('{"token":"fixture-site-token"}'),
			new Response("{}", {
				headers: { "content-type": "application/json; token=fixture-site-token" },
			}),
			new Response("", { headers: { "content-length": String(256 * 1024 + 1) } }),
		]) {
			const f = fixture();
			f.setReply(async () => response);
			await expect(
				f.service.request({ reference: f.lease.reference, connectionId: "wallet" }, f.principal),
			).rejects.toThrow();
		}
		const f = fixture();
		f.setReply(async () => new Response("fixture-site-token", { status: 401 }));
		expect(
			await f.service.request(
				{ reference: f.lease.reference, connectionId: "wallet" },
				f.principal,
			),
		).toEqual({ status: 401, contentType: null, body: "", bytes: 0 });
	});
	test("missing core connections never use an extension root or secret as a substitute", async () => {
		const f = fixture();
		delete f.snapshot.providerRoot;
		delete f.snapshot.providerKey;
		await expect(
			f.service.request({ reference: f.lease.reference, connectionId: "usage" }, f.principal),
		).rejects.toThrow();
		expect(f.calls).toBe(0);
		expect(
			(
				await f.service.request(
					{ reference: f.lease.reference, connectionId: "wallet" },
					f.principal,
				)
			).status,
		).toBe(200);
	});
});
