import { afterAll, describe, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { getTestDb } from "../../../tests/setup";
import type { ExecutionBackend, ReadBytesOptions } from "../../lib/agent/execution/backend";
import { targetPathSemantics } from "../../lib/agent/execution/path-semantics";
import type { AgentConfig, ToolContext } from "../../lib/agent/types";
import type { WorkspaceFileAccess } from "../../lib/plan-file-path";
import type { WorkspaceAttachmentAccess } from "../../lib/uploads";
import { resolveRuntimePolicy } from "../agent-runtime/policy";

const realDbModule = { ...(await import("../../db")) };
const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const realSkillModule = { ...(await import("../skill-service")) };
const { materializeGlobalSkillResources } = realSkillModule;
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../skill-service", () => realSkillModule);
	mock.restore();
});

function fixture(flavor: "posix" | "windows" = "posix") {
	const sourcePaths = targetPathSemantics("posix");
	const targetPaths = targetPathSemantics(flavor);
	const sourceDir = "/configured/global-skills/demo";
	const sourceFiles = new Map<string, Uint8Array>([
		[
			`${sourceDir}/SKILL.md`,
			Buffer.from(
				"---\nname: demo\ndescription: demo skill\n---\nRead scripts/run.sh on the skill device.",
			),
		],
		[`${sourceDir}/scripts/run.sh`, Buffer.from("printf remote-script")],
	]);
	const sourceReads: string[] = [];
	const writes = new Map<string, Uint8Array>();
	const mkdirs: string[] = [];
	let denyTarget = "";
	let denySource = "";
	const sourceBackend = {
		deviceId: "local",
		kind: "local",
		paths: sourcePaths,
		pathFlavor: "posix",
		runtimeGeneration: 0,
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: true,
			runtimeGeneration: 0,
		}),
		statFile: async (path: string) =>
			sourceFiles.has(path)
				? {
						isFile: true,
						isDirectory: false,
						size: sourceFiles.get(path)?.byteLength ?? 0,
						resolvedPath: path,
					}
				: { isFile: false, isDirectory: true, size: 0, resolvedPath: path },
		glob: async () => Array.from(sourceFiles.keys()),
		readFileBytes: async (path: string, options: ReadBytesOptions) => {
			sourceReads.push(path);
			const bytes = sourceFiles.get(path) ?? new Uint8Array();
			return {
				bytes: bytes.subarray(0, options.maxBytes),
				truncated: bytes.length > (options.maxBytes ?? bytes.length),
				totalSize: bytes.length,
				resolvedPath: path,
			};
		},
		writeFileBytes: async () => {
			throw new Error("never write to the source server");
		},
		execCommand: async () => {
			throw new Error("never execute a server script");
		},
	} as unknown as ExecutionBackend;
	const cwd = flavor === "windows" ? "D:\\chosen\\repo" : "/chosen/repo";
	const workspaceContext: WorkspaceContext = {
		deviceId: "remote",
		cwd,
		pathFlavor: flavor,
		revision: 7,
		contextKey: "chosen-remote",
		capabilities: { switchDirectory: true },
	};
	const targetBackend = {
		deviceId: "remote",
		kind: "remote",
		paths: targetPaths,
		pathFlavor: flavor,
		runtimeGeneration: 2,
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: false,
			runtimeGeneration: 2,
		}),
		mkdirp: async (path: string) => {
			mkdirs.push(path);
		},
		conditionalWriteFileBytes: async (
			path: string,
			bytes: Uint8Array,
			options: { expectedBytes: Uint8Array | null; expectedResolvedPath: string },
		) => {
			expect(options.expectedBytes).toBeNull();
			expect(options.expectedResolvedPath).toBe(path);
			writes.set(path, bytes);
		},
		execCommand: async () => {
			throw new Error("materialization must never run commands");
		},
	} as unknown as ExecutionBackend;
	const sourceAccess: WorkspaceFileAccess = {
		backend: sourceBackend,
		authorizeRead: async (path) => path !== denySource && sourcePaths.contains(sourceDir, path),
	};
	const targetAccess: WorkspaceAttachmentAccess = {
		backend: targetBackend,
		workspaceContext,
		authorizeWrite: async (path) => !denyTarget || !path.endsWith(denyTarget),
	};
	const skill = {
		name: "demo",
		description: "demo skill",
		content: "old cached body",
		location: `${sourceDir}/SKILL.md`,
		files: ["scripts/run.sh"],
		source: "global" as const,
	};
	return {
		sourceDir,
		sourceFiles,
		sourceReads,
		targetBackend,
		sourceAccess,
		targetAccess,
		writes,
		mkdirs,
		skill,
		denyWrite: (suffix: string) => {
			denyTarget = suffix;
		},
		denyRead: (path: string) => {
			denySource = path;
		},
	};
}

describe("explicit published skill data materialization", () => {
	test("copies bounded server configuration bytes to the frozen remote Windows root without host execution", async () => {
		const f = fixture("windows");
		const result = await materializeGlobalSkillResources(f.skill, f.sourceAccess, f.targetAccess);
		expect(result.deviceId).toBe("remote");
		expect(result.location).toStartWith("D:\\chosen\\repo\\.narrafork\\skill-resources\\demo-");
		expect(result.files).toEqual(["scripts\\run.sh"]);
		expect(result.materializedFrom).toEqual({ deviceId: "local", location: f.skill.location });
		expect(result.content).toBe("Read scripts/run.sh on the skill device.");
		expect(f.writes.size).toBe(2);
		expect(Array.from(f.writes.keys()).every((path) => path.startsWith("D:\\chosen\\repo\\"))).toBe(
			true,
		);
		expect(f.sourceReads).toHaveLength(2);
	});

	test("per-file write denial happens before any mkdir or file mutation", async () => {
		const f = fixture();
		f.denyWrite("run.sh");
		await expect(
			materializeGlobalSkillResources(f.skill, f.sourceAccess, f.targetAccess),
		).rejects.toThrow("write denied");
		expect(f.writes.size).toBe(0);
		expect(f.mkdirs).toEqual([]);
	});

	test("read denial never copies an unapproved server file", async () => {
		const f = fixture();
		f.denyRead(`${f.sourceDir}/scripts/run.sh`);
		await expect(
			materializeGlobalSkillResources(f.skill, f.sourceAccess, f.targetAccess),
		).rejects.toThrow("read denied");
		expect(f.writes.size).toBe(0);
		expect(f.sourceReads).not.toContain(`${f.sourceDir}/scripts/run.sh`);
	});

	test("file and byte budgets fail closed before writing a partial bundle", async () => {
		const f = fixture();
		for (let i = 0; i < 21; i++) f.sourceFiles.set(`${f.sourceDir}/asset-${i}`, new Uint8Array(1));
		await expect(
			materializeGlobalSkillResources(f.skill, f.sourceAccess, f.targetAccess),
		).rejects.toThrow("21-file limit");
		expect(f.writes.size).toBe(0);
		const large = fixture();
		large.sourceFiles.set(`${large.sourceDir}/large`, new Uint8Array(256_001));
		await expect(
			materializeGlobalSkillResources(large.skill, large.sourceAccess, large.targetAccess),
		).rejects.toThrow("byte limit");
		expect(large.writes.size).toBe(0);
		const total = fixture();
		for (let i = 0; i < 5; i++)
			total.sourceFiles.set(`${total.sourceDir}/asset-${i}`, new Uint8Array(230_000));
		await expect(
			materializeGlobalSkillResources(total.skill, total.sourceAccess, total.targetAccess),
		).rejects.toThrow("byte limit");
		expect(total.writes.size).toBe(0);
	});

	test("Skill normal/read-only loading is control-only text and cannot pretend to copy resources", async () => {
		const f = fixture();
		mock.module("../skill-service", () => ({
			...realSkillModule,
			loadSkillSummariesForContext: async () => ({
				scopeKey: "test",
				roots: [],
				skills: [
					{ ...f.skill, source: "global", rootKind: "global", normalizedRootPath: f.sourceDir },
				],
			}),
			loadSkillByNameForContext: async () => f.skill,
		}));
		const { skillTool } = await import("../../lib/agent/tools/skill");
		const readonly = resolveRuntimePolicy({ variant: "primary", readOnly: true });
		const routing = skillTool.executionRouting;
		if (routing?.kind !== "single") throw new Error("single skill routing required");
		expect(routing.resolve({ name: "demo" }, { cwd: "/chosen/repo" } as AgentConfig)).toMatchObject(
			{ operation: "control" },
		);
		expect(
			routing.resolve({ name: "demo", materialize: true }, {
				cwd: "/chosen/repo",
				runtimePolicy: readonly,
			} as AgentConfig),
		).toMatchObject({ operation: "control" });
		expect(
			routing.resolve({ name: "demo", materialize: true }, {
				cwd: "/chosen/repo",
				workspaceContext: f.targetAccess.workspaceContext,
			} as AgentConfig),
		).toMatchObject({ operation: "write", path: ".narrafork/skill-resources", deviceId: "remote" });
		const result = await skillTool.execute({ name: "demo", materialize: true }, {
			narratorId: "test",
			cwd: "/chosen/repo",
			locale: "en",
			signal: new AbortController().signal,
			runtimePolicy: readonly,
			requestPermission: async () => ({ behavior: "deny" }),
		} as ToolContext);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("old cached body");
		expect(result.output).toContain("Materialization was not performed");
		expect(result.output).toContain("Resource device: local");
		expect(result.metadata?.materialized).toBe(false);
		expect(f.writes.size).toBe(0);
		mock.module("../skill-service", () => realSkillModule);
	});

	test("cancelled installation performs no target writes", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort(new Error("cancel materialization"));
		await expect(
			materializeGlobalSkillResources(
				f.skill,
				{ ...f.sourceAccess, signal: controller.signal },
				f.targetAccess,
			),
		).rejects.toThrow("cancel materialization");
		expect(f.writes.size).toBe(0);
	});
});
