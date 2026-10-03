import { createWorkerShiki } from "./shiki-loader";
import { TextDocumentWorkerRuntime } from "./text-document-worker-core";
import type {
	DocumentWorkerRequest,
	DocumentWorkerResponse,
} from "./text-document-worker-protocol";

// Two instances of this module isolate expensive TextMate work from readable layout.
const scope = globalThis as unknown as {
	postMessage(packet: DocumentWorkerResponse): void;
	onmessage: ((event: MessageEvent<DocumentWorkerRequest>) => void) | null;
};
const runtime = new TextDocumentWorkerRuntime(
	(packet) => scope.postMessage(packet),
	createWorkerShiki,
);
scope.onmessage = (event) => {
	try {
		runtime.handle(event.data);
	} catch (error) {
		scope.postMessage({
			type: "error",
			requestId: "requestId" in event.data ? event.data.requestId : -1,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
