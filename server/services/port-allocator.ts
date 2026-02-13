import { eq } from "drizzle-orm";
import { db } from "../db";
import { portAllocations } from "../db/schema";
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

		// Get all currently allocated ports
		const allocated = await db.select({ port: portAllocations.port }).from(portAllocations);
		const usedPorts = new Set(allocated.map((a) => a.port));

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
					continue;
				}
			}

			if (hostPort === null) {
				// Release any ports we just allocated in this batch
				await this.release(chapterId);
				throw new Error(
					`Port pool exhausted: no available ports in range ${portRangeStart}-${portRangeEnd}`,
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
			.where(eq(portAllocations.chapterId, chapterId))
			.returning();

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
			where: eq(portAllocations.chapterId, chapterId),
		});
	},
};
