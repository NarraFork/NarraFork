import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import { intelligentUiParameters } from "@server/lib/agent/tools/intelligent-ui";
import type { ToolContext } from "@server/lib/agent/types";
import { readIntelligentUiKitNotice } from "@shared/intelligent-ui-kit";
import type { WorkspaceContext } from "@shared/workspace-context";
import {
	approveKitRequest,
	dismissKitRequest,
	getKitRequest,
	resetKitRequestsForTest,
} from "./kit-requests";
import { executeKitAction, type KitToolEnvironment } from "./kit-runtime";
import { resetKitSigningKeyForTest } from "./kit-signature";

const KIT = ".narrafork/intelligent_ui/kit";
const roots: string[] = [];
beforeEach(() => resetKitRequestsForTest());
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Builds are signed with a key in the NarraFork home: keep it out of the developer's.
const savedHome = process.env.NARRAFORK_HOME;
let signingHome = "";
beforeAll(async () => {
	signingHome = await mkdtemp(join(tmpdir(), "nf-ui-kit-tool-home-"));
	process.env.NARRAFORK_HOME = signingHome;
	resetKitSigningKeyForTest();
});
afterAll(async () => {
	if (savedHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = savedHome;
	resetKitSigningKeyForTest();
	await rm(signingHome, { recursive: true, force: true });
});

async function fixture(files: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), "nf-ui-kit-tool-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	const backend = new LocalBackend();
	const workspace: WorkspaceContext = {
		revision: 1,
		deviceId: "local",
		cwd: root,
		pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
		contextKey: "workspace",
		capabilities: { switchDirectory: true },
	};
	const writes: string[] = [];
	const env: KitToolEnvironment = {
		ctx: { narratorId: "n", signal: new AbortController().signal } as ToolContext,
		backend,
		workspace,
		check: async () => {},
		authorizeRead: async () => {},
		authorizeWrite: async (path) => {
			writes.push(path);
		},
	};
	return { root, env, writes };
}
const notice = (result: { metadata?: Record<string, unknown> }) =>
	readIntelligentUiKitNotice(result.metadata?.intelligentUiKit);
/** The workspace-relative bundle path a failed build says it did not produce. */
function bundlePath(output: string): string {
	const match = /dist\/kit-[0-9a-f]{12}\.js/.exec(output);
	if (!match) throw new Error(`no bundle path in: ${output.slice(0, 200)}`);
	return `${KIT}/${match[0]}`;
}
/** Stands in for Vite: counts its runs and writes `js` (unless null) while running. */
function vite(js: string | null) {
	const runs: string[] = [];
	const runCommand: NonNullable<KitToolEnvironment["runCommand"]> = async ({ bundlePath }) => {
		runs.push(bundlePath);
		await mkdir(dirname(bundlePath), { recursive: true });
		if (js !== null) await writeFile(bundlePath, js);
		return { code: 0, log: "" };
	};
	return { runs, runCommand };
}
/** Ask, confirm as the user, and complete a build whose output the stand-in writes. */
async function buildWithApproval(env: KitToolEnvironment) {
	const asked = await executeKitAction({ action: "kit_build" }, env);
	approveKitRequest("n", notice(asked)?.request?.id as string);
	const built = await executeKitAction(
		{ action: "kit_build" },
		{ ...env, runCommand: vite("1").runCommand },
	);
	if (built.isError) throw new Error(built.output);
}
const KIT_JSON = JSON.stringify({ version: 1, components: [{ name: "Pill", from: "./Pill" }] });

describe("IntelligentUI tool schema", () => {
	test("each action accepts exactly its own fields", () => {
		const ok = [
			{ action: "render", source: "<Stack />" },
			{ action: "render", title: "Plans", size: "lg", source: "<Stack />" },
			{ action: "kit_status" },
			{ action: "kit_build" },
			{ action: "kit_build", skip_build: true },
			{ action: "create", prefix: "demo" },
			{ action: "show", path: "x" },
		];
		for (const input of ok) expect(intelligentUiParameters.safeParse(input).success).toBe(true);
		const bad = [
			{ action: "render" },
			{ action: "render", source: "<a/>", path: "x" },
			{ action: "render", source: "<a/>", size: "xl" },
			{ action: "kit_status", source: "<a/>" },
			{ action: "kit_build", prefix: "x" },
			{ action: "create", prefix: "demo", source: "<a/>" },
			{ action: "show", path: "x", title: "t" },
			{ action: "render", source: "x".repeat(12_001) },
			{ action: "build" },
		];
		for (const input of bad) expect(intelligentUiParameters.safeParse(input).success).toBe(false);
	});

	test("source is declared last so the fields that size the card stream first", () => {
		const keys = Object.keys(intelligentUiParameters.shape);
		expect(keys.at(-1)).toBe("source");
		expect(keys.indexOf("size")).toBeLessThan(keys.indexOf("source"));
		expect(keys.indexOf("title")).toBeLessThan(keys.indexOf("source"));
	});
});

describe("render", () => {
	test("accepts built-in components and HTML, and reports which kit drew it", async () => {
		const { env } = await fixture();
		const result = await executeKitAction(
			{
				action: "render",
				title: "Plans",
				source: '<Stack gap="sm"><Title order={4}>Plans</Title><p>ok</p><Tabs.List /></Stack>',
			},
			env,
		);
		expect(result.isError).toBeFalsy();
		expect(result.title).toBe("Plans");
		expect(result.output).toContain("built-in Mantine component kit (4 elements)");
		expect(result.metadata?.intelligentUiInline).toEqual({ version: 1, kit: "builtin" });
		// Not a frontend project (no package.json): the user is not nagged about a kit.
		expect(notice(result)).toEqual({ state: "builtin" });
	});

	test("unknown tags draw nothing and tell the model what exists", async () => {
		const { env } = await fixture();
		const result = await executeKitAction(
			{ action: "render", source: "<Stack><AcmeWidget /><script>x</script></Stack>" },
			env,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("<AcmeWidget>");
		expect(result.output).toContain("<script>");
		expect(result.output).toContain("Stack");
		expect(result.metadata).toBeUndefined();
	});

	test("markup with nothing renderable is rejected", async () => {
		const { env } = await fixture();
		for (const source of ["   ", "just some prose", "<Stack"])
			await expect(executeKitAction({ action: "render", source }, env)).rejects.toThrow(
				"no elements to render",
			);
	});

	test("a frontend project without a kit is asked once, not under every render", async () => {
		const { env } = await fixture({ "package.json": "{}" });
		const first = await executeKitAction({ action: "render", source: "<Stack />" }, env);
		const second = await executeKitAction({ action: "render", source: "<Group />" }, env);
		// The prompt is on the first card only; the request itself stays open.
		expect(notice(first)?.request).toMatchObject({ kind: "build", state: "pending" });
		expect(notice(second)).toEqual({ state: "builtin" });
		expect(getKitRequest("n", "workspace")?.id).toBe(notice(first)?.request?.id as string);
		// The agent is still told, every time, not to build on its own.
		for (const result of [first, second])
			expect(result.output).toContain("Do not build until they confirm");
		// Once the user confirms, the next result carries the approval for the agent.
		approveKitRequest("n", notice(first)?.request?.id as string);
		const third = await executeKitAction({ action: "render", source: "<Group />" }, env);
		expect(notice(third)?.request).toMatchObject({ state: "approved" });
		expect(third.output).toContain("has approved a kit build");
	});

	test("a declined prompt stays declined for passive suggestions", async () => {
		const { env } = await fixture({ "package.json": "{}" });
		const first = await executeKitAction({ action: "render", source: "<Stack />" }, env);
		dismissKitRequest("n", notice(first)?.request?.id as string);
		const later = await executeKitAction({ action: "render", source: "<Stack />" }, env);
		expect(notice(later)).toEqual({ state: "builtin" });
		expect(later.output).not.toContain("Do not build until they confirm");
	});

	test("a built project kit replaces the built-in component set", async () => {
		const { env } = await fixture({ [`${KIT}/kit.json`]: KIT_JSON });
		await buildWithApproval(env);
		const own = await executeKitAction({ action: "render", source: "<Pill>new</Pill>" }, env);
		expect(own.isError).toBeFalsy();
		expect(own.metadata?.intelligentUiInline).toEqual({ version: 1, kit: "project" });
		// Mantine is no longer what this workspace renders with.
		const foreign = await executeKitAction({ action: "render", source: "<Stack />" }, env);
		expect(foreign.isError).toBe(true);
		expect(foreign.output).toContain("project kit provides: Pill");
	});
});

describe("kit_build confirmation", () => {
	test("without the user's confirmation nothing is generated or run", async () => {
		const { env, root, writes } = await fixture({ [`${KIT}/kit.json`]: KIT_JSON });
		const result = await executeKitAction({ action: "kit_build" }, env);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("waiting for the user's confirmation");
		expect(notice(result)?.request).toMatchObject({ kind: "build", state: "pending" });
		expect(writes).toEqual([]);
		expect(existsSync(join(root, KIT, "entry.generated.ts"))).toBe(false);
		// Calling again does not stack requests or slip through.
		const again = await executeKitAction({ action: "kit_build" }, env);
		expect(notice(again)?.request?.id).toBe(notice(result)?.request?.id as string);
		expect(writes).toEqual([]);
	});

	test("after confirmation it builds once; a failure keeps the approval, a success spends it", async () => {
		const { env, root } = await fixture({ [`${KIT}/kit.json`]: KIT_JSON });
		// skip_build still parses, and before approval it only asks, as any kit_build does.
		const asked = await executeKitAction({ action: "kit_build", skip_build: true }, env);
		expect(asked.isError).toBeFalsy();
		expect(asked.output).toContain("waiting for the user's confirmation");
		approveKitRequest("n", notice(asked)?.request?.id as string);
		// The build writes nothing: it fails, and the agent may retry without re-asking.
		const empty = vite(null);
		const failed = await executeKitAction(
			{ action: "kit_build" },
			{ ...env, runCommand: empty.runCommand },
		);
		expect(empty.runs).toHaveLength(1);
		expect(failed.isError).toBe(true);
		expect(failed.output).toContain("approval still stands");
		// No route to a bundle the agent built itself is offered.
		expect(failed.output).not.toContain("skip_build");
		expect(getKitRequest("n", "workspace")?.state).toBe("approved");

		// The agent puts a bundle where the build writes and asks for it to be recorded.
		const planted = join(root, bundlePath(failed.output));
		await writeFile(planted, "globalThis.__nfKit = { planted: true };");
		const spy = vite("never");
		const refused = await executeKitAction(
			{ action: "kit_build", skip_build: true },
			{ ...env, runCommand: spy.runCommand },
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("without skip_build");
		expect(refused.output).toContain("signs the result");
		expect(spy.runs).toEqual([]);
		expect(getKitRequest("n", "workspace")?.state).toBe("approved");
		expect(existsSync(join(root, KIT, "dist/kit.meta.json"))).toBe(false);
		expect((await executeKitAction({ action: "kit_status" }, env)).output).toContain(
			"Project component kit: unbuilt",
		);
		// Nor does a real build that leaves the planted file alone adopt it.
		await writeFile(planted, "globalThis.__nfKit = { planted: true };");
		const untouched = await executeKitAction(
			{ action: "kit_build" },
			{ ...env, runCommand: vite(null).runCommand },
		);
		expect(untouched.isError).toBe(true);
		expect(notice(untouched)?.state).toBe("unbuilt");
		expect(getKitRequest("n", "workspace")?.state).toBe("approved");

		const built = await executeKitAction(
			{ action: "kit_build" },
			{ ...env, runCommand: vite("1").runCommand },
		);
		expect(built.isError).toBeFalsy();
		expect(built.output).toContain("Built the component kit: 1 components");
		expect(notice(built)).toEqual({ state: "ready" });
		expect(getKitRequest("n", "workspace")).toBeNull();
		// The next build is a new decision for the user.
		const next = await executeKitAction({ action: "kit_build" }, env);
		expect(next.output).toContain("waiting for the user's confirmation");
		expect(notice(next)?.request).toMatchObject({ kind: "update", state: "pending" });
	});
});

describe("kit_status", () => {
	test("explains how to author a kit when there is none", async () => {
		const { env } = await fixture();
		const result = await executeKitAction({ action: "kit_status" }, env);
		expect(result.output).toContain("No project component kit");
		expect(result.output).toContain("kit.json");
		expect(result.output).toContain('{action:"kit_build"}');
	});

	test("lists the catalog and whether a build is pending", async () => {
		const { env } = await fixture({
			[`${KIT}/kit.json`]: JSON.stringify({
				version: 1,
				components: [{ name: "Pill", from: "./Pill", description: "Rounded label" }],
			}),
		});
		await executeKitAction({ action: "kit_build" }, env);
		const result = await executeKitAction({ action: "kit_status" }, env);
		expect(result.output).toContain("Project component kit: unbuilt");
		expect(result.output).toContain("<Pill> — Rounded label");
		expect(result.output).toContain("Do not build until they confirm");
		expect(notice(result)?.request?.state).toBe("pending");
	});
});
