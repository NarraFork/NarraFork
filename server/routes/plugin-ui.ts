import { AppError, formatZodError, NotFoundError, ValidationError } from "@server/lib/errors";
import {
	type Capability,
	invocationScopeSchema,
	type PermissionGrant,
	permissionGrantSchema,
} from "@server/lib/plugins/permissions";
import { requireSessionAuth } from "@server/middleware/auth";
import {
	CapabilityBroker,
	type PluginCapabilityBindingInput,
} from "@server/services/plugin-capability-broker";
import { type PluginHealthRegistry, pluginHealthRegistry } from "@server/services/plugin-health";
import { pluginManager as defaultPluginManager } from "@server/services/plugin-manager";
import { pluginPlatformServices } from "@server/services/plugin-platform-services";
import {
	pluginUiAssetService as defaultAssetService,
	type PluginUiAssetService,
} from "@server/services/plugin-ui-assets";
import { PLUGIN_UI_HOST_REQUEST_MAX_BYTES, PluginUiHost } from "@server/services/plugin-ui-host";
import {
	pluginUiSessionService as defaultSessionService,
	type PluginUiSessionService,
} from "@server/services/plugin-ui-session";
import { listEnabledThemes, setThemeEnabled } from "@server/services/user-plugin-theme-service";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";

interface PluginUiManagerLike {
	list?(): Promise<unknown>;
	getStatus(pluginId: string): Promise<
		| {
				desiredState?: string;
				compatibility?: string;
				current?: { version: string; hash: string } | null;
		  }
		| undefined
	>;
	getPermissions?(pluginId: string): Promise<{
		revision: number;
		grants: readonly unknown[];
	}>;
}

export interface PluginUiRouteOptions {
	authMiddleware?: MiddlewareHandler;
	assetService?: PluginUiAssetService;
	sessionService?: PluginUiSessionService;
	pluginManager?: PluginUiManagerLike;
	uiHost?: PluginUiHost;
	capabilityBroker?: CapabilityBroker;
	healthRegistry?: PluginHealthRegistry;
}

const PLUGIN_UI_ROUTE_REMOVAL_LISTENER = Symbol.for("narrafork.plugin-ui.route-session-removal");

const sessionInputSchema = z
	.object({
		pluginId: z.string().min(3).max(128),
		version: z.string().min(1).max(256),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		contributionId: z.string().min(1).max(128),
		panelInstanceId: z.string().min(1).max(256),
		surface: z.enum(["workspace", "director", "focus", "settings", "provider-settings"]),
		surfaceScope: z.enum(["workspace", "narrator", "project", "global"]),
		scope: invocationScopeSchema.optional(),
	})
	.strict();

const themeToggleSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Content types the unauthenticated theme-asset route may return. Kept in lockstep
 * with the manifest's background-image extension allowlist; SVG is excluded
 * because it can carry script.
 */
const THEME_ASSET_ALLOWED_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
]);

function errorResponse(c: Parameters<MiddlewareHandler>[0], error: unknown): Response {
	const appError =
		error instanceof AppError
			? error
			: new AppError("Plugin UI request failed", 500, "PLUGIN_UI_FAILED");
	return c.json({ error: appError.message, code: appError.code }, appError.statusCode as never);
}

function sessionToken(c: Parameters<MiddlewareHandler>[0]): string {
	const value = c.req.header("X-NarraFork-Plugin-Session");
	if (!value)
		throw new AppError("Plugin UI session token required", 401, "PLUGIN_UI_SESSION_REQUIRED");
	return value;
}

function sessionId(c: Parameters<MiddlewareHandler>[0]): string {
	const value = c.req.param("sessionId");
	if (!value) throw new ValidationError("Plugin UI sessionId is required");
	return value;
}

function encodeAssetPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

async function assertEnabled(
	manager: PluginUiManagerLike,
	pluginId: string,
	version: string,
	hash: string,
): Promise<NonNullable<Awaited<ReturnType<PluginUiManagerLike["getStatus"]>>>> {
	const status = await manager.getStatus(pluginId);
	if (!status) throw new AppError("Plugin not found", 404, "NOT_FOUND");
	if (status.desiredState !== "enabled" || status.compatibility !== "compatible") {
		throw new AppError("Plugin UI is disabled", 409, "PLUGIN_UI_DISABLED");
	}
	if (status.current?.version !== version || status.current.hash !== hash) {
		throw new AppError("Plugin UI package is not current", 409, "PLUGIN_UI_PACKAGE_NOT_CURRENT");
	}
	return status;
}

function permissionGrantFromDetails(value: unknown): PermissionGrant {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AppError(
			"Plugin permission details are unavailable",
			503,
			"PLUGIN_UI_PERMISSIONS_UNAVAILABLE",
		);
	}
	const source = value as Record<string, unknown>;
	const parsed = permissionGrantSchema.safeParse({
		capability: source.capability,
		scope: source.scope,
		...(source.constraints === undefined ? {} : { constraints: source.constraints }),
		...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt }),
		...(source.grantId === undefined ? {} : { grantId: source.grantId }),
		...(source.grantedBy === undefined ? {} : { grantedBy: source.grantedBy }),
	});
	if (!parsed.success) {
		throw new AppError(
			"Plugin permission details are unavailable",
			503,
			"PLUGIN_UI_PERMISSIONS_UNAVAILABLE",
		);
	}
	return parsed.data;
}

async function getUiPermissions(
	manager: PluginUiManagerLike,
	pluginId: string,
): Promise<{ revision: number; grants: PermissionGrant[] }> {
	if (!manager.getPermissions) {
		throw new AppError(
			"Plugin permission details are unavailable",
			503,
			"PLUGIN_UI_PERMISSIONS_UNAVAILABLE",
		);
	}
	let details: Awaited<ReturnType<NonNullable<PluginUiManagerLike["getPermissions"]>>>;
	try {
		details = await manager.getPermissions(pluginId);
	} catch {
		throw new AppError(
			"Plugin permission details are unavailable",
			503,
			"PLUGIN_UI_PERMISSIONS_UNAVAILABLE",
		);
	}
	if (
		!details ||
		!Number.isSafeInteger(details.revision) ||
		details.revision < 0 ||
		!Array.isArray(details.grants)
	) {
		throw new AppError(
			"Plugin permission details are unavailable",
			503,
			"PLUGIN_UI_PERMISSIONS_UNAVAILABLE",
		);
	}
	return {
		revision: details.revision,
		grants: details.grants.map(permissionGrantFromDetails),
	};
}

function assertSurfaceScope(
	input: Pick<z.infer<typeof sessionInputSchema>, "surfaceScope" | "scope">,
): void {
	const requiredScopeId = {
		workspace: "workspaceId",
		narrator: "narratorId",
		project: "projectId",
		global: undefined,
	} as const;
	const key = requiredScopeId[input.surfaceScope];
	if (key && !input.scope?.[key]) {
		throw new ValidationError(`Plugin UI ${input.surfaceScope} surface requires scope.${key}`);
	}
}

interface UiCapabilityPrincipalInput {
	pluginId: string;
	version: string;
	hash: string;
	contributionId: string;
	runtimeId: string;
	generation: number;
}

/**
 * Build the capability binding for one UI preflight.
 *
 * Takes no plugin status: the caller has already established that the plugin is installed,
 * enabled and compatible before reaching here, which is why the lifecycle fields below are
 * fixed rather than copied from a status record.
 */
function createUiCapabilityBinding(
	permissions: { revision: number; grants: PermissionGrant[] },
	principal: UiCapabilityPrincipalInput,
	manifest: { permissions?: { host?: string[] } },
): PluginCapabilityBindingInput {
	const requested = [...(manifest.permissions?.host ?? [])];
	const granted = new Set(permissions.grants.map((grant) => grant.capability));
	const effective = requested.filter((capability): capability is Capability =>
		granted.has(capability as Capability),
	);
	return {
		plugin: {
			pluginId: principal.pluginId,
			packageVersion: principal.version,
			runtimeId: principal.runtimeId,
			runtimeGeneration: principal.generation,
			contributionId: principal.contributionId,
			installationId: principal.hash,
		},
		desiredState: "enabled",
		compatibilityState: "compatible",
		runtimeState: "active",
		runtimeGeneration: principal.generation,
		manifestRequested: requested,
		installationGrants: permissions.grants,
		hostPolicy: effective,
		currentUserAuthority: effective,
		contributionPolicy: effective,
		runnerEnforcement: effective,
		...(permissions.revision > 0 ? { grantRevision: permissions.revision } : {}),
	};
}

function uiScopeResourceId(input: z.infer<typeof sessionInputSchema>): string | undefined {
	switch (input.surfaceScope) {
		case "workspace":
			return input.scope?.workspaceId;
		case "narrator":
			return input.scope?.narratorId;
		case "project":
			return input.scope?.projectId;
		default:
			return undefined;
	}
}

/**
 * Reject a UI session before it is created when the `ui.panel` grant does not cover it.
 *
 * Takes no plugin status: the caller has already run `assertEnabled`, and what is checked here
 * is the grant, not the lifecycle.
 */
async function assertUsableUiPanelGrant(
	permissions: { revision: number; grants: PermissionGrant[] },
	input: z.infer<typeof sessionInputSchema>,
	manifest: { permissions?: { host?: string[] } },
	principalId: string,
	userRole: "admin" | "user",
): Promise<void> {
	const principal: UiCapabilityPrincipalInput = {
		pluginId: input.pluginId,
		version: input.version,
		hash: input.hash,
		contributionId: input.contributionId,
		runtimeId: "ui:preflight",
		generation: 1,
	};
	const binding = createUiCapabilityBinding(permissions, principal, manifest);
	const broker = new CapabilityBroker({
		bindings: [binding],
		cacheTtlMs: 0,
		kernelEnforcement: true,
	});
	const context = broker.withCallContext({
		plugin: binding.plugin,
		invocation: {
			kind: "user",
			userId: principalId,
			userRole,
			source: "ui",
		},
		scope: { userId: principalId, ...(input.scope ?? {}) },
	});
	const resourceId = uiScopeResourceId(input);
	const decision = await broker.authorize({
		context,
		capability: "ui.panel",
		methodId: "ui.session.create",
		scope: input.scope,
		constraints: {
			...(resourceId ? { resourceIds: [resourceId] } : {}),
			ratePerSecond: Number.MIN_VALUE,
			maxBytes: 1,
		},
		requestBytes: 0,
		responseBytes: 0,
	});
	if (!decision.allowed) {
		throw new AppError(
			"Plugin UI capability is not granted for this scope",
			403,
			"PLUGIN_UI_PERMISSION_DENIED",
		);
	}
}

/**
 * Bind a UI session's capabilities on the broker.
 *
 * Takes no plugin status: every caller has already gone through `assertEnabled`, which is the
 * lifecycle gate. Passing the status record on would suggest this function re-checks it.
 */
function bindUiCapability(
	broker: CapabilityBroker,
	permissions: { revision: number; grants: PermissionGrant[] },
	session: {
		pluginId: string;
		version: string;
		hash: string;
		sessionId: string;
		generation: number;
		contributionId: string;
	},
	manifest: { permissions?: { host?: string[] } },
): void {
	broker.setBinding(
		session.pluginId,
		createUiCapabilityBinding(
			permissions,
			{
				pluginId: session.pluginId,
				version: session.version,
				hash: session.hash,
				contributionId: session.contributionId,
				runtimeId: `ui:${session.sessionId}`,
				generation: session.generation,
			},
			manifest,
		),
	);
}

function assertUiContribution(
	manifest: {
		permissions?: { host?: string[] };
		contributes?: {
			views?: Array<{
				id: string;
				entry: string;
				style?: string;
				surfaces: string[];
				scope: string;
			}>;
		};
	},
	input: z.infer<typeof sessionInputSchema>,
): { entryPath: string; stylePath?: string } {
	if (!manifest.permissions?.host?.includes("ui.panel")) {
		throw new AppError("Plugin UI capability is not granted", 403, "PLUGIN_UI_PERMISSION_DENIED");
	}
	const view = manifest.contributes?.views?.find(
		(candidate) => candidate.id === input.contributionId,
	);
	if (!view) throw new AppError("Plugin UI contribution not found", 404, "NOT_FOUND");
	if (view.scope !== input.surfaceScope || !view.surfaces.includes(input.surface)) {
		throw new AppError(
			"Plugin UI contribution is not available on this surface",
			403,
			"PLUGIN_UI_SCOPE_DENIED",
		);
	}
	return { entryPath: view.entry, ...(view.style ? { stylePath: view.style } : {}) };
}

export function createPluginUiRoutes(options: PluginUiRouteOptions = {}): Hono {
	const app = new Hono();
	const auth = options.authMiddleware ?? requireSessionAuth;
	const assets = options.assetService ?? defaultAssetService;
	const sessions = options.sessionService ?? defaultSessionService;
	const manager = options.pluginManager ?? defaultPluginManager;
	const healthRegistry = options.healthRegistry ?? pluginHealthRegistry;
	const broker = options.capabilityBroker ?? pluginPlatformServices.capabilityBroker;
	const uiHost =
		options.uiHost ??
		(sessions === pluginPlatformServices.uiSession &&
		broker === pluginPlatformServices.capabilityBroker
			? pluginPlatformServices.uiHost
			: new PluginUiHost({
					publicApi: pluginPlatformServices.publicApi,
					capabilityBroker: broker,
					eventGateway: pluginPlatformServices.eventGateway,
					storageFactory: pluginPlatformServices.storageFactory,
				}));
	const usesPlatformRemovalCascade =
		sessions === pluginPlatformServices.uiSession &&
		uiHost === pluginPlatformServices.uiHost &&
		broker === pluginPlatformServices.capabilityBroker;
	if (!usesPlatformRemovalCascade) {
		sessions.onRemoved((session, reason) => {
			uiHost.revokeSession(session.sessionId, reason);
			broker.clearBinding(session.pluginId, `ui:${session.sessionId}`);
		}, PLUGIN_UI_ROUTE_REMOVAL_LISTENER);
	}

	const payloadTooLarge = (c: Parameters<MiddlewareHandler>[0]) =>
		c.json(
			{
				error: "Plugin UI request exceeds the 256 KiB limit",
				code: "PAYLOAD_TOO_LARGE",
			},
			413,
		);
	app.use(
		"*",
		bodyLimit({
			maxSize: PLUGIN_UI_HOST_REQUEST_MAX_BYTES,
			onError: payloadTooLarge,
		}),
		async (c, next) => {
			if (!c.req.raw.body) return next();
			try {
				const body = await c.req.raw.clone().arrayBuffer();
				if (body.byteLength > PLUGIN_UI_HOST_REQUEST_MAX_BYTES) return payloadTooLarge(c);
			} catch {
				return payloadTooLarge(c);
			}
			return next();
		},
	);

	app.get("/ui/health", auth, (c) => c.json({ metrics: healthRegistry.metrics() }));

	// Theme contributions differ from views: they carry compiled, sanitized CSS
	// (built once at catalog-refresh time) instead of an iframe asset, and they
	// override host-document CSS variables rather than rendering in a sandbox.
	// `ui.theme` is NOT a high-risk capability — theme tokens are zero-JS,
	// strictly validated CSS-variable overrides. So the gate is not a capability
	// grant; it is per-user enablement: the plugin package is installed globally
	// but each user chooses which themes apply to *their* session.

	/** Collect all enabled theme-only theme contributions across installed plugins. */
	const collectThemeContributions = async (): Promise<
		Array<{
			pluginId: string;
			version: string;
			hash: string;
			themeId: string;
			title: string;
			colorScheme: "light" | "dark" | "both";
			css: string;
		}>
	> => {
		const listed = manager.list ? await manager.list() : [];
		const out: Array<{
			pluginId: string;
			version: string;
			hash: string;
			themeId: string;
			title: string;
			colorScheme: "light" | "dark" | "both";
			css: string;
		}> = [];
		if (!Array.isArray(listed)) return out;
		const MAX_THEMES = 200;
		for (const item of listed) {
			if (out.length >= MAX_THEMES) break;
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const status = item as Record<string, unknown>;
			const pluginId = typeof status.pluginId === "string" ? status.pluginId : undefined;
			const current =
				status.current && typeof status.current === "object" && !Array.isArray(status.current)
					? (status.current as Record<string, unknown>)
					: undefined;
			if (
				!pluginId ||
				status.desiredState !== "enabled" ||
				!current ||
				typeof current.version !== "string" ||
				typeof current.hash !== "string"
			)
				continue;
			const contributions = Array.isArray(status.contributions) ? status.contributions : [];
			for (const entry of contributions) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const contribution = entry as Record<string, unknown>;
				if (contribution.kind !== "theme" || typeof contribution.id !== "string") continue;
				if (typeof contribution.themeCss !== "string" || contribution.themeCss.length === 0)
					continue;
				const colorScheme = contribution.colorScheme;
				out.push({
					pluginId,
					version: current.version as string,
					hash: current.hash as string,
					themeId: contribution.id,
					title: typeof contribution.title === "string" ? contribution.title : contribution.id,
					colorScheme:
						colorScheme === "light" || colorScheme === "dark" || colorScheme === "both"
							? colorScheme
							: "both",
					css: contribution.themeCss,
				});
				if (out.length >= MAX_THEMES) break;
			}
		}
		return out;
	};

	// Per-user: compiled CSS only for themes THIS user has enabled. Used by the
	// theme injector to build the pre-injected <style> element.
	app.get("/ui/themes", auth, async (c) => {
		try {
			const userId = c.get("user").sub;
			const [all, enabled] = await Promise.all([
				collectThemeContributions(),
				listEnabledThemes(userId),
			]);
			const enabledSet = new Set(enabled.map((e) => `${e.pluginId}\u0000${e.themeId}`));
			const themes = all.filter((t) => enabledSet.has(`${t.pluginId}\u0000${t.themeId}`));
			return c.json(themes.slice(0, 200));
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// Per-user: catalog of all available theme-only themes (metadata + whether
	// this user has enabled each), so the settings UI can offer them. Includes
	// the compiled CSS so a freshly-enabled theme applies without a second fetch.
	app.get("/ui/themes/available", auth, async (c) => {
		try {
			const userId = c.get("user").sub;
			const [all, enabled] = await Promise.all([
				collectThemeContributions(),
				listEnabledThemes(userId),
			]);
			const enabledSet = new Set(enabled.map((e) => `${e.pluginId}\u0000${e.themeId}`));
			const themes = all
				.slice(0, 200)
				.map((t) => ({ ...t, enabled: enabledSet.has(`${t.pluginId}\u0000${t.themeId}`) }));
			return c.json(themes);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// Per-user enable/disable of a theme. Login-only (no admin, no grant): a user
	// only toggles visibility of an already-installed theme for themselves.
	app.put("/ui/themes/:pluginId/:themeId", auth, async (c) => {
		try {
			const userId = c.get("user").sub;
			const pluginId = c.req.param("pluginId");
			const themeId = c.req.param("themeId");
			const body = themeToggleSchema.safeParse(await c.req.json().catch(() => undefined));
			if (!body.success) throw new ValidationError(formatZodError(body.error));
			// Guard: only allow toggling a theme that actually exists as a theme-only
			// contribution on an enabled plugin. Prevents rows for arbitrary ids.
			if (body.data.enabled) {
				const all = await collectThemeContributions();
				const exists = all.some((t) => t.pluginId === pluginId && t.themeId === themeId);
				if (!exists) throw new AppError("Theme not found", 404, "PLUGIN_THEME_NOT_FOUND");
			}
			const enabled = await setThemeEnabled(userId, pluginId, themeId, body.data.enabled);
			return c.json({ pluginId, themeId, enabled });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/ui/contributions", auth, async (c) => {
		try {
			const listed = manager.list ? await manager.list() : [];
			const contributions: Array<Record<string, unknown>> = [];
			if (Array.isArray(listed)) {
				for (const item of listed) {
					if (!item || typeof item !== "object" || Array.isArray(item)) continue;
					const status = item as Record<string, unknown>;
					const pluginId = typeof status.pluginId === "string" ? status.pluginId : undefined;
					const current =
						status.current && typeof status.current === "object" && !Array.isArray(status.current)
							? (status.current as Record<string, unknown>)
							: undefined;
					if (
						!pluginId ||
						!current ||
						typeof current.version !== "string" ||
						typeof current.hash !== "string"
					)
						continue;
					const views = Array.isArray(status.contributions) ? status.contributions : [];
					for (const view of views) {
						if (!view || typeof view !== "object" || Array.isArray(view)) continue;
						const contribution = view as Record<string, unknown>;
						if (contribution.kind !== "view" || typeof contribution.id !== "string") continue;
						contributions.push({
							pluginId,
							version: current.version,
							hash: current.hash,
							contributionId: contribution.id,
							title: typeof contribution.title === "string" ? contribution.title : contribution.id,
							entryPath:
								typeof contribution.entryPath === "string"
									? contribution.entryPath
									: typeof contribution.entry === "string"
										? contribution.entry
										: undefined,
							stylePath:
								typeof contribution.stylePath === "string"
									? contribution.stylePath
									: typeof contribution.style === "string"
										? contribution.style
										: undefined,
							scope: typeof contribution.scope === "string" ? contribution.scope : undefined,
							// Bounded to the known surface names so a hostile manifest cannot inflate
							// the response or smuggle arbitrary strings into host routing logic.
							surfaces: Array.isArray(contribution.surfaces)
								? contribution.surfaces.filter(
										(surface): surface is string =>
											surface === "workspace" ||
											surface === "director" ||
											surface === "focus" ||
											surface === "settings",
									)
								: undefined,
							status: status.desiredState === "enabled" ? "available" : "disabled",
						});
					}
				}
			}
			return c.json(contributions.slice(0, 200));
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.post("/ui/sessions", auth, async (c) => {
		try {
			const body = sessionInputSchema.safeParse(await c.req.json().catch(() => undefined));
			if (!body.success) throw new ValidationError(formatZodError(body.error));
			assertSurfaceScope(body.data);
			// Called for its lifecycle gate, not its value: a session must not be created for a
			// plugin that is disabled, uninstalled or superseded.
			await assertEnabled(manager, body.data.pluginId, body.data.version, body.data.hash);
			const permissions = await getUiPermissions(manager, body.data.pluginId);
			const pkg = await assets.inspectPackage(
				body.data.pluginId,
				body.data.version,
				body.data.hash,
			);
			const contribution = assertUiContribution(pkg.manifest, body.data);
			const user = c.get("user");
			const principalId = user.sub;
			await assertUsableUiPanelGrant(permissions, body.data, pkg.manifest, principalId, user.role);
			const created = sessions.create({ ...body.data, principalId });
			try {
				bindUiCapability(broker, permissions, created.session, pkg.manifest);
			} catch (error) {
				sessions.remove(created.session.sessionId, "capability-binding-failed");
				throw error;
			}
			const prefix = `/api/plugins/ui/${encodeURIComponent(body.data.pluginId)}/${encodeURIComponent(body.data.version)}/${encodeURIComponent(body.data.hash)}`;
			const assetPrefix = `${prefix}/asset/${encodeURIComponent(created.session.sessionId)}/${encodeURIComponent(created.assetToken)}`;
			return c.json({
				session: created.session,
				sessionToken: created.sessionToken,
				assetToken: created.assetToken,
				shellUrl: `${prefix}/shell/${encodeURIComponent(created.session.sessionId)}/${encodeURIComponent(created.assetToken)}`,
				entryUrl: `${assetPrefix}/${encodeAssetPath(contribution.entryPath)}`,
				styleUrl: contribution.stylePath
					? `${assetPrefix}/${encodeAssetPath(contribution.stylePath)}`
					: undefined,
				bootstrapUrl: `/api/plugins/ui/sessions/${encodeURIComponent(created.session.sessionId)}/bootstrap`,
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/ui/sessions/:sessionId/bootstrap", auth, async (c) => {
		try {
			const id = sessionId(c);
			const session = sessions.authenticate(id, sessionToken(c), c.get("user").sub);
			return c.json({
				type: "narrafork:ui-connect",
				nonce: session.connectNonce,
				protocol: "narrafork.ui/1",
				hostProtocolRange: { min: 1, max: 1 },
				pluginId: session.pluginId,
				contributionId: session.contributionId,
				panelInstanceId: session.panelInstanceId,
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.post("/ui/sessions/:sessionId/request", auth, async (c) => {
		try {
			const id = sessionId(c);
			const token = sessionToken(c);
			const user = c.get("user");
			const session = sessions.authenticate(id, token, user.sub);
			assertSurfaceScope(session);
			// Called for its lifecycle gate, not its value: an existing session must not keep
			// dispatching after the plugin is disabled, uninstalled or superseded.
			await assertEnabled(manager, session.pluginId, session.version, session.hash);
			const permissions = await getUiPermissions(manager, session.pluginId);
			const pkg = await assets.inspectPackage(session.pluginId, session.version, session.hash);
			assertUiContribution(pkg.manifest, session);
			bindUiCapability(broker, permissions, session, pkg.manifest);
			const response = await uiHost.dispatch({
				session,
				principalId: user.sub,
				userRole: user.role,
				request: (await c.req.json().catch(() => undefined)) as never,
				signal: c.req.raw.signal,
			});
			return c.json(response);
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.delete("/ui/sessions/:sessionId", auth, async (c) => {
		try {
			const revoked = sessions.revoke(sessionId(c), c.get("user").sub);
			return c.json({ revoked });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/ui/:pluginId/:version/:hash/shell/:sessionId/:assetToken", async (c) => {
		try {
			const pluginId = c.req.param("pluginId");
			const version = c.req.param("version");
			const hash = c.req.param("hash");
			const session = sessions.authenticateAssetCapability(
				sessionId(c),
				c.req.param("assetToken"),
				{
					pluginId,
					version,
					hash,
				},
			);
			await assertEnabled(manager, pluginId, version, hash);
			const html = await assets.shell(
				pluginId,
				version,
				hash,
				session.sessionId,
				c.req.param("assetToken"),
				session.contributionId,
			);
			const assetOrigin = new URL(c.req.url).origin;
			return new Response(html, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src ${assetOrigin}; style-src ${assetOrigin} 'unsafe-inline'; img-src ${assetOrigin} data: blob:; font-src ${assetOrigin}; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; media-src 'none'`,
				},
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/ui/:pluginId/:version/:hash/asset/:sessionId/:assetToken/:assetPath{.+}", async (c) => {
		try {
			const pluginId = c.req.param("pluginId");
			const version = c.req.param("version");
			const hash = c.req.param("hash");
			sessions.authenticateAssetCapability(sessionId(c), c.req.param("assetToken"), {
				pluginId,
				version,
				hash,
			});
			await assertEnabled(manager, pluginId, version, hash);
			const asset = await assets.readAsset(pluginId, version, hash, c.req.param("assetPath"));
			return new Response(Buffer.from(asset.bytes), {
				headers: {
					"Content-Type": asset.contentType,
					"Cache-Control": "private, no-store",
					ETag: `"${hash}-${asset.path}"`,
					"X-Content-Type-Options": "nosniff",
					"Cross-Origin-Resource-Policy": "cross-origin",
				},
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	// Theme background asset. Unlike the view asset route this is NOT bound to a UI
	// session (theme-only plugins have none): the capability is the exact package
	// hash (content-bound sha256) plus the plugin being enabled + current, and
	// readAsset only serves paths a theme contribution explicitly declared. No
	// auth middleware, because CSS `url()` requests from the host document carry
	// no Authorization header. The image is same-origin and contains no user data.
	app.get("/ui/:pluginId/:version/:hash/theme-asset/:assetPath{.+}", async (c) => {
		try {
			const pluginId = c.req.param("pluginId");
			const version = c.req.param("version");
			const hash = c.req.param("hash");
			await assertEnabled(manager, pluginId, version, hash);
			const asset = await assets.readAsset(pluginId, version, hash, c.req.param("assetPath"));
			// This route is unauthenticated (CSS `url()` carries no Authorization
			// header) and same-origin, so the served Content-Type must never be an
			// active type: an `.html`/`.js`/`.svg` "background" would otherwise be
			// same-origin script delivery. The manifest schema already restricts
			// backgrounds to raster images; re-assert it here (defense in depth) so a
			// schema regression cannot reopen the hole.
			if (!THEME_ASSET_ALLOWED_CONTENT_TYPES.has(asset.contentType)) {
				throw new NotFoundError("Plugin theme asset", asset.path);
			}
			return new Response(Buffer.from(asset.bytes), {
				headers: {
					"Content-Type": asset.contentType,
					"Cache-Control": "private, max-age=86400, immutable",
					ETag: `"${hash}-${asset.path}"`,
					"X-Content-Type-Options": "nosniff",
					"Cross-Origin-Resource-Policy": "same-origin",
					// Belt-and-braces for direct navigation: render inline as an image
					// and forbid every subresource/script in that document.
					"Content-Disposition": "inline",
					"Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
				},
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	return app;
}

export const pluginUiRoutes = createPluginUiRoutes();
