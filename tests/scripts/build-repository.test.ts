import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	githubRepositoryFromOrigin,
	resolveBuildGitHubRepository,
} from "../../scripts/lib/build-repository";
import { OFFICIAL_GITHUB_REPOSITORY } from "../../shared/github-repository";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() {
	const root = mkdtempSync(join(process.cwd(), ".narrafork/build-repository-"));
	roots.push(root);
	return root;
}

describe("build repository identity", () => {
	test("explicit > trusted CI > source origin > official archive compatibility", () => {
		const resolve = (env: NodeJS.ProcessEnv, origin = "https://github.com/Source/Repo.git") =>
			resolveBuildGitHubRepository({ root: process.cwd(), env, origin });
		expect(resolve({ NF_BUILD_GITHUB_REPOSITORY: "Explicit/Repo" })).toBe("Explicit/Repo");
		expect(resolve({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "CI/Repo" })).toBe("CI/Repo");
		expect(resolve({ GITHUB_REPOSITORY: "Untrusted/Repo" })).toBe("Source/Repo");
		expect(resolve({})).toBe("Source/Repo");
		expect(resolve({}, "")).toBe(OFFICIAL_GITHUB_REPOSITORY);
		for (const env of [
			{ NF_BUILD_GITHUB_REPOSITORY: "../Repo" },
			{ NF_BUILD_GITHUB_REPOSITORY: "Owner/Repo\n" },
			{ NF_BUILD_GITHUB_REPOSITORY: "Owner\n/Repo" },
			{ GITHUB_ACTIONS: "true" },
			{
				GITHUB_ACTIONS: "true",
				GITHUB_REPOSITORY: "CI/Repo",
				NF_BUILD_GITHUB_REPOSITORY: "Other/Repo",
			},
		])
			expect(() => resolve(env)).toThrow();
	});
	test("source origin parser accepts GitHub HTTPS/SSH and rejects foreign URLs", () => {
		for (const origin of [
			"https://github.com/Fork/Repo.git",
			"git@github.com:Fork/Repo.git",
			"ssh://git@github.com/Fork/Repo.git",
		])
			expect(githubRepositoryFromOrigin(origin)).toBe("Fork/Repo");
		for (const origin of [
			"https://github.com.evil/Fork/Repo",
			"https://github.com/Fork/Repo?x",
			"../Fork/Repo",
			"https://token@github.com/Fork/Repo",
			"https://github.com/Fork/../Repo",
		])
			expect(githubRepositoryFromOrigin(origin)).toBeUndefined();
	});
	test("actual Vite config automatically injects the trusted CI repository", () => {
		const root = temp();
		const fixture = join(root, "vite-config.ts");
		writeFileSync(
			fixture,
			`import config from ${JSON.stringify(resolve("frontend/vite.config.ts"))};
const value = typeof config === "function" ? await config({command:"build",mode:"production"}) : await config;
console.log(JSON.stringify(value.define.__NARRAFORK_BUILD_REPOSITORY__));`,
		);
		const output = execFileSync(process.execPath, [fixture], {
			cwd: process.cwd(),
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			env: {
				...process.env,
				GITHUB_ACTIONS: "true",
				GITHUB_REPOSITORY: "Example/ViteFork",
				NF_BUILD_GITHUB_REPOSITORY: undefined,
			},
		});
		expect(JSON.parse(output)).toBe(JSON.stringify("Example/ViteFork"));
	}, 35_000);
	test("compiled fixture freezes both frontend and backend defaults despite runtime env/cwd", () => {
		const root = temp();
		const fixture = join(root, "fixture.ts");
		const binary = join(root, process.platform === "win32" ? "fixture.exe" : "fixture");
		const repository = resolveBuildGitHubRepository({
			root: process.cwd(),
			env: {
				GITHUB_ACTIONS: "true",
				GITHUB_REPOSITORY: "Example/CompiledFork",
			},
		});
		const module = (path: string) => JSON.stringify(resolve(path));
		writeFileSync(
			fixture,
			`
import { BUILD_GITHUB_REPOSITORY } from ${module("server/lib/version.ts")};
import { DEFAULT_GITHUB_REPOSITORY as frontend } from ${module("frontend/lib/update-source.ts")};
import { DEFAULT_UPDATE_SETTINGS, normalizeUpdateSourceSettings } from ${module("server/lib/settings/update-source.ts")};
const saved = { source: "github", githubRepository: "Saved/Explicit" };
const legacy = { source: "update-server", githubRepository: "Saved/Legacy", serverUrl: "https://updates.example.com", product: "private" };
console.log(JSON.stringify({ build: BUILD_GITHUB_REPOSITORY, frontend,
 fresh: normalizeUpdateSourceSettings({ update: { ...DEFAULT_UPDATE_SETTINGS } }, {}).update,
 saved: normalizeUpdateSourceSettings({ update: { ...DEFAULT_UPDATE_SETTINGS, ...saved } }, { update: saved }).update,
 legacy: normalizeUpdateSourceSettings({ update: { ...DEFAULT_UPDATE_SETTINGS, ...legacy } }, { update: legacy }).update }));
`,
		);
		execFileSync(
			process.execPath,
			[
				"build",
				fixture,
				"--compile",
				`--define=__NARRAFORK_BUILD_REPOSITORY__=${JSON.stringify(repository)}`,
				"--outfile",
				binary,
			],
			{
				cwd: process.cwd(),
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
			},
		);
		const result = JSON.parse(
			execFileSync(binary, [], {
				cwd: root,
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
				env: {
					...process.env,
					GITHUB_REPOSITORY: "Runtime/Wrong",
					GITHUB_ACTIONS: "true",
					NF_BUILD_GITHUB_REPOSITORY: "Runtime/Wrong",
				},
			}),
		);
		expect(result.build).toBe(repository);
		expect(result.frontend).toBe(repository);
		expect(result.fresh).toMatchObject({ source: "github", githubRepository: repository });
		expect(result.saved).toMatchObject({ source: "github", githubRepository: "Saved/Explicit" });
		expect(result.legacy).toMatchObject({
			source: "update-server",
			githubRepository: "Saved/Legacy",
			product: "private",
		});
	}, 70_000);
});
