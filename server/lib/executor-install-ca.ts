import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { ValidationError } from "./errors";

export const EXECUTOR_INSTALL_CA_MAX_BYTES = 64 * 1024;
const MAX_CERTIFICATES = 32;
const RESOLVE_TIMEOUT_MS = 2_000;

/** Public certificate paths only: never accept/read the TLS private key or passphrase. */
export interface ExecutorInstallCaOptions {
	serverUrl: URL;
	tls?: { enabled: boolean; certFile?: string; caFile?: string };
	builtinCaCertPath?: string;
}

async function readCertificates(path: string, signal: AbortSignal): Promise<X509Certificate[]> {
	signal.throwIfAborted();
	// NONBLOCK prevents a misconfigured FIFO from hanging open; fstat rejects all
	// non-regular files. Reads and allocations are bounded even if the file grows.
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		signal.throwIfAborted();
		const info = await handle.stat();
		if (!info.isFile() || info.size > EXECUTOR_INSTALL_CA_MAX_BYTES) {
			throw new Error("Certificate file must be a regular file of at most 64 KiB");
		}
		const buffer = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		signal.throwIfAborted();
		const after = await handle.stat();
		signal.throwIfAborted();
		if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
			throw new Error("Certificate file changed during reading");
		}
		// A combined PEM may contain other blocks. Only canonical X.509 public
		// certificates are returned; no raw file bytes enter the install response.
		const blocks = buffer
			.toString("utf8")
			.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
		if (!blocks?.length || blocks.length > MAX_CERTIFICATES) {
			throw new Error("Expected a bounded PEM certificate chain");
		}
		return blocks.map((pem) => new X509Certificate(pem));
	} finally {
		await handle.close();
	}
}

function isCurrent(cert: X509Certificate): boolean {
	const now = Date.now();
	return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}

function isSelfSigned(cert: X509Certificate): boolean {
	return cert.subject === cert.issuer && cert.verify(cert.publicKey);
}

function matchingRoot(
	leaf: X509Certificate,
	certificates: X509Certificate[],
): X509Certificate | undefined {
	// Breadth-first traversal with a visited set bounds both cycles and branching.
	const queue = [leaf];
	const visited = new Set([leaf.fingerprint256]);
	for (const current of queue) {
		if (current.ca && isSelfSigned(current)) return current;
		for (const issuer of certificates) {
			if (visited.has(issuer.fingerprint256) || !issuer.ca || !isCurrent(issuer)) continue;
			if (!current.checkIssued(issuer) || !current.verify(issuer.publicKey)) continue;
			visited.add(issuer.fingerprint256);
			queue.push(issuer);
		}
	}
	return undefined;
}

async function resolveCa(
	options: ExecutorInstallCaOptions,
	signal: AbortSignal,
): Promise<string | undefined> {
	const { tls, serverUrl, builtinCaCertPath } = options;
	if (serverUrl.protocol !== "https:" || !tls?.enabled || !tls.certFile) return undefined;
	const certificates = await readCertificates(tls.certFile, signal);
	const leaf = certificates[0];
	const hostname = serverUrl.hostname.replace(/^\[|\]$/g, "");
	const hostMatches = isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname);
	// An override/proxy hostname not served by this certificate is not evidence
	// that the local CA is relevant. Do not probe that URL (including DNS/SSRF).
	if (!hostMatches || !isCurrent(leaf)) return undefined;
	if (isSelfSigned(leaf)) return leaf.toString(); // Legacy self-signed server certificate.
	let root = matchingRoot(leaf, certificates);
	if (root) return root.toString();

	for (const path of [tls.caFile, builtinCaCertPath]) {
		if (!path || path === tls.certFile) continue;
		let extra: X509Certificate[];
		try {
			extra = await readCertificates(path, signal);
		} catch (error) {
			// A stale/unreadable built-in CA must not break an unrelated public TLS
			// deployment. Explicitly configured caFile errors remain actionable.
			if (path === tls.caFile || signal.aborted) throw error;
			continue;
		}
		certificates.push(...extra);
		if (certificates.length > MAX_CERTIFICATES) {
			throw new Error("Too many certificates in the configured TLS chain");
		}
		root = matchingRoot(leaf, certificates);
		if (root) return root.toString();
	}
	// Public PKI/incomplete chains and unconfigured custom reverse-proxy CAs keep
	// system trust defaults. Never promote an intermediate or unrelated local CA.
	return undefined;
}

/**
 * Select an offline, signature-linked trust anchor for an authenticated install
 * response. No settings import, disk writes, private-key access or network I/O.
 * The executor still performs normal TLS hostname/chain validation.
 */
export async function resolveExecutorInstallCa(
	options: ExecutorInstallCaOptions,
): Promise<string | undefined> {
	if (options.serverUrl.protocol !== "https:" || !options.tls?.enabled || !options.tls.certFile) {
		return undefined;
	}
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			resolveCa(options, controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("Certificate lookup timed out"));
				}, RESOLVE_TIMEOUT_MS);
			}),
		]);
	} catch {
		// Do not expose local paths, file contents or crypto parser diagnostics.
		throw new ValidationError(
			"Cannot resolve executor TLS trust. Check configured certificate PEM files " +
				"(regular files, at most 64 KiB and 32 certificates; 2 second lookup limit).",
		);
	} finally {
		clearTimeout(timer);
	}
}
