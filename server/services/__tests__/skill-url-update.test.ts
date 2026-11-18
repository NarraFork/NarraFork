import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import { setOutboundFetchOverrideForTest } from "../../lib/net/outbound-fetch";
import * as links from "../skill-link-download";
import {
	createProjectSkill,
	deleteProjectSkill,
	describeSkillManagement,
	importGlobalSkill,
	importProjectSkill,
	loadGlobalSkills,
	loadProjectSkills,
	loadSkillSummariesForContext,
	toggleGlobalSkill,
	updateGlobalSkill,
	updateGlobalSkillFromUrl,
	updateProjectSkill,
	updateProjectSkillFromUrl,
} from "../skill-service";

const url = "https://github.com/example/skills/tree/main";
const rawUrl = "https://gitee.com/example/skills/raw/main/SKILL.md";
const treeSha = "a".repeat(40);
let root: string;
let name: string;
let calls: string[];
const cleanup: string[] = [];

function markdown(body = "original", skillName = name) {
	return `---\nname: ${skillName}\ndescription: Link update example\nlicense: LICENSE.txt\n---\n\n${body}\n`;
}

function fixture(files: Record<string, string | Uint8Array>, gate?: () => Promise<void>) {
	const entries = Object.entries(files).map(([path, value], i) => ({
		path,
		sha: (i + 1).toString(16).padStart(40, "0"),
		bytes: typeof value === "string" ? new TextEncoder().encode(value) : value,
	}));
	const dirs = new Set<string>();
	for (const e of entries) {
		const parts = e.path.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	const tree = [
		...Array.from(dirs, (path) => ({ path, sha: "b".repeat(40), mode: "040000", type: "tree" })),
		...entries.map((e) => ({
			path: e.path,
			sha: e.sha,
			size: e.bytes.length,
			mode: "100644",
			type: "blob",
		})),
	];
	setOutboundFetchOverrideForTest(async (input) => {
		const request = new URL(String(input));
		calls.push(request.pathname + request.search);
		if (request.pathname.includes("/git/trees/"))
			return Response.json({
				sha: treeSha,
				truncated: false,
				tree: request.search ? tree : tree.filter((e) => !e.path.includes("/")),
			});
		await gate?.();
		const entry = entries.find((e) => request.pathname.endsWith(`/blobs/${e.sha}`));
		return entry ? new Response(new Uint8Array(entry.bytes)) : new Response(null, { status: 404 });
	});
}

function latch() {
	let release!: () => void;
	let notify!: () => void;
	const started = new Promise<void>((r) => {
		notify = r;
	});
	const wait = new Promise<void>((r) => {
		release = r;
	});
	return {
		started,
		release,
		gate: async () => {
			notify();
			await wait;
		},
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(join(getNarraforkHome(), "skill-update-"));
	cleanup.push(root);
	name = `update-${generateId()
		.replace(/[^a-z0-9]/gi, "")
		.toLowerCase()}`;
	calls = [];
});
afterEach(async () => {
	setOutboundFetchOverrideForTest(null);
	for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

describe("skill update from a link", () => {
	test("directory links replace old companions, update binary files and invalidate caches without source state", async () => {
		fixture({ "SKILL.md": markdown(), "old.txt": "remove" });
		await importProjectSkill(root, url);
		const context = { cwd: root, projectGitPath: root };
		await loadSkillSummariesForContext(context);
		fixture({ "SKILL.md": markdown("updated"), "asset.bin": new Uint8Array([0, 255, 128]) });
		const result = await updateProjectSkillFromUrl(root, name, url);
		expect(result.content).toBe("updated");
		expect(result.canUpdateFromUrl).toBe(true);
		const installed = join(root, ".narrafork", "skills", name);
		expect((await fs.readdir(installed)).sort()).toEqual(["SKILL.md", "asset.bin"]);
		expect(new Uint8Array(await fs.readFile(join(installed, "asset.bin")))).toEqual(
			new Uint8Array([0, 255, 128]),
		);
		expect((await loadProjectSkills(root)).find((s) => s.name === name)?.content).toBe("updated");
		expect((await loadSkillSummariesForContext(context)).skills.some((s) => s.name === name)).toBe(
			true,
		);
		expect(await fs.readdir(join(root, ".narrafork", "skills"))).toEqual([name]);
	});

	test("any-site raw Markdown updates only the definition, preserving binary companions and sidecar metadata", async () => {
		fixture({
			"SKILL.md": markdown(),
			"asset.bin": new Uint8Array([0, 255]),
			"agents/openai.yaml": "interface:\n  display_name: Existing title\n",
		});
		await importProjectSkill(root, url);
		// A definition-only update must not inspect or reject unrelated large attachments.
		await fs.writeFile(
			join(root, ".narrafork", "skills", name, "large.bin"),
			new Uint8Array(2 * 1024 * 1024),
		);
		const spy = spyOn(links, "downloadSkillLink").mockImplementation(async (requested) => {
			expect(requested).toBe(rawUrl);
			return {
				kind: "markdown",
				files: [{ path: "SKILL.md", bytes: new TextEncoder().encode(markdown("raw update")) }],
			};
		});
		try {
			const result = await updateProjectSkillFromUrl(root, name, rawUrl);
			expect(result.content).toBe("raw update");
			expect(result.displayName).toBe("Existing title");
			const installed = join(root, ".narrafork", "skills", name);
			expect(new Uint8Array(await fs.readFile(join(installed, "asset.bin")))).toEqual(
				new Uint8Array([0, 255]),
			);
		} finally {
			spy.mockRestore();
		}
	});

	test("raw Markdown links can also create skills with no repository metadata files", async () => {
		const spy = spyOn(links, "downloadSkillLink").mockResolvedValue({
			kind: "markdown",
			files: [{ path: "SKILL.md", bytes: new TextEncoder().encode(markdown()) }],
		});
		try {
			const result = await importProjectSkill(root, rawUrl);
			expect(result.name).toBe(name);
			expect(await fs.readdir(join(root, ".narrafork", "skills", name))).toEqual(["SKILL.md"]);
		} finally {
			spy.mockRestore();
		}
	});

	test("existing manually created skills can update immediately from a link", async () => {
		await createProjectSkill(root, name, "local", "local content");
		fixture({ "SKILL.md": markdown("linked") });
		expect((await updateProjectSkillFromUrl(root, name, url)).content).toBe("linked");
	});

	test("keeps a disabled global skill disabled", async () => {
		fixture({ "SKILL.md": markdown() });
		cleanup.push(join(getNarraforkHome(), "skills", name));
		await importGlobalSkill(url);
		await toggleGlobalSkill(name, false);
		fixture({ "SKILL.md": markdown("new disabled content") });
		const result = await updateGlobalSkillFromUrl(name, url);
		expect(result.disabled).toBe(true);
		expect(result.location).toEndWith("SKILL.md.disabled");
		expect((await loadGlobalSkills()).find((s) => s.name === name)?.disabled).toBe(true);
	});

	test("rejects mismatching names and external scan roots without modifying a skill", async () => {
		await createProjectSkill(root, name, "local", "local content");
		fixture({ "SKILL.md": markdown("wrong", "other-name") });
		await expect(updateProjectSkillFromUrl(root, name, url)).rejects.toThrow("name must match");
		expect((await loadProjectSkills(root)).find((s) => s.name === name)?.content).toBe(
			"local content",
		);
		const dir = join(root, ".claude", "skills", "external");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(join(dir, "SKILL.md"), markdown("external", "external"));
		const external = (await loadProjectSkills(root)).find((s) => s.name === "external");
		if (!external) throw new Error("Expected external skill fixture");
		expect((await describeSkillManagement(root, external)).canUpdateFromUrl).toBe(false);
		calls.length = 0;
		await expect(updateProjectSkillFromUrl(root, "external", url)).rejects.toThrow("Only skills");
		expect(calls).toHaveLength(0);
	});

	test.each([
		"edit",
		"delete",
	] as const)("concurrent %s cannot be overwritten by an older link download", async (action) => {
		fixture({ "SKILL.md": markdown() });
		await importProjectSkill(root, url);
		const gate = latch();
		fixture({ "SKILL.md": markdown("stale") }, gate.gate);
		const outcome = updateProjectSkillFromUrl(root, name, url).catch((error) => error);
		await gate.started;
		if (action === "edit") await updateProjectSkill(root, name, name, "edited", "new local body");
		else await deleteProjectSkill(root, name);
		gate.release();
		expect(await outcome).toBeInstanceOf(Error);
		const skill = (await loadProjectSkills(root)).find((s) => s.name === name);
		if (action === "edit") expect(skill?.content).toBe("new local body");
		else expect(skill).toBeUndefined();
	});

	test("changing enabled state during download prevents stale publishing", async () => {
		fixture({ "SKILL.md": markdown() });
		cleanup.push(join(getNarraforkHome(), "skills", name));
		await importGlobalSkill(url);
		const gate = latch();
		fixture({ "SKILL.md": markdown("stale") }, gate.gate);
		const outcome = updateGlobalSkillFromUrl(name, url).catch((error) => error);
		await gate.started;
		await toggleGlobalSkill(name, false);
		gate.release();
		expect(await outcome).toBeInstanceOf(Error);
		const current = (await loadGlobalSkills()).find((s) => s.name === name);
		expect(current?.disabled).toBe(true);
		expect(current?.content).toBe("original");
	});

	test("upstream failure and cancellation preserve the original skill", async () => {
		fixture({ "SKILL.md": markdown() });
		const skill = await importProjectSkill(root, url);
		setOutboundFetchOverrideForTest(async () => new Response(null, { status: 429 }));
		await expect(updateProjectSkillFromUrl(root, name, url)).rejects.toThrow("rate limit");
		const gate = latch();
		fixture({ "SKILL.md": markdown("cancelled") }, gate.gate);
		const controller = new AbortController();
		const outcome = updateProjectSkillFromUrl(root, name, url, controller.signal).catch(
			(error) => error,
		);
		await gate.started;
		controller.abort();
		gate.release();
		expect(await outcome).toBeInstanceOf(Error);
		expect(await fs.readFile(skill.location, "utf8")).toBe(markdown());
	});

	test("rejects excessive YAML alias work before parsing or publishing", async () => {
		await createProjectSkill(root, name, "local", "local body");
		fixture({
			"SKILL.md": `---\nname: ${name}\ndescription: test\nbase: &base {a: 0}\nextra: { <<: [*base, *base] }\n---\nbody`,
		});
		await expect(updateProjectSkillFromUrl(root, name, url)).rejects.toThrow();
		expect((await loadProjectSkills(root)).find((s) => s.name === name)?.content).toBe(
			"local body",
		);
	});

	test("manual descriptions containing markdown emphasis and anchor-like text remain valid", async () => {
		const description = "Build *React* interfaces & accessible components";
		await createProjectSkill(root, name, description, "body");
		const result = await updateProjectSkill(root, name, name, description, "edited");
		expect(result.description).toBe(description);
		expect((await loadProjectSkills(root)).find((s) => s.name === name)?.content).toBe("edited");
	});

	test("global leaf junctions cannot bypass a project directory lock", async () => {
		fixture({ "SKILL.md": markdown() });
		const skill = await importProjectSkill(root, url);
		const originalHome = process.env.NARRAFORK_HOME;
		const home = await fs.mkdtemp(join(getNarraforkHome(), "global-alias-"));
		cleanup.push(home);
		await fs.mkdir(join(home, "skills"));
		await fs.symlink(
			join(root, ".narrafork", "skills", name),
			join(home, "skills", "alias"),
			"junction",
		);
		process.env.NARRAFORK_HOME = home;
		try {
			await expect(updateGlobalSkill(name, name, "unsafe", "unsafe")).rejects.toThrow(
				"symbolic links",
			);
			expect(await fs.readFile(skill.location, "utf8")).toBe(markdown());
		} finally {
			if (originalHome === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = originalHome;
		}
	});

	test("directory publication failure restores the original skill", async () => {
		fixture({ "SKILL.md": markdown() });
		const skill = await importProjectSkill(root, url);
		fixture({ "SKILL.md": markdown("failed") });
		const original = fs.rename;
		const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(from).includes(".update-")) throw new Error("injected publish failure");
			return original(from, to);
		});
		try {
			await expect(updateProjectSkillFromUrl(root, name, url)).rejects.toThrow();
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(skill.location, "utf8")).toBe(markdown());
	});
});
