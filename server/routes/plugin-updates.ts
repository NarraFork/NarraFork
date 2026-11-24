import { pluginSourceIdSchema, pluginSourceSchema } from "@shared/plugin-source";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AppError, NotFoundError, RateLimitError, ValidationError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { PluginSourceFailure } from "../services/plugin-source-resolvers";
import { type PluginSourceService, pluginSourceService } from "../services/plugin-source-service";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceBody = z
	.object({ source: pluginSourceSchema.nullable(), expectedRevision: revision })
	.strict();
const preferenceBody = z.object({ autoUpdate: z.boolean(), expectedRevision: revision }).strict();
const applyBody = z
	.object({
		candidateId: z.string().uuid(),
		expectedRevision: revision,
		allowTrustChange: z.boolean().optional(),
	})
	.strict();
const emptyBody = z.object({}).strict();
const jobId = z.string().uuid();

export interface PluginUpdateRouteOptions {
	service?: PluginSourceService;
	adminMiddleware?: MiddlewareHandler;
	enabled?: boolean;
}

/** Fixed routes mount before the dynamic pluginId router, behind first-party session auth. */
export function createPluginUpdateRoutes(options: PluginUpdateRouteOptions = {}): Hono {
	const app = new Hono();
	const service = options.service ?? pluginSourceService;
	const admin = options.adminMiddleware ?? requireAdmin;
	const boundedBody = bodyLimit({
		maxSize: 16 * 1024,
		onError: () => {
			throw new AppError("Plugin update request is too large", 413, "PLUGIN_UPDATE_BODY_TOO_LARGE");
		},
	});
	const updateBoundary: MiddlewareHandler = async (c, next) => {
		c.header("Cache-Control", "no-store");
		if (
			c.req.method !== "GET" &&
			!c.req.path.endsWith("/cancel") &&
			!(options.enabled ?? (await service.isEnabled()))
		)
			throw new AppError("Plugin system is disabled", 503, "PLUGINS_DISABLED");
		try {
			await next();
		} catch (error) {
			if (!(error instanceof PluginSourceFailure)) throw error;
			if (error.code === "rate_limited" || error.code === "queue_full") {
				const delay = error.retryAfterMs || 1_000;
				c.header("Retry-After", String(Math.ceil(delay / 1_000)));
				throw new RateLimitError(
					"PLUGIN_UPDATE_THROTTLED",
					delay,
					"Plugin update operation requested too frequently",
				);
			}
			const status = [
				"source_changed",
				"installation_changed",
				"identity_mismatch",
				"manual_required",
			].includes(error.code)
				? 409
				: error.code === "local_missing" || error.code === "no_source"
					? 404
					: error.code === "cancelled"
						? 503
						: 400;
			throw new AppError(
				"Plugin update operation failed",
				status,
				`PLUGIN_UPDATE_${error.code.toUpperCase()}`,
			);
		}
	};
	// Restrict middleware to this additive surface. A prefix-wide guard would
	// change permissions/body limits of the legacy plugin router mounted next.
	for (const path of [
		"/builtins",
		"/builtins/:pluginId/install",
		"/update-jobs/:jobId",
		"/update-jobs/:jobId/cancel",
		"/:pluginId/source",
		"/:pluginId/updates",
		"/:pluginId/updates/check",
		"/:pluginId/updates/apply",
		"/:pluginId/updates/preferences",
	]) {
		app.use(path, admin, boundedBody, updateBoundary);
	}
	const body = async (c: { req: { text(): Promise<string> } }) => {
		let text: string;
		try {
			text = await c.req.text();
		} catch (error) {
			if (error instanceof Error && error.name === "BodyLimitError")
				throw new AppError(
					"Plugin update request is too large",
					413,
					"PLUGIN_UPDATE_BODY_TOO_LARGE",
				);
			throw error;
		}
		try {
			return text ? JSON.parse(text) : {};
		} catch {
			throw new ValidationError("Invalid plugin update request");
		}
	};

	app.get("/builtins", async (c) => c.json({ builtins: await service.listBuiltins() }));
	app.post("/builtins/:pluginId/install", async (c) => {
		const id = pluginSourceIdSchema.parse(c.req.param("pluginId"));
		emptyBody.parse(await body(c));
		return c.json(await service.installBuiltin(id), 202);
	});
	app.get("/update-jobs/:jobId", (c) => {
		const id = jobId.parse(c.req.param("jobId"));
		const job = service.getJob(id);
		if (!job) throw new NotFoundError("Plugin update job", id);
		return c.json(job);
	});
	app.post("/update-jobs/:jobId/cancel", async (c) => {
		const id = jobId.parse(c.req.param("jobId"));
		emptyBody.parse(await body(c));
		const job = service.cancel(id);
		if (!job) throw new NotFoundError("Plugin update job", id);
		return c.json(job);
	});
	app.get("/:pluginId/source", async (c) =>
		c.json(await service.getSource(pluginSourceIdSchema.parse(c.req.param("pluginId")))),
	);
	app.put("/:pluginId/source", async (c) => {
		const id = pluginSourceIdSchema.parse(c.req.param("pluginId"));
		const input = sourceBody.parse(await body(c));
		return c.json(await service.setSource(id, input.source, input.expectedRevision));
	});
	app.get("/:pluginId/updates", async (c) =>
		c.json(await service.getUpdates(pluginSourceIdSchema.parse(c.req.param("pluginId")))),
	);
	app.post("/:pluginId/updates/check", async (c) => {
		const id = pluginSourceIdSchema.parse(c.req.param("pluginId"));
		emptyBody.parse(await body(c));
		return c.json(await service.check(id), 202);
	});
	app.post("/:pluginId/updates/apply", async (c) => {
		const id = pluginSourceIdSchema.parse(c.req.param("pluginId"));
		const input = applyBody.parse(await body(c));
		return c.json(
			await service.apply(id, input.candidateId, input.expectedRevision, {
				allowTrustChange: input.allowTrustChange,
			}),
			202,
		);
	});
	app.put("/:pluginId/updates/preferences", async (c) => {
		const id = pluginSourceIdSchema.parse(c.req.param("pluginId"));
		const input = preferenceBody.parse(await body(c));
		return c.json(await service.setAutoUpdate(id, input.autoUpdate, input.expectedRevision));
	});
	return app;
}

export const pluginUpdateRoutes = createPluginUpdateRoutes();
