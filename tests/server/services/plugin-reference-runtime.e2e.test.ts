import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "../../../server/lib/plugins/manifest";
import { LocalProcessRunner, PluginRuntime } from "../../../server/services/plugin-runtime";

const fixtureRoot = join(import.meta.dir, "../../fixtures/plugins/e2e/reference-tool-rpc");
const exampleEntry = join(
	import.meta.dir,
	"../../../examples/plugins/tool-command/server/index.js",
);

test("self-contained e2e entry mirrors the shipped reference tool plugin", async () => {
	expect(await readFile(join(fixtureRoot, "server/index.js"), "utf8")).toBe(
		await readFile(exampleEntry, "utf8"),
	);
});

test("reference server plugin completes handshake and tools.invoke over Content-Length RPC", async () => {
	const manifest = parseManifest(
		JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")),
	);
	if (!manifest.server) throw new Error("reference fixture must declare a server entry");
	const runtime = new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		command: [process.execPath, join(fixtureRoot, manifest.server.entry)],
		cwd: fixtureRoot,
		rpcProtocol: manifest.server.protocol,
		runner: new LocalProcessRunner({
			allowedCwds: [fixtureRoot],
			maxBodyBytes: 128 * 1024,
			maxStdoutBytes: 256 * 1024,
			maxStderrBytes: 16 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			spawnTimeoutMs: 2_000,
			idleTimeoutMs: 5_000,
			totalTimeoutMs: 5_000,
			resourceLimits: { cpuTimeSeconds: 5, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 2_000,
			activationMs: 2_000,
			rpcMs: 2_000,
			drainMs: 100,
			shutdownMs: 500,
			cancelGraceMs: 50,
		},
	});

	try {
		await runtime.start();
		expect(runtime.state).toBe("active");
		expect(runtime.generation).toBe(1);

		const result = await runtime.request<{
			output: string;
			title: string;
			metadata: { length: number; preview: string };
		}>("tools.invoke", {
			contributionId: "describe-selection",
			input: { text: "hello reference" },
			context: { requestId: "e2e-tool", correlationId: "e2e" },
		});
		expect(JSON.parse(result.output)).toEqual({ length: 15, preview: "hello reference" });
		expect(result.title).toBe("Selection description");
		expect(result.metadata).toEqual({ length: 15, preview: "hello reference" });

		await expect(runtime.request("reference.unknown")).rejects.toMatchObject({ code: "-32601" });
	} finally {
		await runtime.shutdown();
	}
	expect(runtime.state).toBe("stopped");
});
