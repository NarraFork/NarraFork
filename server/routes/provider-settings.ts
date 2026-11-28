import { AppError } from "@server/lib/errors";
import {
	providerSettingsAddressParamsSchema,
	providerSettingsDeleteSchema,
	providerSettingsRebindSchema,
	providerSettingsRetainedQuerySchema,
	providerSettingsTargetQuerySchema,
} from "@server/lib/validators/provider-settings";
import { requireAdmin } from "@server/middleware/auth";
import { pluginPlatformServices } from "@server/services/plugin-platform-services";
import type { ProviderSettingsService } from "@server/services/provider-settings-service";
import { providerSettingsFieldVisibility } from "@shared/provider-settings";
import { PROVIDER_SETTINGS_VALUE_LIMITS } from "@shared/provider-settings-values";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

export function createProviderSettingsRoutes(
	service: Pick<
		ProviderSettingsService,
		"list" | "save" | "remove" | "action" | "rebind" | "retained"
	>,
	initialize: () => Promise<unknown>,
) {
	const routes = new Hono();
	const target = (c: Context) => {
		const parsed = providerSettingsTargetQuerySchema.safeParse(c.req.query());
		if (!parsed.success)
			throw new AppError("Invalid saved provider target", 400, "PROVIDER_SETTINGS_INVALID_TARGET");
		return parsed.data;
	};
	const address = (c: Context) => {
		const parsed = providerSettingsAddressParamsSchema.safeParse(c.req.param());
		if (!parsed.success)
			throw new AppError(
				"Invalid provider settings contribution",
				400,
				"PROVIDER_SETTINGS_INVALID_CONTRIBUTION",
			);
		return parsed.data;
	};
	const json = async (c: Context) => {
		try {
			return await c.req.json();
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			throw new AppError(
				"Invalid provider settings request",
				400,
				"PROVIDER_SETTINGS_INVALID_REQUEST",
			);
		}
	};
	routes.get("/", async (c) => {
		const { kind, id } = target(c);
		await initialize();
		const entries = await service.list(kind, id);
		if (c.get("user")?.role === "admin" && !c.get("oauth")) return c.json({ extensions: entries });
		// Ordinary provider viewers receive only public summaries. No host-only values,
		// secret presence or connection policy is returned through this projection.
		return c.json({
			extensions: entries.map((entry) => ({
				pluginId: entry.pluginId,
				contributionId: entry.contributionId,
				title: entry.declaration?.title,
				unavailable: entry.unavailable ?? false,
				...(entry.config
					? {
							config: {
								revision: entry.config.revision,
								status: entry.config.status,
								values: Object.fromEntries(
									Object.entries(entry.config.values).filter(([key]) => {
										const field = entry.declaration?.configSchema.properties[key];
										return field && providerSettingsFieldVisibility(field) === "public";
									}),
								),
							},
						}
					: {}),
			})),
		});
	});
	routes.use("/:pluginId/:contributionId/*", requireAdmin);
	routes.use("/:pluginId/:contributionId", requireAdmin);
	routes.use(
		"/*",
		bodyLimit({
			maxSize: PROVIDER_SETTINGS_VALUE_LIMITS.requestBytes,
			onError: (c) => c.json({ code: "PROVIDER_SETTINGS_REQUEST_TOO_LARGE" }, 413),
		}),
	);
	routes.put("/:pluginId/:contributionId", async (c) => {
		const { kind, id } = target(c),
			{ pluginId, contributionId } = address(c),
			input = await json(c);
		await initialize();
		return c.json(await service.save(pluginId, contributionId, kind, id, input, c.req.raw.signal));
	});
	routes.delete("/:pluginId/:contributionId", async (c) => {
		const { kind, id } = target(c),
			{ pluginId, contributionId } = address(c);
		const input = providerSettingsDeleteSchema.safeParse(await json(c));
		if (!input.success)
			throw new AppError(
				"Invalid provider settings revision",
				400,
				"PROVIDER_SETTINGS_INVALID_REQUEST",
			);
		await initialize();
		await service.remove(
			pluginId,
			contributionId,
			kind,
			id,
			input.data.expectedRevision,
			c.req.raw.signal,
		);
		return c.json({ ok: true });
	});
	routes.get("/:pluginId/:contributionId/retained", async (c) => {
		const { pluginId, contributionId } = address(c);
		const query = providerSettingsRetainedQuerySchema.safeParse(c.req.query());
		if (!query.success)
			throw new AppError(
				"Invalid retained settings cursor",
				400,
				"PROVIDER_SETTINGS_INVALID_REQUEST",
			);
		await initialize();
		return c.json(
			await service.retained(
				pluginId,
				contributionId,
				query.data.kind,
				query.data.id,
				query.data.cursor,
			),
		);
	});
	routes.post("/:pluginId/:contributionId/rebind", async (c) => {
		const { kind, id } = target(c),
			{ pluginId, contributionId } = address(c),
			input = providerSettingsRebindSchema.safeParse(await json(c));
		if (!input.success)
			throw new AppError(
				"Invalid provider settings confirmation",
				400,
				"PROVIDER_SETTINGS_INVALID_REQUEST",
			);
		await initialize();
		return c.json(
			await service.rebind(pluginId, contributionId, kind, id, input.data, c.req.raw.signal),
		);
	});
	routes.post("/:pluginId/:contributionId/action", async (c) => {
		const { kind, id } = target(c),
			{ pluginId, contributionId } = address(c);
		await initialize();
		return c.json(
			await service.action(pluginId, contributionId, kind, id, c.get("user").sub, c.req.raw.signal),
		);
	});
	return routes;
}
export const providerSettingsRoutes = createProviderSettingsRoutes(
	pluginPlatformServices.providerSettingsService,
	async () => {
		/* Startup owns catalog initialization; opening this route never activates plugins. */
	},
);
