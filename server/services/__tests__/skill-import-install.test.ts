import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import { setOutboundFetchOverrideForTest } from "../../lib/net/outbound-fetch";
import * as writeQueue from "../file-write-queue";
import {
	createGlobalSkill,
	createProjectSkill,
	importGlobalSkill,
	importProjectSkill,
	loadProjectSkills,
	loadSkillSummariesForContext,
	SKILL_IMPORT_TIMEOUT_MS,
} from "../skill-service";

const URL = "https://github.com/example/skills/tree/main";
const TREE = "a".repeat(40);
let root: string;
let skillName: string;
const cleanup: string[] = [];

function markdown(name = skillName) {
	return `---\nname: ${name}\ndescription: Imported description\nlicense: See LICENSE.txt\nmetadata:\n  short-description: concise\n---\n\n# Original body\n`;
}

function githubFixture(files: Record<string, string | Uint8Array>) {
	const entries = Object.entries(files).map(([path, content], index) => {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		return { path, bytes, sha: (index + 1).toString(16).padStart(40, "0") };
	});
	const directories = new Set<string>();
	for (const { path } of entries) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
	}
	const tree = [
		...Array.from(directories, (path) => ({
			path,
			sha: "b".repeat(40),
			type: "tree",
			mode: "040000",
		})),
		...entries.map(({ path, bytes, sha }) => ({
			path,
			sha,
			type: "blob",
			mode: path.endsWith(".sh") ? "100755" : "100644",
			size: bytes.byteLength,
		})),
	];
	setOutboundFetchOverrideForTest(async (input) => {
		const url = new globalThis.URL(String(input));
		if (url.pathname.includes("/git/trees/")) {
			return Response.json({
				sha: TREE,
				truncated: false,
				tree: url.search ? tree : tree.filter((e) => !e.path.includes("/")),
			});
		}
		const file = entries.find((entry) => url.pathname.endsWith(`/git/blobs/${entry.sha}`));
		return file ? new Response(new Uint8Array(file.bytes)) : new Response(null, { status: 404 });
	});
}

async function directories() {
	return fs.readdir(join(root, ".narrafork", "skills")).catch(() => []);
}

beforeEach(async () => {
	root = await fs.mkdtemp(join(getNarraforkHome(), "import-project-"));
	cleanup.push(root);
	skillName = `import-${generateId()
		.replace(/[^a-z0-9]/gi, "")
		.toLowerCase()}`;
});

afterEach(async () => {
	setOutboundFetchOverrideForTest(null);
	for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

describe("GitHub skill installation", () => {
	test("preserves raw YAML, license, binary, executable and sidecar; invalidates summaries", async () => {
		const context = { projectGitPath: root, cwd: root };
		expect(
			(await loadSkillSummariesForContext(context)).skills.some((s) => s.name === skillName),
		).toBe(false);
		const original = markdown();
		const binary = new Uint8Array([0, 128, 255, 42]);
		githubFixture({
			"SKILL.md": original,
			"LICENSE.txt": "Example license",
			"asset.bin": binary,
			"script.sh": "#!/bin/sh\nexit 0\n",
			"agents/openai.yaml":
				"interface:\n  display_name: Imported title\npolicy:\n  allow_implicit_invocation: false\n",
		});
		const result = await importProjectSkill(root, URL);
		const installed = join(root, ".narrafork", "skills", skillName);
		expect(result.location).toBe(join(installed, "SKILL.md"));
		expect(result.displayName).toBe("Imported title");
		expect(result.allowImplicitInvocation).toBe(false);
		expect(result.shortDescription).toBe("concise");
		expect(await fs.readFile(result.location, "utf8")).toBe(original);
		expect(new Uint8Array(await fs.readFile(join(installed, "asset.bin")))).toEqual(binary);
		expect(await fs.readFile(join(installed, "LICENSE.txt"), "utf8")).toBe("Example license");
		if (process.platform !== "win32")
			expect((await fs.stat(join(installed, "script.sh"))).mode & 0o111).toBe(0o111);
		expect((await loadProjectSkills(root)).some((s) => s.name === skillName)).toBe(true);
		expect(
			(await loadSkillSummariesForContext(context)).skills.some((s) => s.name === skillName),
		).toBe(true);
		expect(await directories()).toEqual([skillName]);
	});

	test("global imports honor NARRAFORK_HOME", async () => {
		githubFixture({ "SKILL.md": markdown(), "LICENSE.txt": "license" });
		const target = join(getNarraforkHome(), "skills", skillName);
		cleanup.push(target);
		const result = await importGlobalSkill(URL);
		expect(result.location).toBe(join(target, "SKILL.md"));
		expect(await fs.readFile(result.location, "utf8")).toBe(markdown());
	});

	test("manual global creation still supports a user-managed skills junction", async () => {
		const originalHome = process.env.NARRAFORK_HOME;
		const outside = await fs.mkdtemp(join(getNarraforkHome(), "manual-linked-skills-"));
		cleanup.push(outside);
		await fs.symlink(outside, join(root, "skills"), "junction");
		process.env.NARRAFORK_HOME = root;
		try {
			const result = await createGlobalSkill(skillName, "manual", "manual body");
			expect(result.name).toBe(skillName);
			expect(await fs.readFile(join(outside, skillName, "SKILL.md"), "utf8")).toContain(
				"manual body",
			);
		} finally {
			if (originalHome === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = originalHome;
		}
	});

	test("overlapping global and project destinations use the same real queue", async () => {
		const originalHome = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = join(root, ".narrafork");
		githubFixture({ "SKILL.md": markdown() });
		const original = writeQueue.withFileWrite;
		const keys: string[] = [];
		const spy = spyOn(writeQueue, "withFileWrite").mockImplementation((target, body, options) => {
			keys.push(target.canonicalPath);
			return original(target, body, options);
		});
		try {
			const outcomes = await Promise.allSettled([
				importProjectSkill(root, URL),
				createGlobalSkill(skillName, "manual", "manual body"),
			]);
			expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(keys).toHaveLength(2);
			expect(keys[0]).toBe(keys[1]);
			expect(await directories()).toEqual([skillName]);
		} finally {
			spy.mockRestore();
			if (originalHome === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = originalHome;
		}
	});

	test("does not overwrite an existing skill, including disabled skills and other search roots", async () => {
		const existing = join(root, ".claude", "skills", "already-here");
		await fs.mkdir(existing, { recursive: true });
		await fs.writeFile(join(existing, "SKILL.md.disabled"), markdown());
		githubFixture({ "SKILL.md": markdown() });
		await expect(importProjectSkill(root, URL)).rejects.toThrow("already exists");
		expect(await fs.readFile(join(existing, "SKILL.md.disabled"), "utf8")).toBe(markdown());
		expect(await directories()).toEqual([]);
	});

	test("does not replace an existing empty destination directory", async () => {
		const target = join(root, ".narrafork", "skills", skillName);
		await fs.mkdir(target, { recursive: true });
		githubFixture({ "SKILL.md": markdown() });
		await expect(importProjectSkill(root, URL)).rejects.toThrow("already exists");
		expect(await fs.readdir(target)).toEqual([]);
	});

	test("serializes simultaneous imports of the same skill", async () => {
		githubFixture({ "SKILL.md": markdown() });
		const outcomes = await Promise.allSettled([
			importProjectSkill(root, URL),
			importProjectSkill(root, URL),
		]);
		expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
		expect(await directories()).toEqual([skillName]);
	});

	test("shares its creation lock with manual creation", async () => {
		githubFixture({ "SKILL.md": markdown() });
		const outcomes = await Promise.allSettled([
			importProjectSkill(root, URL),
			createProjectSkill(root, skillName, "manual description", "manual content"),
		]);
		expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(await directories()).toEqual([skillName]);
	});

	test.each([
		"---\nname: missing-description\n---\nbody",
		"plain text",
		"---\nname: con\ndescription: reserved\n---\nbody",
	])("rejects invalid metadata before writing: %s", async (raw) => {
		githubFixture({ "SKILL.md": raw });
		await expect(importProjectSkill(root, URL)).rejects.toThrow();
		expect(await directories()).toEqual([]);
	});

	test("never evaluates JavaScript-tagged frontmatter", async () => {
		const key = `__skill_import_probe_${generateId()}`;
		githubFixture({
			"SKILL.md": `---javascript\n(globalThis[${JSON.stringify(key)}] = true, {name: '${skillName}', description: 'bad'})\n---\nbody`,
		});
		await expect(importProjectSkill(root, URL)).rejects.toThrow("YAML");
		expect(Reflect.get(globalThis, key)).toBeUndefined();
		expect(await directories()).toEqual([]);
	});

	test("rejects a symlink in the destination ancestry", async () => {
		const outside = await fs.mkdtemp(join(getNarraforkHome(), "import-outside-"));
		cleanup.push(outside);
		await fs.symlink(outside, join(root, ".narrafork"), "junction");
		githubFixture({ "SKILL.md": markdown() });
		await expect(importProjectSkill(root, URL)).rejects.toThrow("symbolic links");
		expect(await fs.readdir(outside)).toEqual([]);
	});

	test("cleans the hidden staging directory after a write failure", async () => {
		githubFixture({ "SKILL.md": markdown(), "LICENSE.txt": "license" });
		const original = fs.writeFile;
		const spy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (String(args[0]).endsWith("LICENSE.txt")) throw new Error("injected write failure");
			return original(...args);
		});
		try {
			await expect(importProjectSkill(root, URL)).rejects.toThrow("injected write failure");
		} finally {
			spy.mockRestore();
		}
		expect(await directories()).toEqual([]);
	});

	test("cancellation during staging leaves no published or temporary skill", async () => {
		const controller = new AbortController();
		githubFixture({ "SKILL.md": markdown(), "LICENSE.txt": "license" });
		const original = fs.writeFile;
		const spy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			const value = await original(...args);
			if (String(args[0]).endsWith("LICENSE.txt")) controller.abort();
			return value;
		});
		try {
			await expect(importProjectSkill(root, URL, controller.signal)).rejects.toThrow("cancelled");
		} finally {
			spy.mockRestore();
		}
		expect(await directories()).toEqual([]);
	});

	test("admission is bounded to two imports and cancelled slots are released", async () => {
		setOutboundFetchOverrideForTest(() => new Promise(() => {}));
		const controller = new AbortController();
		const a = importProjectSkill(root, URL, controller.signal);
		const b = importProjectSkill(root, URL, controller.signal);
		const pending = Promise.allSettled([a, b]);
		await expect(importProjectSkill(root, URL)).rejects.toThrow("already running");
		controller.abort();
		expect((await pending).every((result) => result.status === "rejected")).toBe(true);
		githubFixture({ "SKILL.md": markdown() });
		expect((await importProjectSkill(root, URL)).name).toBe(skillName);
	});

	test("the overall deadline covers stalled requests", async () => {
		setOutboundFetchOverrideForTest(() => new Promise(() => {}));
		const original = globalThis.setTimeout;
		let shortened = false;
		const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [fn, ms, ...rest] = args;
			if (ms === SKILL_IMPORT_TIMEOUT_MS) shortened = true;
			return original(fn, ms === SKILL_IMPORT_TIMEOUT_MS ? 10 : ms, ...rest);
		}) as typeof setTimeout);
		try {
			await expect(importProjectSkill(root, URL)).rejects.toThrow("timed out");
			expect(shortened).toBe(true);
		} finally {
			spy.mockRestore();
		}
		expect(await directories()).toEqual([]);
	});
});
