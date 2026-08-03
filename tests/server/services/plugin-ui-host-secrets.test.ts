import { describe, expect, test } from "bun:test";
import { PluginUiHost } from "@server/services/plugin-ui-host";
import type { PluginUiSession } from "@server/services/plugin-ui-session";

/**
 * `secrets.get|set|delete|list` from a UI surface.
 *
 * A view gets its own plugin's secrets rather than being blanket-denied
 * (`docs/plugin-system/11-capability-policy.md`). Withholding values from the UI never
 * contained anything — the plugin's own backend command could return them — but it did stop
 * a settings view from showing which credential was already configured.
 *
 * Two boundaries are pinned here. The plugin id comes from the session, never from request
 * params, so no message a view can send names another plugin's secret — the mechanism VS Code
 * relies on, where `mainThreadSecretState` derives the key as
 * `JSON.stringify({ extensionId, key })` with a host-injected id. And `secrets.get`, the one
 * method that returns plaintext, additionally requires an admin session, because a UI session
 * is created for any authenticated user while the host's own credential paths are admin-only
 * and never echo a value.
 */

const pluginId = "com.example.settings-view";
const otherPluginId = "com.example.victim";

function makeSession(overrides: Partial<PluginUiSession> = {}): PluginUiSession {
	return {
		pluginId,
		version: "1.0.0",
		hash: "s".repeat(64),
		principalId: "user-1",
		contributionId: "settings",
		panelInstanceId: "panel-1",
		surface: "provider-settings",
		surfaceScope: "global",
		scope: {},
		sessionId: "uis_secret",
		connectNonce: "n".repeat(24),
		generation: 1,
		createdAt: "2026-07-16T12:00:00.000Z",
		expiresAt: "2026-07-16T13:00:00.000Z",
		...overrides,
	} as PluginUiSession;
}

interface HostOptions {
	allowed?: boolean;
	store?: Map<string, string>;
	seenPluginIds?: string[];
	omitSuppliers?: boolean;
}

function hostWith(options: HostOptions = {}) {
	const { allowed = true, store = new Map<string, string>(), seenPluginIds = [] } = options;
	const record = (id: string) => {
		seenPluginIds.push(id);
	};
	return new PluginUiHost({
		capabilityBroker: {
			authorize: async () =>
				(allowed
					? { allowed: true }
					: { allowed: false, error: { code: "PERMISSION_DENIED" } }) as never,
		},
		...(options.omitSuppliers
			? {}
			: {
					secretKeyLister: (id) => {
						record(id);
						return [...store.keys()];
					},
					secretReader: (id, key) => {
						record(id);
						return store.get(key);
					},
					secretWriter: (id, key, value) => {
						record(id);
						store.set(key, value);
					},
					secretDeleter: (id, key) => {
						record(id);
						return store.delete(key);
					},
				}),
	});
}

function call(
	host: PluginUiHost,
	method: string,
	params?: unknown,
	session = makeSession(),
	userRole: "admin" | "user" = "admin",
) {
	return host.dispatch({
		session,
		principalId: "user-1",
		userRole,
		request: {
			protocol: "narrafork.ui/1" as const,
			kind: "request" as const,
			id: `req-${method}`,
			method,
			...(params === undefined ? {} : { params: params as never }),
		},
	});
}

describe("plugin UI host: own-plugin secrets", () => {
	test("reads a configured secret by value", async () => {
		const store = new Map([["provider.demo.apiKey", "sk-configured"]]);

		// The point of opening this up: a settings view can render what is already set
		// instead of forcing the user to retype a credential it cannot see.
		expect(
			await call(hostWith({ store }), "secrets.get", { key: "provider.demo.apiKey" }),
		).toMatchObject({ result: { key: "provider.demo.apiKey", value: "sk-configured" } });
	});

	test("writes and deletes a secret", async () => {
		const store = new Map<string, string>();
		const host = hostWith({ store });

		expect(
			await call(host, "secrets.set", { key: "provider.demo.token", value: "tok-1" }),
		).toMatchObject({ result: { key: "provider.demo.token", stored: true } });
		expect(store.get("provider.demo.token")).toBe("tok-1");

		expect(await call(host, "secrets.delete", { key: "provider.demo.token" })).toMatchObject({
			result: { key: "provider.demo.token", deleted: true },
		});
		expect(store.has("provider.demo.token")).toBe(false);
	});

	test("reports an unset secret as null rather than failing", async () => {
		expect(await call(hostWith(), "secrets.get", { key: "provider.demo.absent" })).toMatchObject({
			result: { key: "provider.demo.absent", value: null },
		});
	});

	test("always uses the session's plugin id, never one from request params", async () => {
		const seenPluginIds: string[] = [];
		const store = new Map([["provider.demo.apiKey", "sk-owner"]]);
		const host = hostWith({ store, seenPluginIds });

		// Strict params refuse the extra field, so this never reaches the vault at all.
		const spoofed = (await call(host, "secrets.get", {
			key: "provider.demo.apiKey",
			pluginId: otherPluginId,
		})) as { error?: unknown };
		expect(spoofed.error).toBeDefined();

		// And a well-formed call resolves to the session owner.
		await call(host, "secrets.get", { key: "provider.demo.apiKey" });
		expect(seenPluginIds).toEqual([pluginId]);
		expect(seenPluginIds).not.toContain(otherPluginId);
	});

	test("scopes storage to the session that made the call", async () => {
		const seenPluginIds: string[] = [];
		const store = new Map<string, string>();
		const host = hostWith({ store, seenPluginIds });

		// Two sessions of different plugins write the same key name; each write is attributed
		// to its own session's plugin, so the namespaces cannot collide.
		await call(host, "secrets.set", { key: "shared.key", value: "from-owner" });
		await call(
			host,
			"secrets.set",
			{ key: "shared.key", value: "from-other" },
			makeSession({ pluginId: otherPluginId, sessionId: "uis_other" }),
		);

		expect(seenPluginIds).toEqual([pluginId, otherPluginId]);
	});

	test("rejects a malformed key and an oversized value", async () => {
		const store = new Map<string, string>();
		const host = hostWith({ store });

		for (const params of [{ key: "" }, { key: "x".repeat(257) }]) {
			expect((await call(host, "secrets.get", params)) as { error?: unknown }).toHaveProperty(
				"error",
			);
		}

		// The 64KB ceiling is retained deliberately: the vault is a synchronous JSON
		// read/modify/write on the main thread, so an unbounded value would stall the
		// event loop for every other request. See CLAUDE.md on main-thread blocking.
		const oversized = (await call(host, "secrets.set", {
			key: "provider.demo.blob",
			value: "x".repeat(64 * 1024 + 1),
		})) as { error?: unknown };
		expect(oversized.error).toBeDefined();
		expect(store.size).toBe(0);
	});

	test("denies every secret method when the broker denies", async () => {
		const store = new Map([["provider.demo.apiKey", "sk-unreachable"]]);
		const host = hostWith({ allowed: false, store });

		for (const [method, params] of [
			["secrets.get", { key: "provider.demo.apiKey" }],
			["secrets.set", { key: "provider.demo.apiKey", value: "sk-new" }],
			["secrets.delete", { key: "provider.demo.apiKey" }],
			["secrets.list", {}],
		] as const) {
			const response = (await call(host, method, params)) as {
				error?: unknown;
				result?: unknown;
			};
			expect(response.result).toBeUndefined();
			expect(response.error).toBeDefined();
		}

		// A denied write must not have taken effect.
		expect(store.get("provider.demo.apiKey")).toBe("sk-unreachable");
	});

	/**
	 * A UI session is not an admin session: `routes/plugin-ui.ts` creates one behind
	 * `requireSessionAuth`, which admits ordinary users. `secret.use_self` says the plugin
	 * may touch its own vault, not which user may read it back, so before this check a
	 * non-admin could pull credential plaintext out of an iframe that the host's own
	 * (admin-only) provider-config path replaces with a placeholder.
	 */
	test("refuses to disclose a secret value to a non-admin session", async () => {
		const seenPluginIds: string[] = [];
		const store = new Map([["provider.demo.apiKey", "sk-admin-only"]]);
		const host = hostWith({ store, seenPluginIds });

		const denied = (await call(
			host,
			"secrets.get",
			{ key: "provider.demo.apiKey" },
			makeSession(),
			"user",
		)) as { result?: unknown; error?: { code?: string } };
		expect(denied.result).toBeUndefined();
		expect(denied.error?.code).toBe("PERMISSION_DENIED");
		// The value must not even be fetched, so it cannot leak through a log or a timing path.
		expect(seenPluginIds).toEqual([]);

		// The same call from an admin session still works: this is a caller-role gate, not a
		// withdrawal of the capability.
		expect(
			await call(host, "secrets.get", { key: "provider.demo.apiKey" }, makeSession(), "admin"),
		).toMatchObject({ result: { key: "provider.demo.apiKey", value: "sk-admin-only" } });
	});

	test("still lets a non-admin session list, write and delete its own secrets", async () => {
		const store = new Map([["provider.demo.apiKey", "sk-existing"]]);
		const host = hostWith({ store });
		const asUser = (method: string, params: unknown) =>
			call(host, method, params, makeSession(), "user");

		// Names and a configured flag carry no plaintext, so a non-admin settings view can
		// still show what is set.
		expect(await asUser("secrets.list", {})).toMatchObject({
			result: { secrets: [{ key: "provider.demo.apiKey", configured: true }] },
		});

		// Writes and deletes never echo a value back, so they keep the pre-existing access.
		expect(
			await asUser("secrets.set", { key: "provider.demo.token", value: "tok-user" }),
		).toMatchObject({ result: { key: "provider.demo.token", stored: true } });
		expect(store.get("provider.demo.token")).toBe("tok-user");
		expect(await asUser("secrets.delete", { key: "provider.demo.token" })).toMatchObject({
			result: { key: "provider.demo.token", deleted: true },
		});
		expect(store.has("provider.demo.token")).toBe(false);
	});

	test("degrades to empty answers when the host wires no secret suppliers", async () => {
		const host = hostWith({ omitSuppliers: true });

		expect(await call(host, "secrets.get", { key: "provider.demo.apiKey" })).toMatchObject({
			result: { value: null },
		});
		expect(await call(host, "secrets.delete", { key: "provider.demo.apiKey" })).toMatchObject({
			result: { deleted: false },
		});
		// A write cannot be silently dropped: reporting success with nowhere to store the
		// value would make a settings view believe a credential was saved.
		expect(
			(await call(host, "secrets.set", { key: "provider.demo.apiKey", value: "sk-1" })) as {
				error?: unknown;
			},
		).toHaveProperty("error");
	});
});
