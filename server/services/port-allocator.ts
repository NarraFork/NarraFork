import { and, eq, gt, gte, isNull, lte } from "drizzle-orm";
import { db } from "../db";
import { portAllocations } from "../db/schema";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";

export interface PortMapping {
	hostPort: number;
	containerPort: number;
	serviceName: string;
}

export const portAllocator = {
	/**
	 * Allocate host ports from the configured pool range for a chapter's container ports.
	 * Uses the port_allocations table to avoid conflicts across chapters.
	 */
	async allocate(
		chapterId: string,
		ports: Array<{ containerPort: number; serviceName: string }>,
	): Promise<PortMapping[]> {
		if (ports.length === 0) return [];

		const { portRangeStart, portRangeEnd } = settings.containers;
		if (
			ports.length > 128 ||
			!Number.isInteger(portRangeStart) ||
			!Number.isInteger(portRangeEnd) ||
			portRangeStart < 1 ||
			portRangeEnd > 65535 ||
			portRangeStart > portRangeEnd
		) {
			throw new AppError("Invalid or oversized port allocation request", 400);
		}

		// Global PK still arbitrates both domains. Read only the configured pool through
		// small indexed pages, never an unbounded whole-table inventory.
		const usedPorts = new Set<number>();
		let cursor: number | undefined;
		const deadline = performance.now() + 5000;
		for (let page = 0; ; page++) {
			if (performance.now() > deadline || page >= 512)
				throw new AppError("Port allocation scan budget exceeded", 503);
			const allocated = await db
				.select({ port: portAllocations.port })
				.from(portAllocations)
				.where(
					and(
						gte(portAllocations.port, portRangeStart),
						lte(portAllocations.port, portRangeEnd),
						cursor === undefined ? undefined : gt(portAllocations.port, cursor),
					),
				)
				.orderBy(portAllocations.port)
				.limit(129);
			for (const row of allocated.slice(0, 128)) usedPorts.add(row.port);
			if (allocated.length <= 128) break;
			cursor = allocated[127]?.port;
			if (cursor === undefined) throw new AppError("Port allocation scan incomplete", 503);
			if (page % 16 === 15) await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}

		const mappings: PortMapping[] = [];
		const now = new Date().toISOString();

		for (const { containerPort, serviceName } of ports) {
			// Find and insert an available port, retrying on conflict
			let hostPort: number | null = null;
			for (let p = portRangeStart; p <= portRangeEnd; p++) {
				if (usedPorts.has(p)) continue;
				try {
					await db.insert(portAllocations).values({
						port: p,
						chapterId,
						serviceName,
						allocatedAt: now,
					});
					hostPort = p;
					usedPorts.add(p);
					break;
				} catch {
					// Primary key conflict — another chapter grabbed this port concurrently
					usedPorts.add(p);
				}
			}

			if (hostPort === null) {
				// Release any ports we just allocated in this batch
				for (const mapping of mappings) {
					await db
						.delete(portAllocations)
						.where(
							and(
								eq(portAllocations.port, mapping.hostPort),
								eq(portAllocations.chapterId, chapterId),
								eq(portAllocations.allocatedAt, now),
								isNull(portAllocations.worktreeResourceId),
							),
						);
				}
				throw new AppError(
					`Port pool exhausted: no available ports in range ${portRangeStart}-${portRangeEnd}`,
					500,
				);
			}

			mappings.push({ hostPort, containerPort, serviceName });
		}

		logger.info("Ports allocated", {
			chapterId,
			mappings: mappings.map((m) => `${m.serviceName}:${m.hostPort}->${m.containerPort}`),
		});

		return mappings;
	},

	/** Release all port allocations for a chapter. */
	async release(chapterId: string): Promise<void> {
		const released = await db
			.delete(portAllocations)
			.where(
				and(eq(portAllocations.chapterId, chapterId), isNull(portAllocations.worktreeResourceId)),
			)
			.returning({ port: portAllocations.port });

		if (released.length > 0) {
			logger.info("Ports released", {
				chapterId,
				ports: released.map((r) => r.port),
			});
		}
	},

	/** List all port allocations for a chapter. */
	async listByChapter(chapterId: string) {
		return db.query.portAllocations.findMany({
			where: and(
				eq(portAllocations.chapterId, chapterId),
				isNull(portAllocations.worktreeResourceId),
			),
		});
	},
};
