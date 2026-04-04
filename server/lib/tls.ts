import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { logger } from "./logger";

const TLS_DIR = join(homedir(), ".narrafork", "tls");
const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const VALIDITY_YEARS = 10;

export interface GeneratedCert {
	certPath: string;
	keyPath: string;
	certPem: string;
	expiresAt: string;
}

/**
 * Generate a self-signed TLS certificate and write it to ~/.narrafork/tls/.
 * Returns the file paths and PEM content.
 */
export async function generateSelfSignedCert(): Promise<GeneratedCert> {
	// Ensure TLS directory exists with restrictive permissions
	mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });

	const now = new Date();
	const expiresAt = new Date(now);
	expiresAt.setFullYear(expiresAt.getFullYear() + VALIDITY_YEARS);

	const attrs = [
		{ name: "commonName", value: "NarraFork" },
		{ name: "organizationName", value: "NarraFork" },
	];

	const result = await generate(attrs, {
		keySize: 2048,
		algorithm: "sha256",
		notBeforeDate: now,
		notAfterDate: expiresAt,
		extensions: [
			{ name: "basicConstraints", cA: false },
			{
				name: "keyUsage",
				digitalSignature: true,
				keyEncipherment: true,
				critical: true,
			},
			{
				name: "extKeyUsage",
				serverAuth: true,
			},
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "localhost" },
					{ type: 2, value: "*.local" },
					{ type: 7, ip: "127.0.0.1" },
					{ type: 7, ip: "::1" },
				],
			},
		],
	});

	const certPath = join(TLS_DIR, CERT_FILE);
	const keyPath = join(TLS_DIR, KEY_FILE);

	// Write cert (world-readable is fine for certs)
	writeFileSync(certPath, result.cert, { mode: 0o644 });
	// Write key with restrictive permissions
	writeFileSync(keyPath, result.private, { mode: 0o600 });

	logger.info(`TLS certificate generated: ${certPath}, expires ${expiresAt.toISOString()}`);

	return {
		certPath,
		keyPath,
		certPem: result.cert,
		expiresAt: expiresAt.toISOString(),
	};
}

/** Check whether auto-generated TLS cert files exist. */
export function tlsCertExists(): boolean {
	const certPath = join(TLS_DIR, CERT_FILE);
	const keyPath = join(TLS_DIR, KEY_FILE);
	return existsSync(certPath) && existsSync(keyPath);
}
