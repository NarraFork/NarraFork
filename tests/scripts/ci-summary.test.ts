import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const summaryTest = test.skipIf(!Bun.which("python3"));
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "ci-summary-"));
	directories.push(directory);
	return {
		write: (name: string, text: string) => writeFileSync(join(directory, name), text),
		render: () => {
			const child = Bun.spawnSync(
				[
					"python3",
					"-I",
					new URL("../../scripts/summarize-ci-tests.py", import.meta.url).pathname,
					"--artifacts",
					directory,
					"--shard",
					"4/4",
				],
				{ timeout: 5_000 },
			);
			expect(child.exitCode).toBe(0);
			return child.stdout.toString();
		},
	};
}

const failure =
	'<testcase classname="M1" name="(unnamed)" file="tests/browser.ts" time="90"><failure message="test timed out">sensitive output</failure></testcase>';

summaryTest("reports a complete JUnit timeout and bounded stage/runner metadata", () => {
	const { write, render } = fixture();
	write("ci-tests.xml", `<testsuites><testsuite>${failure}</testsuite></testsuites>`);
	write(
		"native-tests-4-of-4-diagnostics.jsonl",
		'{"event":"exit","exitCode":1,"failure":"nonzero","private":"sensitive output"}\n',
	);
	write("ci-stage-browser.jsonl", '{"event":"start","phase":"go-peer-build"}\n');
	const summary = render();
	expect(summary).toContain("JUnit: **complete**; failed entries found: **1**");
	expect(summary).toContain("`M1 / (unnamed)` · timeout · 90 s");
	expect(summary).toContain("exitCode: `1`");
	expect(summary).toContain("phase: `go-peer-build`");
	expect(summary).not.toContain("sensitive output");
});

summaryTest("keeps completed failures from truncated XML and ignores malformed event lines", () => {
	const { write, render } = fixture();
	write("ci-tests.xml", `<testsuites><testsuite>${failure}<testcase name="interrupted`);
	write("ci-stage-a.jsonl", 'invalid\n{"phase":"chromium","event":"start"}\n{"unfinished":');
	const summary = render();
	expect(summary).toContain("truncated, malformed or incomplete");
	expect(summary).toContain("failed entries found: **1**");
	expect(summary).toContain("phase: `chromium`");
});

summaryTest(
	"still summarizes runner failures with no report, without forwarding untrusted markup",
	() => {
		const { write, render } = fixture();
		write(
			"native-tests-4-of-4-diagnostics.jsonl",
			'{"event":"timeout","failure":"`<script>alert(1)</script>"}\n',
		);
		const summary = render();
		expect(summary).toContain("missing or unreadable");
		expect(summary).toContain("event: `timeout`");
		expect(summary).not.toContain("<script>");
	},
);

summaryTest("keeps an unfinished stage visible after more recent stages have completed", () => {
	const { write, render } = fixture();
	write(
		"ci-stage-7.jsonl",
		'{"timestamp":"2026-01-01T00:00:00Z","pid":7,"phase":"webrtc-connect","event":"start"}\n',
	);
	write(
		"ci-stage-8.jsonl",
		Array.from({ length: 8 }, (_, index) =>
			JSON.stringify({
				timestamp: `2026-01-01T00:00:0${index + 1}Z`,
				pid: 8,
				phase: "chromium",
				event: index % 2 ? "end" : "start",
			}),
		).join("\n"),
	);
	const unfinished = render()
		.split("**Fixture stages with no recorded end**")[1]
		?.split("**Recent fixture stages**")[0];
	expect(unfinished).toContain("phase: `webrtc-connect`");
	expect(unfinished).not.toContain("chromium");
});
