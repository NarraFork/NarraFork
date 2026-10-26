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
import { resolve } from "node:path";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { generateSessionToken, hashSessionToken } from "../lib/session-token-hash";

const narraforkDir = getNarraforkHome();
const settingsPath = resolve(narraforkDir, "settings.json");
const dbPath = resolve(narraforkDir, "narrafork.db");

const watchMode = process.argv.includes("--watch") || process.argv.includes("-w");
const POLL_INTERVAL_MS = 2000;

// Load settings for the server port
let port: number;
try {
	const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
	port = (Number(process.env.PORT) || raw.server?.port) ?? 7778;
} catch {
	console.error(`Cannot read settings from ${settingsPath}`);
	process.exit(1);
}

const baseUrl = `http://localhost:${port}`;

// Track already-approved IDs in watch mode to avoid duplicate logs
const approvedIds = new Set<string>();

/** Lifetime of the session this script opens for one approval pass. */
const SCRIPT_SESSION_TTL_SECONDS = 300;

/**
 * Open a short-lived session for the first admin directly in the database (the server
 * stores only the token's hash), and return the token plus a way to revoke it.
 */
function openAdminSession(): { token: string; revoke: () => void } {
	const sqlite = new Database(dbPath);
	try {
		sqlite.exec("PRAGMA busy_timeout = 200");
		const admin = sqlite
			.prepare("SELECT id, token_version FROM users WHERE role = 'admin' LIMIT 1")
			.get() as { id: string; token_version: number } | null;
		if (!admin) {
			console.error("No admin user found in the database. Please create one first.");
			process.exit(1);
		}
		const id = generateId();
		const token = generateSessionToken();
		const now = Math.floor(Date.now() / 1000);
		sqlite
			.prepare(
				`INSERT INTO auth_sessions
					(id, user_id, token_hash, token_version, session_start, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				admin.id,
				hashSessionToken(token),
				admin.token_version,
				now,
				now,
				now + SCRIPT_SESSION_TTL_SECONDS,
			);
		return {
			token,
			revoke: () => {
				const db = new Database(dbPath);
				try {
					db.exec("PRAGMA busy_timeout = 200");
					db.prepare(
						"UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
					).run(Math.floor(Date.now() / 1000), id);
				} catch {
					// Best effort: the session expires on its own within minutes.
				} finally {
					db.close();
				}
			},
		};
	} finally {
		sqlite.close();
	}
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

	const session = openAdminSession();
	const { token } = session;
	let approved = 0;
	let failed = 0;

	try {
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
	} finally {
		session.revoke();
	}
	return { approved, failed };
}

// --- Main ---

if (watchMode) {
	console.log(`Watching for pending permissions (poll every ${POLL_INTERVAL_MS / 1000}s)...`);
	console.log("Press Ctrl+C to stop.\n");

	const tick = async () => {
		try {
			const { failed } = await approveAll();
			if (failed > 0) {
				console.log("Hint: make sure the server is running (bun run dev).");
			}
		} catch (err) {
			// One failed pass (a busy database, say) must not end the watch.
			console.error(`  ✗ Approval pass failed: ${err}`);
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
