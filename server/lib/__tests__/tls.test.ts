import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lanAddresses from "../net/lan-addresses";
import type { TlsConfig } from "../settings/types";

// Redirect the TLS directory before importing the module under test.
const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-tls-test-"));
process.env.NARRAFORK_HOME = testHome;

const {
	ensureCa,
	generateSelfSignedCert,
	getAutoSans,
	getTlsPaths,
	getTlsStatus,
	issueServerCert,
	parseSanEntries,
	readCustomSans,
	regenerateCa,
	reissueBuiltinTlsOnStartup,
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

describe("reissueBuiltinTlsOnStartup", () => {
	let home: string;
	let savedHome: string | undefined;
	let lanSpy: ReturnType<typeof spyOn<typeof lanAddresses, "getLanAddresses">>;

	beforeEach(() => {
		savedHome = process.env.NARRAFORK_HOME;
		home = mkdtempSync(join(tmpdir(), "narrafork-tls-startup-"));
		process.env.NARRAFORK_HOME = home;
		lanSpy = spyOn(lanAddresses, "getLanAddresses").mockReturnValue(["192.168.1.10"]);
	});

	afterEach(() => {
		lanSpy.mockRestore();
		if (savedHome === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	});

	function builtinConfig(): TlsConfig {
		const { certPath, keyPath } = getTlsPaths();
		return { enabled: true, certFile: certPath, keyFile: keyPath };
	}

	function snapshotFiles() {
		const { certPath, keyPath, caCertPath, caKeyPath, sanSidecarPath } = getTlsPaths();
		return [certPath, keyPath, caCertPath, caKeyPath, sanSidecarPath].map((path) =>
			readFileSync(path, "utf8"),
		);
	}

	test.each([
		["added", ["192.168.1.10"], ["192.168.1.10", "192.168.1.20"]],
		["removed", ["192.168.1.10", "192.168.1.20"], ["192.168.1.10"]],
	])("reissues when a LAN IP is %s, preserving CA and custom SANs", async (_, before, after) => {
		lanSpy.mockReturnValue(before);
		await issueServerCert(["nas.local", "10.20.30.40"]);
		const previous = snapshotFiles();
		lanSpy.mockReturnValue(after);

		// autoReissue deliberately omitted: existing configurations default to enabled.
		expect(await reissueBuiltinTlsOnStartup(builtinConfig())).toBe(true);
		const current = snapshotFiles();
		expect(current[0]).not.toBe(previous[0]);
		expect(current[1]).not.toBe(previous[1]);
		expect(current.slice(2)).toEqual(previous.slice(2));
		expect(readCustomSans()).toEqual(["nas.local", "10.20.30.40"]);
		const leaf = new X509Certificate(current[0]);
		expect(leaf.verify(new X509Certificate(current[2]).publicKey)).toBe(true);
		expect(leaf.checkHost("nas.local")).toBe("nas.local");
		expect(leaf.checkIP("10.20.30.40")).toBe("10.20.30.40");
		for (const ip of after) expect(leaf.checkIP(ip)).toBe(ip);
		if (!after.includes("192.168.1.20")) {
			expect(leaf.checkIP("192.168.1.20")).toBeUndefined();
		}
		// An immediate second startup must be a no-op.
		expect(await reissueBuiltinTlsOnStartup(builtinConfig())).toBe(false);
		expect(snapshotFiles()).toEqual(current);
	});

	test("ignores SAN order, duplicates and equivalent IPv6 spellings", async () => {
		lanSpy.mockReturnValue(["192.168.1.10", "192.168.1.20"]);
		await issueServerCert(["nas.local", "2001:db8::1"]);
		const before = snapshotFiles();
		lanSpy.mockReturnValue(["192.168.1.20", "192.168.1.10", "192.168.1.10"]);
		// OpenSSL exposes expanded IPv6 SANs, while the sidecar uses compressed form.
		expect(await reissueBuiltinTlsOnStartup(builtinConfig())).toBe(false);
		expect(snapshotFiles()).toEqual(before);
	});

	test("does not touch certificates when opted out, disabled, absent or external", async () => {
		await issueServerCert([]);
		const before = snapshotFiles();
		lanSpy.mockReturnValue(["192.168.1.20"]);
		const config = builtinConfig();
		const configs: (TlsConfig | undefined)[] = [
			undefined,
			{ ...config, enabled: false },
			{ ...config, autoReissue: false },
			{ ...config, certFile: join(home, "external-cert.pem") },
			{ ...config, keyFile: join(home, "external-key.pem") },
			{ ...config, certFile: "" },
			{ ...config, keyFile: "" },
			{ ...config, passphrase: "encrypted-key" },
		];
		for (const candidate of configs) {
			expect(await reissueBuiltinTlsOnStartup(candidate)).toBe(false);
			expect(snapshotFiles()).toEqual(before);
		}
	});

	test("does not replace a leaf signed by a different CA with the same issuer name", async () => {
		await issueServerCert([]);
		await regenerateCa();
		const before = snapshotFiles();
		lanSpy.mockReturnValue(["192.168.1.20"]);
		expect(await reissueBuiltinTlsOnStartup(builtinConfig())).toBe(false);
		expect(snapshotFiles()).toEqual(before);
	});

	test("does not replace legacy self-signed certificates", async () => {
		await issueServerCert([]);
		await generateSelfSignedCert();
		const before = snapshotFiles();
		lanSpy.mockReturnValue(["192.168.1.20"]);
		expect(await reissueBuiltinTlsOnStartup(builtinConfig())).toBe(false);
		expect(snapshotFiles()).toEqual(before);
	});

	test.each([
		"caCertPath",
		"caKeyPath",
	] as const)("does not create a missing %s or change the remaining files", async (missing) => {
		await issueServerCert([]);
		const paths = getTlsPaths();
		rmSync(paths[missing]);
		const remaining = [paths.certPath, paths.keyPath, paths.caCertPath, paths.caKeyPath].filter(
			(path) => path !== paths[missing],
		);
		const before = remaining.map((path) => readFileSync(path, "utf8"));
		lanSpy.mockReturnValue(["192.168.1.20"]);
		expect(await reissueBuiltinTlsOnStartup(builtinConfig())).toBe(false);
		expect(existsSync(paths[missing])).toBe(false);
		expect(remaining.map((path) => readFileSync(path, "utf8"))).toEqual(before);
	});

	test("backdates new CA, leaf and legacy certificates by five minutes", async () => {
		const skew = 5 * 60 * 1000;
		function expectBackdated(pem: string, started: number, finished: number) {
			const notBefore = Date.parse(new X509Certificate(pem).validFrom);
			// X.509 timestamps truncate milliseconds to whole seconds.
			expect(notBefore).toBeGreaterThanOrEqual(started - skew - 1000);
			expect(notBefore).toBeLessThanOrEqual(finished - skew);
		}

		let started = Date.now();
		const ca = await ensureCa();
		expectBackdated(ca.caCertPem, started, Date.now());
		started = Date.now();
		const leaf = await issueServerCert([]);
		expectBackdated(readFileSync(leaf.certPath, "utf8"), started, Date.now());
		started = Date.now();
		const legacy = await generateSelfSignedCert();
		expectBackdated(readFileSync(legacy.certPath, "utf8"), started, Date.now());
	});

	test("issued leaf lifetime stays within Apple's 825-day cap", async () => {
		// iOS 13+/macOS 10.15+ reject TLS leaves valid for more than 825 days,
		// including ones chaining to a user-installed and trusted root. A longer
		// leaf breaks Safari on those platforms while looking fine on desktop,
		// so guard the cap rather than the exact constant.
		const APPLE_MAX_DAYS = 825;

		const issued = await issueServerCert([]);
		const leaf = new X509Certificate(readFileSync(issued.certPath, "utf8"));
		const lifetimeDays =
			(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / (24 * 60 * 60 * 1000);

		expect(lifetimeDays).toBeLessThanOrEqual(APPLE_MAX_DAYS);
		// Still long enough that routine use does not mean constant reissuance.
		expect(lifetimeDays).toBeGreaterThan(365);

		const legacy = await generateSelfSignedCert();
		const legacyLeaf = new X509Certificate(readFileSync(legacy.certPath, "utf8"));
		const legacyDays =
			(Date.parse(legacyLeaf.validTo) - Date.parse(legacyLeaf.validFrom)) / (24 * 60 * 60 * 1000);
		expect(legacyDays).toBeLessThanOrEqual(APPLE_MAX_DAYS);
		expect(legacyDays).toBeGreaterThan(365);
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
