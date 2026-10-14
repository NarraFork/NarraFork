import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { safeParseManifest } from "../../../../server/lib/plugins/manifest";
import { PluginPackageStore } from "../../../../server/services/plugin-package-store";

const packageRoot = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"));
const entry = readFileSync(join(packageRoot, "ui/panel.iife.js"), "utf8");

type CommandCall = { commandId: string; input: unknown };
class TestElement {
	children: TestElement[] = [];
	textContent = "";
	className = "";
	id = "";
	type = "";
	value = "";
	placeholder = "";
	maxLength = 0;
	rows = 0;
	disabled = false;
	dataset: Record<string, string> = {};
	attributes: Record<string, string> = {};
	listeners = new Map<string, () => unknown>();
	appendChild(child: TestElement) {
		this.children.push(child);
		return child;
	}
	setAttribute(name: string, value: string) {
		this.attributes[name] = value;
	}
	addEventListener(event: string, handler: () => unknown) {
		this.listeners.set(event, handler);
	}
	replaceChildren(...children: TestElement[]) {
		this.children = [...children];
	}
	click() {
		if (!this.disabled) this.listeners.get("click")?.();
	}
	byClass(name: string): TestElement {
		if (this.className.split(" ").includes(name)) return this;
		for (const child of this.children) {
			try {
				return child.byClass(name);
			} catch {
				/* Search the next sibling. */
			}
		}
		throw new Error(`Missing element: ${name}`);
	}
}
const binding = {
	stewardNarratorId: "narrator-current",
	boundAt: "2026-01-01T00:00:00Z",
	revision: 1,
};
function mount(
	options: {
		narratorId?: string | null;
		recipientRows?: Array<{ id: string; title?: string; handle?: string }>;
		result?: unknown;
		command?: (call: CommandCall) => Promise<unknown>;
		noSdk?: boolean;
		contextError?: boolean;
	} = {},
) {
	const root = new TestElement();
	const calls: CommandCall[] = [];
	const sdk = {
		getContext: async () => {
			if (options.contextError) throw new Error("会话已失效");
			const id = options.narratorId === undefined ? "narrator-current" : options.narratorId;
			return id ? { narrator: { id } } : {};
		},
		commands: {
			execute: async (commandId: string, input: unknown) => {
				const call = { commandId, input };
				calls.push(call);
				if (commandId === "steward.recipients")
					return { output: { items: options.recipientRows ?? [] } };
				return options.command
					? options.command(call)
					: options.result === undefined
						? binding
						: options.result;
			},
		},
	};
	runInNewContext(entry, {
		document: { body: root, getElementById: () => root, createElement: () => new TestElement() },
		narrafork: options.noSdk ? undefined : sdk,
		Error,
		Date,
		Number,
		String,
	});
	return { root, calls, get: (name: string) => root.byClass(name) };
}
async function settle() {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("steward-narrator manifest and package", () => {
	test("passes the authoritative manifest schema with server/ui contributions", () => {
		const parsed = safeParseManifest(manifest);
		if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
		expect(parsed.data.pluginId).toBe("steward-narrator");
		expect(parsed.data.server?.entry).toBe("server/index.js");
		expect(parsed.data.engine.features).toEqual(["host_api.requests"]);
		expect(parsed.data.contributes.tools).toHaveLength(1);
		expect(parsed.data.contributes.tools[0].execution).toBe("server");
		expect(parsed.data.contributes.tools[0].id).toBe("steward.send");
		expect(parsed.data.contributes.tools[0].allowBackground).toBe(false);
		expect(
			parsed.data.contributes.commands.map((command) => [command.id, command.handler]),
		).toEqual([
			["steward.bind", "server"],
			["steward.binding", "server"],
			["steward.recipients", "host"],
			["steward.panelSend", "host"],
		]);
		expect(parsed.data.permissions.host).toEqual([
			"ui.panel",
			"storage.read_self",
			"storage.write_self",
			"command.narrator.send_message",
		]);
		expect(parsed.data.contributes.views[0]).toMatchObject({
			id: "steward-panel",
			scope: "narrator",
			instance: "singleton-per-narrator",
			defaultPosition: "side",
		});
	});

	test("contribution input cannot choose an identity or perform extra actions", () => {
		const schema = manifest.contributes.tools[0].inputSchema;
		expect(Object.keys(schema.properties)).toEqual(["targetNarratorId", "message"]);
		expect(schema.required).toEqual(["targetNarratorId", "message"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.message.maxLength).toBe(16000);
		for (const command of manifest.contributes.commands.slice(0, 2)) {
			expect(command.inputSchema.properties).toEqual({});
			expect(command.inputSchema.additionalProperties).toBe(false);
		}
		expect(manifest.contributes.commands[2].inputSchema.properties).toHaveProperty("cursor");
		expect(manifest.contributes.commands[3].inputSchema.required).toEqual([
			"targetNarratorId",
			"message",
		]);
		expect(manifest.contributes.commands[3].inputSchema.additionalProperties).toBe(false);
		expect(entry).not.toMatch(
			/storage\.(set|get)|queries\.execute|fetch\(|XMLHttpRequest|innerHTML|eval\(|new Function/,
		);
		const css = readFileSync(join(packageRoot, "ui/panel.css"), "utf8");
		expect(css).toContain("--nf-color-body");
		expect(css).not.toMatch(/@import|https?:|url\(/);
		expect(manifest.permissions.network.mode).toBe("none");
		expect(manifest.permissions.process.spawn).toBe("none");
	});

	test("fixed plugin package installs with approved source and content hashes", async () => {
		const archive = join(packageRoot, "steward-narrator-0.2.0.nfplugin");
		const sourceHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
		expect(sourceHash).toBe("06242b7dcbb549afe0bf8e18598b22cd08cd43ccde61cc949f919173fae136d8");
		const storeRoot = mkdtempSync(join(tmpdir(), "steward-narrator-install-"));
		try {
			const installed = await new PluginPackageStore(storeRoot).install(archive);
			expect(installed.pluginId).toBe("steward-narrator");
			expect(installed.version).toBe("0.2.0");
			expect(installed.hash).toBe(
				"4bff64215cc7f1a971a2f5cbd1a0f275b3415b7fb3173e8ce9283819b43c3657",
			);
			for (const name of [
				"manifest.json",
				"package.json",
				"sbom.spdx.json",
				"server/index.js",
				"ui/panel.css",
				"ui/panel.iife.js",
			]) {
				expect(readFileSync(join(installed.packagePath, name))).toEqual(
					readFileSync(join(packageRoot, name)),
				);
			}
		} finally {
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	test("npm pack contains exactly the installable server/ui assets", () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "steward-narrator-pack-"));
		try {
			const result = spawnSync(
				"npm",
				["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", outputDirectory],
				{
					cwd: packageRoot,
					encoding: "utf8",
					shell: process.platform === "win32",
					timeout: 30_000,
				},
			);
			if (result.status !== 0) throw new Error(result.stderr || String(result.error));
			const packed = JSON.parse(result.stdout)[0];
				expect(packed.files.map((file: { path: string }) => file.path).sort()).toEqual([
					"manifest.json",
					"package.json",
					"sbom.spdx.json",
					"server/index.js",
					"ui/panel.css",
					"ui/panel.iife.js",
				]);
			const archive = spawnSync("tar", ["-tzf", packed.filename], {
				cwd: outputDirectory,
				encoding: "utf8",
			});
			expect(archive.status).toBe(0);
				expect(archive.stdout.trim().split(/\r?\n/).sort()).toEqual([
					"package/manifest.json",
					"package/package.json",
					"package/sbom.spdx.json",
					"package/server/index.js",
					"package/ui/panel.css",
					"package/ui/panel.iife.js",
				]);
			const packedManifest = spawnSync("tar", ["-xOzf", packed.filename, "package/manifest.json"], {
				cwd: outputDirectory,
				encoding: "utf8",
			});
			expect(packedManifest.status).toBe(0);
			expect(safeParseManifest(JSON.parse(packedManifest.stdout)).success).toBe(true);
		} finally {
			rmSync(outputDirectory, { recursive: true, force: true });
		}
	}, 45_000);
});

describe("steward binding panel", () => {
	for (const result of [
		binding,
		{ binding },
		{ status: "succeeded", output: binding },
		{ status: "succeeded", output: { binding } },
	]) {
		test(`renders supported binding envelope ${JSON.stringify(result)}`, async () => {
			const ui = mount({ result });
			await settle();
			expect(ui.get("steward-binding-id").textContent).toBe(binding.stewardNarratorId);
			expect(ui.get("steward-status").textContent).toBe("当前叙述者已绑定");
			expect(ui.get("steward-button-primary").disabled).toBe(false);
		});
	}

	test("reads an unbound state and binds only the current host-scoped narrator", async () => {
		const ui = mount({
			command: async ({ commandId }) =>
				commandId.endsWith(".binding") ? { binding: null } : { output: { binding } },
		});
		await settle();
		expect(ui.get("steward-status").textContent).toBe("未绑定");
		ui.get("steward-button-primary").click();
		ui.get("steward-button-primary").click();
		expect(ui.get("steward-button-primary").disabled).toBe(true);
		await settle();
		expect(ui.calls.filter((call) => call.commandId !== "steward.recipients")).toEqual([
			{ commandId: "steward.binding", input: {} },
			{ commandId: "steward.bind", input: {} },
		]);
		expect(ui.get("steward-feedback").textContent).toBe("绑定已更新。");
	});

	test("panel sends only the selected ACL-visible recipient through the host command", async () => {
		const ui = mount({ recipientRows: [{ id: "visible-target", title: "可见叙述者" }] });
		await settle();
		const recipient = ui.get("steward-recipient");
		recipient.value = "visible-target";
		recipient.listeners.get("change")?.();
		const message = ui.get("steward-message");
		message.value = "请继续上次的工作";
		ui.get("steward-send").click();
		await settle();
		expect(ui.calls[ui.calls.length - 1]).toEqual({
			commandId: "steward.panelSend",
			input: { targetNarratorId: "visible-target", message: "请继续上次的工作" },
		});
		expect(ui.get("steward-feedback").textContent).toBe("消息已由宿主安全发送。");
	});

	test("refresh uses the read command and shows another narrator without selecting it", async () => {
		const ui = mount({ result: { ...binding, stewardNarratorId: "another-narrator" } });
		await settle();
		expect(ui.get("steward-status").textContent).toBe("已绑定其他叙述者");
		ui.get("steward-button-secondary").click();
		await settle();
		expect(ui.calls.filter((call) => call.commandId !== "steward.recipients").map((call) => call.commandId)).toEqual(["steward.binding", "steward.binding"]);
	});

	test("host command failure is visible and recovers with refresh without retrying bind", async () => {
		const ui = mount({
			command: async ({ commandId }) => {
				if (commandId.endsWith(".bind")) throw new Error("当前用户无访问权限");
				return binding;
			},
		});
		await settle();
		ui.get("steward-button-primary").click();
		await settle();
		expect(ui.get("steward-status").textContent).toBe("更新失败");
		expect(ui.get("steward-feedback").textContent).toContain("当前用户无访问权限");
		expect(ui.get("steward-button-secondary").disabled).toBe(false);
		ui.get("steward-button-secondary").click();
		await settle();
		expect(ui.get("steward-status").textContent).toBe("当前叙述者已绑定");
		expect(ui.calls.filter((call) => call.commandId.endsWith(".bind"))).toHaveLength(1);
	});

	for (const result of [
		{},
		{ status: "failed", error: { message: "拒绝访问" } },
		{ binding: { ...binding, revision: "1" } },
	]) {
		test(`does not mistake malformed or failed results for an unbound state ${JSON.stringify(result)}`, async () => {
			const ui = mount({ result });
			await settle();
			expect(ui.get("steward-status").textContent).toBe("更新失败");
			expect(ui.get("steward-feedback").dataset.state).toBe("error");
		});
	}

	test("a panel without narrator scope cannot invoke bind", async () => {
		const ui = mount({ narratorId: null, result: null });
		await settle();
		expect(ui.get("steward-button-primary").disabled).toBe(true);
		ui.get("steward-button-primary").click();
		await settle();
		expect(ui.calls.map((call) => call.commandId)).toEqual([
			"steward.binding",
			"steward.recipients",
		]);
	});

	test("expired context sends no command and exposes recovery", async () => {
		const ui = mount({ contextError: true });
		await settle();
		expect(ui.calls).toEqual([]);
		expect(ui.get("steward-feedback").textContent).toContain("会话已失效");
		expect(ui.get("steward-button-secondary").disabled).toBe(false);
	});

	test("host-returned markup stays literal text", async () => {
		const maliciousId = '<img src=x onerror="alert(1)">';
		const ui = mount({ result: { ...binding, stewardNarratorId: maliciousId } });
		await settle();
		expect(ui.get("steward-binding-id").textContent).toBe(maliciousId);
		expect(ui.get("steward-binding-id").children).toHaveLength(0);
	});

	test("running outside the authenticated host does not send commands", () => {
		const ui = mount({ noSdk: true });
		expect(ui.get("steward-status").textContent).toBe("不可用");
		expect(ui.get("steward-button-primary").disabled).toBe(true);
		expect(ui.calls).toEqual([]);
	});
});
