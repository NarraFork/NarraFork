import { describe, expect, test } from "bun:test";
import { ValidationError } from "@server/lib/errors";
import { MAX_COMMAND_SECRET_VALUE_BYTES } from "@server/lib/plugins/protocol";
import {
	applyCommandSecretWrites,
	type CommandSecretSink,
} from "@server/services/plugin-command-secret-writes";
import {
	PluginProviderRegistry,
	type ProviderRegistryRegistration,
} from "@server/services/plugin-provider-registry";

/**
 * `secretWrites` after the open-capability change (`11-capability-policy.md`).
 *
 * Two limits remain and are covered here:
 *
 *  1. **Cross-plugin and cross-contribution isolation.** Structural, derived from the
 *     registry rather than the request, and reported with one indistinguishable message so a
 *     plugin cannot probe which contribution ids exist elsewhere.
 *  2. **Per-value 64KB.** A main-thread protection, not a trust rule: the vault is a
 *     synchronous JSON read/modify/write.
 *
 * Deliberately no longer tested, because no longer enforced: the `configSchema` field
 * whitelist, the entry-count ceiling, the batch-total ceiling, duplicate-key rejection, and
 * batch atomicity. Those assumed an installed plugin was untrusted. The tests below pin the
 * *new* behaviour in their place — including that a batch is now applied incrementally,
 * which is the real cost of dropping atomicity.
 */

const PLUGIN_ID = "com.example.writer";
const OTHER_PLUGIN_ID = "com.example.other";

function registration(
	overrides: Partial<ProviderRegistryRegistration> = {},
): ProviderRegistryRegistration {
	return {
		kind: "executable-plugin",
		pluginId: PLUGIN_ID,
		localId: "alpha",
		providerInstanceId: "inst-alpha",
		providerPrefix: "alpha",
		displayName: "Alpha",
		configSchema: {
			type: "object",
			properties: {
				apiMode: { type: "string" },
				apiKey: { type: "string", writeOnly: true },
				bundle: { type: "string", "x-narrafork-secret": true },
			},
			additionalProperties: false,
		},
		...overrides,
	} as ProviderRegistryRegistration;
}

/** Records what reached the vault, so "nothing was written" is assertable. */
function recordingSink(): CommandSecretSink & { writes: string[]; deletes: string[] } {
	const writes: string[] = [];
	const deletes: string[] = [];
	return {
		writes,
		deletes,
		setSecret: ({ key }) => void writes.push(key),
		deleteSecret: ({ key }) => void deletes.push(key),
	};
}

function registryWith(...registrations: ProviderRegistryRegistration[]): PluginProviderRegistry {
	const registry = new PluginProviderRegistry();
	for (const item of registrations) registry.register(item);
	return registry;
}

describe("plugin command secret writes: allowed cases", () => {
	test("writes a secret field the plugin's own provider declares", async () => {
		const sink = recordingSink();
		const result = await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [{ key: "provider.alpha.apiKey", value: "sk-live" }],
			registry: registryWith(registration()),
			sink,
		});
		expect(result.written).toEqual(["provider.alpha.apiKey"]);
		expect(sink.writes).toEqual(["provider.alpha.apiKey"]);
	});

	test("recognizes both secret markers", async () => {
		const sink = recordingSink();
		await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [
				{ key: "provider.alpha.apiKey", value: "a" },
				{ key: "provider.alpha.bundle", value: "b" },
			],
			registry: registryWith(registration()),
			sink,
		});
		expect(sink.writes.sort()).toEqual(["provider.alpha.apiKey", "provider.alpha.bundle"]);
	});

	test("a null value deletes the key", async () => {
		const sink = recordingSink();
		const result = await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [{ key: "provider.alpha.apiKey", value: null }],
			registry: registryWith(registration()),
			sink,
		});
		expect(result.deleted).toEqual(["provider.alpha.apiKey"]);
		expect(sink.writes).toEqual([]);
	});

	test("writes across several of the plugin's own providers", async () => {
		const sink = recordingSink();
		await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [
				{ key: "provider.alpha.apiKey", value: "a" },
				{ key: "provider.beta.apiKey", value: "b" },
			],
			registry: registryWith(
				registration(),
				registration({
					localId: "beta",
					providerInstanceId: "inst-beta",
					providerPrefix: "beta",
				}),
			),
			sink,
		});
		expect(sink.writes.sort()).toEqual(["provider.alpha.apiKey", "provider.beta.apiKey"]);
	});

	test("an empty batch is a no-op", async () => {
		const sink = recordingSink();
		const result = await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [],
			registry: registryWith(registration()),
			sink,
		});
		expect(result).toEqual({ written: [], deleted: [] });
		expect(sink.writes).toEqual([]);
	});
});

describe("plugin command secret writes: refused escapes", () => {
	test("refuses a key outside the provider namespace", async () => {
		const sink = recordingSink();
		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				writes: [{ key: "acme.credentials", value: "x" }],
				registry: registryWith(registration()),
				sink,
			}),
		).rejects.toThrow(ValidationError);
		expect(sink.writes).toEqual([]);
	});

	test("refuses a sibling contribution the plugin does not own", async () => {
		const sink = recordingSink();
		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				// `gamma` exists in the registry but belongs to a different plugin.
				writes: [{ key: "provider.gamma.apiKey", value: "x" }],
				registry: registryWith(
					registration(),
					registration({
						pluginId: OTHER_PLUGIN_ID,
						localId: "gamma",
						providerInstanceId: "inst-gamma",
						providerPrefix: "gamma",
					}),
				),
				sink,
			}),
		).rejects.toThrow(ValidationError);
		expect(sink.writes).toEqual([]);
	});

	test("refuses a key with no field part", async () => {
		const sink = recordingSink();
		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				// `provider.alpha` names a contribution but no field, so there is nothing to store.
				writes: [{ key: "provider.alpha", value: "x" }],
				registry: registryWith(registration()),
				sink,
			}),
		).rejects.toThrow(ValidationError);
		expect(sink.writes).toEqual([]);
	});

	test("refuses everything when the plugin contributed no providers", async () => {
		const sink = recordingSink();
		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				writes: [{ key: "provider.alpha.apiKey", value: "x" }],
				registry: registryWith(registration({ pluginId: OTHER_PLUGIN_ID })),
				sink,
			}),
		).rejects.toThrow(ValidationError);
		expect(sink.writes).toEqual([]);
	});

	test("does not distinguish escape kinds in the error message", async () => {
		// Telling a plugin *why* a key was refused would let it probe which keys exist for
		// other plugins and providers.
		const registry = registryWith(
			registration(),
			registration({
				pluginId: OTHER_PLUGIN_ID,
				localId: "gamma",
				providerInstanceId: "inst-gamma",
				providerPrefix: "gamma",
			}),
		);
		const messages: string[] = [];
		// `provider.alpha.apiMode` is no longer a probe: undeclared fields are writable now.
		// What must stay indistinguishable is "another plugin's contribution" versus "not a
		// provider key at all".
		for (const key of ["provider.gamma.apiKey", "provider.unknown.apiKey", "unrelated.key"]) {
			try {
				await applyCommandSecretWrites({
					pluginId: PLUGIN_ID,
					writes: [{ key, value: "x" }],
					registry,
					sink: recordingSink(),
				});
			} catch (error) {
				messages.push(error instanceof Error ? error.message.replace(key, "<key>") : "");
			}
		}
		expect(new Set(messages).size).toBe(1);
	});
});

describe("plugin command secret writes: retained size limit", () => {
	test("refuses an oversized single value rather than truncating it", async () => {
		const sink = recordingSink();
		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				writes: [
					{ key: "provider.alpha.bundle", value: "x".repeat(MAX_COMMAND_SECRET_VALUE_BYTES + 1) },
				],
				registry: registryWith(registration()),
				sink,
			}),
		).rejects.toThrow(/too large/);
		// Kept while the count and batch-total ceilings were dropped, for a different reason
		// than trust: the vault is a synchronous JSON read/modify/write on the main thread.
		// Truncating instead would produce a credential that fails to authenticate in a way
		// that looks like a server fault.
		expect(sink.writes).toEqual([]);
	});

	test("accepts a batch far larger than the old fifty-entry cap", async () => {
		const sink = recordingSink();
		const result = await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: Array.from({ length: 200 }, (_, index) => ({
				key: `provider.alpha.token${index}`,
				value: `tok-${index}`,
			})),
			registry: registryWith(registration()),
			sink,
		});

		// A plugin managing one credential per signed-in account has no reason to fit inside
		// an arbitrary host-chosen count.
		expect(result.written).toHaveLength(200);
		expect(sink.writes).toHaveLength(200);
	});
});

describe("plugin command secret writes: relaxed rules", () => {
	test("writes a field the configSchema never declared", async () => {
		const sink = recordingSink();
		// The whitelist is gone. A plugin that rotates tokens or stores one entry per account
		// cannot enumerate those keys in a static manifest, so requiring it blocked exactly
		// the plugins that most need credential storage.
		const result = await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [{ key: "provider.alpha.rotated-2026-08", value: "tok-fresh" }],
			registry: registryWith(registration()),
			sink,
		});

		expect(result.written).toEqual(["provider.alpha.rotated-2026-08"]);
		expect(sink.writes).toEqual(["provider.alpha.rotated-2026-08"]);
	});

	test("writes a non-secret field name without complaint", async () => {
		const sink = recordingSink();
		// `apiMode` is a plain field in the schema. Writing it to the vault is now a plugin's
		// own business: it wastes a vault slot but harms nothing the host must protect.
		await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [{ key: "provider.alpha.apiMode", value: "verbose" }],
			registry: registryWith(registration()),
			sink,
		});

		expect(sink.writes).toEqual(["provider.alpha.apiMode"]);
	});

	test("applies duplicate keys in order, last write winning", async () => {
		const applied: Array<{ key: string; value: string }> = [];
		const sink: CommandSecretSink = {
			setSecret: ({ key, value }) => void applied.push({ key, value }),
			deleteSecret: () => undefined,
		};

		await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [
				{ key: "provider.alpha.apiKey", value: "first" },
				{ key: "provider.alpha.apiKey", value: "second" },
			],
			registry: registryWith(registration()),
			sink,
		});

		// Previously rejected for making the outcome order-dependent. Order is now simply the
		// defined semantics, which is what a caller would expect from a sequence of writes.
		expect(applied.map((item) => item.value)).toEqual(["first", "second"]);
	});

	test("a batch is applied incrementally, so an I/O failure can leave earlier writes", async () => {
		const applied: string[] = [];
		const sink: CommandSecretSink = {
			setSecret: ({ key }) => {
				if (key === "provider.alpha.second") throw new Error("vault write failed");
				applied.push(key);
			},
			deleteSecret: () => undefined,
		};

		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				writes: [
					{ key: "provider.alpha.first", value: "a" },
					{ key: "provider.alpha.second", value: "b" },
					{ key: "provider.alpha.third", value: "c" },
				],
				registry: registryWith(registration()),
				sink,
			}),
		).rejects.toThrow(/vault write failed/);

		// This is the honest cost of dropping the atomic pre-pass, asserted rather than
		// hidden: the first entry persisted, the third never ran. A plugin rotating a
		// credential set must tolerate a partially-applied batch.
		expect(applied).toEqual(["provider.alpha.first"]);
	});

	test("still rejects the whole batch before writing when a key is out of namespace", async () => {
		const sink = recordingSink();
		await expect(
			applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				writes: [
					{ key: "provider.alpha.apiKey", value: "valid" },
					{ key: "provider.gamma.apiKey", value: "not-allowed" },
				],
				registry: registryWith(
					registration(),
					registration({
						pluginId: OTHER_PLUGIN_ID,
						localId: "gamma",
						providerInstanceId: "inst-gamma",
						providerPrefix: "gamma",
					}),
				),
				sink,
			}),
		).rejects.toThrow(ValidationError);
		// Namespace validation still runs as an up-front pass over every entry, so a
		// cross-plugin key cannot slip in behind a valid one.
		expect(sink.writes).toEqual([]);
		expect(sink.deletes).toEqual([]);
	});
});

describe("plugin command secret writes: no value disclosure", () => {
	test("error messages name the key but never the value", async () => {
		const secret = "sk-super-secret-value";
		try {
			// Uses a key that is still refused (another plugin's contribution); `apiMode` now
			// succeeds, so it would no longer produce an error to inspect.
			await applyCommandSecretWrites({
				pluginId: PLUGIN_ID,
				writes: [{ key: "provider.gamma.apiKey", value: secret }],
				registry: registryWith(registration()),
				sink: recordingSink(),
			});
			throw new Error("expected a rejection");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("provider.gamma.apiKey");
			expect(message).not.toContain(secret);
		}
	});

	test("the result reports keys only, so a caller cannot echo values back", async () => {
		const result = await applyCommandSecretWrites({
			pluginId: PLUGIN_ID,
			writes: [{ key: "provider.alpha.apiKey", value: "sk-live" }],
			registry: registryWith(registration()),
			sink: recordingSink(),
		});
		expect(JSON.stringify(result)).not.toContain("sk-live");
	});
});
