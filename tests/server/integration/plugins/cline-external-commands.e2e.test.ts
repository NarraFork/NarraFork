import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import { PluginCommandRegistry } from "@server/services/plugin-command-registry";
import { applyCommandSecretWrites } from "@server/services/plugin-command-secret-writes";
import { PluginHostDispatcher } from "@server/services/plugin-host-dispatcher";
import { providerRegistrationsFromManifest } from "@server/services/plugin-provider-manifest";
import { PluginProviderRegistry } from "@server/services/plugin-provider-registry";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";
import { PluginSecretVault } from "@server/services/plugin-secret-vault";

/**
 * The settings view's action surface, driven through a real plugin subprocess.
 *
 * ## The property this file exists to pin down
 *
 * These commands read their credentials with `secrets.get`, **not** from `input.config`. That
 * is not a style choice: `commands.invoke` forwards only `{contributionId, input, context}`
 * (`plugin-command-registry.ts`) and the iframe's `commands.execute` params are a `.strict()`
 * object with no config field, so a command that expects injected config receives `undefined`
 * `{config, ...input}` by hand.
 *
 * So this harness **deliberately never puts config in the input**. If a command here ever
 * starts depending on it, these tests fail rather than passing while production breaks.
 *
 * The Plugin→Host direction is served by the real `PluginHostDispatcher` over the same stdio
 * transport, so `secrets.get` / `secrets.set` are answered the way the host answers them.
 */

const PLUGIN_ROOT = resolve(import.meta.dir, "../../../../examples/plugins/cline-external");
const CREDENTIALS_KEY = "provider.cline.credentials";
const ENABLED_MODELS_KEY = "provider.cline.enabledModels";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadManifest() {
	return parseManifest(JSON.parse(await readFile(join(PLUGIN_ROOT, "manifest.json"), "utf8")));
}

/**
 * A dispatcher backing `secrets.*` with a real vault.
 *
 * The method definitions mirror `plugin-host-services.ts`: same names, same capabilities, same
 * result shapes. That is what makes the commands' vault reads exercise the production contract
 * rather than a convenience stub.
 */
function createDispatcher(
	manifest: Awaited<ReturnType<typeof loadManifest>>,
	vault: PluginSecretVault,
): PluginHostDispatcher {
	const pluginId = manifest.pluginId;
	return new PluginHostDispatcher({
		identity: {
			pluginId,
			packageVersion: manifest.version,
			installationId: "installation-cline-cmd-e2e",
			runtimeId: "runtime-cline-cmd-e2e",
			runtimeGeneration: 1,
		},
		methods: {
			"secrets.get": {
				method: "secrets.get",
				capability: "secret.use_self",
				handler: async (params) => {
					const key = String((params as { key?: unknown }).key ?? "");
					const value = await vault.getSecret({ pluginId, key });
					// `value: null` for an unset key, exactly as the host reports it.
					return { key, value: value ?? null };
				},
			},
			"secrets.set": {
				method: "secrets.set",
				capability: "secret.use_self",
				sideEffect: "unknown",
				handler: async (params) => {
					const record = params as { key?: unknown; value?: unknown };
					const key = String(record.key ?? "");
					await vault.setSecret({ pluginId, key, value: String(record.value ?? "") });
					return { key, stored: true };
				},
			},
			"secrets.delete": {
				method: "secrets.delete",
				capability: "secret.use_self",
				sideEffect: "unknown",
				handler: async (params) => {
					const key = String((params as { key?: unknown }).key ?? "");
					const deleted = await vault.deleteSecret({ pluginId, key });
					return { key, deleted };
				},
			},
		},
	});
}

function createRuntime(
	manifest: Awaited<ReturnType<typeof loadManifest>>,
	dispatcher: PluginHostDispatcher,
): PluginRuntime {
	if (!manifest.server) throw new Error("plugin must declare a server entry");
	return new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		runtimeId: "runtime-cline-cmd-e2e",
		generation: 1,
		command: [process.execPath, join(PLUGIN_ROOT, manifest.server.entry)],
		cwd: PLUGIN_ROOT,
		rpcProtocol: manifest.server.protocol,
		hostApiVersion: "1.0",
		grantedCapabilities: manifest.permissions.host,
		activationReason: "commands-e2e",
		dispatcher,
		runner: new LocalProcessRunner({
			allowedCwds: [PLUGIN_ROOT],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 4 * 1024 * 1024,
			maxStdoutBytes: 4 * 1024 * 1024,
			stderrRingBytes: 16 * 1024,
			maxStderrBytes: 32 * 1024,
			maxStderrBytesPerSecond: 32 * 1024,
			spawnTimeoutMs: 10_000,
			idleTimeoutMs: 30_000,
			totalTimeoutMs: 60_000,
			killProcessTree: true,
			resourceLimits: { cpuTimeSeconds: 30, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 10_000,
			activationMs: 10_000,
			rpcMs: 30_000,
			drainMs: 200,
			shutdownMs: 1_500,
			cancelGraceMs: 1_000,
		},
		idleTimeoutMs: 30_000,
		totalTimeoutMs: 60_000,
		maxInFlight: 4,
	});
}

function credentialBlob(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		accessToken: "at-1",
		refreshToken: "rt-1",
		// Far future, so no command triggers a refresh and none needs the network.
		expiresAt: 4_000_000_000,
		email: "user@example.com",
		displayName: "Test User",
		startedAt: 1_700_000_000_000,
		...overrides,
	});
}

interface Harness {
	/** Invoke a command. Config is deliberately never included — see the file header. */
	invoke: (
		contributionId: string,
		input?: Record<string, unknown>,
	) => Promise<{ output: Record<string, unknown>; applied: string[] }>;
	invokeRaw: (
		contributionId: string,
		input?: Record<string, unknown>,
	) => Promise<{ output: unknown; secretWrites: Array<{ key: string; value: string | null }> }>;
	vault: PluginSecretVault;
	pluginId: string;
}

async function withPlugin<T>(
	seed: Record<string, string>,
	run: (harness: Harness) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "nf-cline-cmd-e2e-"));
	roots.push(root);
	const manifest = await loadManifest();
	const vault = new PluginSecretVault({ root });
	// The real Plugin→Host dispatcher, so `secrets.get`/`secrets.set` behave as in production.
	const runtime = createRuntime(manifest, createDispatcher(manifest, vault));
	const providerRegistry = new PluginProviderRegistry();
	for (const registration of providerRegistrationsFromManifest({
		manifest,
		generation: `${manifest.version}:cmd-e2e`,
	})) {
		providerRegistry.register(registration);
	}
	for (const [key, value] of Object.entries(seed)) {
		await vault.setSecret({ pluginId: manifest.pluginId, key, value });
	}

	const commandRegistry = new PluginCommandRegistry({ resolveRuntime: () => runtime });
	commandRegistry.registerManifest(manifest);

	try {
		await runtime.start();
		let seq = 0;
		const invokeRaw: Harness["invokeRaw"] = async (contributionId, input) => {
			seq += 1;
			const result = await commandRegistry.invoke(
				contributionId,
				manifest.pluginId,
				// No `config` key. This is the whole point of the harness.
				(input ?? {}) as never,
				{ requestId: `req-${seq}` },
			);
			return { output: result.output, secretWrites: result.secretWrites };
		};
		const invoke: Harness["invoke"] = async (contributionId, input) => {
			const { output, secretWrites } = await invokeRaw(contributionId, input);
			// Applied through the real validator, so a namespace escape fails here rather than in
			// production.
			const applied =
				secretWrites.length > 0
					? (
							await applyCommandSecretWrites({
								pluginId: manifest.pluginId,
								writes: secretWrites,
								registry: providerRegistry,
								sink: vault,
							})
						).written
					: [];
			return { output: (output ?? {}) as Record<string, unknown>, applied };
		};
		return await run({ invoke, invokeRaw, vault, pluginId: manifest.pluginId });
	} finally {
		await runtime.shutdown().catch(() => undefined);
	}
}

describe("cline-external commands: credentials come from the vault", () => {
	test("status reports a signed-in account with no config in the input", async () => {
		// The assertion that separates this plugin from the reference one: the credential was only
		// ever in the vault, and the command found it.
		await withPlugin({ [CREDENTIALS_KEY]: credentialBlob() }, async ({ invoke }) => {
			const { output } = await invoke("status");
			expect(output.authenticated).toBe(true);
			expect(output.email).toBe("user@example.com");
			expect(output.displayName).toBe("Test User");
			expect(output.expired).toBe(false);
		});
	}, 60_000);

	test("status reports not-signed-in when the vault is empty", async () => {
		await withPlugin({}, async ({ invoke }) => {
			const { output } = await invoke("status");
			expect(output.authenticated).toBe(false);
			expect(output.enabledModelCount).toBe(0);
		});
	}, 60_000);

	test("status never returns credential material", async () => {
		// Command output reaches an iframe, so a token must not appear in it.
		await withPlugin({ [CREDENTIALS_KEY]: credentialBlob() }, async ({ invoke }) => {
			const { output } = await invoke("status");
			const serialized = JSON.stringify(output);
			expect(serialized).not.toContain("at-1");
			expect(serialized).not.toContain("rt-1");
			expect(serialized).not.toContain("accessToken");
			expect(serialized).not.toContain("refreshToken");
		});
	}, 60_000);

	test("an unreadable credential is reported, not thrown", async () => {
		// The settings view must still render: signing out is how the user recovers from exactly
		// this state, and a thrown command would leave them with no button to press.
		await withPlugin({ [CREDENTIALS_KEY]: "{not json" }, async ({ invoke }) => {
			const { output } = await invoke("status");
			expect(output.authenticated).toBe(false);
			expect(String(output.credentialError)).toContain("valid JSON");
		});
	}, 60_000);

	test("an expired token is flagged without triggering a refresh", async () => {
		// `status` is polled by the open settings page. If it refreshed, leaving the page open
		// would generate recurring upstream traffic.
		await withPlugin(
			{ [CREDENTIALS_KEY]: credentialBlob({ expiresAt: 1 }) },
			async ({ invoke, vault, pluginId }) => {
				const { output } = await invoke("status");
				expect(output.authenticated).toBe(true);
				expect(output.expired).toBe(true);
				// Unchanged: no refresh was attempted, so nothing was written back.
				expect(await vault.getSecret({ pluginId, key: CREDENTIALS_KEY })).toBe(
					credentialBlob({ expiresAt: 1 }),
				);
			},
		);
	}, 60_000);

	test("status reads the enabled-model list from the vault too", async () => {
		await withPlugin(
			{
				[CREDENTIALS_KEY]: credentialBlob(),
				[ENABLED_MODELS_KEY]: JSON.stringify(["a/one", "b/two"]),
			},
			async ({ invoke }) => {
				const { output } = await invoke("status");
				expect(output.enabledModelCount).toBe(2);
				expect(output.enabledModels).toEqual(["a/one", "b/two"]);
			},
		);
	}, 60_000);
});

describe("cline-external commands: browserAuth is a three-state field", () => {
	test("status reports one of the three documented values", async () => {
		// The settings view switches on this exact field name and these exact values. A rename on
		// either side is invisible to the compiler across the iframe boundary.
		await withPlugin({}, async ({ invoke }) => {
			const { output } = await invoke("status");
			// Compared as a string rather than via `toContain` on a string[]: `output` is
			// `Record<string, unknown>`, and `toContain` would not accept an `unknown` needle.
			expect(["available", "port_busy", "unsupported"]).toContain(String(output.browserAuth));
			// The superseded spelling must not reappear.
			expect("browserAuthAvailable" in output).toBe(false);
		});
	}, 60_000);

	test("the probe does not leave the callback port bound", async () => {
		// It binds and immediately releases. If it held the port, the built-in adapter could not
		// sign in while a settings page was open, and the second probe below would report busy.
		await withPlugin({}, async ({ invoke }) => {
			const first = await invoke("status");
			const second = await invoke("status");
			expect(second.output.browserAuth).toBe(first.output.browserAuth);
		});
	}, 60_000);
});

describe("cline-external commands: sign-in and sign-out", () => {
	test("a pasted callback URL is imported and stored under the provider namespace", async () => {
		const payload = Buffer.from(
			JSON.stringify({
				accessToken: "at-new",
				refreshToken: "rt-new",
				email: "new@example.com",
				name: "New User",
				expiresAt: "2030-01-01T00:00:00Z",
			}),
		).toString("base64");
		const callbackUrl = `http://localhost:19876/auth/callback?code=${encodeURIComponent(payload)}`;

		await withPlugin({}, async ({ invoke, vault, pluginId }) => {
			const { output, applied } = await invoke("auth.callback", { callbackUrl });
			expect(output.ok).toBe(true);
			expect(output.email).toBe("new@example.com");
			expect(applied).toEqual([CREDENTIALS_KEY]);

			const stored = await vault.getSecret({ pluginId, key: CREDENTIALS_KEY });
			expect(JSON.parse(String(stored)).accessToken).toBe("at-new");

			// And the account is now visible to a later command.
			const status = await invoke("status");
			expect(status.output.authenticated).toBe(true);
		});
	}, 60_000);

	test("a malformed callback URL is an INVALID_PARAMS error naming the cause", async () => {
		await withPlugin({}, async ({ invoke }) => {
			await expect(invoke("auth.callback", { callbackUrl: "nonsense" })).rejects.toThrow(
				"does not look like a URL",
			);
		});
	}, 60_000);

	test("auth.callback requires its argument", async () => {
		await withPlugin({}, async ({ invoke }) => {
			await expect(invoke("auth.callback", {})).rejects.toThrow("callbackUrl is required");
		});
	}, 60_000);

	test("signing out clears the credential but keeps the model selection", async () => {
		await withPlugin(
			{
				[CREDENTIALS_KEY]: credentialBlob(),
				[ENABLED_MODELS_KEY]: '["a/one"]',
			},
			async ({ invoke, vault, pluginId }) => {
				const { output } = await invoke("auth.logout");
				expect(output.ok).toBe(true);
				expect(await vault.getSecret({ pluginId, key: CREDENTIALS_KEY })).toBeUndefined();
				// A preference, not part of the session.
				expect(await vault.getSecret({ pluginId, key: ENABLED_MODELS_KEY })).toBe('["a/one"]');

				const status = await invoke("status");
				expect(status.output.authenticated).toBe(false);
				expect(status.output.enabledModelCount).toBe(1);
			},
		);
	}, 60_000);

	test("cancelling with no pending sign-in is a no-op rather than an error", async () => {
		await withPlugin({}, async ({ invoke }) => {
			const { output } = await invoke("auth.cancel");
			expect(output.cancelled).toBe(false);
		});
	}, 60_000);
});

describe("cline-external commands: model selection", () => {
	test("a selection is validated, stored, and read back by status", async () => {
		await withPlugin({}, async ({ invoke, vault, pluginId }) => {
			const { output, applied } = await invoke("config.setEnabledModels", {
				models: ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"],
			});
			expect(output.count).toBe(2);
			expect(output.truncated).toBe(false);
			expect(applied).toEqual([ENABLED_MODELS_KEY]);
			expect(await vault.getSecret({ pluginId, key: ENABLED_MODELS_KEY })).toBe(
				'["anthropic/claude-sonnet-4.6","deepseek/deepseek-chat"]',
			);

			const status = await invoke("status");
			expect(status.output.enabledModelCount).toBe(2);
		});
	}, 60_000);

	test("duplicates and blanks are removed before storing", async () => {
		await withPlugin({}, async ({ invoke }) => {
			const { output } = await invoke("config.setEnabledModels", {
				models: ["a/one", "a/one", "   ", "b/two"],
			});
			expect(output.count).toBe(2);
		});
	}, 60_000);

	test("an oversized selection reports how many will actually be served", async () => {
		// The catalog is capped at the declared page size, so a longer selection saves fine but
		// only the first 50 reach the picker. Surfacing it lets the view explain the difference.
		await withPlugin({}, async ({ invoke }) => {
			const models = Array.from({ length: 60 }, (_, index) => `vendor/model-${index}`);
			const { output } = await invoke("config.setEnabledModels", { models });
			expect(output.count).toBe(60);
			expect(output.servedToAgent).toBe(50);
			expect(output.truncated).toBe(true);
		});
	}, 60_000);

	test("a non-array or non-string payload is rejected", async () => {
		await withPlugin({}, async ({ invoke }) => {
			await expect(invoke("config.setEnabledModels", { models: "a/one" })).rejects.toThrow(
				"must be an array",
			);
			await expect(invoke("config.setEnabledModels", { models: [1, 2] })).rejects.toThrow(
				"only strings",
			);
		});
	}, 60_000);

	test("clearing the selection stores an empty list rather than failing", async () => {
		await withPlugin({ [ENABLED_MODELS_KEY]: '["a/one"]' }, async ({ invoke, vault, pluginId }) => {
			const { output } = await invoke("config.setEnabledModels", { models: [] });
			expect(output.count).toBe(0);
			expect(await vault.getSecret({ pluginId, key: ENABLED_MODELS_KEY })).toBe("[]");
		});
	}, 60_000);

	test("too many models is refused with a clear reason", async () => {
		await withPlugin({}, async ({ invoke }) => {
			const models = Array.from({ length: 201 }, (_, index) => `vendor/m-${index}`);
			await expect(invoke("config.setEnabledModels", { models })).rejects.toThrow(
				"Too many models",
			);
		});
	}, 60_000);
});

describe("cline-external commands: unknown commands", () => {
	test("an unregistered command id is a not-found error", async () => {
		await withPlugin({}, async ({ invoke }) => {
			await expect(invoke("does.not.exist")).rejects.toThrow();
		});
	}, 60_000);
});
