import { describe, expect, test } from "bun:test";
import { reportCredentialId } from "../credential-report";
import type { ChatParams, ProviderAdapter } from "../provider";

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
});
