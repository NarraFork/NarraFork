import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, install } from "@puppeteer/browsers";

// Keep all browser gates on the same build validated by the CI CDP/trace probe.
const buildId = "146.0.7680.31";
const temp = process.env.RUNNER_TEMP;
const environmentFile = process.env.GITHUB_ENV;
if (!temp || !environmentFile) throw new Error("Chrome installation requires runner paths");
const { executablePath } = await install({
	browser: Browser.CHROME,
	buildId,
	cacheDir: join(temp, "narrafork-ci-chrome"),
	baseUrl: "https://storage.googleapis.com/chrome-for-testing-public",
});
const version = spawnSync(executablePath, ["--version"], {
	encoding: "utf8",
	timeout: 15000,
	maxBuffer: 4096,
});
if (version.error || version.status !== 0)
	throw new Error("Chrome version command failed", { cause: version.error });
const expectedVersion = `Google Chrome for Testing ${buildId}`;
if (version.stdout.trim() !== expectedVersion)
	throw new Error(`Expected ${expectedVersion}; received ${version.stdout.trim()}`);
console.log(version.stdout.trim());
appendFileSync(
	environmentFile,
	`NF_TEST_CHROMIUM_PATH=${executablePath}\nPUPPETEER_EXECUTABLE_PATH=${executablePath}\n`,
);
