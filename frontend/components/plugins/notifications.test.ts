import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { handlePluginUiNotification } from "./notifications";

describe("handlePluginUiNotification", () => {
	test("invalidates settings caches for a catalog-invalidated notification", async () => {
		const queryClient = new QueryClient();
		await queryClient.prefetchQuery({ queryKey: ["settings"], queryFn: () => ({ stale: true }) });
		await queryClient.prefetchQuery({
			queryKey: ["admin", "settings"],
			queryFn: () => ({ stale: true }),
		});
		await queryClient.prefetchQuery({ queryKey: ["other"], queryFn: () => ({ kept: true }) });

		const handled = handlePluginUiNotification(
			{
				protocol: "narrafork.ui/1",
				kind: "notification",
				method: "providerSettings.catalogInvalidated",
				params: { providerId: "acme" },
			},
			queryClient,
		);

		expect(handled).toBe(true);
		expect(queryClient.getQueryState(["settings"])?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(["admin", "settings"])?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(["other"])?.isInvalidated).toBe(false);
	});

	test("ignores unrelated notifications", () => {
		const queryClient = new QueryClient();
		const handled = handlePluginUiNotification(
			{
				protocol: "narrafork.ui/1",
				kind: "notification",
				method: "plugin.lifecycle",
				params: { state: "ready" },
			},
			queryClient,
		);
		expect(handled).toBe(false);
	});
});
