import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import i18n from "../lib/i18n";
import en from "../locales/en/routines.json";
import zh from "../locales/zh-CN/routines.json";

await i18n.init({ lng: "en", resources: { en: { routines: en }, "zh-CN": { routines: zh } } });

const failures: unknown[] = [];
const invalidations: unknown[] = [];
const reactQuery = { ...(await import("@tanstack/react-query")) };
const queryClient = { ...(await import("../lib/query-client")) };
mock.module("@tanstack/react-query", () => ({
	...reactQuery,
	useMutation: (options: unknown) => options,
	useQueryClient: () => ({
		invalidateQueries: async (options: unknown) => {
			invalidations.push(options);
		},
	}),
}));
mock.module("../lib/query-client", () => ({
	...queryClient,
	reportMutationError: (error: unknown) => {
		failures.push(error);
	},
}));
const { useRefreshAllMcpServers } = await import("./useMcp");

type RefreshData = { results: Array<{ name: string; ok: boolean }> };
function mutation() {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query hooks are stubs here; inspect mutation callbacks without mounting React.
	return useRefreshAllMcpServers() as unknown as {
		onSuccess: (data: RefreshData) => Promise<void>;
	};
}

beforeEach(() => {
	failures.length = 0;
	invalidations.length = 0;
});
afterAll(() => {
	mock.module("@tanstack/react-query", () => reactQuery);
	mock.module("../lib/query-client", () => queryClient);
	mock.restore();
});

describe("MCP refreshAll partial failures", () => {
	test("HTTP success with failed results reports their count and names and refreshes cache", async () => {
		await i18n.changeLanguage("en");
		await mutation().onSuccess({
			results: [
				{ name: "healthy", ok: true },
				{ name: "JetBrains", ok: false },
				{ name: "offline", ok: false },
			],
		});
		expect(failures).toHaveLength(1);
		expect((failures[0] as Error).message).toContain("2");
		expect((failures[0] as Error).message).toContain("JetBrains, offline");
		expect((failures[0] as Error).message).not.toContain("healthy");
		expect(invalidations).toEqual([{ queryKey: ["mcp-servers"] }]);
	});

	test("complete success stays quiet", async () => {
		await mutation().onSuccess({ results: [{ name: "healthy", ok: true }] });
		expect(failures).toEqual([]);
		expect(invalidations).toHaveLength(1);
	});

	test("partial failure is localized in Chinese", async () => {
		await i18n.changeLanguage("zh-CN");
		await mutation().onSuccess({ results: [{ name: "IDE", ok: false }] });
		expect((failures[0] as Error).message).toBe("1 个 MCP 服务器刷新失败：IDE");
	});
});
