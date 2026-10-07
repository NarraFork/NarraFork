import { afterAll, describe, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { getTestDb } from "../../../tests/setup";
import type { ExecutionBackend, ReadBytesOptions } from "../../lib/agent/execution/backend";
import { targetPathSemantics } from "../../lib/agent/execution/path-semantics";
import { createWorkspaceFileAccess } from "../../lib/plan-file-path";

const realDbModule = { ...(await import("../../db")) };
const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const {
	getSkillContextCacheKey,
	loadSkillSummariesForContext,
	loadSkillByNameForContext,
	readSkillFile,
} = await import("../skill-service");
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

function fixture(deviceId: string, name: string, flavor: "posix" | "windows" = "posix") {
	const paths = targetPathSemantics(flavor);
	const cwd = flavor === "windows" ? "D:\\selected\\repo" : "/selected/repo";
	const workspaceContext: WorkspaceContext = {
		deviceId,
		cwd,
		pathFlavor: flavor,
		contextKey: `${deviceId}:chosen`,
		revision: 2,
		capabilities: { switchDirectory: true },
	};
	const location = paths.resolve(cwd, ".agents/skills/review/SKILL.md");
	const sidecar = paths.resolve(paths.dirname(location), "agents/openai.yaml");
	const file = paths.resolve(paths.dirname(location), "references/info.txt");
	const files = new Map([
		[location, `---\nname: review\ndescription: ${name}\n---\n${name} body`],
		[
			sidecar,
			"interface:\n  default_prompt: inspect remote\npolicy:\n  allow_implicit_invocation: false",
		],
		[file, `${name} resource`],
	]);
	const readPaths: string[] = [];
	let denied = "";
	const backend = {
		deviceId,
		kind: "remote",
		paths,
		pathFlavor: flavor,
		runtimeGeneration: 1,
		defaultCwd: "/wrong-default",
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: true,
			runtimeGeneration: 1,
		}),
		statFile: async (path: string) =>
			files.has(path)
				? {
						isFile: true,
						isDirectory: false,
						size: Buffer.byteLength(files.get(path) ?? ""),
						resolvedPath: path,
					}
				: Array.from(files.keys()).some((f) => paths.contains(path, f))
					? { isFile: false, isDirectory: true, size: 0, resolvedPath: path }
					: null,
		glob: async (pattern: string, options: { cwd: string }) =>
			Array.from(files.keys()).filter(
				(path) =>
					paths.contains(options.cwd, path) &&
					(pattern === "**/*" || paths.basename(path).startsWith("SKILL.md")),
			),
		readFileBytes: async (path: string, options: ReadBytesOptions) => {
			readPaths.push(path);
			const bytes = Buffer.from(files.get(path) ?? "");
			return {
				bytes: bytes.subarray(0, options.maxBytes),
				totalSize: bytes.length,
				truncated: bytes.length > (options.maxBytes ?? bytes.length),
				resolvedPath: path,
			};
		},
	} as unknown as ExecutionBackend;
	const fileAccess = createWorkspaceFileAccess({
		backend,
		workspaceContext,
		authorizeRead: async (path) => path !== denied,
	});
	return {
		context: { cwd, projectGitPath: "/server-project-decoy", workspaceContext, fileAccess },
		location,
		file,
		readPaths,
		deny: (path: string) => {
			denied = path;
		},
	};
}

describe("workspace skills physical source", () => {
	test("device and workspace identities isolate summary keys and skill bodies", async () => {
		const first = fixture("device-a", "FIRST");
		const second = fixture("device-b", "SECOND");
		expect(getSkillContextCacheKey(first.context)).not.toBe(
			getSkillContextCacheKey(second.context),
		);
		const a = await loadSkillByNameForContext(first.context, "review");
		const b = await loadSkillByNameForContext(second.context, "review");
		expect(a?.content).toBe("FIRST body");
		expect(b?.content).toBe("SECOND body");
		expect(a?.deviceId).toBe("device-a");
		expect(a?.source).toBe("workspace");
		expect(a?.defaultPrompt).toBe("inspect remote");
		expect(a?.allowImplicitInvocation).toBe(false);
		expect(first.readPaths.every((path) => path.startsWith("/selected/repo/"))).toBe(true);
	});

	test("Windows companion resources use target grammar and no host reads", async () => {
		const f = fixture("win", "WINDOWS", "windows");
		const skill = await loadSkillByNameForContext(f.context, "review");
		expect(skill?.location).toBe(f.location);
		expect(skill?.files).toContain("references\\info.txt");
		expect(await readSkillFile(f.location, "references/info.txt", f.context.fileAccess)).toBe(
			"WINDOWS resource",
		);
		await expect(
			readSkillFile(f.location, "../../escape.txt", f.context.fileAccess),
		).rejects.toThrow("traversal");
	});

	test("revocation rechecks policy instead of serving a cached skill body", async () => {
		const f = fixture("revoked", "SECRET");
		expect(
			(await loadSkillSummariesForContext(f.context)).skills.some((s) => s.name === "review"),
		).toBe(true);
		f.deny(f.location);
		const result = await loadSkillSummariesForContext(f.context);
		expect(result.skills.some((s) => s.name === "review" && s.source === "workspace")).toBe(false);
	});
});
