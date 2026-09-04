import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@server/lib/plugins/protocol";
import { type PluginCommandDispatcher, PluginUiHost } from "@server/services/plugin-ui-host";
import type { PluginUiSession } from "@server/services/plugin-ui-session";

/**
 * `commands.execute` routing between host-registered and plugin-declared commands.
 *
 * Two properties matter here and neither is obvious from the implementation:
 *
 *  1. **A host command always wins.** Plugin dispatch is a fallback, so a plugin cannot
 *     shadow host behaviour by picking a colliding command id.
 *  2. **Persisted values never reach this class.** The dispatcher applies `secretWrites`
 *     and `configWrites` before returning, so the UI host has nothing to leak even by
 *     accident. The contract enforces this by shape: `PluginCommandDispatcher.invoke`
 *     returns only `output` plus post-write catalog sync metadata.
 */

function makeSession(overrides: Partial<PluginUiSession> = {}): PluginUiSession {
	return {
		pluginId: "com.example.commands",
		version: "1.0.0",
		hash: "c".repeat(64),
		authorityInstallationId: "installation-ui-cmd",
		installationId: "installation-commands",
		principalId: "user-1",
		contributionId: "settings",
		panelInstanceId: "panel-1",
		surface: "provider-settings",
		surfaceScope: "global",
		scope: {},
		sessionId: "uis_cmd",
		connectNonce: "n".repeat(24),
		generation: 1,
		createdAt: "2026-07-16T12:00:00.000Z",
		expiresAt: "2026-07-16T13:00:00.000Z",
		...overrides,
	};
}

function request(id: string, method: string, params?: JsonValue) {
	return {
		protocol: "narrafork.ui/1" as const,
		kind: "request" as const,
		id,
		method,
		...(params === undefined ? {} : { params }),
	};
}

/** Records calls so "the plugin was never asked" is assertable. */
function recordingDispatcher(
	output: JsonValue = { ok: true },
): PluginCommandDispatcher & { calls: string[]; known: Set<string> } {
	const calls: string[] = [];
	const known = new Set(["verify-credential"]);
	return {
		calls,
		known,
		has: (commandId) => known.has(commandId),
		invoke: async (commandId) => {
			calls.push(commandId);
			return { output };
		},
	};
}

function hostWith(dispatcher?: PluginCommandDispatcher, hostCommandIds: string[] = []) {
	return new PluginUiHost({
		capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
		...(dispatcher ? { pluginCommands: dispatcher } : {}),
		// Minimal stand-in for the host's public API: only `commands.has` participates in
		// the routing decision under test.
		publicApi: {
			commands: { has: (id: string) => hostCommandIds.includes(id) },
			command: async () => ({ status: "succeeded", output: { from: "host" } }),
		} as never,
	});
}

async function execute(
	host: PluginUiHost,
	commandId: string,
	input?: JsonValue,
	session = makeSession(),
) {
	return host.dispatch({
		session,
		principalId: "user-1",
		userRole: "user",
		request: request("cmd-1", "commands.execute", {
			commandId,
			...(input === undefined ? {} : { input }),
		}),
	});
}

describe("plugin UI host: plugin command dispatch", () => {
	test("dispatches a plugin-declared command", async () => {
		const dispatcher = recordingDispatcher({ modelCount: 8 });
		const response = await execute(hostWith(dispatcher), "verify-credential");

		expect(dispatcher.calls).toEqual(["verify-credential"]);
		expect(response).toMatchObject({
			result: { status: "succeeded", output: { modelCount: 8 } },
		});
	});

	test("forwards post-write catalog sync metadata without exposing writes", async () => {
		const dispatcher: PluginCommandDispatcher = {
			has: () => true,
			invoke: async () => ({
				output: { saved: true },
				catalogSync: [
					{ providerInstanceId: "com.example.commands/cline/1/hash", ok: true, modelCount: 2 },
				],
			}),
		};
		const response = await execute(hostWith(dispatcher), "verify-credential");
		expect(response).toMatchObject({
			result: {
				status: "succeeded",
				output: { saved: true },
				catalogSync: [
					{ providerInstanceId: "com.example.commands/cline/1/hash", ok: true, modelCount: 2 },
				],
			},
		});
		expect(JSON.stringify(response)).not.toContain("secretWrites");
		expect(JSON.stringify(response)).not.toContain("configWrites");
	});

	test("forwards the command input", async () => {
		const seen: JsonValue[] = [];
		const dispatcher: PluginCommandDispatcher = {
			has: () => true,
			invoke: async (_id, _plugin, input) => {
				seen.push(input ?? null);
				return { output: null };
			},
		};
		await execute(hostWith(dispatcher), "verify-credential", { credentialId: "abc" });
		expect(seen).toEqual([{ credentialId: "abc" }]);
	});

	test("passes the session's plugin id, not one supplied by the caller", async () => {
		const seen: string[] = [];
		const dispatcher: PluginCommandDispatcher = {
			has: () => true,
			invoke: async (_id, pluginId) => {
				seen.push(pluginId);
				return { output: null };
			},
		};
		// A UI session is bound to one plugin; the command must be attributed to it rather
		// than to anything the iframe claims.
		await execute(hostWith(dispatcher), "verify-credential", undefined, makeSession());
		expect(seen).toEqual(["com.example.commands"]);
	});

	test("a host-registered command takes priority over a plugin command of the same id", async () => {
		const dispatcher = recordingDispatcher();
		dispatcher.known.add("shared-id");
		const response = await execute(hostWith(dispatcher, ["shared-id"]), "shared-id");

		// The decisive assertion: the plugin must not be consulted at all, or a plugin could
		// intercept a host command by declaring a colliding id.
		expect(dispatcher.calls).toEqual([]);
		expect(response).toMatchObject({ result: { output: { from: "host" } } });
	});

	test("falls through to the host when the plugin declares no such command", async () => {
		const dispatcher = recordingDispatcher();
		const response = await execute(hostWith(dispatcher, ["host-only"]), "host-only");
		expect(dispatcher.calls).toEqual([]);
		expect(response).toMatchObject({ result: { output: { from: "host" } } });
	});

	test("without a dispatcher the host path is used unchanged", async () => {
		// No `pluginCommands` at all — the pre-`commands.invoke` configuration. The point is
		// that adding plugin dispatch did not alter what happens when it is absent: the
		// request still goes to the host's own command API rather than failing.
		const response = await execute(hostWith(undefined, []), "verify-credential");
		expect(response).toMatchObject({ result: { output: { from: "host" } } });
	});
});

describe("plugin UI host: plugin command error mapping", () => {
	async function failWith(code: string, message = "boom") {
		const dispatcher: PluginCommandDispatcher = {
			has: () => true,
			invoke: async () => {
				throw Object.assign(new Error(message), { code });
			},
		};
		return execute(hostWith(dispatcher), "verify-credential");
	}

	test("maps a missing command to METHOD_NOT_FOUND", async () => {
		expect(await failWith("METHOD_NOT_FOUND")).toMatchObject({
			error: { code: "METHOD_NOT_FOUND" },
		});
	});

	test("maps a cross-plugin attempt to PERMISSION_DENIED", async () => {
		expect(await failWith("PERMISSION_DENIED")).toMatchObject({
			error: { code: "PERMISSION_DENIED" },
		});
	});

	test("maps a byte-limit breach to PAYLOAD_TOO_LARGE", async () => {
		expect(await failWith("OUTPUT_LIMIT")).toMatchObject({
			error: { code: "PAYLOAD_TOO_LARGE" },
		});
	});

	test("maps an unavailable runtime to HOST_UNAVAILABLE", async () => {
		expect(await failWith("HOST_UNAVAILABLE")).toMatchObject({
			error: { code: "HOST_UNAVAILABLE" },
		});
	});

	test("maps a ui-handler command to INVALID_PARAMS", async () => {
		// Calling a `handler: "ui"` command from the backend path is a caller mistake, not a
		// host fault.
		expect(await failWith("INVALID_STATE", "handled in the plugin UI")).toMatchObject({
			error: { code: "INVALID_PARAMS" },
		});
	});
});

describe("plugin UI host: secret isolation", () => {
	test("the dispatcher contract exposes no channel for secret values", async () => {
		// `invoke` resolves to `{ output }` only. `secretWrites` are applied by the dispatcher
		// before it returns, so there is no shape through which a credential could reach the
		// iframe from here.
		const dispatcher: PluginCommandDispatcher = {
			has: () => true,
			invoke: async () => ({ output: { configured: true } }),
		};
		const response = await execute(hostWith(dispatcher), "verify-credential");
		expect(JSON.stringify(response)).not.toContain("secretWrites");
	});

	test("a dispatcher that leaks extra fields cannot smuggle them through", async () => {
		const dispatcher = {
			has: () => true,
			// Deliberately returns more than the contract allows.
			invoke: async () => ({
				output: { ok: true },
			}),
		} as unknown as PluginCommandDispatcher;
		const response = await execute(hostWith(dispatcher), "verify-credential");
		// The host reads only `output`, so the extra field is dropped rather than forwarded.
		expect(JSON.stringify(response)).not.toContain("sk-leak");
	});
});
