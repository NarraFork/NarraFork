import { DB_INTEGRITY_WORKER_FLAG } from "./db/integrity-protocol";
import { waitForPreviousServerShutdown } from "./lib/restart-handoff";
import { WATCHER_WORKER_FLAG } from "./lib/watcher/worker-protocol";

if (process.argv.includes(DB_INTEGRITY_WORKER_FLAG)) {
	// Read-only integrity probe subprocess. Must be checked before anything else: importing ./main
	// (or the watcher worker) would open the database read-write and take the instance lock.
	await import("./db/integrity-probe-worker");
} else if (process.argv.includes(WATCHER_WORKER_FLAG)) {
	await import("./lib/watcher/parcel-watcher-worker");
} else {
	const handoffOk = await waitForPreviousServerShutdown();
	if (!handoffOk) {
		process.exit(1);
	}
	await import("./main");
}
