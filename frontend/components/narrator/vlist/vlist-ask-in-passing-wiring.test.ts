import { describe, expect, it } from "bun:test";

const read = (file: string) => Bun.file(new URL(file, import.meta.url)).text();

describe("ask-in-passing exact-row contract", () => {
	it("keeps pending forms out of the dynamic-height escape hatch", async () => {
		const shell = await read("./PretextExactMessageList.tsx");
		const start = shell.indexOf("const dynamicRowKeys = useMemo(");
		const end = shell.indexOf("dynamicRowKeysRef.current = dynamicRowKeys", start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const dynamic = shell.slice(start, end);
		expect(dynamic).not.toContain("ask-in-passing");
		expect(dynamic).not.toContain("isVListAskInPassingPending");
		expect(shell).toContain("askInPassing.pendingByKey.get(item.spec.key)");
		for (const file of [
			"./ExactRow.tsx",
			"./render-registry.tsx",
			"./render/RenderAskInPassing.tsx",
		]) {
			const source = await read(file);
			expect(source).not.toContain("askInPassingFormSlot");
			expect(source).not.toContain("formSlot");
		}
	});

	it("routes HTTP acknowledgements and ambiguous projections through anchored synchronization", async () => {
		const shell = await read("./PretextExactMessageList.tsx");
		expect(shell).toContain("subscribeAskInPassingEvents");
		expect(shell).toContain("pretextDocumentRef.current.refreshAskInPassing()");
		expect(shell).toContain("forgetAskInPassingRef.current?.(id)");
		const bridge = await read("./vlist-ask-in-passing-bridge.tsx");
		expect(bridge).not.toContain("AskInPassingPendingCard");
		expect(bridge).toContain("useSyncExternalStore");
		expect(bridge).toContain("await resolve(");
		expect(bridge).toContain("await cancel(");
	});
});
