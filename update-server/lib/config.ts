/**
 * Configuration management for the update server.
 * Reads/writes config.json, auto-generates on first run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerConfig, TokenRecord } from "../types";
import { nanoid } from "./id";
import { logger } from "./logger";

const DEFAULT_CONFIG: ServerConfig = {
	port: 7780,
	host: "0.0.0.0",
	dataDir: "./data",
	tokens: [],
	storage: { type: "local" },
	cors: { enabled: true, origins: ["*"] },
};

let configPath = "";
let currentConfig: ServerConfig = { ...DEFAULT_CONFIG };

/**
 * Hash a token string using SHA-256.
 */
async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Buffer.from(hash).toString("hex");
}

/**
 * Verify a plain token against a stored hash.
 */
export async function verifyToken(plain: string, hash: string): Promise<boolean> {
	const computed = await hashToken(plain);
	return computed === hash;
}

/**
 * Generate a new API token.
 */
function generateTokenString(): string {
	return `nfup_${nanoid(32)}`;
}

/**
 * Initialize configuration. Creates config.json with admin token on first run.
 */
export async function initConfig(path: string): Promise<{ adminToken?: string }> {
	configPath = resolve(path);
	const dir = resolve(path, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	if (existsSync(configPath)) {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ServerConfig>;
		currentConfig = { ...DEFAULT_CONFIG, ...parsed };
		logger.info("Config loaded", { path: configPath });
		return {};
	}

	// First run — generate admin token
	const adminTokenPlain = generateTokenString();
	const adminTokenHash = await hashToken(adminTokenPlain);

	const adminRecord: TokenRecord = {
		id: `tok_${nanoid(12)}`,
		name: "admin",
		tokenHash: adminTokenHash,
		role: "admin",
		createdAt: new Date().toISOString(),
	};

	currentConfig = { ...DEFAULT_CONFIG, tokens: [adminRecord] };
	saveConfig();

	logger.info("Config created with admin token", { path: configPath });
	return { adminToken: adminTokenPlain };
}

/**
 * Save current config to disk.
 */
export function saveConfig(): void {
	writeFileSync(configPath, JSON.stringify(currentConfig, null, "\t"), "utf-8");
}

/**
 * Get current config (read-only).
 */
export function getConfig(): Readonly<ServerConfig> {
	return currentConfig;
}

/**
 * Add a new token to the config.
 */
export async function addToken(
	name: string,
	role: "admin" | "upload",
): Promise<{ id: string; token: string }> {
	const plain = generateTokenString();
	const hash = await hashToken(plain);
	const record: TokenRecord = {
		id: `tok_${nanoid(12)}`,
		name,
		tokenHash: hash,
		role,
		createdAt: new Date().toISOString(),
	};
	currentConfig.tokens.push(record);
	saveConfig();
	return { id: record.id, token: plain };
}

/**
 * Remove a token by ID.
 */
export function removeToken(id: string): boolean {
	const before = currentConfig.tokens.length;
	currentConfig.tokens = currentConfig.tokens.filter((t) => t.id !== id);
	if (currentConfig.tokens.length < before) {
		saveConfig();
		return true;
	}
	return false;
}

/**
 * Find a token record by verifying the plain token against all stored hashes.
 */
export async function findTokenByPlain(plain: string): Promise<TokenRecord | null> {
	for (const record of currentConfig.tokens) {
		if (await verifyToken(plain, record.tokenHash)) {
			return record;
		}
	}
	return null;
}
