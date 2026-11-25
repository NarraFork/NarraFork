import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type Profiler, Session } from "node:inspector";
import { join } from "node:path";
import { testEnvironment } from "../../../tests/preload";
import { safeSpawn } from "../../lib/spawn";
import { CpuProfiler } from "../cpu-profiler";

function post<T>(session: Session, method: string, params: object = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		session.post(method, params, (error, result) => {
			if (error) reject(error);
			else resolve(result as T);
		});
	});
}

const profilerImport = JSON.stringify(join(import.meta.dir, "../cpu-profiler.ts"));

test("an inspector opened by Bun CLI makes online capture unavailable", async () => {
	// Bun's debugger thread prints its banner with async writes after it starts listening; a child
	// that exits first loses them, which left CI an empty stderr. So the child captures only after
	// stdin closes, and the test closes stdin once the whole banner proves the inspector listens.
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			"--inspect=127.0.0.1:0",
			"-e",
			`
				import { CpuProfiler } from ${profilerImport};
				await Bun.stdin.text();
				try {
					await new CpuProfiler().capture(20);
					throw new Error("Started recording with the inspector open");
				} catch (error) {
					if (error.statusCode !== 503) throw error;
					console.log(error.message);
				}
			`,
		],
		env: { ...process.env, BUN_OPTIONS: "" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	// Inside bun test's 5s test timeout, so a missing banner fails with what stderr held.
	const deadline = setTimeout(() => child.kill(), 4_000);
	try {
		const stdout = new Response(child.stdout).text();
		const stderr = child.stderr.getReader();
		const decoder = new TextDecoder();
		let banner = "";
		// The same rule opens and closes the banner, and the closing one is written last.
		while (banner.split("Bun Inspector").length < 3 && banner.length < 8_192) {
			const { done, value } = await stderr.read();
			if (done) break;
			banner += decoder.decode(value, { stream: true });
		}
		child.stdin.end();
		const rest = (async () => {
			let text = "";
			for (;;) {
				const { done, value } = await stderr.read();
				if (done) return text;
				if (text.length < 8_192) text += decoder.decode(value, { stream: true });
			}
		})();
		expect(banner).toMatch(/Listening:\s+\S*ws:\/\/127\.0\.0\.1:\d+\//);
		const exitCode = await child.exited;
		// toMatchObject ignores stderr but shows it if the child failed.
		expect({ exitCode, stdout: (await stdout).trim(), stderr: await rest }).toMatchObject({
			exitCode: 0,
			stdout: "CPU profiling is unavailable",
		});
	} finally {
		clearTimeout(deadline);
		child.kill();
	}
});

test("a foreign in-process profile survives a busy capture and profiler shutdown", async () => {
	const foreign = new Session();
	foreign.connect();
	const profiler = new CpuProfiler();
	try {
		await post(foreign, "Profiler.enable");
		await post(foreign, "Profiler.start");
		await expect(profiler.capture(20)).rejects.toMatchObject({ statusCode: 409 });
		await profiler.shutdown();
		const { profile } = await post<Profiler.StopReturnType>(foreign, "Profiler.stop");
		expect(profile.nodes.length).toBeGreaterThan(0);
	} finally {
		foreign.disconnect();
	}
});

test("shutdown cancels an owned recording and fences new ones", async () => {
	const profiler = new CpuProfiler();
	const capture = profiler.capture(30_000).catch((error: unknown) => error);
	const observer = new Session();
	observer.connect();
	try {
		const deadline = Date.now() + 1_000;
		let outcome: unknown;
		do {
			outcome = await post(observer, "Profiler.setSamplingInterval", { interval: 10_000 }).catch(
				(error: unknown) => error,
			);
			if (outcome instanceof Error) break;
			await Bun.sleep(1);
		} while (Date.now() < deadline);
		expect(outcome).toMatchObject({
			message: expect.stringContaining("while profiler is running"),
		});
		await profiler.shutdown();
		expect(await capture).toMatchObject({ code: "CPU_PROFILER_SHUTDOWN" });
		await expect(profiler.capture(20)).rejects.toMatchObject({ code: "CPU_PROFILER_SHUTDOWN" });
		await post(observer, "Profiler.setSamplingInterval", { interval: 10_000 });
	} finally {
		await profiler.shutdown();
		observer.disconnect();
	}
});

test.each([
	"argv",
	"BUN_OPTIONS",
])("Bun CLI sampling via %s writes a usable profile after online refusal", async (via) => {
	const home = await mkdtemp(join(testEnvironment.isolatedHome, "cli-profiler-"));
	try {
		const args = ["--cpu-prof", "--cpu-prof-name=cli.cpuprofile"];
		const source = `
			import { CpuProfiler } from ${profilerImport};
			function burnFixtureCpu() {
				const end = Date.now() + 150;
				while (Date.now() < end) Math.random();
			}
			try {
				await new CpuProfiler().capture(20);
				throw new Error("Took over CLI profiling");
			} catch (error) {
				if (error.statusCode !== 503) throw error;
				console.log(error.message);
			}
			burnFixtureCpu();
		`;
		const result = await safeSpawn({
			cmd: [process.execPath, ...(via === "argv" ? args : []), "-e", source],
			cwd: home,
			env: { ...process.env, BUN_OPTIONS: via === "BUN_OPTIONS" ? args.join(" ") : "" },
			timeout: 5_000,
			maxOutputBytes: 8_192,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("CPU profiling is unavailable");
		const profile = JSON.parse(await readFile(join(home, "cli.cpuprofile"), "utf8"));
		const hotNode = profile.nodes.find(
			(node: Profiler.ProfileNode) => node.callFrame.functionName === "burnFixtureCpu",
		);
		expect(profile.samples).toContain(hotNode?.id);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
