import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { compiledBuildArguments } from "../../../scripts/lib/compiled-build";
import { compiledWorkerBuildEntrypoints } from "../compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../../..");

// Keep the probe alongside the production main entry so the worker has the same embedded key.
test("compiled ModelTrace works from a clean directory with no cache or network requests", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-modeltrace-"));
	const probe = join(project, "server", `.modeltrace-probe-${crypto.randomUUID()}.ts`);
	const binary = join(artifacts, process.platform === "win32" ? "probe.exe" : "probe");
	const worker = "./server/lib/modeltrace/worker.ts";
	let proxyRequests = 0;
	const proxy = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				proxyRequests++;
				socket.end();
			},
			data() {},
		},
	});
	try {
		expect(compiledWorkerBuildEntrypoints()).toContain(worker);
		await writeFile(
			probe,
			`import { analyzeModelTrace } from "./lib/modeltrace";
const outputs = [298].map(expected_count => ({ expected_count,
	text: Array.from({ length: expected_count }, (_, i) => i % 2 ? 9 + i % 40 : 200 + i % 100).join(", "),
}));
console.log(JSON.stringify(await analyzeModelTrace(outputs, "en")));`,
		);
		await exec(
			process.execPath,
			["build", probe, worker, ...compiledBuildArguments(), "--outfile", binary],
			{
				cwd: project,
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
			},
		);
		await rm(probe);
		const proxyUrl = `http://127.0.0.1:${proxy.port}`;
		const { stdout, stderr } = await exec(binary, [], {
			cwd: artifacts,
			env: {
				...process.env,
				NARRAFORK_DISABLE_MODELTRACE_WORKER: "0",
				HOME: artifacts,
				XDG_CACHE_HOME: artifacts,
				LOCALAPPDATA: artifacts,
				HTTPS_PROXY: proxyUrl,
				HTTP_PROXY: proxyUrl,
				NO_PROXY: "",
			},
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
		const result = JSON.parse(stdout.trim());
		expect(result, stderr).toMatchObject({ type: "modeltrace_result", decision: "partial" });
		expect(result.results).toHaveLength(5);
		expect(result.results[0].probability).toBeGreaterThan(0);
		expect(proxyRequests).toBe(0);
		expect(await readdir(artifacts)).toEqual([
			process.platform === "win32" ? "probe.exe" : "probe",
		]);
	} finally {
		proxy.stop(true);
		await rm(probe, { force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 90_000);
