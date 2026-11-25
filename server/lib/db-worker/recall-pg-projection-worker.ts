import { parentPort } from "node:worker_threads";
import { DbReadError } from "./errors";
import { projectRecallPg, type RecallPgProjectionRequest } from "./recall-pg-projection";

if (!parentPort) throw new Error("Recall projection requires a Worker");
const port = parentPort;
port.once(
	"message",
	({ request, deadlineAt }: { request: RecallPgProjectionRequest; deadlineAt: number }) => {
		try {
			port.postMessage({ result: projectRecallPg(request, deadlineAt) });
		} catch (error) {
			// Stored content and driver errors never cross the worker error channel.
			port.postMessage({
				error: { code: error instanceof DbReadError ? error.code : "DB_READ_FAILED" },
			});
		} finally {
			port.close();
		}
	},
);
port.postMessage({ ready: true });
