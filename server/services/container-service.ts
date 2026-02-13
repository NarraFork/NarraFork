import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, containerInstances } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { type PortMapping, portAllocator } from "./port-allocator";

export interface ContainerConfig {
	composeFile?: string;
	services?: string[];
	ports?: Array<{ containerPort: number; serviceName: string }>;
	env?: Record<string, string>;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runtime(): string {
	return settings.containers.runtime;
}

async function exec(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<ExecResult> {
	const proc = Bun.spawn([runtime(), ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		logger.error("Container command failed", {
			cmd: [runtime(), ...args].join(" "),
			cwd,
			stderr,
			exitCode,
		});
	}
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/** Resolve the compose file path in a worktree directory. */
function resolveComposeFile(worktreePath: string, config: ContainerConfig | null): string | null {
	if (config?.composeFile) {
		const p = resolve(worktreePath, config.composeFile);
		// Prevent path traversal — resolved path must stay within worktree
		if (!p.startsWith(worktreePath + "/") && p !== worktreePath) return null;
		return existsSync(p) ? p : null;
	}
	for (const name of ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
		const p = resolve(worktreePath, name);
		if (existsSync(p)) return p;
	}
	return null;
}

/** Build environment variables for compose, including port mappings. */
function buildComposeEnv(
	chapterId: string,
	portMappings: PortMapping[],
	config: ContainerConfig | null,
): Record<string, string> {
	const env: Record<string, string> = {
		NARRAFORK_CHAPTER_ID: chapterId,
		NARRAFORK_VOLUME_PREFIX: `nf_${chapterId.slice(0, 12)}`,
	};
	for (const { hostPort, containerPort } of portMappings) {
		env[`PORT_${containerPort}`] = String(hostPort);
	}
	if (config?.env) {
		Object.assign(env, config.env);
	}
	return env;
}

export const containerService = {
	/**
	 * Start containers for a chapter based on its containerConfig.
	 * Allocates ports, runs compose up, records container instances.
	 */
	async startChapterContainers(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

		const config = chapter.containerConfig as ContainerConfig | null;
		const composeFile = resolveComposeFile(chapter.worktreePath, config);
		if (!composeFile) {
			logger.debug("No compose file found, skipping container start", { chapterId });
			return;
		}

		// Allocate ports
		let portMappings: PortMapping[] = [];
		if (config?.ports && config.ports.length > 0) {
			portMappings = await portAllocator.allocate(chapterId, config.ports);
		}

		const env = buildComposeEnv(chapterId, portMappings, config);

		// Build compose args
		const composeArgs = ["compose", "-f", composeFile, "up", "-d"];
		if (config?.services && config.services.length > 0) {
			composeArgs.push(...config.services);
		}

		const result = await exec(composeArgs, chapter.worktreePath, env);
		if (result.exitCode !== 0) {
			// Cleanup allocated ports on failure
			await portAllocator.release(chapterId);
			throw new Error(`Failed to start containers: ${result.stderr}`);
		}

		// Query running containers to record instances
		await this._recordContainerInstances(
			chapterId,
			chapter.worktreePath,
			composeFile,
			portMappings,
			env,
		);

		logger.info("Chapter containers started", { chapterId });
		eventBus.emit({ type: "container:started", chapterId });
	},

	/** Pause all containers for a chapter (used during dormant). */
	async pauseChapterContainers(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);

		const config = chapter.containerConfig as ContainerConfig | null;
		const worktreePath = chapter.worktreePath;
		if (!worktreePath) return;

		const composeFile = resolveComposeFile(worktreePath, config);
		if (!composeFile) return;

		const result = await exec(["compose", "-f", composeFile, "pause"], worktreePath);
		if (result.exitCode !== 0) {
			logger.warn("Failed to pause containers", { chapterId, stderr: result.stderr });
			return;
		}

		const now = new Date().toISOString();
		await db
			.update(containerInstances)
			.set({ status: "paused", updatedAt: now })
			.where(eq(containerInstances.chapterId, chapterId));

		logger.info("Chapter containers paused", { chapterId });
	},

	/** Unpause all containers for a chapter (used during wake). */
	async unpauseChapterContainers(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

		const config = chapter.containerConfig as ContainerConfig | null;
		const composeFile = resolveComposeFile(chapter.worktreePath, config);
		if (!composeFile) return;

		const result = await exec(["compose", "-f", composeFile, "unpause"], chapter.worktreePath);
		if (result.exitCode !== 0) {
			// Containers may have been removed — clean up stale records and do a fresh start
			logger.warn("Unpause failed, attempting fresh start", { chapterId });
			await this.removeChapterContainers(chapterId);
			await this.startChapterContainers(chapterId);
			return;
		}

		const now = new Date().toISOString();
		await db
			.update(containerInstances)
			.set({ status: "running", updatedAt: now })
			.where(eq(containerInstances.chapterId, chapterId));

		logger.info("Chapter containers unpaused", { chapterId });
	},

	/** Stop all containers for a chapter. */
	async stopChapterContainers(chapterId: string): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);

		const config = chapter.containerConfig as ContainerConfig | null;
		const worktreePath = chapter.worktreePath;
		if (!worktreePath) return;

		const composeFile = resolveComposeFile(worktreePath, config);
		if (!composeFile) return;

		const result = await exec(["compose", "-f", composeFile, "stop"], worktreePath);
		if (result.exitCode !== 0) {
			logger.warn("Failed to stop containers", { chapterId, stderr: result.stderr });
		}

		const now = new Date().toISOString();
		await db
			.update(containerInstances)
			.set({ status: "stopped", updatedAt: now })
			.where(eq(containerInstances.chapterId, chapterId));

		eventBus.emit({ type: "container:stopped", chapterId });
		logger.info("Chapter containers stopped", { chapterId });
	},

	/**
	 * Remove all containers for a chapter (used during cleanup).
	 * Optionally deletes volumes.
	 */
	async removeChapterContainers(
		chapterId: string,
		opts: { deleteVolumes?: boolean } = {},
	): Promise<void> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);

		const config = chapter.containerConfig as ContainerConfig | null;
		const worktreePath = chapter.worktreePath;

		// Try to run compose down if worktree exists
		if (worktreePath) {
			const composeFile = resolveComposeFile(worktreePath, config);
			if (composeFile) {
				const args = ["compose", "-f", composeFile, "down"];
				if (opts.deleteVolumes) args.push("-v");

				const result = await exec(args, worktreePath);
				if (result.exitCode !== 0) {
					logger.warn("Failed to remove containers via compose", {
						chapterId,
						stderr: result.stderr,
					});
				}
			}
		}

		// Clean up DB records regardless
		await db.delete(containerInstances).where(eq(containerInstances.chapterId, chapterId));
		await portAllocator.release(chapterId);

		eventBus.emit({ type: "container:stopped", chapterId });
		logger.info("Chapter containers removed", { chapterId, deleteVolumes: opts.deleteVolumes });
	},

	/** Get container logs for a chapter. */
	async getContainerLogs(
		chapterId: string,
		opts: { tail?: number; service?: string } = {},
	): Promise<string> {
		const chapter = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

		const config = chapter.containerConfig as ContainerConfig | null;
		const composeFile = resolveComposeFile(chapter.worktreePath, config);
		if (!composeFile) return "";

		const args = ["compose", "-f", composeFile, "logs"];
		if (opts.tail) args.push("--tail", String(opts.tail));
		if (opts.service) args.push(opts.service);

		const result = await exec(args, chapter.worktreePath);
		return result.stdout || result.stderr;
	},

	/** List container instances for a chapter from DB. */
	async listByChapter(chapterId: string) {
		return db.query.containerInstances.findMany({
			where: eq(containerInstances.chapterId, chapterId),
		});
	},

	/**
	 * @internal Record container instances by querying compose ps.
	 */
	async _recordContainerInstances(
		chapterId: string,
		worktreePath: string,
		composeFile: string,
		portMappings: PortMapping[],
		env: Record<string, string>,
	): Promise<void> {
		const result = await exec(
			["compose", "-f", composeFile, "ps", "--format", "json"],
			worktreePath,
			env,
		);

		const now = new Date().toISOString();

		if (result.exitCode === 0 && result.stdout) {
			// compose ps --format json may output one JSON object per line or an array
			const lines = result.stdout.split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					const containers = Array.isArray(parsed) ? parsed : [parsed];
					for (const container of containers) {
						const serviceName = container.Service || container.Name || "unknown";
						const portMapping = portMappings.find((p) => p.serviceName === serviceName);

						await db.insert(containerInstances).values({
							id: generateId(),
							chapterId,
							containerId: container.ID || container.Id || null,
							serviceName,
							status: "running",
							hostPort: portMapping?.hostPort ?? null,
							containerPort: portMapping?.containerPort ?? null,
							createdAt: now,
							updatedAt: now,
						});
					}
				} catch {
					logger.warn("Failed to parse compose ps output line", { line });
				}
			}
		} else {
			// Fallback: create instances from port mappings if ps failed
			for (const { hostPort, containerPort, serviceName } of portMappings) {
				await db.insert(containerInstances).values({
					id: generateId(),
					chapterId,
					serviceName,
					status: "running",
					hostPort,
					containerPort,
					createdAt: now,
					updatedAt: now,
				});
			}
		}
	},
};
