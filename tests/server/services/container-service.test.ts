import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { chapters, containerInstances, portAllocations, projects } from "../../../server/db/schema";
import { buildProxyUrl } from "../../../server/services/container-proxy";
import {
	buildComposeEnv,
	type ContainerConfig,
	resolveComposeFile,
	resolveProxyPortHints,
} from "../../../server/services/container-service";
import { cleanDb, getTestDb } from "../../setup";

// ─── Test DB ───
const { db, sqlite } = getTestDb();
afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

function seedProject(id = "p1") {
	db.insert(projects)
		.values({ id, name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
}

function seedChapter(id = "ch1", extra: Record<string, unknown> = {}) {
	seedProject();
	db.insert(chapters)
		.values({
			id,
			projectId: "p1",
			title: "Ch",
			branch: "chapter/ch-abc",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
			...extra,
		})
		.run();
}

// ─── Temp directory helpers ───
let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = join(tmpdir(), `nf-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tmpDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	tmpDirs = [];
});

// ═══════════════════════════════════════════════════════════════
// resolveComposeFile
// ═══════════════════════════════════════════════════════════════
describe("resolveComposeFile", () => {
	it("returns null when no compose file exists", () => {
		const dir = makeTmpDir();
		expect(resolveComposeFile(dir, null)).toBeNull();
	});

	it("finds compose.yml by default", () => {
		const dir = makeTmpDir();
		const file = join(dir, "compose.yml");
		writeFileSync(file, "version: '3'");
		expect(resolveComposeFile(dir, null)).toBe(file);
	});

	it("finds compose.yaml by default", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "compose.yaml"), "version: '3'");
		expect(resolveComposeFile(dir, null)).toBe(join(dir, "compose.yaml"));
	});

	it("does not match docker-compose.yml", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "docker-compose.yml"), "version: '3'");
		expect(resolveComposeFile(dir, null)).toBeNull();
	});

	it("does not match docker-compose.yaml", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "docker-compose.yaml"), "version: '3'");
		expect(resolveComposeFile(dir, null)).toBeNull();
	});

	it("uses config.composeFile when specified", () => {
		const dir = makeTmpDir();
		const sub = join(dir, "infra");
		mkdirSync(sub, { recursive: true });
		const file = join(sub, "my-compose.yml");
		writeFileSync(file, "version: '3'");

		const config: ContainerConfig = { composeFile: "infra/my-compose.yml" };
		expect(resolveComposeFile(dir, config)).toBe(file);
	});

	it("returns null when config.composeFile does not exist", () => {
		const dir = makeTmpDir();
		const config: ContainerConfig = { composeFile: "nonexistent.yml" };
		expect(resolveComposeFile(dir, config)).toBeNull();
	});

	it("blocks path traversal via config.composeFile", () => {
		const dir = makeTmpDir();
		// Create a file outside the worktree
		const outside = makeTmpDir();
		writeFileSync(join(outside, "evil.yml"), "version: '3'");

		const config: ContainerConfig = { composeFile: `../../${outside}/evil.yml` };
		expect(resolveComposeFile(dir, config)).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════
// buildComposeEnv
// ═══════════════════════════════════════════════════════════════
describe("buildComposeEnv", () => {
	it("sets NARRAFORK_CHAPTER_ID", () => {
		const env = buildComposeEnv("ch-abc123", [], null);
		expect(env.NARRAFORK_CHAPTER_ID).toBe("ch-abc123");
	});

	it("sets NARRAFORK_VOLUME_PREFIX from first 12 chars of chapterId", () => {
		const env = buildComposeEnv("abcdefghijklmnop", [], null);
		expect(env.NARRAFORK_VOLUME_PREFIX).toBe("nf_abcdefghijkl");
	});

	it("maps port mappings to PORT_<containerPort> env vars", () => {
		const env = buildComposeEnv(
			"ch1",
			[
				{ hostPort: 10000, containerPort: 3000, serviceName: "web" },
				{ hostPort: 10001, containerPort: 5432, serviceName: "db" },
			],
			null,
		);
		expect(env.PORT_3000).toBe("10000");
		expect(env.PORT_5432).toBe("10001");
	});

	it("merges config.env", () => {
		const config: ContainerConfig = { env: { NODE_ENV: "test", DEBUG: "1" } };
		const env = buildComposeEnv("ch1", [], config);
		expect(env.NODE_ENV).toBe("test");
		expect(env.DEBUG).toBe("1");
	});

	it("config.env overrides port env vars", () => {
		const config: ContainerConfig = { env: { PORT_3000: "9999" } };
		const env = buildComposeEnv(
			"ch1",
			[{ hostPort: 10000, containerPort: 3000, serviceName: "web" }],
			config,
		);
		// config.env is applied after port mappings, so it wins
		expect(env.PORT_3000).toBe("9999");
	});

	it("returns only base env when no ports and no config", () => {
		const env = buildComposeEnv("ch1", [], null);
		expect(Object.keys(env)).toEqual(["NARRAFORK_CHAPTER_ID", "NARRAFORK_VOLUME_PREFIX"]);
	});

	it("injects proxy mode env and proxy URLs from config ports", () => {
		const config: ContainerConfig = {
			ports: [
				{ serviceName: "web", containerPort: 3000 },
				{ serviceName: "api", containerPort: 8080 },
			],
		};
		const env = buildComposeEnv("chapter-abcdef123456", [], config, {
			domain: "dev.localhost",
			port: 7780,
			chapterShortId: "chap1234",
		});
		expect(env.NARRAFORK_PROXY).toBe("1");
		expect(env.NARRAFORK_PROXY_DOMAIN).toBe("dev.localhost");
		expect(env.NARRAFORK_PROXY_URL_3000).toBe(
			buildProxyUrl("chap1234-web-3000", "dev.localhost", 7780),
		);
		expect(env.NARRAFORK_PROXY_URL_8080).toBe(
			buildProxyUrl("chap1234-api-8080", "dev.localhost", 7780),
		);
		expect(env.PORT_3000).toBeUndefined();
	});
});

describe("resolveProxyPortHints", () => {
	it("merges compose/config/inspect ports with de-duplication", () => {
		const hints = resolveProxyPortHints(
			new Map([
				["web", [3000, 8080]],
				["worker", [7000]],
			]),
			new Map([
				["web", [8080, 9000]],
				["api", [5000]],
			]),
			new Map([
				["web", [3000, 10000]],
				["api", [6000]],
			]),
		);

		const normalized = hints
			.map((h) => `${h.serviceName}:${h.containerPort}`)
			.sort((a, b) => a.localeCompare(b));

		expect(normalized).toEqual([
			"api:5000",
			"api:6000",
			"web:10000",
			"web:3000",
			"web:8080",
			"web:9000",
			"worker:7000",
		]);
	});
});

// ═══════════════════════════════════════════════════════════════
// container_instances DB operations
// ═══════════════════════════════════════════════════════════════
describe("container_instances DB", () => {
	it("can insert and query container instances", () => {
		seedChapter();
		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				containerId: "abc123",
				serviceName: "web",
				status: "running",
				hostPort: 10000,
				containerPort: 3000,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const rows = db
			.select()
			.from(containerInstances)
			.where(eq(containerInstances.chapterId, "ch1"))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0].serviceName).toBe("web");
		expect(rows[0].hostPort).toBe(10000);
		expect(rows[0].containerPort).toBe(3000);
		expect(rows[0].status).toBe("running");
	});

	it("can update container status", () => {
		seedChapter();
		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				serviceName: "web",
				status: "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.update(containerInstances)
			.set({ status: "paused", updatedAt: new Date().toISOString() })
			.where(eq(containerInstances.id, "ci1"))
			.run();

		const row = db.select().from(containerInstances).where(eq(containerInstances.id, "ci1")).get();
		expect(row?.status).toBe("paused");
	});

	it("can delete container instances by chapter", () => {
		seedChapter();
		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				serviceName: "web",
				status: "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(containerInstances)
			.values({
				id: "ci2",
				chapterId: "ch1",
				serviceName: "api",
				status: "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.delete(containerInstances).where(eq(containerInstances.chapterId, "ch1")).run();

		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		const remaining = sqlite.prepare("SELECT count(*) as c FROM container_instances").get() as any;
		expect(remaining.c).toBe(0);
	});

	it("multiple chapters have independent container instances", () => {
		seedChapter("ch1");
		db.insert(chapters)
			.values({
				id: "ch2",
				projectId: "p1",
				title: "Ch2",
				branch: "chapter/ch2-def",
				baseBranch: "main",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				serviceName: "web",
				status: "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(containerInstances)
			.values({
				id: "ci2",
				chapterId: "ch2",
				serviceName: "web",
				status: "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// Delete ch1 instances only
		db.delete(containerInstances).where(eq(containerInstances.chapterId, "ch1")).run();

		const remaining = db.select().from(containerInstances).all();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].chapterId).toBe("ch2");
	});

	it("nullable fields default correctly", () => {
		seedChapter();
		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				serviceName: "worker",
				status: "created",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const row = db.select().from(containerInstances).where(eq(containerInstances.id, "ci1")).get();
		expect(row?.containerId).toBeNull();
		expect(row?.hostPort).toBeNull();
		expect(row?.containerPort).toBeNull();
		expect(row?.volumeName).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════
// port_allocations + container_instances interaction
// ═══════════════════════════════════════════════════════════════
describe("port allocations and container instances together", () => {
	it("can track ports alongside container instances for a chapter", () => {
		seedChapter();

		// Allocate ports
		db.insert(portAllocations)
			.values({ port: 10000, chapterId: "ch1", serviceName: "web", allocatedAt: now })
			.run();
		db.insert(portAllocations)
			.values({ port: 10001, chapterId: "ch1", serviceName: "api", allocatedAt: now })
			.run();

		// Record container instances with matching ports
		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				serviceName: "web",
				status: "running",
				hostPort: 10000,
				containerPort: 3000,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(containerInstances)
			.values({
				id: "ci2",
				chapterId: "ch1",
				serviceName: "api",
				status: "running",
				hostPort: 10001,
				containerPort: 8080,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const instances = db
			.select()
			.from(containerInstances)
			.where(eq(containerInstances.chapterId, "ch1"))
			.all();
		const ports = db
			.select()
			.from(portAllocations)
			.where(eq(portAllocations.chapterId, "ch1"))
			.all();

		expect(instances).toHaveLength(2);
		expect(ports).toHaveLength(2);
	});

	it("cleanup removes both container instances and port allocations", () => {
		seedChapter();

		db.insert(portAllocations)
			.values({ port: 10000, chapterId: "ch1", serviceName: "web", allocatedAt: now })
			.run();
		db.insert(containerInstances)
			.values({
				id: "ci1",
				chapterId: "ch1",
				serviceName: "web",
				status: "running",
				hostPort: 10000,
				containerPort: 3000,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// Simulate cleanup: delete both
		db.delete(containerInstances).where(eq(containerInstances.chapterId, "ch1")).run();
		db.delete(portAllocations).where(eq(portAllocations.chapterId, "ch1")).run();

		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		const ci = sqlite.prepare("SELECT count(*) as c FROM container_instances").get() as any;
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		const pa = sqlite.prepare("SELECT count(*) as c FROM port_allocations").get() as any;
		expect(ci.c).toBe(0);
		expect(pa.c).toBe(0);
	});
});
