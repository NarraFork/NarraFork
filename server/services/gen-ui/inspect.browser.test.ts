import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import type { ToolContext } from "@server/lib/agent/types";
import type { WorkspaceContext } from "@shared/workspace-context";
import { workspaceKey } from "./files";
import { type InspectionDependencies, inspectGenUi } from "./inspect";
import type { InspectionToolRecord } from "./inspection-target";
import type { KitSnapshot } from "./kit";
import type { KitToolEnvironment } from "./kit-runtime";
import { buildGenUiPreview } from "./preview";

// Deliberately opt-in: this suite needs built host runtime assets and sandbox-enabled Chrome.
// GEN_UI_INSPECT_BROWSER_TEST=1 bun test --isolate server/services/gen-ui/inspect.browser.test.ts
const browserTest = process.env.GEN_UI_INSPECT_BROWSER_TEST === "1" ? describe : describe.skip;
browserTest("GenUI real-browser independent replay", () => {
	let root = "";
	let env: KitToolEnvironment;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "nf-inspect-browser-"));
		await mkdir(join(root, ".narrafork/gen_ui/demo"), { recursive: true });
		const backend = new LocalBackend();
		const workspace: WorkspaceContext = {
			revision: 1,
			deviceId: "local",
			cwd: root,
			pathFlavor: "posix",
			contextKey: "browser-test",
			capabilities: { switchDirectory: true },
		};
		env = {
			ctx: { narratorId: "n", userId: "u", signal: new AbortController().signal } as ToolContext,
			backend,
			workspace,
			check: async () => {},
			authorizeRead: async () => {},
			authorizeWrite: async () => {},
		};
	});
	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});
	function dependencies(row: InspectionToolRecord): Partial<InspectionDependencies> {
		return {
			tool: async () => row,
			kit: async () =>
				({
					location: { root, kitDir: "", manifestPath: "", distDir: "", metaPath: "" },
					status: { state: "builtin", components: [] },
				}) satisfies KitSnapshot,
			preview: async (narratorId, userId, reference, signal) =>
				buildGenUiPreview(narratorId, userId, reference, signal, {
					workspace: async () => env.workspace,
					backend: () => env.backend,
					authorize: async (_n, _u, _d, path) => path,
					kit: async () => null,
				}),
		};
	}
	function verifyPng(images: { base64: string }[] | undefined) {
		expect(images).toHaveLength(1);
		const png = Buffer.from(images?.[0].base64 ?? "", "base64");
		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(png.readUInt32BE(16)).toBe(640);
		expect(png.readUInt32BE(20)).toBe(480);
	}
	test("render returns a real Mantine screenshot without a frontend session", async () => {
		const row: InspectionToolRecord = {
			id: "render-call",
			toolName: "GenUI",
			status: "success",
			inputJson: {
				action: "render",
				source: "<Stack><Title order={3}>Visual inspection</Title><Button>Ready</Button></Stack>",
			},
			outputJson: { _metadata: { genUiInline: { version: 1 } } },
			executionDeviceId: "local",
			executionCwd: root,
		};
		const result = await inspectGenUi(
			{ action: "inspect", toolUseId: "render-use", toolCallId: row.id, width: 640, height: 480 },
			env,
			dependencies(row),
		);
		expect(result.output).not.toContain("failed during");
		expect(result.isError).toBeUndefined();
		verifyPng(result.images);
	}, 40_000);
	test("show reports compilation error, then a corrected React app produces a new snapshot", async () => {
		const directory = join(root, ".narrafork/gen_ui/demo");
		const app = join(directory, "App.tsx");
		const row: InspectionToolRecord = {
			id: "show-call",
			toolName: "GenUI",
			status: "success",
			inputJson: { action: "show" },
			outputJson: {
				_metadata: {
					genUi: {
						version: 1,
						toolUseId: "show-use",
						toolCallId: "show-call",
						deviceId: "local",
						cwd: root,
						workspaceKey: workspaceKey(env.workspace),
						directory,
						entry: "App.tsx",
						title: "demo",
					},
				},
			},
		};
		const input = {
			action: "inspect" as const,
			toolUseId: "show-use",
			toolCallId: row.id,
			width: 640,
			height: 480,
		};
		await writeFile(app, "export default function App( {");
		const broken = await inspectGenUi(input, env, dependencies(row));
		expect(broken.isError).toBe(true);
		expect(broken.output).toContain("during compile");
		expect(broken.images).toBeUndefined();
		await writeFile(
			app,
			'import {Card,Text} from "@mantine/core"; export default function App(){return <Card><Text>Repaired preview</Text></Card>}',
		);
		const repaired = await inspectGenUi(input, env, dependencies(row));
		expect(repaired.output).not.toContain("failed during");
		expect(repaired.isError).toBeUndefined();
		verifyPng(repaired.images);
		await writeFile(app, 'export default function App(){throw new Error("runtime smoke error")}');
		const runtimeError = await inspectGenUi(input, env, dependencies(row));
		expect(runtimeError.isError).toBe(true);
		expect(runtimeError.output).toContain("runtime smoke error");
		verifyPng(runtimeError.images);
	}, 90_000);
});
