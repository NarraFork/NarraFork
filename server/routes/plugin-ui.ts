import { db } from "@server/db";
import { AppError, formatZodError, ValidationError } from "@server/lib/errors";
import {
	type Capability,
	invocationScopeSchema,
	type PermissionGrant,
	permissionGrantSchema,
} from "@server/lib/plugins/permissions";
import { requireSessionAuth } from "@server/middleware/auth";
import {
	CapabilityBroker,
	capabilityBroker,
	type PluginCapabilityBindingInput,
} from "@server/services/plugin-capability-broker";
import { type PluginHealthRegistry, pluginHealthRegistry } from "@server/services/plugin-health";
import { pluginManager as defaultPluginManager } from "@server/services/plugin-manager";
import { pluginPlatformServices } from "@server/services/plugin-platform-services";
import {
	createCorePluginPublicApiAdapters,
	PluginPublicApi,
} from "@server/services/plugin-public-api";
import {
	pluginUiAssetService as defaultAssetService,
	type PluginUiAssetService,
} from "@server/services/plugin-ui-assets";
import { PluginUiHost } from "@server/services/plugin-ui-host";
import {
	pluginUiSessionService as defaultSessionService,
	type PluginUiSessionService,
} from "@server/services/plugin-ui-session";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod/v4";

interface PluginUiManagerLike {
	list?(): Promise<unknown>;
	getStatus(pluginId: string): Promise<
		| {
				desiredState?: string;
				compatibility?: string;
				current?: { version: string; hash: string } | null;
				trustTier?: "T0" | "T1" | "T2" | "T3";
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
	healthRegistry?: PluginHealthRegistry;
}

const sessionInputSchema = z
	.object({
		pluginId: z.string().min(3).max(128),
		version: z.string().min(1).max(256),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		contributionId: z.string().min(1).max(128),
		panelInstanceId: z.string().min(1).max(256),
		surface: z.enum(["workspace", "director", "focus", "settings"]),
		surfaceScope: z.enum(["workspace", "narrator", "project", "global"]),
		scope: invocationScopeSchema.optional(),
	})
	.strict();

function errorResponse(c: Parameters<MiddlewareHandler>[0], error: unknown): Response {
	const appError =
		error instanceof AppError
			? error
			: new AppError("Plugin UI request failed", 500, "PLUGIN_UI_FAILED");
	return c.json({ error: appError.message, code: appError.code }, appError.statusCode as never);
}

function sessionToken(c: Parameters<MiddlewareHandler>[0]): string {
	const header = c.req.header("X-NarraFork-Plugin-Session");
	const query = c.req.query("sessionToken");
	const value = header ?? query;
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

function createUiCapabilityBinding(
	status: NonNullable<Awaited<ReturnType<PluginUiManagerLike["getStatus"]>>>,
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
		trustTier: status.trustTier,
		manifestRequested: requested,
		installationGrants: permissions.grants,
		hostPolicy: effective,
		currentUserAuthority: effective,
		contributionPolicy: effective,
		runnerEnforcement: effective,
		...(permissions.revision > 0 ? { grantRevision: permissions.revision } : {}),
	};
}

function uiScopeResource(input: z.infer<typeof sessionInputSchema>) {
	switch (input.surfaceScope) {
		case "workspace":
			return input.scope?.workspaceId
				? { type: "workspace" as const, id: input.scope.workspaceId }
				: undefined;
		case "narrator":
			return input.scope?.narratorId
				? { type: "narrator" as const, id: input.scope.narratorId }
				: undefined;
		case "project":
			return input.scope?.projectId
				? { type: "project" as const, id: input.scope.projectId }
				: undefined;
		default:
			return undefined;
	}
}

async function assertUsableUiPanelGrant(
	status: NonNullable<Awaited<ReturnType<PluginUiManagerLike["getStatus"]>>>,
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
	const binding = createUiCapabilityBinding(status, permissions, principal, manifest);
	const broker = new CapabilityBroker({ bindings: [binding], cacheTtlMs: 0 });
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
	const decision = await broker.authorize({
		context,
		capability: "ui.panel",
		methodId: "ui.session.create",
		resource: uiScopeResource(input),
		constraints: { ratePerSecond: Number.MIN_VALUE, maxBytes: 1 },
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

function bindUiCapability(
	status: NonNullable<Awaited<ReturnType<PluginUiManagerLike["getStatus"]>>>,
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
	capabilityBroker.setBinding(
		session.pluginId,
		createUiCapabilityBinding(
			status,
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
	const publicApi = new PluginPublicApi({
		capabilityBroker: pluginPlatformServices.capabilityBroker,
		adapters: createCorePluginPublicApiAdapters({
			db,
			pluginManager: manager as unknown as Pick<
				typeof defaultPluginManager,
				"list" | "enable" | "disable"
			>,
		}),
	});
	const uiHost =
		options.uiHost ??
		new PluginUiHost({
			publicApi,
			capabilityBroker: pluginPlatformServices.capabilityBroker,
			eventGateway: pluginPlatformServices.eventGateway,
		});

	app.get("/ui/health", auth, (c) => c.json({ metrics: healthRegistry.metrics() }));

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
			const status = await assertEnabled(
				manager,
				body.data.pluginId,
				body.data.version,
				body.data.hash,
			);
			const permissions = await getUiPermissions(manager, body.data.pluginId);
			const pkg = await assets.inspectPackage(
				body.data.pluginId,
				body.data.version,
				body.data.hash,
			);
			const contribution = assertUiContribution(pkg.manifest, body.data);
			const user = c.get("user");
			const principalId = user.sub;
			await assertUsableUiPanelGrant(
				status,
				permissions,
				body.data,
				pkg.manifest,
				principalId,
				user.role,
			);
			const created = sessions.create({ ...body.data, principalId });
			bindUiCapability(status, permissions, created.session, pkg.manifest);
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
			const status = await assertEnabled(manager, session.pluginId, session.version, session.hash);
			const permissions = await getUiPermissions(manager, session.pluginId);
			const pkg = await assets.inspectPackage(session.pluginId, session.version, session.hash);
			assertUiContribution(pkg.manifest, session);
			bindUiCapability(status, permissions, session, pkg.manifest);
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
			const id = sessionId(c);
			const session = sessions.get(id);
			const revoked = sessions.revoke(id, c.get("user").sub);
			// Cascade: drop this panel instance's capability binding so a stale
			// per-session binding can never be resolved again.
			if (revoked && session) {
				capabilityBroker.clearBinding(session.pluginId, `ui:${session.sessionId}`);
			}
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

	return app;
}

export const pluginUiRoutes = createPluginUiRoutes();
