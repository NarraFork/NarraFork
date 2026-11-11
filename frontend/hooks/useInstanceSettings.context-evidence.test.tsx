import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createHarness, input, settle } from "../../tests/frontend/context-memory-harness";
import { api } from "../lib/api";
import { type UseInstanceSettingsReturn, useInstanceSettings } from "./useInstanceSettings";

let harness: ReturnType<typeof createHarness>;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
	await harness?.close();
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("context evidence settings state", () => {
	test("hydrates explicit zero/off/false and saves the same independent values", async () => {
		harness = createHarness();
		const server = {
			agent: { defaultModel: "test", contextEvidenceBudgetBytes: 0 },
			knowledge: { injectMode: "off", retrievalMode: "hybrid", scanToolOutput: false },
		};
		spies.push(spyOn(api, "getSettings").mockResolvedValue(server as never));
		const update = spyOn(api, "updateSettings").mockImplementation(async (data) => data as never);
		spies.push(update);
		let state!: UseInstanceSettingsReturn;
		function Probe() {
			state = useInstanceSettings();
			return null;
		}
		await harness.render(<Probe />);
		expect(state.contextEvidenceBudgetBytes).toBe(0);
		expect(state.knowledgeInjectMode).toBe("off");
		expect(state.knowledgeRetrievalMode).toBe("hybrid");
		expect(state.knowledgeScanToolOutput).toBe(false);
		await act(() => {
			state.setContextEvidenceBudgetBytes(32768);
			state.setKnowledgeRetrievalMode("keywords");
		});
		await act(() => state.save());
		await settle();
		expect(update.mock.calls[0]?.[0]).toMatchObject({
			agent: { contextEvidenceBudgetBytes: 32768 },
			knowledge: { injectMode: "off", retrievalMode: "keywords", scanToolOutput: false },
		});
	});
	test("older settings hydrate the bounded budget and keyword defaults", async () => {
		harness = createHarness();
		spies.push(
			spyOn(api, "getSettings").mockResolvedValue({ agent: { defaultModel: "test" } } as never),
		);
		let state!: UseInstanceSettingsReturn;
		function Probe() {
			state = useInstanceSettings();
			return null;
		}
		await harness.render(<Probe />);
		expect(state.contextEvidenceBudgetBytes).toBe(16384);
		expect(state.knowledgeInjectMode).toBe("summary");
		expect(state.knowledgeRetrievalMode).toBe("keywords");
		expect(state.knowledgeScanToolOutput).toBe(true);
	});
});

test("the evidence card exposes bounded controls and the persisted configuration", async () => {
	const { existsSync } = await import("node:fs");
	expect(
		existsSync(new URL("../components/settings/ContextEvidenceSettings.tsx", import.meta.url)),
	).toBe(true);
	const { ContextEvidenceSettings } = await import(
		"../components/settings/ContextEvidenceSettings"
	);
	const { InstanceSettingsProvider } = await import("./useInstanceSettings");
	harness = createHarness();
	spies.push(
		spyOn(api, "getSettings").mockResolvedValue({
			agent: { contextEvidenceBudgetBytes: 0 },
			knowledge: { injectMode: "off", retrievalMode: "hybrid", scanToolOutput: false },
		} as never),
	);
	function Probe() {
		const value = useInstanceSettings();
		return (
			<InstanceSettingsProvider value={value}>
				<ContextEvidenceSettings />
			</InstanceSettingsProvider>
		);
	}
	await harness.render(<Probe />);
	expect(harness.container.textContent).toContain("Shared evidence budget");
	const budget = harness.container.querySelector<HTMLInputElement>(
		'[name="contextEvidenceBudgetBytes"]',
	);
	expect(budget?.value).toBe("0");
	await input(harness.container, "contextEvidenceBudgetBytes", "70000");
	await act(() => budget?.dispatchEvent(new Event("focusout", { bubbles: true })));
	expect(budget?.value).toBe("65536");
	expect(
		harness.container.querySelector<HTMLSelectElement>('[name="knowledgeRetrievalMode"]')?.value,
	).toBe("hybrid");
	expect(
		harness.container.querySelector<HTMLInputElement>('[name="knowledgeScanToolOutput"]')?.checked,
	).toBe(false);
});
