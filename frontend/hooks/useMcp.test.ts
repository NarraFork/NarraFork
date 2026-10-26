import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import i18n from "../lib/i18n";
import en from "../locales/en/routines.json";
import zh from "../locales/zh-CN/routines.json";

await i18n.init({ lng: "en", resources: { en: { routines: en }, "zh-CN": { routines: zh } } });

type ServerCache = { servers: Array<Record<string, unknown> & { id: string }> };
let cache: ServerCache | undefined;
const failures: unknown[] = [];
const invalidations: unknown[] = [];
const reactQuery = { ...(await import("@tanstack/react-query")) };
const queryClient = { ...(await import("../lib/query-client")) };
mock.module("@tanstack/react-query", () => ({
	...reactQuery,
	useMutation: (options: unknown) => options,
	useQueryClient: () => ({
		cancelQueries: async () => {},
		getQueryData: () => cache,
		setQueryData: (
			_key: unknown,
			value: ServerCache | ((old: ServerCache | undefined) => ServerCache | undefined),
		) => {
			cache = typeof value === "function" ? value(cache) : value;
		},
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
const { useRefreshAllMcpServers, useUpdateMcpServer } = await import("./useMcp");

type RefreshData = { results: Array<{ name: string; ok: boolean }> };
function mutation() {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query hooks are stubs here; inspect mutation callbacks without mounting React.
	return useRefreshAllMcpServers() as unknown as {
		onSuccess: (data: RefreshData) => Promise<void>;
	};
}

function updateMutation() {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query hooks are stubbed to expose callbacks.
	return useUpdateMcpServer() as unknown as {
		onMutate: (
			variables: { id: string } & Record<string, unknown>,
		) => Promise<{ previous?: ServerCache }>;
		onError: (error: Error, variables: unknown, context: { previous?: ServerCache }) => void;
		onSuccess: (updated: Record<string, unknown>, variables: { id: string }) => void;
	};
}

beforeEach(() => {
	cache = undefined;
	failures.length = 0;
	invalidations.length = 0;
});
afterAll(() => {
	mock.module("@tanstack/react-query", () => reactQuery);
	mock.module("../lib/query-client", () => queryClient);
	mock.restore();
});

describe("MCP loading mode optimistic updates", () => {
	test("updates mode and compatibility enabled without changing connection status or permissions", async () => {
		const permissions = [{ toolName: "read", behavior: "ask", enabled: false }];
		cache = {
			servers: [
				{
					id: "a",
					mode: "resident",
					enabled: true,
					status: "connected",
					toolPermissions: permissions,
				},
			],
		};
		const mutation = updateMutation();
		for (const mode of ["auto", "disabled", "resident"]) {
			await mutation.onMutate({ id: "a", mode });
			expect(cache?.servers[0]).toMatchObject({
				mode,
				enabled: mode !== "disabled",
				status: "connected",
				toolPermissions: permissions,
			});
		}
	});

	test("retains auto on legacy enable, disables on legacy false, and rolls back errors", async () => {
		cache = { servers: [{ id: "a", mode: "auto", enabled: true }] };
		const mutation = updateMutation();
		await mutation.onMutate({ id: "a", enabled: true });
		expect(cache?.servers[0]?.mode).toBe("auto");
		const context = await mutation.onMutate({ id: "a", enabled: false });
		expect(cache?.servers[0]?.mode).toBe("disabled");
		mutation.onError(new Error("failed"), {}, context);
		expect(cache?.servers[0]).toMatchObject({ mode: "auto", enabled: true });
		expect(failures).toHaveLength(1);
	});

	test("applies authoritative response and keeps tool permission enablement independent", async () => {
		cache = {
			servers: [
				{
					id: "a",
					mode: "auto",
					enabled: true,
					toolPermissions: [{ toolName: "read", behavior: "ask", enabled: true }],
				},
			],
		};
		const mutation = updateMutation();
		await mutation.onMutate({ id: "a", toolPermissionPatch: { toolName: "read", enabled: false } });
		expect(cache?.servers[0]).toMatchObject({
			mode: "auto",
			enabled: true,
			toolPermissions: [{ toolName: "read", behavior: "ask", enabled: false }],
		});
		mutation.onSuccess({ mode: "resident", enabled: true, status: "connected" }, { id: "a" });
		expect(cache?.servers[0]).toMatchObject({
			mode: "resident",
			enabled: true,
			status: "connected",
		});
		expect(invalidations).toHaveLength(1);
	});
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
