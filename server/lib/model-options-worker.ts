import { open } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import { decodeBundledCatalog, decodeCatalog, MAX_CATALOG_BYTES } from "./model-catalog/source";
import {
	type ModelOptionInput,
	ModelOptionsError,
	type ModelOptionsQuery,
} from "./model-options-contract";
import { ModelOptionsIndex } from "./model-options-index";

const port = parentPort;
if (!port) throw new Error("model options requires a Worker");
const index = new ModelOptionsIndex();
interface Request {
	id: number;
	type: "begin" | "batch" | "publish" | "query" | "discard" | "sources" | "filters" | "seed-codex";
	filterKind?: "hidden" | "excluded";
	values?: string[];
	facts?: import("@shared/auto-route-strategy").AutoRouteSignals[];
	sourceModelId?: string;
	revision: string;
	catalog?: { path: string; source: "builtin" | "downloaded"; version: string };
	hidden?: string[];
	excluded?: string[];
	codex?: boolean;
	rows?: ModelOptionInput[];
	query?: ModelOptionsQuery;
}
async function loadCatalog(source: NonNullable<Request["catalog"]>) {
	let catalog = decodeBundledCatalog();
	if (source.source === "downloaded") {
		const file = await open(source.path, "r");
		try {
			const info = await file.stat();
			if (info.size > MAX_CATALOG_BYTES) throw new Error("Catalog exceeds budget");
			const bytes = Buffer.alloc(info.size + 1);
			let read = 0;
			while (read < bytes.length) {
				const result = await file.read(bytes, read, bytes.length - read, read);
				if (!result.bytesRead) break;
				read += result.bytesRead;
			}
			if (read > info.size) throw new Error("Catalog changed during read");
			catalog = decodeCatalog(JSON.parse(bytes.subarray(0, read).toString("utf8")));
		} finally {
			await file.close();
		}
	}
	if (catalog.catalogVersion !== source.version)
		throw new ModelOptionsError("MODEL_OPTIONS_SOURCE_CHANGED", "Catalog changed during build");
	return catalog;
}
port.on("message", async (message: Request | { ping: boolean }) => {
	if ("ping" in message) {
		port.postMessage({ ready: true });
		return;
	}
	try {
		let result: unknown;
		if (message.type === "begin") {
			if (!message.catalog) throw new Error("Missing catalog source");
			const catalog = await loadCatalog(message.catalog);
			index.begin(message.revision, catalog, message.hidden ?? [], message.excluded ?? []);
		} else if (message.type === "filters" && message.filterKind)
			index.appendFilters(message.filterKind, message.values ?? []);
		else if (message.type === "seed-codex") index.seedCodex();
		else if (message.type === "batch") index.append(message.rows ?? []);
		else if (message.type === "publish") index.publish();
		else if (message.type === "discard") index.discard();
		else if (message.type === "sources" && message.sourceModelId)
			result = index.sourceCandidates(message.revision, message.sourceModelId);
		else if (message.type === "query" && message.query)
			result = index.query(message.revision, message.query, message.facts);
		port.postMessage({ id: message.id, ok: true, result });
	} catch (error) {
		index.discard();
		port.postMessage({
			id: message.id,
			ok: false,
			code: error instanceof ModelOptionsError ? error.code : "MODEL_OPTIONS_WORKER_FAILED",
			status: error instanceof ModelOptionsError ? error.status : 503,
			error: error instanceof ModelOptionsError ? error.message : "Model options worker failed",
		});
	}
});
port.postMessage({ ready: true });
