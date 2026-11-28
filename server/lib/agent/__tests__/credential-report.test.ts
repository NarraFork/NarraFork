import { describe, expect, mock, test } from "bun:test";
import {
	bindFrozenQuotaTarget,
	type FrozenCustomApiQuotaTarget,
	frozenQuotaTargetFor,
} from "../../provider-quota-async";
import { reportCredentialId } from "../credential-report";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "../provider";

class FakeAdapter implements ProviderAdapter {
	seen: Array<ChatParams["onRequestStart"]> = [];
	formatTools() {
		return [];
	}
	async buildHistory() {
		return { history: [] } as never;
	}
	injectSystemPrompt() {}
	async *chat(params: ChatParams) {
		this.seen.push(params.onRequestStart);
		params.onRequestStart?.({ credentialId: "inner", validateDiagnosticCredential: () => false });
		yield { text: "hi" };
	}
	async generate() {
		return "text";
	}
	async generateWithMeta() {
		return { text: "meta", credentialId: "inner" };
	}
	async generateWithHistory() {
		return "text";
	}
}

async function drain(adapter: ProviderAdapter, params: Partial<ChatParams> = {}) {
	const events: ParsedStreamEvent[] = [];
	for await (const event of adapter.chat({
		signal: new AbortController().signal,
		...params,
	} as ChatParams)) {
		events.push(event);
	}
	expect(events.length).toBeGreaterThan(0);
	return events;
}

describe("reportCredentialId", () => {
	test("forces the credential and keeps the instance and the inner start info", async () => {
		const inner = new FakeAdapter();
		const adapter = reportCredentialId<ProviderAdapter>(inner, "conn");
		expect(adapter).toBe(inner);
		expect(adapter).toBeInstanceOf(FakeAdapter);
		expect(adapter.generateWithHistoryWithMeta).toBeUndefined();

		const started: Array<{ credentialId?: string; valid?: boolean }> = [];
		const events = [];
		for await (const event of adapter.chat({
			signal: new AbortController().signal,
			onRequestStart: (info?: {
				credentialId?: string;
				validateDiagnosticCredential?: () => boolean;
			}) =>
				started.push({
					credentialId: info?.credentialId,
					valid: info?.validateDiagnosticCredential?.(),
				}),
		} as unknown as ChatParams)) {
			events.push(event);
		}
		expect(started).toEqual([{ credentialId: "conn", valid: false }]);
		expect(events).toEqual([{ text: "hi", credentialId: "conn" }]);
		expect(await adapter.generateWithMeta("q", "m")).toEqual({
			text: "meta",
			credentialId: "conn",
		});
		expect(await adapter.generate("q", "m")).toBe("text");

		// A caller that does not listen for the start is not given a listener.
		for await (const _ of adapter.chat({ signal: new AbortController().signal } as ChatParams)) {
		}
		expect(inner.seen.at(-1)).toBeUndefined();
	});

	test("freezes the real key before preparation and preserves it through nested billing wrappers", async () => {
		const subject = { providerId: "provider", keyId: "stored-key" };
		const target = { ...subject, generation: "before-preparation" };
		const order: string[] = [];
		const inner: ProviderAdapter = new FakeAdapter();
		inner.chat = async function* (params) {
			order.push("prepare");
			target.generation = "changed-during-preparation";
			await Promise.resolve();
			params.onRequestStart?.({ credentialId: "inner" });
			yield { quotaBalance: "3" };
			target.generation = "changed-during-stream";
			yield { quotaBalance: "2" };
		};
		const adapter = reportCredentialId(reportCredentialId(inner, "group", subject), "billing");
		// The factory's selected subject cannot be changed after creating the adapter.
		subject.keyId = "replacement-key";
		const capture = mock((providerId: string, keyId: string) => {
			order.push("capture");
			expect([providerId, keyId]).toEqual(["provider", "stored-key"]);
			return target;
		});
		const events = await drain(adapter, {
			captureCustomApiQuotaTarget: capture,
			onRequestStart: (info) => {
				order.push("start");
				expect(info?.credentialId).toBe("billing");
				expect(info?.quotaCredentialId).toBe("stored-key");
			},
		});
		expect(order).toEqual(["capture", "prepare", "start"]);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(events).toEqual([
			{ quotaBalance: "3", credentialId: "billing" },
			{ quotaBalance: "2", credentialId: "billing" },
		]);
		for (const event of events) {
			expect(frozenQuotaTargetFor(event)).toEqual({
				providerId: "provider",
				keyId: "stored-key",
				generation: "before-preparation",
			});
			expect(Object.isFrozen(frozenQuotaTargetFor(event))).toBe(true);
			expect(JSON.stringify(event)).not.toContain("generation");
		}
		// Reusing an adapter starts a new capture only for the next request.
		target.generation = "next-request";
		const nextEvents = await drain(adapter, { captureCustomApiQuotaTarget: capture });
		expect(capture).toHaveBeenCalledTimes(2);
		for (const event of nextEvents)
			expect(frozenQuotaTargetFor(event)?.generation).toBe("next-request");
	});

	test.each([
		"null",
		"throw",
	])("quota capture %s fails closed without interrupting inference", async (failure) => {
		const adapter = reportCredentialId(new FakeAdapter(), "group", {
			providerId: "provider",
			keyId: "stored-key",
		});
		const capture = mock(() => {
			if (failure === "throw") throw new Error("quota directory unavailable");
			return null;
		});
		const events = await drain(adapter, { captureCustomApiQuotaTarget: capture });
		expect(capture).toHaveBeenCalledTimes(1);
		expect(events).toEqual([{ text: "hi", credentialId: "group" }]);
		for (const event of events) expect(frozenQuotaTargetFor(event)).toBeNull();
	});

	test("a legacy provider without stored keys captures its group without claiming a stored quota key", async () => {
		const capture = mock((providerId: string, keyId: string) => ({
			providerId,
			keyId,
			generation: "legacy-generation",
		}));
		const started = mock((info?: { credentialId?: string; quotaCredentialId?: string }) => {
			expect(info?.credentialId).toBe("group");
			expect(info?.quotaCredentialId).toBeUndefined();
		});
		const events = await drain(
			reportCredentialId(new FakeAdapter(), "group", { providerId: "group" }),
			{ captureCustomApiQuotaTarget: capture, onRequestStart: started },
		);
		expect(capture).toHaveBeenCalledWith("group", "group");
		expect(started).toHaveBeenCalledTimes(1);
		for (const event of events)
			expect(frozenQuotaTargetFor(event)?.generation).toBe("legacy-generation");
	});

	test("billing-only wrappers do not attempt Custom API capture", async () => {
		const capture = mock(() => null);
		const events = await drain(reportCredentialId(new FakeAdapter(), "tokendance"), {
			captureCustomApiQuotaTarget: capture,
		});
		expect(capture).not.toHaveBeenCalled();
		for (const event of events) expect(frozenQuotaTargetFor(event)).toBeUndefined();
	});

	test.each([
		"target",
		"null",
	])("an inner host %s survives copying without a capture callback", async (kind) => {
		const inner: ProviderAdapter = new FakeAdapter();
		const target: FrozenCustomApiQuotaTarget | null =
			kind === "null"
				? null
				: { providerId: "provider", keyId: "stored-key", generation: "inner-generation" };
		const original = { quotaBalance: "3" };
		bindFrozenQuotaTarget(original, target);
		inner.chat = async function* () {
			yield original;
		};
		const events = await drain(reportCredentialId(reportCredentialId(inner, "inner"), "outer"));
		for (const event of events) {
			expect(event).not.toBe(original);
			expect(frozenQuotaTargetFor(event)).toEqual(target);
		}
	});

	test("an inner explicit rejection cannot be replaced by an outer capture", async () => {
		const inner: ProviderAdapter = new FakeAdapter();
		inner.chat = async function* () {
			const event = { quotaBalance: "3" };
			bindFrozenQuotaTarget(event, null);
			yield event;
		};
		const subject = { providerId: "provider", keyId: "stored-key" };
		const events = await drain(reportCredentialId(inner, "group", subject), {
			captureCustomApiQuotaTarget: () => ({ ...subject, generation: "outer-generation" }),
		});
		for (const event of events) expect(frozenQuotaTargetFor(event)).toBeNull();
	});

	test("an adapter already invalidated before chat cannot capture the new connection", async () => {
		const inner: ProviderAdapter = new FakeAdapter();
		inner.isDiagnosticConnectionCurrent = () => false;
		const capture = mock(() => ({
			providerId: "provider",
			keyId: "stored-key",
			generation: "new-generation",
		}));
		const events = await drain(
			reportCredentialId(inner, "group", { providerId: "provider", keyId: "stored-key" }),
			{ captureCustomApiQuotaTarget: capture },
		);
		expect(capture).not.toHaveBeenCalled();
		for (const event of events) expect(frozenQuotaTargetFor(event)).toBeNull();
	});
});
