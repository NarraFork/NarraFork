import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createPluginUiRoutes } from "../../../server/routes/plugin-ui";

/**
 * `GET /plugins/ui/contributions` is what tells the client where a plugin view may
 * mount. It reads from `manager.list()`, which is typed `Promise<unknown>`, so the
 * response projection is a real trust boundary rather than a formality: the host routes
 * on `surfaces`, and an unrecognized name passed through here would end up in client
 * routing logic.
 *
 * Before the settings surface was wired, `surfaces` was dropped entirely by this route,
 * so a settings-only view was indistinguishable from a workspace one.
 */

const allowAuth: MiddlewareHandler = async (_c, next) => {
	await next();
};

function routes(listResult: unknown) {
	return createPluginUiRoutes({
		authMiddleware: allowAuth,
		pluginManager: { list: async () => listResult } as never,
	});
}

function pluginStatus(views: Array<Record<string, unknown>>, desiredState = "enabled") {
	return [
		{
			pluginId: "com.example.demo",
			desiredState,
			current: { version: "1.0.0", hash: "a".repeat(64) },
			contributions: views,
		},
	];
}

function view(overrides: Record<string, unknown> = {}) {
	return {
		kind: "view",
		id: "panel",
		title: "Panel",
		entry: "ui/panel.js",
		scope: "global",
		surfaces: ["workspace", "settings"],
		...overrides,
	};
}

async function fetchContributions(listResult: unknown) {
	const response = await routes(listResult).request("/ui/contributions");
	expect(response.status).toBe(200);
	return (await response.json()) as Array<Record<string, unknown>>;
}

describe("plugin UI contributions surfaces", () => {
	it("reports the declared surfaces so the client can filter per surface", async () => {
		const [item] = await fetchContributions(pluginStatus([view()]));
		expect(item.contributionId).toBe("panel");
		expect(item.surfaces).toEqual(["workspace", "settings"]);
		expect(item.scope).toBe("global");
	});

	/**
	 * `provider-settings` was missing from the allowlist, so a provider plugin's own
	 * credential UI could never mount: `PluginProviderSection` looks for exactly this
	 * value and silently fell back to the host's generated config form instead.
	 */
	it("reports provider-settings so a provider plugin's own UI can mount", async () => {
		const [item] = await fetchContributions(
			pluginStatus([view({ surfaces: ["provider-settings"] })]),
		);
		expect(item.surfaces).toEqual(["provider-settings"]);
	});

	it("keeps provider-settings alongside the other surfaces", async () => {
		const [item] = await fetchContributions(
			pluginStatus([view({ surfaces: ["provider-settings", "settings"] })]),
		);
		expect(item.surfaces).toEqual(["provider-settings", "settings"]);
	});

	it("drops surface names the host does not know", async () => {
		// `manager.list()` is untyped, so this projection cannot assume a validated shape.
		const [item] = await fetchContributions(
			pluginStatus([view({ surfaces: ["settings", "evil", "workspace"] })]),
		);
		expect(item.surfaces).toEqual(["settings", "workspace"]);
	});

	it("omits surfaces entirely when the field is not an array", async () => {
		for (const surfaces of [undefined, "settings", 42, null, {}]) {
			const [item] = await fetchContributions(pluginStatus([view({ surfaces })]));
			expect(item.surfaces).toBeUndefined();
		}
	});

	it("reports an empty array when every declared surface is unknown", async () => {
		const [item] = await fetchContributions(pluginStatus([view({ surfaces: ["nope"] })]));
		// Distinguishable from "not declared": the plugin said something, none of it usable.
		expect(item.surfaces).toEqual([]);
	});

	it("still marks a disabled plugin's view as disabled", async () => {
		const [item] = await fetchContributions(pluginStatus([view()], "disabled"));
		expect(item.status).toBe("disabled");
		// Surfaces are still reported so the client can show *why* the view is unavailable
		// instead of claiming the plugin contributes no settings view.
		expect(item.surfaces).toEqual(["workspace", "settings"]);
	});

	it("passes through the declared host runtime and drops unknown values", async () => {
		const [hosted] = await fetchContributions(pluginStatus([view({ runtime: "host-react" })]));
		expect(hosted.runtime).toBe("host-react");
		for (const runtime of ["custom", true, 1, {}]) {
			const [item] = await fetchContributions(pluginStatus([view({ runtime })]));
			expect(item.runtime).toBeUndefined();
		}
	});

	it("ignores non-view contributions", async () => {
		const items = await fetchContributions(
			pluginStatus([{ kind: "tool", id: "t", title: "Tool" }, view()]),
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.contributionId).toBe("panel");
	});
});
