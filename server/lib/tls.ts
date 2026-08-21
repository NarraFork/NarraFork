import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { generate } from "selfsigned";
import { ValidationError } from "./errors";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";
import { getLanAddresses } from "./net/lan-addresses";

const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const CA_CERT_FILE = "ca.pem";
const CA_KEY_FILE = "ca-key.pem";
const SAN_SIDECAR_FILE = "san-list.json";

const CERT_VALIDITY_YEARS = 10;
const CA_VALIDITY_YEARS = 20;
/** Also the zod `.max()` in routes/tls.ts — keep the two from drifting apart. */
export const MAX_CUSTOM_SANS = 50;

/** Resolved lazily so tests can point NARRAFORK_HOME at a temp dir before first use. */
function tlsDir(): string {
	return getNarraforkPath("tls");
}

export function getTlsPaths() {
	const dir = tlsDir();
	return {
		dir,
		certPath: join(dir, CERT_FILE),
		keyPath: join(dir, KEY_FILE),
		caCertPath: join(dir, CA_CERT_FILE),
		caKeyPath: join(dir, CA_KEY_FILE),
		sanSidecarPath: join(dir, SAN_SIDECAR_FILE),
	};
}

export interface GeneratedCert {
	certPath: string;
	keyPath: string;
	certPem: string;
	expiresAt: string;
}

export interface CaInfo {
	caCertPem: string;
	caKeyPem: string;
	/** True when this call created the CA (false = pre-existing CA was reused). */
	created: boolean;
	expiresAt: string;
}

export interface IssuedServerCert {
	certPath: string;
	keyPath: string;
	expiresAt: string;
	effectiveSans: string[];
	customSans: string[];
	autoSans: string[];
	/** The CA that signed the certificate (created on demand during this call). */
	ca: CaInfo;
}

export interface TlsStatus {
	caExists: boolean;
	caExpiresAt: string | null;
	certExists: boolean;
	certExpiresAt: string | null;
	/** True when cert.pem is a legacy self-signed cert (issuer == subject), not CA-issued. */
	legacySelfSigned: boolean;
	/** SANs embedded in the current server certificate (empty when no cert). */
	certSans: string[];
	customSans: string[];
	autoSans: string[];
}

// ---------------------------------------------------------------------------
// SAN parsing / validation
// ---------------------------------------------------------------------------

const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidDnsName(name: string): boolean {
	if (name.length > 253) return false;
	const labels = name.split(".");
	return labels.every((label) => DNS_LABEL_RE.test(label));
}

/**
 * Validate and classify custom SAN entries into DNS names and IP addresses.
 *
 * Accepts IPv4/IPv6 literals, plain hostnames (single-label allowed for LAN
 * machines), and left-most wildcards (`*.example.com`). Anything URL-shaped
 * (scheme, port, path) or otherwise malformed is rejected in one throw that
 * names every offending entry, so the UI can surface them all at once.
 */
export function parseSanEntries(entries: string[]): { dns: string[]; ips: string[] } {
	if (entries.length > MAX_CUSTOM_SANS) {
		throw new ValidationError(`Too many SAN entries: ${entries.length} (max ${MAX_CUSTOM_SANS})`);
	}
	const dns: string[] = [];
	const ips: string[] = [];
	const invalid: string[] = [];

	for (const raw of entries) {
		const entry = raw.trim();
		if (!entry) {
			invalid.push("(empty)");
			continue;
		}
		if (isIP(entry)) {
			ips.push(entry);
			continue;
		}
		// DNS candidates are matched case-insensitively; lowercase for canonical form.
		const lower = entry.toLowerCase();
		const base = lower.startsWith("*.") ? lower.slice(2) : lower;
		// Single-label names (e.g. "nas") are valid LAN hostnames.
		if (isValidDnsName(base)) {
			dns.push(lower);
		} else {
			invalid.push(raw);
		}
	}

	if (invalid.length > 0) {
		throw new ValidationError(
			`Invalid SAN entries: ${invalid.join(", ")}. ` +
				"Use hostnames (e.g. nas.local, *.home.arpa) or IP addresses (e.g. 192.168.1.10).",
		);
	}
	return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

/**
 * SANs always embedded in the server certificate: loopback names/addresses
 * plus every RFC1918 LAN address of the host. Recomputed at issue time so a
 * machine that changes networks picks up its new address on re-issue.
 */
export function getAutoSans(): string[] {
	return ["localhost", "*.local", "127.0.0.1", "::1", ...getLanAddresses()];
}

// ---------------------------------------------------------------------------
// Custom SAN sidecar
//
// Stored next to the certs (not in settings.json) so the main settings save —
// which submits the whole `tls` object — can never clobber SAN edits with a
// stale UI snapshot. Only the dedicated TLS endpoints write this file.
// ---------------------------------------------------------------------------

export function readCustomSans(): string[] {
	const { sanSidecarPath } = getTlsPaths();
	try {
		if (!existsSync(sanSidecarPath)) return [];
		const raw = JSON.parse(readFileSync(sanSidecarPath, "utf8")) as { customSans?: unknown };
		if (!Array.isArray(raw.customSans)) return [];
		return raw.customSans.filter((e): e is string => typeof e === "string");
	} catch {
		return [];
	}
}

function writeCustomSans(customSans: string[]): void {
	const { dir, sanSidecarPath } = getTlsPaths();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(sanSidecarPath, `${JSON.stringify({ customSans }, null, "\t")}\n`, {
		mode: 0o600,
	});
}

// ---------------------------------------------------------------------------
// CA management
// ---------------------------------------------------------------------------

async function generateCa(): Promise<CaInfo> {
	const { dir, caCertPath, caKeyPath } = getTlsPaths();
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const now = new Date();
	const expiresAt = new Date(now);
	expiresAt.setFullYear(expiresAt.getFullYear() + CA_VALIDITY_YEARS);

	const result = await generate(
		[
			{ name: "commonName", value: "NarraFork Local CA" },
			{ name: "organizationName", value: "NarraFork" },
		],
		{
			keySize: 2048,
			algorithm: "sha256",
			notBeforeDate: now,
			notAfterDate: expiresAt,
			extensions: [
				{ name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
				{ name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
			],
		},
	);

	writeFileSync(caCertPath, result.cert, { mode: 0o644 });
	writeFileSync(caKeyPath, result.private, { mode: 0o600 });

	logger.info(`TLS root CA generated: ${caCertPath}, expires ${expiresAt.toISOString()}`);
	return {
		caCertPem: result.cert,
		caKeyPem: result.private,
		created: true,
		expiresAt: expiresAt.toISOString(),
	};
}

/** Return the existing root CA, generating one on first use. */
export async function ensureCa(): Promise<CaInfo> {
	const { caCertPath, caKeyPath } = getTlsPaths();
	if (existsSync(caCertPath) && existsSync(caKeyPath)) {
		const caCertPem = readFileSync(caCertPath, "utf8");
		const caKeyPem = readFileSync(caKeyPath, "utf8");
		let expiresAt = "";
		try {
			expiresAt = new X509Certificate(caCertPem).validTo;
		} catch {
			// Unparseable CA on disk — fall through and regenerate below.
		}
		if (expiresAt) {
			return { caCertPem, caKeyPem, created: false, expiresAt };
		}
		logger.warn("Existing CA certificate is unreadable; regenerating", { caCertPath });
	}
	return generateCa();
}

/**
 * Throw away the current root CA and generate a fresh one. Every device that
 * trusted the old CA must import the new one — the route surfaces that warning.
 */
export async function regenerateCa(): Promise<CaInfo> {
	return generateCa();
}

// ---------------------------------------------------------------------------
// Server certificate issuance
// ---------------------------------------------------------------------------

/**
 * Issue a server certificate signed by the root CA.
 *
 * `customSans`, when provided, replaces the stored custom SAN list; when
 * omitted, the stored list is used — this is how "regenerate after CA renewal"
 * keeps covering the same names. Validation happens BEFORE any file is
 * touched, and the new SAN list is persisted only after the certificate and
 * key have landed, so a rejected or failed request leaves the on-disk state
 * exactly as it was (in particular the sidecar never advertises names the
 * current certificate does not cover). cert.pem is written as leaf + CA so
 * TLS clients receive the full chain.
 */
export async function issueServerCert(customSans?: string[]): Promise<IssuedServerCert> {
	const { dir, certPath, keyPath } = getTlsPaths();
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	let storedCustom: string[];
	if (customSans !== undefined) {
		const parsed = parseSanEntries(customSans);
		storedCustom = [...parsed.dns, ...parsed.ips];
	} else {
		storedCustom = readCustomSans();
		// Re-validate persisted entries: a hand-edited sidecar must not crash issuance.
		storedCustom = (({ dns, ips }) => [...dns, ...ips])(parseSanEntries(storedCustom));
	}

	const ca = await ensureCa();
	const caNotAfter = new Date(new X509Certificate(ca.caCertPem).validTo);

	const now = new Date();
	const expiresAt = new Date(now);
	expiresAt.setFullYear(expiresAt.getFullYear() + CERT_VALIDITY_YEARS);
	// A leaf may not outlive its issuer.
	if (expiresAt > caNotAfter) expiresAt.setTime(caNotAfter.getTime());

	const autoSans = getAutoSans();
	const effectiveSans = [...new Set([...autoSans, ...storedCustom])];
	const altNames = effectiveSans.map((name) =>
		isIP(name) ? { type: 7 as const, ip: name } : { type: 2 as const, value: name },
	);

	const result = await generate(
		[
			{ name: "commonName", value: "NarraFork" },
			{ name: "organizationName", value: "NarraFork" },
		],
		{
			keySize: 2048,
			algorithm: "sha256",
			notBeforeDate: now,
			notAfterDate: expiresAt,
			extensions: [
				{ name: "basicConstraints", cA: false },
				{ name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
				{ name: "extKeyUsage", serverAuth: true },
				{ name: "subjectAltName", altNames },
			],
			ca: { key: ca.caKeyPem, cert: ca.caCertPem },
		},
	);

	// Chain the CA after the leaf so clients only missing the intermediate still verify.
	// PEM blocks must be newline-separated — a missing trailing newline on the leaf
	// otherwise fuses END/BEGIN markers and makes the file unparseable.
	const chainPem = `${result.cert.trimEnd()}\n${ca.caCertPem.trimEnd()}\n`;
	writeFileSync(certPath, chainPem, { mode: 0o644 });
	writeFileSync(keyPath, result.private, { mode: 0o600 });

	// Persist the new SAN list only now: before this point a failure must leave
	// the previous sidecar untouched, or the UI would advertise names the cert
	// on disk does not actually cover.
	if (customSans !== undefined) {
		writeCustomSans(storedCustom);
	}

	logger.info(`TLS server certificate issued: ${certPath}, expires ${expiresAt.toISOString()}`, {
		sanCount: effectiveSans.length,
	});

	return {
		certPath,
		keyPath,
		expiresAt: expiresAt.toISOString(),
		effectiveSans,
		customSans: storedCustom,
		autoSans,
		ca,
	};
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function parseCertFile(
	certPem: string,
): { expiresAt: string; selfSigned: boolean; sans: string[] } | null {
	try {
		const cert = new X509Certificate(certPem);
		const sans = (cert.subjectAltName ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => part.replace(/^(DNS|IP Address|URI|email):/i, ""));
		return { expiresAt: cert.validTo, selfSigned: cert.issuer === cert.subject, sans };
	} catch {
		return null;
	}
}

/** Inspect the TLS directory: what exists, when it expires, which names are covered. */
export function getTlsStatus(): TlsStatus {
	const { certPath, caCertPath, caKeyPath } = getTlsPaths();

	const caExists = existsSync(caCertPath) && existsSync(caKeyPath);
	let caExpiresAt: string | null = null;
	if (caExists) {
		try {
			caExpiresAt = new X509Certificate(readFileSync(caCertPath, "utf8")).validTo;
		} catch {
			caExpiresAt = null;
		}
	}

	const certParsed = existsSync(certPath) ? parseCertFile(readFileSync(certPath, "utf8")) : null;

	return {
		caExists,
		caExpiresAt,
		certExists: certParsed !== null,
		certExpiresAt: certParsed?.expiresAt ?? null,
		legacySelfSigned: certParsed?.selfSigned ?? false,
		certSans: certParsed?.sans ?? [],
		customSans: readCustomSans(),
		autoSans: getAutoSans(),
	};
}

// ---------------------------------------------------------------------------
// Legacy self-signed flow (kept for the old /generate-tls compatibility path)
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed TLS certificate and write it to ~/.narrafork/tls/.
 * Returns the file paths and PEM content.
 *
 * @deprecated Legacy one-shot path kept for backward compatibility. New code
 * should use the CA flow: `ensureCa()` + `issueServerCert()`.
 */
export async function generateSelfSignedCert(): Promise<GeneratedCert> {
	const { dir, certPath, keyPath } = getTlsPaths();
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const now = new Date();
	const expiresAt = new Date(now);
	expiresAt.setFullYear(expiresAt.getFullYear() + CERT_VALIDITY_YEARS);

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
	const { certPath, keyPath } = getTlsPaths();
	return existsSync(certPath) && existsSync(keyPath);
}
