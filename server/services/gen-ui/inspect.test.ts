import { describe, expect, test } from "bun:test";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import { genUiParameters } from "@server/lib/agent/tools/gen-ui";
import type { ToolContext } from "@server/lib/agent/types";
import { isGenUiReadAction } from "@shared/gen-ui-tool-policy";
import type { WorkspaceContext } from "@shared/workspace-context";
import { workspaceKey } from "./files";
import { type InspectionDependencies, inspectGenUi } from "./inspect";
import { type InspectionToolRecord, inspectionTarget } from "./inspection-target";
import type { KitSnapshot } from "./kit";
import type { KitToolEnvironment } from "./kit-runtime";

const input = { action: "inspect" as const, toolUseId: "use", toolCallId: "call" };
function fixture() {
	const backend = new LocalBackend();
	const workspace: WorkspaceContext = {
		revision: 1,
		deviceId: "local",
		cwd: process.cwd(),
		pathFlavor: "posix",
		contextKey: "test",
		capabilities: { switchDirectory: true },
	};
	const controller = new AbortController();
	const env: KitToolEnvironment = {
		ctx: { narratorId: "n", userId: "u", signal: controller.signal } as ToolContext,
		backend,
		workspace,
		check: async () => {},
		authorizeRead: async () => {},
		authorizeWrite: async () => {},
	};
	const row: InspectionToolRecord = {
		id: "call",
		toolName: "GenUI",
		status: "success",
		inputJson: { action: "render", source: "<div>Hello</div>" },
		outputJson: { _metadata: { genUiInline: { version: 1 } } },
		executionDeviceId: "local",
		executionCwd: workspace.cwd,
	};
	let captures = 0;
	const deps: InspectionDependencies = {
		tool: async () => row,
		kit: async () =>
			({
				location: { root: workspace.cwd, kitDir: "", manifestPath: "", distDir: "", metaPath: "" },
				status: { state: "builtin", components: [] },
			}) satisfies KitSnapshot,
		kitBundle: async () => {
			throw new Error("not used");
		},
		builtin: async () => ({ runtimeJs: "runtime", runtimeCss: "" }),
		preview: async () => {
			throw new Error("not used");
		},
		capture: async () => {
			captures++;
			return { images: [{ format: "png", base64: "fixture" }], diagnostics: [], failed: false };
		},
	};
	return { env, row, deps, controller, captures: () => captures };
}

describe("GenUI inspection target and schema", () => {
	test("only bound IDs and bounded viewport are accepted; execution is not read-exempt", () => {
		expect(genUiParameters.safeParse(input).success).toBe(true);
		expect(isGenUiReadAction("inspect")).toBe(false);
		for (const invalid of [
			{ ...input, toolCallId: undefined },
			{ ...input, url: "http://localhost" },
			{ ...input, path: "/secret" },
			{ ...input, source: "<div/>" },
			{ ...input, width: 1601 },
			{ ...input, height: 1201 },
			{ ...input, width: 1 },
			{ ...input, width: 300.5 },
			{ action: "render", source: "<div/>", toolUseId: "use" },
		])
			expect(genUiParameters.safeParse(invalid).success).toBe(false);
	});
	test("rejects wrong identity, failed/incomplete calls and unbound legacy renders", () => {
		const { row } = fixture();
		for (const change of [
			{ id: "other" },
			{ toolName: "Bash" },
			{ status: "running" },
			{ status: "fail" },
			{ executionCwd: null },
			{ executionDeviceId: null },
			{ inputJson: { action: "create" } },
		])
			expect(() => inspectionTarget({ ...row, ...change }, "use", "call")).toThrow();
	});
	test("show references accept only trusted COW origin and rebind visible PK", () => {
		const { row, env } = fixture();
		row.inputJson = { action: "show" };
		row.outputJson = {
			_metadata: {
				genUi: {
					version: 1,
					toolUseId: "use",
					toolCallId: "origin",
					deviceId: "local",
					cwd: env.workspace.cwd,
					workspaceKey: workspaceKey(env.workspace),
					directory: `${env.workspace.cwd}/.narrafork/gen_ui/demo`,
					entry: "App.tsx",
					title: "demo",
				},
			},
		};
		expect(() => inspectionTarget(row, "use", "call")).toThrow();
		row.executionOriginToolCallId = "origin";
		const target = inspectionTarget(row, "use", "call");
		expect(target.mode).toBe("app");
		if (target.mode === "app") expect(target.reference.toolCallId).toBe("call");
		expect(() => inspectionTarget(row, "wrong-use", "call")).toThrow();
	});
});

describe("GenUI inspection orchestration", () => {
	test("returns images with explicit offline/current-state scope and snapshot identity", async () => {
		const f = fixture();
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBeUndefined();
		expect(result.images?.[0].format).toBe("png");
		expect(result.output).toBe("Preview captured (960×640, dark, offline replay).");
		expect(result.output).not.toContain("snapshotHash");
		expect(result.metadata?.genUiInspection).toMatchObject({
			version: 1,
			toolCallId: "call",
			viewport: { width: 960, height: 640 },
			snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(f.captures()).toBe(1);
	});
	test("offline resources produce a limited preview, not a rendering failure", async () => {
		const f = fixture();
		f.deps.capture = async () => ({
			images: [{ format: "png", base64: "fixture" }],
			diagnostics: ["External image blocked in offline preview"],
			failed: false,
			limited: true,
		});
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("Preview captured with offline resource limits");
		expect(result.output).not.toContain("runtime errors");
		expect(result.metadata?.genUiInspection).toMatchObject({ limited: true });
		expect(result.images).toHaveLength(1);
	});
	test("capture failure without an image is not described as an app error", async () => {
		const f = fixture();
		f.deps.capture = async () => ({
			images: [],
			diagnostics: ["Chrome is unavailable"],
			failed: true,
		});
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Preview capture failed");
		expect(result.output).not.toContain("runtime errors");
	});
	test("rejects remote or stale workspace render before runtime/code execution", async () => {
		for (const mutation of ["device", "cwd", "key"]) {
			const f = fixture();
			if (mutation === "device") f.row.executionDeviceId = "remote";
			if (mutation === "cwd") f.row.executionCwd = "/another";
			if (mutation === "key")
				f.row.outputJson = {
					_metadata: { genUiInline: { version: 1 }, genUiInspection: { workspaceKey: "stale" } },
				};
			expect((await inspectGenUi(input, f.env, f.deps)).isError).toBe(true);
			expect(f.captures()).toBe(0);
		}
	});
	test("visible-row authorization failure does not execute or release images", async () => {
		const f = fixture();
		f.deps.tool = async () => {
			throw new Error("not visible to narrator");
		};
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.output).toContain("not visible");
		expect(result.images).toBeUndefined();
		expect(f.captures()).toBe(0);
	});
	test("post-capture permission revocation discards images", async () => {
		const f = fixture();
		f.deps.capture = async () => {
			f.env.check = async () => {
				throw new Error("permission revoked");
			};
			return { images: [{ format: "png", base64: "secret" }], diagnostics: [], failed: false };
		};
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBe(true);
		expect(result.images).toBeUndefined();
		expect(result.output).toContain("permission revoked");
	});
	test("permission revoked during final row lookup blocks builtin markup with no files", async () => {
		const f = fixture();
		let calls = 0;
		f.deps.tool = async () => {
			if (++calls > 1)
				f.env.check = async () => {
					throw new Error("revoked during lookup");
				};
			return f.row;
		};
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBe(true);
		expect(result.images).toBeUndefined();
		expect(result.output).toContain("revoked during lookup");
	});
	test("target deleted during file reauthorization blocks result release", async () => {
		const f = fixture();
		let captured = false;
		const kit = f.deps.kit;
		f.deps.kit = async (backend, workspace, authorize, signal) => {
			await authorize(`${workspace.cwd}/kit.js`, signal);
			return kit(backend, workspace, authorize, signal);
		};
		f.deps.capture = async () => {
			captured = true;
			return { images: [{ format: "png", base64: "secret" }], diagnostics: [], failed: false };
		};
		f.env.authorizeRead = async () => {
			if (captured) f.row.status = "fail";
		};
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBe(true);
		expect(result.images).toBeUndefined();
	});
	test("a matching remote workspace cannot grant local browser execution", async () => {
		const f = fixture();
		f.env.workspace.deviceId = "remote";
		f.row.executionDeviceId = "remote";
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.output).toContain("server-local workspace");
		expect(result.images).toBeUndefined();
		expect(f.captures()).toBe(0);
	});
	test("target deleted after capture cannot release screenshot", async () => {
		const f = fixture();
		let calls = 0;
		f.deps.tool = async () => {
			if (++calls > 1) throw new Error("target deleted");
			return f.row;
		};
		expect((await inspectGenUi(input, f.env, f.deps)).images).toBeUndefined();
	});
	test("render failure still returns an error screenshot, never verification success", async () => {
		const f = fixture();
		f.deps.capture = async () => ({
			images: [{ format: "png", base64: "error" }],
			diagnostics: ["React failed"],
			failed: true,
		});
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("React failed");
		expect(result.images).toHaveLength(1);
	});
	test("abort ends inspection and a later call can proceed", async () => {
		const f = fixture();
		f.controller.abort(new Error("cancelled"));
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.isError).toBe(true);
		expect(f.captures()).toBe(0);
		const next = fixture();
		expect((await inspectGenUi(input, next.env, next.deps)).isError).toBeUndefined();
	});
	test("runtime unavailable reports phase without a success image", async () => {
		const f = fixture();
		f.deps.builtin = async () => {
			throw new Error("missing runtime assets");
		};
		const result = await inspectGenUi(input, f.env, f.deps);
		expect(result.output).toContain("during runtime");
		expect(result.images).toBeUndefined();
		expect(f.captures()).toBe(0);
	});
});
