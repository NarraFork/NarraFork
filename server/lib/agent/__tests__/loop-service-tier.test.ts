import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
	createNarratorFastModeResolver,
	type NarratorFastModeRow,
} from "../../../services/narrator-fast-mode";
import { agentLoop, runReflectionLoop } from "../loop";
import {
	type ChatParams,
	type ParsedStreamEvent,
	type ProviderAdapter,
	registerExternalProviderResolver,
} from "../provider";
import { resolveToolJsonSchema, toolRegistry } from "../tool-registry";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

const PROVIDER = "tierfixture";
const NEXT_PROVIDER = "tiernextfixture";
const MODEL = `${PROVIDER}:supported`;
const NEXT_MODEL = `${NEXT_PROVIDER}:ordinary`;
const TOOL = "ServiceTierBoundaryTool";
const DECISION = "ServiceTierDecisionTool";
const requests: Array<{ provider: string; params: ChatParams }> = [];
let enabled = true;
let chat: (params: ChatParams) => AsyncGenerator<ParsedStreamEvent>;

function adapter(provider: string): ProviderAdapter {
	return {
		formatTools: (tools) =>
			tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: resolveToolJsonSchema(tool),
			})),
		buildHistory: async () => ({ history: [] }),
		injectSystemPrompt: () => {},
		async *chat(params) {
			requests.push({ provider, params });
			yield* chat(params);
		},
		generate: async () => "",
		generateWithMeta: async () => ({ text: "" }),
		generateWithHistory: async () => "",
	};
}
const adapters = new Map([
	[PROVIDER, adapter(PROVIDER)],
	[NEXT_PROVIDER, adapter(NEXT_PROVIDER)],
]);
const unregister = registerExternalProviderResolver({
	resolve: (provider) => adapters.get(provider) ?? null,
	listReadiness: () => [],
});
for (const [name, reflectionOnly] of [
	[TOOL, false],
	[DECISION, true],
] as const) {
	toolRegistry.register({
		name,
		description: "Drive a service-tier request boundary",
		parameters: z.object({}),
		reflectionOnly,
		execute: async () => ({ output: "done" }),
	});
}

beforeEach(() => {
	requests.length = 0;
	enabled = true;
	chat = async function* () {
		yield { text: "done" };
	};
});
afterAll(() => {
	unregister();
	toolRegistry.unregister(TOOL);
	toolRegistry.unregister(DECISION);
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "service-tier-boundary",
		conversationId: "service-tier-conversation",
		provider: PROVIDER,
		model: MODEL,
		cwd: process.env.HOME as string,
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: (tool) => tool.name === TOOL || tool.name === DECISION,
		maxTurns: 4,
		maxTransientRetries: 1,
		retryBackoffCeilMs: 0,
		resolveServiceTier: () => (enabled ? "priority" : undefined),
		...overrides,
	};
}
async function drain(input: AgentConfig, events: AgentEvent[] = []) {
	for await (const event of agentLoop(input, "test input", { rows: [] })) events.push(event);
	return events;
}
function tiers() {
	return requests.map(({ params }) => params.serviceTier);
}

describe("service tier snapshots at real provider request boundaries", () => {
	test("one pass observes changes on successive turns without mutating sent requests", async () => {
		chat = async function* () {
			if (requests.length < 3) {
				enabled = !enabled;
				yield {
					toolUses: [{ toolUseId: `tier-turn-${requests.length}`, name: TOOL, input: {} }],
				};
				return;
			}
			yield { text: "done" };
		};
		await drain(config());
		expect(tiers()).toEqual(["priority", undefined, "priority"]);
		expect(requests.map(({ params }) => params.conversationId)).toEqual([
			"service-tier-conversation",
			"service-tier-conversation",
			"service-tier-conversation",
		]);
	});

	test("async resolution blocks sending until its request snapshot is ready", async () => {
		let entered!: () => void;
		let release!: (tier: string | undefined) => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const tier = new Promise<string | undefined>((resolve) => {
			release = resolve;
		});
		const running = drain(
			config({
				resolveServiceTier: () => {
					entered();
					return tier;
				},
			}),
		);
		await waiting;
		expect(requests).toHaveLength(0);
		release("priority");
		await running;
		expect(tiers()).toEqual(["priority"]);
	});

	test("provider retries resolve again and retain the first attempt's tier", async () => {
		chat = async function* () {
			if (requests.length === 1) {
				enabled = false;
				throw new ApiError(503, "transient upstream failure");
			}
			yield { text: "retry completed" };
		};
		const events = await drain(config());
		expect(tiers()).toEqual(["priority", undefined]);
		expect(events.some((event) => event.type === "retrying")).toBe(true);
	});

	test("callback undefined disables an old static priority tier", async () => {
		await drain(config({ serviceTier: "priority", resolveServiceTier: () => undefined }));
		expect(tiers()).toEqual([undefined]);
	});

	test("callers without a callback retain their static service tier", async () => {
		await drain(config({ serviceTier: "priority", resolveServiceTier: undefined }));
		expect(tiers()).toEqual(["priority"]);
	});

	test("runtime model switches pass the actual provider and model to tier resolution", async () => {
		const identities: Array<{ provider: string; model: string }> = [];
		chat = async function* () {
			if (requests.length === 1) {
				yield { toolUses: [{ toolUseId: "tier-model-switch", name: TOOL, input: {} }] };
				return;
			}
			yield { text: "new provider completed" };
		};
		await drain(
			config({
				getRuntimeSettingsOverride: () => (requests.length ? { model: NEXT_MODEL } : null),
				resolveServiceTier: (identity) => {
					identities.push({ provider: identity.provider, model: identity.model });
					return identity.provider === PROVIDER && identity.model === MODEL
						? "priority"
						: undefined;
				},
			}),
		);
		expect(identities).toEqual([
			{ provider: PROVIDER, model: MODEL },
			{ provider: NEXT_PROVIDER, model: NEXT_MODEL },
		]);
		expect(requests.map(({ provider, params }) => [provider, params.model])).toEqual([
			[PROVIDER, MODEL],
			[NEXT_PROVIDER, NEXT_MODEL],
		]);
		expect(tiers()).toEqual(["priority", undefined]);
	});

	test("durable identity admission completes before tier resolution", async () => {
		const order: string[] = [];
		await drain(
			config({
				beforeProviderRequest: async () => {
					await Promise.resolve();
					order.push("identity");
				},
				resolveServiceTier: () => {
					order.push("tier");
					return "priority";
				},
			}),
		);
		expect(order).toEqual(["identity", "tier"]);
		expect(tiers()).toEqual(["priority"]);
	});

	test("failed identity admission never resolves a tier or sends a request", async () => {
		let resolutions = 0;
		await expect(
			drain(
				config({
					beforeProviderRequest: async () => {
						throw new Error("identity persistence failed");
					},
					resolveServiceTier: () => {
						resolutions++;
						return "priority";
					},
				}),
			),
		).rejects.toThrow("identity persistence failed");
		expect(resolutions).toBe(0);
		expect(requests).toHaveLength(0);
	});

	test("resolver failure fails closed outside provider retry handling", async () => {
		const events: AgentEvent[] = [];
		let resolutions = 0;
		await expect(
			drain(
				config({
					resolveServiceTier: async () => {
						resolutions++;
						throw new Error("fast-mode read failed");
					},
				}),
				events,
			),
		).rejects.toThrow("fast-mode read failed");
		expect(resolutions).toBe(1);
		expect(requests).toHaveLength(0);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
	});

	test("a failed retry-time resolver prevents the next provider attempt", async () => {
		chat = async function* () {
			if (requests.length === 1) throw new ApiError(503, "upstream unavailable");
			yield { text: "retry unexpectedly reached the provider" };
		};
		await expect(
			drain(
				config({
					resolveServiceTier: async () => {
						if (requests.length) throw new Error("invalidated preference read failed");
						return "priority";
					},
				}),
			),
		).rejects.toThrow("invalidated preference read failed");
		expect(tiers()).toEqual(["priority"]);
	});

	test("cancelling only reflection interrupts a cold fast-mode read before provider dispatch", async () => {
		const parentAbort = new AbortController();
		const reflectionAbort = new AbortController();
		const loadStarted = Promise.withResolvers<void>();
		const blockedRead = Promise.withResolvers<NarratorFastModeRow | undefined>();
		const resolver = createNarratorFastModeResolver({
			events: { on() {}, off() {} },
			loadNarrator: async () => {
				loadStarted.resolve();
				return blockedRead.promise;
			},
			loadUserDefault: async () => false,
			getActivePrincipal: () => undefined,
			getPersistedPrincipal: () => undefined,
		});
		let tierSignal: AbortSignal | undefined;
		const running = runReflectionLoop({
			parentConfig: config({
				signal: parentAbort.signal,
				resolveServiceTier: async ({ signal }) => {
					tierSignal = signal;
					const snapshot = await resolver.resolveNarratorFastMode("cold-reflection", { signal });
					return snapshot.effectiveFastMode ? "priority" : undefined;
				},
			}),
			rows: [],
			prompt: "reflect",
			abortController: reflectionAbort,
			reflectionLoop: {
				allowedTools: [DECISION],
				context: { kind: "taskReflection", requestId: "cold-tier-cancellation" },
			},
		});
		// Observe rejections immediately, including failures before the loader starts.
		const settled = running.then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await loadStarted.promise;
			expect(requests).toHaveLength(0);
			expect(tierSignal).toBeDefined();
			expect(tierSignal).not.toBe(parentAbort.signal);
			reflectionAbort.abort();
			const result = await Promise.race([
				settled,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Reflection cancellation waited for the cold-read timeout")),
						1_000,
					);
				}),
			]);
			expect(result.error).toBeInstanceOf(DOMException);
			expect((result.error as DOMException).name).toBe("AbortError");
			expect(tierSignal?.aborted).toBe(true);
			expect(parentAbort.signal.aborted).toBe(false);
			expect(requests).toHaveLength(0);
		} finally {
			clearTimeout(timer);
			reflectionAbort.abort();
			parentAbort.abort();
			blockedRead.resolve({ type: "primary", fastModeOverride: "on" });
			resolver.dispose();
			await settled;
		}
	});

	test("ordinary reflection inherits the callback and resolves its own fresh snapshot", async () => {
		const parentConfig = config({ serviceTier: "priority" });
		await drain(parentConfig);
		enabled = false;
		chat = async function* () {
			yield { toolUses: [{ toolUseId: "tier-reflection-decision", name: DECISION, input: {} }] };
		};
		const observed = await runReflectionLoop({
			parentConfig,
			rows: [],
			prompt: "reflect",
			reflectionLoop: {
				allowedTools: [DECISION],
				context: { kind: "taskReflection", requestId: "tier-reflection" },
			},
		});
		expect(observed.decisionSucceeded).toBe(true);
		expect(tiers()).toEqual(["priority", undefined]);
	});
});
