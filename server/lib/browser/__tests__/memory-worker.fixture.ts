import { spyOn } from "bun:test";
import type { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { WorkerHandle } from "../../worker-runtime/lifecycle";

type Spawn = (specifier: string) => EventEmitter & { terminate(): Promise<number> };
const registrations = new Set<{ spawn: Spawn; specifiers?: readonly string[] }>();

/** Replace only native construction: production connector still owns candidate/ready budgets. */
export function installMemoryWorker(spawn: Spawn, specifiers?: readonly string[]) {
	const registration = { spawn, specifiers };
	registrations.add(registration);
	const spy = spyOn(WorkerHandle, "thread").mockImplementation((entry) => {
		const specifier = String(entry);
		const match = [...registrations]
			.reverse()
			.find((item) => !item.specifiers || item.specifiers.includes(specifier));
		if (!match) throw new Error("Unexpected worker fixture entry");
		const worker = match.spawn(specifier);
		const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
		const handle = new WorkerHandle(worker as Worker, exit, () => worker.terminate());
		worker.on("error", () => {
			void handle.close().catch(() => {});
		});
		return handle;
	});
	return {
		mockRestore() {
			registrations.delete(registration);
			if (!registrations.size) spy.mockRestore();
		},
	};
}
