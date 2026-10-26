import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import {
	assertCaptureSandboxArgs,
	CAPTURE_LIMITS,
	captureGenUiSnapshot,
	captureLaunchOptions,
	createBoundedCaptureTransport,
	createCaptureDiagnostics,
	validateCaptureInput,
} from "./capture";

const input = () => ({
	html: "<p>test</p>",
	viewport: { width: 640, height: 480 },
	signal: new AbortController().signal,
});

describe("GenUI capture bounds", () => {
	test("keeps Chrome sandboxes enabled and uses private debugging pipes", () => {
		const options = captureLaunchOptions("/test/chrome", input().signal);
		expect(options.pipe).toBe(true);
		expect(options.debuggingPort).toBeUndefined();
		expect(options.userDataDir).toBeUndefined();
		expect(options.handleSIGINT).toBe(false);
		expect(options.handleSIGTERM).toBe(false);
		expect(options.handleSIGHUP).toBe(false);
		expect(
			options.args?.some(
				(arg) => arg.includes("no-sandbox") || arg.includes("disable-setuid-sandbox"),
			),
		).toBe(false);
		expect(options.args).toContain("--proxy-bypass-list=<-loopback>");
		expect(options.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
	});

	test("refuses sandbox-disabling switches in the final Chrome argv", () => {
		for (const option of [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-seccomp-filter-sandbox",
			"--disable-namespace-sandbox",
			"--disable-gpu-sandbox=true",
			"--disable-landlock-sandbox",
			"--allow-sandbox-debugging",
			"--single-process",
			"--in-process-gpu",
			"--no-zygote",
		]) {
			expect(() => assertCaptureSandboxArgs(["--headless=new", option])).toThrow(
				"refused unsafe Chrome argument",
			);
		}
		expect(() =>
			assertCaptureSandboxArgs(["--headless=new", "--remote-debugging-pipe"]),
		).not.toThrow();
	});

	test("fails before spawn when Puppeteer environment injects no-sandbox", async () => {
		const previousDangerous = process.env.PUPPETEER_DANGEROUS_NO_SANDBOX;
		const previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
			throw new Error("Chrome must not be spawned");
		});
		try {
			process.env.PUPPETEER_DANGEROUS_NO_SANDBOX = "true";
			process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
			const result = await captureGenUiSnapshot(input());
			expect(result.failed).toBe(true);
			expect(result.images).toEqual([]);
			expect(result.diagnostics.join(" ")).toContain("refused unsafe Chrome argument --no-sandbox");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			if (previousDangerous === undefined) delete process.env.PUPPETEER_DANGEROUS_NO_SANDBOX;
			else process.env.PUPPETEER_DANGEROUS_NO_SANDBOX = previousDangerous;
			if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
			else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
		}
	});

	test("rejects oversized fragmented CDP before forwarding to Puppeteer", () => {
		const read = new PassThrough();
		const write = new PassThrough();
		let violation = "";
		let received = 0;
		const transport = createBoundedCaptureTransport(read, write, input().signal, (error) => {
			violation = error.message;
		});
		transport.onmessage = () => {
			received++;
		};
		read.write(Buffer.alloc(2 * 1024 * 1024, 120));
		read.write(Buffer.alloc(3 * 1024 * 1024, 120));
		expect(violation).toContain("4MiB");
		expect(received).toBe(0);
		expect(read.destroyed).toBe(true);
		expect(write.destroyed).toBe(true);
		transport.close();
	});

	test("enforces pre-parse CDP rate and aggregate budgets", () => {
		for (const mode of ["events", "bytes", "total"] as const) {
			const read = new PassThrough();
			const write = new PassThrough();
			let clock = 0;
			let violation = "";
			let received = 0;
			const transport = createBoundedCaptureTransport(
				read,
				write,
				input().signal,
				(error) => {
					violation = error.message;
				},
				() => clock,
			);
			transport.onmessage = () => {
				received++;
			};
			if (mode === "events") {
				read.write(Buffer.from("{}\0".repeat(1100)));
				expect(violation).toContain("event-rate");
				expect(received).toBe(1000);
			} else {
				const message = Buffer.alloc(3 * 1024 * 1024, 120);
				message[message.length - 1] = 0;
				for (let i = 0; i < (mode === "total" ? 6 : 3); i++) {
					if (mode === "total") clock += 1000;
					read.write(message);
				}
				expect(violation).toContain("byte budget");
				expect(received).toBe(mode === "total" ? 5 : 2);
			}
			transport.close();
		}
	});

	test("reassembles bounded multibyte CDP frames and closes on abort", () => {
		const read = new PassThrough();
		const write = new PassThrough();
		const controller = new AbortController();
		const transport = createBoundedCaptureTransport(read, write, controller.signal, () => {
			throw new Error("unexpected violation");
		});
		const messages: string[] = [];
		transport.onmessage = (message) => messages.push(message);
		const payload = Buffer.from('{"value":"中文"}\0{}\0');
		read.write(payload.subarray(0, 12));
		read.write(payload.subarray(12));
		expect(messages).toEqual(['{"value":"中文"}', "{}"]);
		controller.abort();
		expect(read.destroyed).toBe(true);
		expect(write.destroyed).toBe(true);
	});

	test("validates pixel, dimensions, HTML and markup budgets", () => {
		expect(() => validateCaptureInput(input())).not.toThrow();
		for (const viewport of [
			{ width: 2000, height: 1001 },
			{ width: 0, height: 10 },
			{ width: 1.1, height: 10 },
			{ width: 5000, height: 1 },
			{ width: Number.NaN, height: 1 },
		]) {
			expect(() => validateCaptureInput({ ...input(), viewport })).toThrow("viewport");
		}
		expect(() =>
			validateCaptureInput({ ...input(), html: "x".repeat(CAPTURE_LIMITS.htmlBytes + 1) }),
		).toThrow("HTML");
		expect(() =>
			validateCaptureInput({ ...input(), tree: [{ $node: "text", text: "valid" }] }),
		).not.toThrow();
		expect(() =>
			validateCaptureInput({
				...input(),
				tree: [{ $node: "text", text: "中".repeat(CAPTURE_LIMITS.treeBytes / 3) }],
			}),
		).toThrow("markup tree exceeds");
	});

	test("bounds diagnostics while collecting, including multibyte Unicode", () => {
		const diagnostics = createCaptureDiagnostics();
		for (let i = 0; i < 100; i++) diagnostics.add(`${i}: ${"错误😀".repeat(3000)}`);
		expect(diagnostics.entries.length).toBeLessThanOrEqual(20);
		expect(diagnostics.entries.every((entry) => Buffer.byteLength(entry) <= 2048)).toBe(true);
		expect(
			diagnostics.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0),
		).toBeLessThanOrEqual(16384);
		const short = createCaptureDiagnostics();
		for (let i = 0; i < 100; i++) short.add(`diagnostic ${i}`);
		expect(short.entries).toHaveLength(20);
	});

	test("returns bounded failure without launching for invalid input or pre-abort", async () => {
		const invalid = await captureGenUiSnapshot({
			...input(),
			viewport: { width: 2000, height: 2000 },
		});
		expect(invalid.failed).toBe(true);
		expect(invalid.images).toEqual([]);
		const controller = new AbortController();
		controller.abort(new Error("test cancellation"));
		const aborted = await captureGenUiSnapshot({ ...input(), signal: controller.signal });
		expect(aborted.failed).toBe(true);
		expect(aborted.diagnostics).toEqual(["test cancellation"]);
	});
});
