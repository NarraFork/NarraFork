import type { GitChangesListWindow } from "./git-changes-list-model";
import type {
	GitChangesWorkerCommand,
	GitChangesWorkerRequest,
	GitChangesWorkerResponse,
} from "./git-changes-list-worker-protocol";

export interface GitChangesWorkerPort {
	postMessage(request: GitChangesWorkerRequest): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<GitChangesWorkerResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}
let testFactory: (() => GitChangesWorkerPort) | undefined;
/** DOM fixtures provide an isolated deterministic Worker transport, never a production fallback. */
export function __setGitChangesWorkerFactory(factory?: () => GitChangesWorkerPort) {
	testFactory = factory;
}

export class GitChangesListClient {
	private worker: GitChangesWorkerPort;
	private sequence = 0;
	private acceptedWindow = 0;
	private closed = false;
	private pending = new Map<
		number,
		{ resolve: (paths: string[]) => void; reject: (error: Error) => void }
	>();

	constructor(
		readonly generation: string,
		onWindow: (window: GitChangesListWindow, requestId: number) => void,
		onError: (error: Error) => void,
	) {
		this.worker = testFactory
			? testFactory()
			: new Worker(new URL("./git-changes-list.worker.ts", import.meta.url), { type: "module" });
		this.worker.onmessage = ({ data }) => {
			if (this.closed || data.generation !== this.generation) return;
			if (data.type === "scope") {
				this.pending.get(data.id)?.resolve(data.paths);
				this.pending.delete(data.id);
			} else if (data.type === "error") {
				const error = new Error(data.message);
				const pending = this.pending.get(data.id);
				if (pending) pending.reject(error);
				else onError(error);
				this.pending.delete(data.id);
			} else if (data.id > this.acceptedWindow) {
				this.acceptedWindow = data.id;
				onWindow(data.window, data.id);
			}
		};
		this.worker.onerror = (event) => {
			const error = new Error(event.message || "Git list Worker failed");
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			if (!this.closed) onError(error);
		};
	}

	send(command: GitChangesWorkerCommand) {
		if (this.closed) return;
		const id = ++this.sequence;
		this.worker.postMessage({ ...command, id, generation: this.generation });
		return id;
	}

	scope(section: "staged" | "unstaged", directory?: string): Promise<string[]> {
		if (this.closed) return Promise.reject(new DOMException("Cancelled", "AbortError"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({
				type: "scope",
				section,
				directory,
				id,
				generation: this.generation,
			});
		});
	}

	close() {
		this.closed = true;
		this.worker.terminate();
		for (const pending of this.pending.values())
			pending.reject(new DOMException("Cancelled", "AbortError"));
		this.pending.clear();
		this.worker.onmessage = null;
		this.worker.onerror = null;
	}
}
