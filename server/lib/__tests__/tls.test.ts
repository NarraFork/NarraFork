import { afterAll, describe, expect, test } from "bun:test";
import { createPublicKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the TLS directory before importing the module under test.
const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-tls-test-"));
process.env.NARRAFORK_HOME = testHome;

const {
	ensureCa,
	getAutoSans,
	getTlsPaths,
	getTlsStatus,
	issueServerCert,
	parseSanEntries,
	readCustomSans,
	regenerateCa,
} = await import("../tls");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("parseSanEntries", () => {
	test("accepts IPv4, IPv6, hostnames, wildcards and single-label names", () => {
		const { dns, ips } = parseSanEntries([
			"192.168.1.10",
			"::1",
			"fe80::1",
			"nas.local",
			"NAS.Example.COM",
			"*.home.arpa",
			"nas",
		]);
		expect(ips).toEqual(["192.168.1.10", "::1", "fe80::1"]);
		// DNS entries are canonicalized to lowercase.
		expect(dns).toEqual(["nas.local", "nas.example.com", "*.home.arpa", "nas"]);
	});

	test("deduplicates entries", () => {
		const { dns } = parseSanEntries(["nas.local", "nas.local", "NAS.local"]);
		expect(dns).toEqual(["nas.local"]);
	});

	test("rejects URL-shaped and malformed entries, naming every offender", () => {
		expect(() =>
			parseSanEntries(["https://evil.com", "ok.local", "a b", "bad_underscore.com"]),
		).toThrow(/https:\/\/evil\.com/);
		try {
			parseSanEntries(["https://evil.com", "a b"]);
			throw new Error("should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("https://evil.com");
			expect(message).toContain("a b");
			expect(message).not.toContain("ok.local");
		}
	});

	test("rejects empty entries", () => {
		expect(() => parseSanEntries(["   "])).toThrow(/Invalid SAN entries/);
	});

	test("rejects more than 50 entries", () => {
		const entries = Array.from({ length: 51 }, (_, i) => `host-${i}.local`);
		expect(() => parseSanEntries(entries)).toThrow(/Too many SAN entries/);
	});

	test("rejects over-length DNS names and bad labels", () => {
		expect(() => parseSanEntries([`${"a".repeat(64)}.com`])).toThrow();
		expect(() => parseSanEntries(["-leading.com"])).toThrow();
		expect(() => parseSanEntries(["trailing-.com"])).toThrow();
		expect(() => parseSanEntries(["a..b"])).toThrow();
	});
});

describe("getAutoSans", () => {
	test("always includes loopback names and addresses", () => {
		const sans = getAutoSans();
		expect(sans).toContain("localhost");
		expect(sans).toContain("127.0.0.1");
		expect(sans).toContain("::1");
	});
});

describe("CA flow", () => {
	test("ensureCa generates a CA certificate and is idempotent", async () => {
		const first = await ensureCa();
		expect(first.created).toBe(true);

		const cert = new X509Certificate(first.caCertPem);
		expect(cert.ca).toBe(true);
		expect(cert.subject).toContain("NarraFork Local CA");
		expect(cert.issuer).toBe(cert.subject);

		const second = await ensureCa();
		expect(second.created).toBe(false);
		expect(second.caCertPem).toBe(first.caCertPem);
	});

	test("issueServerCert signs with the CA and embeds auto + custom SANs", async () => {
		const issued = await issueServerCert(["nas.local", "192.168.99.5"]);

		// cert.pem is leaf + CA chain; X509Certificate reads the first block.
		const chainPem = readFileSync(issued.certPath, "utf8");
		const pemBlocks = chainPem.match(/-----BEGIN CERTIFICATE-----/g);
		expect(pemBlocks?.length).toBe(2);

		const leaf = new X509Certificate(chainPem);
		expect(leaf.ca).toBe(false);

		// Signature verifies against the CA public key.
		const { caCertPath, caKeyPath, keyPath, sanSidecarPath } = getTlsPaths();
		const caKey = createPublicKey(readFileSync(caCertPath, "utf8"));
		expect(leaf.verify(caKey)).toBe(true);
		expect(leaf.issuer).toContain("NarraFork Local CA");

		// SAN coverage: custom entries plus the automatic loopback set.
		const san = leaf.subjectAltName ?? "";
		expect(san).toContain("DNS:nas.local");
		expect(san).toContain("IP Address:192.168.99.5");
		expect(san).toContain("DNS:localhost");
		expect(san).toContain("IP Address:127.0.0.1");

		// Private key and SAN sidecar are not world-readable.
		expect(statSync(keyPath).mode & 0o777).toBe(0o600);
		expect(statSync(caKeyPath).mode & 0o777).toBe(0o600);
		expect(statSync(sanSidecarPath).mode & 0o777).toBe(0o600);

		// Custom SANs persisted for later re-issuance.
		expect(readCustomSans()).toEqual(["nas.local", "192.168.99.5"]);
	});

	test("issueServerCert without arguments reuses stored custom SANs", async () => {
		const issued = await issueServerCert();
		expect(issued.customSans).toEqual(["nas.local", "192.168.99.5"]);
		expect(issued.effectiveSans).toContain("nas.local");
		expect(issued.effectiveSans).toContain("192.168.99.5");
	});

	test("issueServerCert rejects invalid custom SANs without writing files", async () => {
		const before = readCustomSans();
		await expect(issueServerCert(["https://bad.example"])).rejects.toThrow(/Invalid SAN entries/);
		expect(readCustomSans()).toEqual(before);
	});

	test("regenerateCa replaces the CA and old server certs stop verifying", async () => {
		const oldChainPem = readFileSync(getTlsPaths().certPath, "utf8");
		const oldLeaf = new X509Certificate(oldChainPem);

		const ca = await regenerateCa();
		expect(ca.created).toBe(true);
		const issued = await issueServerCert();

		const newLeaf = new X509Certificate(readFileSync(issued.certPath, "utf8"));
		const newCaKey = createPublicKey(ca.caCertPem);
		expect(newLeaf.verify(newCaKey)).toBe(true);
		// The pre-regeneration leaf must NOT verify against the new CA.
		expect(oldLeaf.verify(newCaKey)).toBe(false);
		// Stored SANs survive CA regeneration.
		expect(issued.customSans).toEqual(["nas.local", "192.168.99.5"]);
	});
});

describe("getTlsStatus", () => {
	test("reports the CA-issued state after issuance", () => {
		const status = getTlsStatus();
		expect(status.caExists).toBe(true);
		expect(status.certExists).toBe(true);
		expect(status.legacySelfSigned).toBe(false);
		expect(status.caExpiresAt).toBeTruthy();
		expect(status.certExpiresAt).toBeTruthy();
		expect(status.certSans).toContain("nas.local");
		expect(status.customSans).toEqual(["nas.local", "192.168.99.5"]);
		expect(status.autoSans).toContain("localhost");
	});

	test("flags a legacy self-signed cert", async () => {
		const { certPath, keyPath } = getTlsPaths();
		const savedCert = readFileSync(certPath, "utf8");
		const savedKey = readFileSync(keyPath, "utf8");
		try {
			// The deprecated one-shot flow produces exactly the legacy on-disk shape:
			// a server cert whose issuer == subject.
			const { generateSelfSignedCert } = await import("../tls");
			await generateSelfSignedCert();
			const status = getTlsStatus();
			expect(status.certExists).toBe(true);
			expect(status.legacySelfSigned).toBe(true);
		} finally {
			writeFileSync(certPath, savedCert, { mode: 0o644 });
			writeFileSync(keyPath, savedKey, { mode: 0o600 });
		}
		expect(getTlsStatus().legacySelfSigned).toBe(false);
	});
});

describe("getTlsStatus on an empty directory", () => {
	test("reports nothing existing", () => {
		const emptyHome = mkdtempSync(join(tmpdir(), "narrafork-tls-empty-"));
		const saved = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = emptyHome;
		try {
			const status = getTlsStatus();
			expect(status.caExists).toBe(false);
			expect(status.certExists).toBe(false);
			expect(status.legacySelfSigned).toBe(false);
			expect(status.certSans).toEqual([]);
			expect(status.customSans).toEqual([]);
		} finally {
			process.env.NARRAFORK_HOME = saved;
			rmSync(emptyHome, { recursive: true, force: true });
		}
	});
});
