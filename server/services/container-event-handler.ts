/**
 * Container event handler — listens for `container:started` events and:
 * 1. Injects a system message with container access URLs into the chapter's primary narrator
 * 2. Auto-enables the Browser tool so the narrator can test the running service
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, containerInstances, narrators, projects } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { buildProxyUrl } from "./container-proxy";
import { narratorService } from "./narrator-service";
import { loadOptionalTool } from "./narrator-session";

// ---------------------------------------------------------------------------
// Build container access info for injection
// ---------------------------------------------------------------------------

interface ContainerAccessInfo {
	services: Array<{
		serviceName: string;
		url: string;
		containerPort: number;
	}>;
}

async function getContainerAccessInfo(chapterId: string): Promise<ContainerAccessInfo | null> {
	const instances = await db.query.containerInstances.findMany({
		where: and(
			eq(containerInstances.chapterId, chapterId),
			eq(containerInstances.status, "running"),
		),
	});
	if (instances.length === 0) return null;

	// Determine if proxy mode
	const chapter = await db.query.chapters.findFirst({
		where: eq(chapters.id, chapterId),
		columns: { projectId: true },
	});
	if (!chapter) return null;

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, chapter.projectId),
		columns: { proxyDomain: true },
	});

	const proxyEnabled = settings.containers.proxy?.enabled && !!project?.proxyDomain;
	const proxyDomain = project?.proxyDomain ?? null;
	const proxyPort = settings.containers.proxy?.port ?? 7780;

	const services: ContainerAccessInfo["services"] = [];

	for (const inst of instances) {
		let url: string;
		if (proxyEnabled && inst.proxyLabel && proxyDomain) {
			url = buildProxyUrl(inst.proxyLabel, proxyDomain, proxyPort);
		} else if (inst.hostPort) {
			url = `http://localhost:${inst.hostPort}`;
		} else {
			continue;
		}

		services.push({
			serviceName: inst.serviceName,
			url,
			containerPort: inst.containerPort ?? 0,
		});
	}

	return services.length > 0 ? { services } : null;
}

// ---------------------------------------------------------------------------
// Build notification text
// ---------------------------------------------------------------------------

function buildContainerReadyText(info: ContainerAccessInfo, browserLoaded: boolean): string {
	let text = "Container services are now running:\n\n";
	for (const svc of info.services) {
		text += `- **${svc.serviceName}** (port ${svc.containerPort}): ${svc.url}\n`;
	}
	if (browserLoaded) {
		text += "\nThe Browser tool has been automatically enabled. ";
	}
	text +=
		"\nYou can use the Browser tool to test these services, or access them via HTTP requests.";
	return text;
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

export function initContainerEventHandler(): void {
	eventBus.on("container:started", async (event) => {
		try {
			// 1. Find the chapter's primary narrator
			const narrator = await db.query.narrators.findFirst({
				where: and(eq(narrators.chapterId, event.chapterId), eq(narrators.type, "primary")),
				columns: { id: true },
			});
			if (!narrator) {
				logger.debug("No primary narrator for chapter, skipping container ready notification", {
					chapterId: event.chapterId,
				});
				return;
			}

			// 2. Get container access info
			const info = await getContainerAccessInfo(event.chapterId);
			if (!info) {
				logger.debug("No accessible container services found", {
					chapterId: event.chapterId,
				});
				return;
			}

			// 3. Auto-enable Browser tool if not already loaded
			const toolResult = await loadOptionalTool(narrator.id, "Browser");
			const browserLoaded = toolResult === "loaded";
			if (browserLoaded) {
				logger.info("Browser tool auto-enabled for container chapter", {
					narratorId: narrator.id,
					chapterId: event.chapterId,
				});
			}

			// 4. Inject system message with container URLs into narrator history
			//    (uses role="user" so the model sees it in context)
			const text = buildContainerReadyText(info, browserLoaded);
			await narratorService.persistSystemMessage(narrator.id, text, [
				{
					type: "container_ready",
					services: info.services,
					browserAutoEnabled: browserLoaded,
				},
			]);

			logger.info("Container ready notification injected", {
				narratorId: narrator.id,
				chapterId: event.chapterId,
				serviceCount: info.services.length,
			});
		} catch (err) {
			logger.error("Failed to handle container:started event", {
				chapterId: event.chapterId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});
}
