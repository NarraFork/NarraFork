/**
 * Standalone CLI script to approve all pending permission requests.
 * Useful when the frontend is down but narrators are waiting for approval.
 *
 * Usage:
 *   bun run approve          — approve once and exit
 *   bun run approve --watch  — poll every 2s and auto-approve new requests
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { sign } from "hono/jwt";

const narraforkDir = resolve(homedir(), ".narrafork");
const settingsPath = resolve(narraforkDir, "settings.json");
const dbPath = resolve(narraforkDir, "narrafork.db");

const watchMode = process.argv.includes("--watch") || process.argv.includes("-w");
const POLL_INTERVAL_MS = 2000;

// Load settings for JWT secret and server port
let jwtSecret: string;
let port: number;
try {
	const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
	jwtSecret = raw.auth?.jwtSecret;
	port = raw.server?.port ?? 7778;
	if (!jwtSecret) {
		console.error("No JWT secret found in settings. Has the server been started at least once?");
		process.exit(1);
	}
} catch {
	console.error(`Cannot read settings from ${settingsPath}`);
	process.exit(1);
}

const baseUrl = `http://localhost:${port}`;

// Track already-approved IDs in watch mode to avoid duplicate logs
const approvedIds = new Set<string>();

async function getToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: "cli-approve", role: "admin", iat: now, exp: now + 300 }, jwtSecret);
}

function queryPending(): { id: string; narrator_id: string; tool_name: string }[] {
	const sqlite = new Database(dbPath, { readonly: true });
	const rows = sqlite
		.prepare("SELECT id, narrator_id, tool_name FROM narrator_tool_calls WHERE status = 'pending'")
		.all() as { id: string; narrator_id: string; tool_name: string }[];
	sqlite.close();
	return rows;
}

async function approveAll(): Promise<{ approved: number; failed: number }> {
	const pending = queryPending().filter((p) => !approvedIds.has(p.id));
	if (pending.length === 0) return { approved: 0, failed: 0 };

	const token = await getToken();
	let approved = 0;
	let failed = 0;

	for (const p of pending) {
		try {
			const res = await fetch(`${baseUrl}/api/narrators/permissions/${p.id}/approve`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.ok) {
				const ts = new Date().toLocaleTimeString();
				console.log(`  [${ts}] ✓ Approved ${p.id} (${p.tool_name})`);
				approvedIds.add(p.id);
				approved++;
			} else {
				const body = await res.text();
				console.error(`  ✗ Failed ${p.id}: ${res.status} ${body}`);
				failed++;
			}
		} catch (err) {
			console.error(`  ✗ Failed ${p.id}: ${err}`);
			failed++;
		}
	}
	return { approved, failed };
}

// --- Main ---

if (watchMode) {
	console.log(`Watching for pending permissions (poll every ${POLL_INTERVAL_MS / 1000}s)...`);
	console.log("Press Ctrl+C to stop.\n");

	const tick = async () => {
		const { failed } = await approveAll();
		if (failed > 0) {
			console.log("Hint: make sure the server is running (bun run dev).");
		}
	};

	// Run immediately, then on interval
	await tick();
	setInterval(tick, POLL_INTERVAL_MS);
} else {
	const pending = queryPending();
	if (pending.length === 0) {
		console.log("No pending permission requests.");
		process.exit(0);
	}

	console.log(`Found ${pending.length} pending permission request(s):\n`);
	for (const p of pending) {
		console.log(`  ${p.id}  narrator=${p.narrator_id}  tool=${p.tool_name}`);
	}
	console.log();

	const { approved, failed } = await approveAll();
	console.log(`\nDone. Approved: ${approved}, Failed: ${failed}`);
	if (failed > 0) {
		console.log("Hint: make sure the server is running (bun run dev).");
	}
}
