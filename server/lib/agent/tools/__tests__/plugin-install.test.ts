import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionResult, ToolContext } from "../../types";
import { createPluginInstallTool } from "../plugin-install";

const TEST_RUN_ID = Date.now().toString(36);
let root: string;

function makeCtx(
	options: {
		userId?: string | null;
		permission?: PermissionResult;
		onPermission?: (input: Record<string, unknown>) => void;
	} = {},
): ToolContext {
	return {
		narratorId: "plugin-install-test",
		cwd: root,
		signal: new AbortController().signal,
		locale: "en",
		userId: options.userId ?? "admin-user",
		currentToolUseId: "tool-use-1",
		requestPermission: async (_toolName, input) => {
			options.onPermission?.(input);
			return options.permission ?? { behavior: "allow" };
		},
	};
}

function makeManager(installed: unknown[] = []) {
	const calls: Array<{ method: "install" | "enable"; value: string }> = [];
	return {
		calls,
		manager: {
			isEnabled: () => true,
			list: async () => installed,
			install: async (source: string | Uint8Array) => {
				calls.push({ method: "install", value: String(source) });
				return {
					pluginId: "com.example.demo",
					version: "0.2.0",
					status: "installed",
					path: source,
					stderr: "token=secret-value should not leak",
					manifest: { secret: "not returned" },
				};
			},
			enable: async (pluginId: string) => {
				calls.push({ method: "enable", value: pluginId });
				return { pluginId, desiredState: "enabled", runtimeState: "inactive" };
			},
		},
	};
}

beforeEach(() => {
	root = join(
		tmpdir(),
		`narrafork-plugin-install-tool-${TEST_RUN_ID}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "demo.nfplugin"), "plugin");
	writeFileSync(join(root, "demo.zip"), "zip");
	writeFileSync(join(root, "ignore.txt"), "nope");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("PluginInstall tool", () => {
	test("lists only installable package sources from the import root", async () => {
		const { manager } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
		});

		const result = await tool.execute({ action: "list_sources" }, makeCtx());

		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("demo.nfplugin");
		expect(result.output).toContain("demo.zip");
		expect(result.output).not.toContain("ignore.txt");
		expect(result.metadata).toMatchObject({ action: "list_sources", count: 2 });
	});

	test("rejects traversal, network paths, and unsupported extensions", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
		});

		for (const path of ["../evil.nfplugin", "//server/share/demo.nfplugin", "ignore.txt"]) {
			const result = await tool.execute({ action: "install", path }, makeCtx());
			expect(result.isError).toBe(true);
		}
		expect(calls).toHaveLength(0);
	});

	test("rejects non-admin users before requesting install permission", async () => {
		const { manager, calls } = makeManager();
		let permissionRequested = false;
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => false,
		});

		const result = await tool.execute(
			{ action: "install", path: "demo.nfplugin" },
			makeCtx({ onPermission: () => (permissionRequested = true) }),
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("administrator");
		expect(permissionRequested).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("does not install when the user denies permission", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
		});

		const result = await tool.execute(
			{ action: "install", path: "demo.nfplugin" },
			makeCtx({ permission: { behavior: "deny", message: "not now" } }),
		);

		expect(result.isError).toBe(true);
		expect(result.output).toBe("not now");
		expect(calls).toHaveLength(0);
	});

	test("installs a package for admin users after approval", async () => {
		const { manager, calls } = makeManager();
		let permissionInput: Record<string, unknown> | undefined;
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
		});

		const result = await tool.execute(
			{ action: "install", path: "demo.nfplugin" },
			makeCtx({ onPermission: (input) => (permissionInput = input) }),
		);

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([{ method: "install", value: join(root, "demo.nfplugin") }]);
		expect(permissionInput).toMatchObject({ action: "install", path: "demo.nfplugin" });
		expect(result.output).toContain("com.example.demo");
		expect(result.output).not.toContain("not returned");
		expect(result.output).not.toContain("secret-value");
	});

	test("installs then enables using the installed plugin id", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
		});

		const result = await tool.execute(
			{ action: "install_and_enable", path: "demo.zip" },
			makeCtx(),
		);

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual([
			{ method: "install", value: join(root, "demo.zip") },
			{ method: "enable", value: "com.example.demo" },
		]);
		expect(result.output).toContain("enabled");
	});

	// ─── URL install (online) ───

	const PACKAGE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
	const PUBLIC_IP_URL = "https://93.184.216.34/plugins/demo.nfplugin?token=secret-query";

	function okResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
		return new Response(Buffer.from(bytes), {
			status: 200,
			headers: { "content-length": String(bytes.byteLength), ...headers },
		});
	}

	test("installs a package downloaded from a public URL", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => okResponse(PACKAGE_BYTES),
		});
		let permissionInput: Record<string, unknown> | undefined;

		const result = await tool.execute(
			{ action: "install", url: PUBLIC_IP_URL },
			makeCtx({ onPermission: (input) => (permissionInput = input) }),
		);

		expect(result.isError).toBeFalsy();
		// manager.install received the downloaded bytes
		expect(calls[0]?.method).toBe("install");
		// Query string must not leak into permission input or output.
		expect(permissionInput?.url).toBe("https://93.184.216.34/plugins/demo.nfplugin");
		expect(permissionInput?.source).toBe("url");
		expect(JSON.stringify(result)).not.toContain("secret-query");
		expect(result.output).toContain("com.example.demo");
	});

	test("rejects private and loopback download URLs", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => okResponse(PACKAGE_BYTES),
		});

		for (const url of [
			"http://localhost/plugin.zip",
			"http://127.0.0.1/plugin.zip",
			"http://10.0.0.5/plugin.zip",
			"http://192.168.1.10/plugin.zip",
			"http://172.16.3.1/plugin.zip",
			"http://169.254.1.1/plugin.zip",
			"http://[::1]/plugin.zip",
			"http://0.0.0.0/plugin.zip",
		]) {
			const result = await tool.execute({ action: "install", url }, makeCtx());
			expect(result.isError).toBe(true);
			expect(result.output).toContain("not public");
			expect(calls).toHaveLength(0);
		}
	});

	test("rejects a hostname that resolves to a private address", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => okResponse(PACKAGE_BYTES),
			lookupImpl: async () => [{ address: "10.1.2.3", family: 4 }],
		});

		const result = await tool.execute(
			{ action: "install", url: "https://internal.example.com/plugin.zip" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("private address");
		expect(calls).toHaveLength(0);
	});

	test("rejects unsupported protocols and embedded credentials", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => okResponse(PACKAGE_BYTES),
		});

		for (const url of [
			"file:///C:/plugins/demo.zip",
			"ftp://example.com/demo.zip",
			"https://user:pass@93.184.216.34/demo.zip",
		]) {
			const result = await tool.execute({ action: "install", url }, makeCtx());
			expect(result.isError).toBe(true);
			expect(calls).toHaveLength(0);
		}
	});

	test("rejects redirects to a private address", async () => {
		const { manager, calls } = makeManager();
		let hop = 0;
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => {
				hop++;
				if (hop === 1) {
					return new Response(null, {
						status: 302,
						headers: { location: "http://127.0.0.1/evil.zip" },
					});
				}
				return okResponse(PACKAGE_BYTES);
			},
		});

		const result = await tool.execute({ action: "install", url: PUBLIC_IP_URL }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not public");
		expect(calls).toHaveLength(0);
	});

	test("rejects downloads that exceed the size limit", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () =>
				okResponse(PACKAGE_BYTES, { "content-length": String(64 * 1024 * 1024 + 1) }),
		});

		const result = await tool.execute({ action: "install", url: PUBLIC_IP_URL }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("MiB limit");
		expect(calls).toHaveLength(0);
	});

	test("rejects install requests that provide both path and url", async () => {
		const { manager, calls } = makeManager();
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => okResponse(PACKAGE_BYTES),
		});

		const result = await tool.execute(
			{ action: "install", path: "demo.zip", url: PUBLIC_IP_URL },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not both");
		expect(calls).toHaveLength(0);
	});

	// ─── list_installed / update semantics ───

	test("lists installed plugins without admin checks", async () => {
		const { manager } = makeManager([
			{
				pluginId: "com.example.demo",
				version: "0.1.0",
				status: "enabled",
				desiredState: "enabled",
				runtimeState: "running",
				displayName: "Demo",
				crashCount: 0,
			},
		]);
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => false,
		});

		const result = await tool.execute({ action: "list_installed" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("com.example.demo");
		expect(result.output).toContain("0.1.0");
		expect(result.metadata).toMatchObject({ action: "list_installed", count: 1 });
	});

	test("detects an upgrade when the same pluginId was already installed", async () => {
		const { manager, calls } = makeManager([
			{ pluginId: "com.example.demo", version: "0.1.0", status: "enabled" },
		]);
		const tool = createPluginInstallTool({
			manager,
			installRoots: [root],
			isAdminUser: () => true,
			fetchImpl: async () => okResponse(PACKAGE_BYTES),
		});

		const result = await tool.execute({ action: "install", url: PUBLIC_IP_URL }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.title).toBe("Plugin upgraded");
		expect(result.metadata).toMatchObject({
			upgraded: true,
			previousVersion: "0.1.0",
			installedVersion: "0.2.0",
		});
		expect(calls).toHaveLength(1);
	});
});
