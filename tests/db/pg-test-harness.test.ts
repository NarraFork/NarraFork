import { describe, expect, it } from "bun:test";
import {
	HarnessCommandError,
	OUTPUT_LIMIT,
	runHarnessCommand,
	withPostgres,
} from "./pg-test-harness";

const script = (source: string) => [process.execPath, "-e", source];

describe("bounded harness commands", () => {
	it("retains small output", async () => {
		const result = await runHarnessCommand(script('console.log("1")'));
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("1");
	});
	for (const stream of ["stdout", "stderr"]) {
		it(`terminates ${stream} flooding at the byte budget`, async () => {
			await expect(
				runHarnessCommand(script(`while (true) process.${stream}.write("x".repeat(65536))`)),
			).rejects.toMatchObject({ kind: "output-limit" });
		});
	}
	it("shares one budget between both streams", async () => {
		await expect(
			runHarnessCommand(
				script(`process.stdout.write("x".repeat(${OUTPUT_LIMIT})); process.stderr.write("y");`),
			),
		).rejects.toMatchObject({ kind: "output-limit" });
	});
	it("kills timed out children", async () => {
		await expect(
			runHarnessCommand(script("setInterval(() => {}, 1000)"), { timeout: 30 }),
		).rejects.toMatchObject({ kind: "timeout" });
	});
	it("cancels running children", async () => {
		const controller = new AbortController();
		const pending = runHarnessCommand(script("setInterval(() => {}, 1000)"), {
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
	});
	it("does not spawn pre-cancelled or nonexistent commands", async () => {
		await expect(
			runHarnessCommand(["nonexistent-harness-command"], {
				signal: AbortSignal.abort(),
			}),
		).rejects.toMatchObject({ kind: "cancelled" });
		await expect(runHarnessCommand(["nonexistent-harness-command"])).rejects.toMatchObject({
			kind: "spawn",
		});
	});
});

/** Fake Podman replies for the image provisioning step that precedes every container. */
const IMAGE_PRESENT = { code: 0, stdout: "sha256:local\n", stderr: "" };

describe("temporary PostgreSQL lifecycle", () => {
	it("blocks when the controlled container cannot start", async () => {
		const calls: string[][] = [];
		const result = await withPostgres(
			async () => {
				throw new Error("must not run");
			},
			{
				run: async (args) => {
					calls.push(args);
					if (args[1] === "image") return IMAGE_PRESENT;
					return { code: 1, stdout: "", stderr: "secret" };
				},
			},
		);
		expect(result).toMatchObject({ status: "blocked", errorType: "environment" });
		expect(calls[0]?.[1]).toBe("image");
		expect(calls[1]?.[1]).toBe("run");
	});
	for (const kind of ["timeout", "cancelled", "output-limit"] as const) {
		it(`cleans its own random name after interrupted creation: ${kind}`, async () => {
			const calls: string[][] = [];
			const result = await withPostgres(async () => null, {
				run: async (args, options) => {
					calls.push(args);
					if (args[1] === "image") return IMAGE_PRESENT;
					if (args[1] === "run") {
						expect(args.join(" ")).not.toContain(options?.env?.POSTGRES_PASSWORD ?? "missing");
						throw new HarnessCommandError(kind);
					}
					if (args[1] === "rm") expect(options?.signal).toBeUndefined();
					return { code: 0, stdout: "", stderr: "" };
				},
			});
			expect(result).toMatchObject({
				status: "blocked",
				errorType: "environment",
				reason: `harness command ${kind}`,
			});
			const start = calls[1];
			const name = start[start.indexOf("--name") + 1];
			expect(name).toMatch(/^narrafork-pg-harness-[a-f0-9]{16}$/);
			expect(calls[2]).toEqual(["podman", "rm", "--force", "--ignore", name]);
		});
	}
	it("cleans after callback failure and hides sensitive errors", async () => {
		const calls: string[][] = [];
		const result = await withPostgres(
			async () => {
				throw new Error("secret-password");
			},
			{
				run: async (args) => {
					calls.push(args);
					if (args[1] === "image") return IMAGE_PRESENT;
					return { code: 0, stdout: args[1] === "port" ? "127.0.0.1:49152\n" : "1\n", stderr: "" };
				},
			},
		);
		expect(result).toMatchObject({ status: "failed", errorType: "callback" });
		expect(JSON.stringify(result)).not.toContain("secret-password");
		expect(calls.at(-1)?.[1]).toBe("rm");
	});
	it("blocks if PostgreSQL exec is unavailable", async () => {
		let cleaned = false;
		const result = await withPostgres(async () => "unexpected", {
			run: async (args) => {
				if (args[1] === "image") return IMAGE_PRESENT;
				if (args[1] === "exec") throw new HarnessCommandError("spawn");
				if (args[1] === "rm") cleaned = true;
				return { code: 0, stdout: "127.0.0.1:49152\n", stderr: "" };
			},
		});
		expect(result).toMatchObject({ status: "blocked", errorType: "environment" });
		expect(cleaned).toBe(true);
	});
	it("does not report success if cleanup fails", async () => {
		const result = await withPostgres(async () => "success", {
			run: async (args) => ({
				code: args[1] === "rm" ? 1 : 0,
				stdout: args[1] === "port" ? "127.0.0.1:49152\n" : "1\n",
				stderr: "",
			}),
		});
		expect(result).toEqual({
			status: "blocked",
			errorType: "environment",
			reason: "temporary PostgreSQL cleanup failed",
		});
	});
});

describe("Podman environment and image selection", () => {
	// tests/preload.ts redirects HOME to an isolated temp dir. Rootless Podman derives
	// its image store from HOME, so an inherited test HOME makes every locally present
	// image report "image not known". Podman commands must see the host home.
	it("runs every Podman command against the host container store", async () => {
		const homes = new Set<string | undefined>();
		await withPostgres(async () => "ok", {
			run: async (args, options) => {
				homes.add(options?.env?.HOME);
				if (args[1] === "image") return IMAGE_PRESENT;
				return { code: 0, stdout: args[1] === "port" ? "127.0.0.1:49152\n" : "1\n", stderr: "" };
			},
		});
		expect(homes.size).toBe(1);
		const home = [...homes][0];
		expect(home).toBe(process.env.NARRAFORK_ORIGINAL_HOME);
		expect(home).not.toBe(process.env.HOME);
	});

	it("pulls the requested image and never substitutes another version", async () => {
		const images: string[] = [];
		const result = await withPostgres(async () => "ok", {
			image: "docker.io/library/postgres:17-alpine",
			run: async (args) => {
				if (args[1] === "image") {
					images.push(args.at(-1) as string);
					return { code: 125, stdout: "", stderr: "image not known" };
				}
				if (args[1] === "pull") {
					images.push(args.at(-1) as string);
					return { code: 0, stdout: "", stderr: "" };
				}
				if (args[1] === "run") images.push(args.at(-1) as string);
				return { code: 0, stdout: args[1] === "port" ? "127.0.0.1:49152\n" : "1\n", stderr: "" };
			},
		});
		expect(result).toBe("ok");
		expect(images).toEqual([
			"docker.io/library/postgres:17-alpine",
			"docker.io/library/postgres:17-alpine",
			"docker.io/library/postgres:17-alpine",
		]);
	});

	it("reports the bounded runtime diagnostic when the image cannot be obtained", async () => {
		let started = false;
		const result = await withPostgres(async () => "ok", {
			image: "docker.io/library/postgres:17-alpine",
			run: async (args) => {
				if (args[1] === "image") return { code: 125, stdout: "", stderr: "image not known" };
				if (args[1] === "pull")
					return { code: 125, stdout: "", stderr: "dial tcp: lookup registry: no such host" };
				if (args[1] === "run") started = true;
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		expect(started).toBe(false);
		expect(result).toMatchObject({ status: "blocked", errorType: "environment" });
		if ("reason" in (result as object)) {
			const { reason } = result as { reason: string };
			expect(reason).toContain("docker.io/library/postgres:17-alpine");
			expect(reason).toContain("no such host");
			expect(reason).not.toContain("validation unavailable");
		}
	});
});

// Opt-in integration: a missing runtime/image must fail an explicitly requested probe,
// never turn an unavailable database into a passing integration test.
it.skipIf(process.env.NF_PG_HARNESS_INTEGRATION !== "1")(
	"real temporary PostgreSQL SELECT 1",
	async () => {
		const result = await withPostgres(async ({ port, schema, exec }) => {
			const query = await exec("SELECT 1;");
			expect(query.code).toBe(0);
			expect(query.stdout.trim()).toBe("1");
			return { port, schema };
		});
		expect(result).not.toHaveProperty("status");
		if (!("status" in result)) {
			expect(result.schema).toMatch(/^h_[a-f0-9]+$/);
			expect(result.port).toBeGreaterThan(0);
		}
	},
	120_000,
);
