import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createPluginRoutes, type PluginManager } from "../../../server/routes/plugins";
import type { PluginPermissionRequest } from "../../../server/services/plugin-permission-store";

const allowAdmin: MiddlewareHandler = async (_c, next) => {
	await next();
};

const denyAdmin: MiddlewareHandler = async (c) => c.json({ error: "forbidden" }, 403);

class PendingPermissionManager implements PluginManager {
	readonly calls: Array<{ method: string; value: unknown }> = [];
	requests: PluginPermissionRequest[] = [
		{
			requestId: "req-1",
			capability: "query.read.projects",
			scope: { type: "global" },
			requestedByRuntimeId: "rt_1",
			requestedAt: "2026-07-18T00:00:00.000Z",
			status: "pending",
		},
	];
	denyResult = true;
	approveMutation: unknown = {
		status: { pluginId: "com.example.demo", desiredState: "enabled" },
		permissions: {
			pluginId: "com.example.demo",
			installationId: "installation-1",
			revision: 4,
			grants: [
				{
					pluginId: "com.example.demo",
					installationId: "installation-1",
					grantId: "grant-1",
					capability: "query.read.projects",
					scope: { type: "global" },
					grantedBy: "admin-user-1",
					revision: 4,
				},
			],
		},
	};

	list(): unknown {
		return { generatedAt: "2026-07-18T00:00:00.000Z", plugins: [] };
	}

	getStatus(pluginId: string): unknown {
		return { pluginId, status: "compatible", version: "1.0.0" };
	}

	getDiagnostics(): unknown {
		return { pluginId: "com.example.demo", status: "active" };
	}

	getPermissions(): unknown {
		return { pluginId: "com.example.demo", installationId: "installation-1", revision: 3, grants: [] };
	}

	replacePermissions(): unknown {
		return { status: { pluginId: "com.example.demo", desiredState: "enabled" }, permissions: { grants: [] } };
	}

	revokePermissions(): unknown {
		return { status: { pluginId: "com.example.demo", desiredState: "enabled" }, permissions: { grants: [] } };
	}

	async install(): Promise<unknown> {
		return { pluginId: "com.example.demo", status: "installed" };
	}

	async enable(pluginId: string): Promise<unknown> {
		return { desiredState: "enabled", pluginId };
	}

	async disable(pluginId: string): Promise<unknown> {
		return { desiredState: "disabled", pluginId };
	}

	async activate(pluginId: string): Promise<unknown> {
		return { runtimeState: "active", pluginId };
	}

	async uninstall(pluginId: string): Promise<unknown> {
		return { desiredState: "uninstalling", pluginId };
	}

	listPendingPermissionRequests(pluginId: string): Promise<PluginPermissionRequest[]> {
		this.calls.push({ method: "listPendingPermissionRequests", value: pluginId });
		return Promise.resolve(this.requests);
	}

	async approvePermissionRequest(pluginId: string, requestId: string, grantedBy: unknown): Promise<unknown> {
		this.calls.push({ method: "approvePermissionRequest", value: { pluginId, requestId, grantedBy } });
		return this.approveMutation;
	}

	async denyPermissionRequest(pluginId: string, requestId: string): Promise<boolean> {
		this.calls.push({ method: "denyPermissionRequest", value: { pluginId, requestId } });
		return this.denyResult;
	}
}

function createApp(manager: PluginManager, adminMiddleware = allowAdmin) {
	return createPluginRoutes(manager, {
		enabled: true,
		adminMiddleware,
		installRoots: ["/safe/plugin-imports"],
		authMiddleware: allowAdmin,
	});
}

describe("plugin permission request routes", () => {
	it("lists pending permission requests without leaking runtime internals", async () => {
		const manager = new PendingPermissionManager();
		const app = createApp(manager);
		const response = await app.request("/com.example.demo/grants/pending");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { requests: unknown[] };
		expect(body.requests).toEqual(manager.requests);
		expect(manager.calls).toEqual([
			{ method: "listPendingPermissionRequests", value: "com.example.demo" },
		]);
	});

	it("approves a pending request and returns the grant mutation", async () => {
		const manager = new PendingPermissionManager();
		const app = createApp(manager);
		const response = await app.request("/com.example.demo/grants/requests/req-1/approve", {
			method: "POST",
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: { desiredState: string } };
		expect(body.status.desiredState).toBe("enabled");
		const call = manager.calls.at(-1) as { method: string; value: { requestId: string; grantedBy: unknown } };
		expect(call.method).toBe("approvePermissionRequest");
		expect(call.value.requestId).toBe("req-1");
		expect(call.value.grantedBy).toBe("admin");
	});

	it("denies a pending request", async () => {
		const manager = new PendingPermissionManager();
		const app = createApp(manager);
		const response = await app.request("/com.example.demo/grants/requests/req-1/deny", {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ denied: true });
		expect(manager.calls).toEqual([
			{ method: "denyPermissionRequest", value: { pluginId: "com.example.demo", requestId: "req-1" } },
		]);
	});

	it("returns 404 when the deny mutation reports the request is gone", async () => {
		const manager = new PendingPermissionManager();
		manager.denyResult = false;
		const app = createApp(manager);
		const response = await app.request("/com.example.demo/grants/requests/req-1/deny", {
			method: "POST",
		});
		expect(response.status).toBe(404);
	});

	it("rejects malformed request ids with 400", async () => {
		const app = createApp(new PendingPermissionManager());
		for (const requestId of ["   ", "x".repeat(257)]) {
			const response = await app.request(
				`/com.example.demo/grants/requests/${requestId}/approve`,
				{ method: "POST" },
			);
			expect(response.status).toBe(400);
		}
	});

	it("blocks non-admins with 403", async () => {
		const app = createApp(new PendingPermissionManager(), denyAdmin);
		const response = await app.request("/com.example.demo/grants/pending");
		expect(response.status).toBe(403);
	});
});
