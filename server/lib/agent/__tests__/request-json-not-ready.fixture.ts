import { parentPort } from "node:worker_threads";

// A real worker that remains alive but never acknowledges readiness or computes a packet.
parentPort?.on("message", () => {});
