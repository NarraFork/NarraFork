import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let executable: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "narrafork-replacement-lifecycle-"));
	executable = join(root, process.platform === "win32" ? "probe.exe" : "probe");
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			join(import.meta.dir, "replacement-lifecycle.fixture.ts"),
			"--compile",
			"--outfile",
			executable,
		],
		{ stdio: ["ignore", "ignore", "ignore"], timeout: 30_000 },
	);
	expect(await build.exited).toBe(0);
}, 40_000);

afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function check(mode: "detached" | "legacy"): Promise<void> {
	const directory = join(root, mode === "detached" ? "中文 空格 & %PATH%" : "legacy");
	await mkdir(directory);
	// The fixed path must bypass cmd's expansion/quoting for the binary as well as argv/cwd.
	const binary =
		mode === "detached"
			? join(directory, process.platform === "win32" ? "更新 & new.exe" : "更新 & new")
			: executable;
	if (binary !== executable) await copyFile(executable, binary);
	const child = Bun.spawn([binary, "check", mode, directory], {
		cwd: directory,
		env: { ...process.env, NARRAFORK_HOME: directory },
		stdio: ["ignore", "ignore", "ignore"],
		timeout: 40_000,
	});
	const code = await child.exited;
	if (code !== 0) {
		const events = await readFile(join(directory, "events.log"), "utf8").catch(String);
		throw new Error(`Native lifecycle ${mode} exited ${code}:\n${events.slice(-8_000)}`);
	}
	expect(JSON.parse(await readFile(join(directory, "result.json"), "utf8"))).toMatchObject({
		ok: true,
		mode,
		platform: process.platform,
	});
}

test(
	"detached replacement manager and service survive the retiring manager",
	() => check("detached"),
	45_000,
);

test.skipIf(process.platform !== "win32")(
	"legacy cmd-start initiator still kills the same receiver on first upgrade",
	() => check("legacy"),
	45_000,
);
