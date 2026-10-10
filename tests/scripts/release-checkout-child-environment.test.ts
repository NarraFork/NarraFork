import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertPrimaryReleaseCheckout } from "../../scripts/ci-release";

test("primary checkout probe strips upload authority from its actual git child", async () => {
	const directory = await mkdtemp(join(tmpdir(), "release-checkout-env-"));
	const record = join(directory, "child.json");
	const keys = ["PATH", "NF_UPDATE_TOKEN", "NF_UPDATE_SERVER", "nf_update_token", "GH_TOKEN"];
	const original = new Map(keys.map((key) => [key, process.env[key]]));
	try {
		const script = join(directory, "git");
		await writeFile(
			script,
			`#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ uploadAuthorityPresent: Object.keys(process.env).some(key => /^(NF_UPDATE_TOKEN|NF_UPDATE_SERVER)$/i.test(key)), githubAuthPreserved: process.env.GH_TOKEN === "fixture-github-auth" }));\nconsole.log("/fixture/.git\\n/fixture/.git");\n`,
		);
		await chmod(script, 0o700);
		process.env.PATH = `${directory}${delimiter}${original.get("PATH") ?? ""}`;
		process.env.NF_UPDATE_TOKEN = "fixture-upload-secret";
		process.env.NF_UPDATE_SERVER = "https://fixture-mirror.example";
		process.env.nf_update_token = "fixture-lowercase-secret";
		process.env.GH_TOKEN = "fixture-github-auth";
		assertPrimaryReleaseCheckout(directory);
		expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
			uploadAuthorityPresent: false,
			githubAuthPreserved: true,
		});
		expect(process.env.NF_UPDATE_TOKEN).toBe("fixture-upload-secret");
		expect(process.env.nf_update_token).toBe("fixture-lowercase-secret");
	} finally {
		for (const [key, value] of original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
});
