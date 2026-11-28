import { GitChangesListModel } from "./git-changes-list-model";
import type {
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";

let model: GitChangesListModel | undefined;
let generation = "";
const worker = self as unknown as {
	onmessage: ((event: MessageEvent<GitChangesWorkerRequest>) => void) | null;
	postMessage(response: GitChangesWorkerResponse): void;
};
worker.onmessage = ({ data: request }) => {
	const { id, generation: requestedGeneration } = request;
	if (request.type === "reset") {
		generation = requestedGeneration;
		model = new GitChangesListModel(request.config, generation);
	}
	if (!model || requestedGeneration !== generation) return;
	const base = { id, generation };
	try {
		switch (request.type) {
			case "append":
				model.append(request.pages);
				break;
			case "staging-pages":
				model.appendStaging(request.listId, request.pages, request.offset);
				break;
			case "configure":
				model.configure(request.config);
				break;
			case "stats-source":
				model.setStatsSource(request.source);
				break;
			case "page-stats":
				model.mergePageStats(request.source, request.result, request.options);
				break;
			case "scope":
				worker.postMessage({
					...base,
					type: "scope",
					paths: model.scope(request.section, request.directory),
				});
				return;
		}
		worker.postMessage({
			...base,
			type: "window",
			window:
				request.type === "window" ? model.window(request.start, request.count) : model.window(),
		});
	} catch (error) {
		worker.postMessage({
			...base,
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}
};
