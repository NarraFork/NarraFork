import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { EXECUTOR_INSTALL_CA_MAX_BYTES, resolveExecutorInstallCa } from "../executor-install-ca";

type Certificate = Awaited<ReturnType<typeof generate>>;
let dir: string;
let root: Certificate;
let otherRoot: Certificate;
let leaf: Certificate;
let intermediate: Certificate;
let chainedLeaf: Certificate;
let legacy: Certificate;
let fileCounter = 0;

async function certificate(name: string, ca: boolean, issuer?: Certificate) {
	return generate([{ name: "commonName", value: name }], {
		keyType: "ec",
		algorithm: "sha256",
		notBeforeDate: new Date(Date.now() - 60_000),
		notAfterDate: new Date(Date.now() + 86_400_000),
		extensions: [
			{ name: "basicConstraints", cA: ca, critical: true },
			{ name: "keyUsage", keyCertSign: ca, digitalSignature: true, critical: true },
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "nf.example.test" },
					{ type: 7, ip: "127.0.0.1" },
					{ type: 7, ip: "::1" },
				],
			},
		],
		...(issuer ? { ca: { cert: issuer.cert, key: issuer.private } } : {}),
	});
}

async function file(content: string): Promise<string> {
	const path = join(dir, `${fileCounter++}.pem`);
	await writeFile(path, content);
	return path;
}

function pem(cert: Certificate): string {
	return new X509Certificate(cert.cert).toString();
}

async function resolve(chain: string, ca?: string, builtin?: string, url?: string) {
	return resolveExecutorInstallCa({
		serverUrl: new URL(url ?? "https://nf.example.test:7779"),
		tls: {
			enabled: true,
			certFile: await file(chain),
			caFile: ca === undefined ? undefined : await file(ca),
		},
		builtinCaCertPath: builtin === undefined ? undefined : await file(builtin),
	});
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "nf-executor-install-ca-"));
	root = await certificate("Local CA", true);
	otherRoot = await certificate("Local CA", true); // Same subject, different signing key.
	leaf = await certificate("Server", false, root);
	intermediate = await certificate("Intermediate CA", true, root);
	chainedLeaf = await certificate("Server", false, intermediate);
	legacy = await certificate("Legacy Server", false);
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("resolveExecutorInstallCa (isolated public certificate paths)", () => {
	test("chooses the root from the configured chain instead of pinning the leaf", async () => {
		expect(await resolve(`${leaf.cert}\n${root.cert}`)).toBe(pem(root));
	});

	test("finds a signing root in the built-in public CA file", async () => {
		expect(await resolve(leaf.cert, undefined, root.cert)).toBe(pem(root));
	});

	test("accepts an explicitly configured CA and ignores unrelated built-in CA", async () => {
		expect(await resolve(leaf.cert, root.cert, otherRoot.cert)).toBe(pem(root));
	});

	test("walks a shuffled chain through intermediates and selects only the root", async () => {
		expect(await resolve(`${chainedLeaf.cert}\n${root.cert}\n${intermediate.cert}`)).toBe(
			pem(root),
		);
		expect(await resolve(chainedLeaf.cert, intermediate.cert, root.cert)).toBe(pem(root));
	});

	test("leaf renewal preserves the selected trust anchor", async () => {
		const renewed = await certificate("Renewed Server", false, root);
		expect(await resolve(renewed.cert, undefined, root.cert)).toBe(
			await resolve(leaf.cert, undefined, root.cert),
		);
	});

	test("supports legacy self-signed non-CA leaves without consulting unrelated CA files", async () => {
		expect(await resolve(legacy.cert, "invalid", otherRoot.cert)).toBe(pem(legacy));
	});

	test("does not trust a same-subject CA with a different key", async () => {
		expect(await resolve(leaf.cert, undefined, otherRoot.cert)).toBeUndefined();
	});

	test("does not promote a non-CA signer to a trust anchor", async () => {
		const invalidChainLeaf = await certificate("Server", false, legacy);
		expect(await resolve(`${invalidChainLeaf.cert}\n${legacy.cert}`)).toBeUndefined();
	});

	test("verifies self-signatures rather than just equal subject and issuer", async () => {
		const raw = Buffer.from(new X509Certificate(legacy.cert).raw);
		raw[raw.length - 1] ^= 1;
		const tampered = `-----BEGIN CERTIFICATE-----\n${raw.toString("base64")}\n-----END CERTIFICATE-----`;
		expect(await resolve(tampered)).toBeUndefined();
	});

	test("keeps system roots for an incomplete/public chain and an unrelated built-in CA", async () => {
		expect(
			await resolve(`${chainedLeaf.cert}\n${intermediate.cert}`, undefined, otherRoot.cert),
		).toBeUndefined();
	});

	test("does not attach local trust to an unrelated hostname (no URL probes)", async () => {
		expect(
			await resolve(`${leaf.cert}\n${root.cert}`, undefined, undefined, "https://unrelated.test"),
		).toBeUndefined();
	});

	test("matches IPv4 and IPv6 SANs without DNS lookup", async () => {
		for (const url of ["https://127.0.0.1:7779", "https://[::1]:7779"]) {
			expect(await resolve(leaf.cert, root.cert, undefined, url)).toBe(pem(root));
		}
	});

	test("skips all files for non-HTTPS, disabled TLS and unconfigured reverse proxies", async () => {
		const missing = join(dir, "must-not-read");
		for (const options of [
			{ serverUrl: new URL("http://nf.example.test"), tls: { enabled: true, certFile: missing } },
			{ serverUrl: new URL("https://nf.example.test"), tls: { enabled: false, certFile: missing } },
			{ serverUrl: new URL("https://nf.example.test") },
			{ serverUrl: new URL("https://nf.example.test"), tls: { enabled: true } },
		]) {
			expect(
				await resolveExecutorInstallCa({ ...options, builtinCaCertPath: missing }),
			).toBeUndefined();
		}
	});

	test("returns only CERTIFICATE PEM, stripping private keys and arbitrary text", async () => {
		const result = await resolve(`comment\n${leaf.private}\n${leaf.cert}\n${root.cert}`);
		expect(result).toBe(pem(root));
		expect(result).not.toContain("PRIVATE KEY");
		expect(result).not.toContain("comment");
	});

	test("never consults configured private-key paths or passphrases", async () => {
		const tls = {
			enabled: true,
			certFile: await file(`${leaf.cert}\n${root.cert}`),
			get keyFile(): string {
				throw new Error("Private key path must not be consulted");
			},
			get passphrase(): string {
				throw new Error("Private key passphrase must not be consulted");
			},
		};
		expect(
			await resolveExecutorInstallCa({ serverUrl: new URL("https://nf.example.test"), tls }),
		).toBe(pem(root));
	});

	test("does not select expired or not-yet-valid certificates", async () => {
		for (const offset of [-3, 1]) {
			const expired = await generate([{ name: "commonName", value: "nf.example.test" }], {
				keyType: "ec",
				algorithm: "sha256",
				notBeforeDate: new Date(Date.now() + offset * 86_400_000),
				notAfterDate: new Date(Date.now() + (offset + 1) * 86_400_000),
			});
			expect(await resolve(expired.cert)).toBeUndefined();
		}
	});

	test("never exposes configured paths or private material in parser errors", async () => {
		const keyPath = await file(leaf.private);
		try {
			await resolveExecutorInstallCa({
				serverUrl: new URL("https://nf.example.test"),
				tls: { enabled: true, certFile: keyPath },
			});
			throw new Error("Expected rejection");
		} catch (error) {
			expect(String(error)).toContain("Cannot resolve executor TLS trust");
			expect(String(error)).not.toContain(keyPath);
			expect(String(error)).not.toContain("PRIVATE KEY");
		}
	});

	test("rejects malformed configured chains, missing files and non-regular files", async () => {
		await expect(
			resolve("-----BEGIN CERTIFICATE-----\nBAD\n-----END CERTIFICATE-----"),
		).rejects.toThrow("Cannot resolve executor TLS trust");
		for (const certFile of [join(dir, "missing"), dir]) {
			await expect(
				resolveExecutorInstallCa({
					serverUrl: new URL("https://nf.example.test"),
					tls: { enabled: true, certFile },
				}),
			).rejects.toThrow("Cannot resolve executor TLS trust");
		}
	});

	test("ignores missing or malformed optional built-in CA files for public TLS", async () => {
		expect(await resolve(leaf.cert, undefined, "not a certificate")).toBeUndefined();
		expect(
			await resolveExecutorInstallCa({
				serverUrl: new URL("https://nf.example.test"),
				tls: { enabled: true, certFile: await file(leaf.cert) },
				builtinCaCertPath: join(dir, "missing-ca.pem"),
			}),
		).toBeUndefined();
		await expect(resolve(leaf.cert, "invalid explicitly configured CA")).rejects.toThrow(
			"Cannot resolve executor TLS trust",
		);
	});

	test("enforces the 64 KiB bound on every certificate source", async () => {
		const oversized = `${leaf.cert}${" ".repeat(EXECUTOR_INSTALL_CA_MAX_BYTES)}`;
		await expect(resolve(oversized)).rejects.toThrow("64 KiB");
		await expect(resolve(leaf.cert, oversized)).rejects.toThrow("64 KiB");
		expect(await resolve(leaf.cert, undefined, oversized)).toBeUndefined();
		const atLimit = legacy.cert.padEnd(EXECUTOR_INSTALL_CA_MAX_BYTES, " ");
		expect(await resolve(atLimit)).toBe(pem(legacy));
	});

	test("caps certificate parsing and graph traversal", async () => {
		await expect(resolve(leaf.cert.repeat(33))).rejects.toThrow("32 certificates");
	});
});
