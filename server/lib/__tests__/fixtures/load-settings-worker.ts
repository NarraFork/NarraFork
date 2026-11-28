// Loads settings in a worker thread, as the request recorder worker does.
import { parentPort } from "node:worker_threads";

const { getNarraforkHome } = await import("../../narrafork-home");
await import("../../settings");
parentPort?.postMessage(getNarraforkHome());
