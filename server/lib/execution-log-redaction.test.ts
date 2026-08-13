import { describe, expect, it } from "bun:test";
import {
	isSensitiveExecutionLogKey,
	redactExecutionLogPayload,
	redactExecutionLogText,
} from "./execution-log-redaction";

/**
 * The execution log is a GLOBAL admin view over every narrator's tool calls, so a
 * credential that reaches `input_json`/`output_json` becomes readable by someone
 * the user who typed it never shared it with. These tests pin the shapes that
 * actually show up in stored payloads — not a generic "does the regex fire" set.
 */
describe("redactExecutionLogText", () => {
	it("masks a bearer token in a curl command line", () => {
		const masked = redactExecutionLogText(
			`curl -H "Authorization: Bearer sk-live-abc123def456" https://api.example.com/v1/me`,
		);
		expect(masked).not.toContain("sk-live-abc123def456");
	});

	it("masks a shell export of a credential-looking variable", () => {
		const masked = redactExecutionLogText('export GITHUB_TOKEN="ghp_realSecretValue123"');
		expect(masked).not.toContain("ghp_realSecretValue123");
		// The variable NAME survives: knowing which credential was set is the
		// diagnostic value, and it is not itself a secret.
		expect(masked).toContain("GITHUB_TOKEN");
	});

	it("masks a single-quoted export value", () => {
		const masked = redactExecutionLogText("export API_SECRET='quoted-secret-value'");
		expect(masked).not.toContain("quoted-secret-value");
	});

	it("masks an unquoted export value without eating the next command", () => {
		const masked = redactExecutionLogText("export MY_TOKEN=rawvalue; echo done");
		expect(masked).not.toContain("rawvalue");
		expect(masked).toContain("echo done");
	});

	it("masks a credential passed as a separate argv flag value", () => {
		const masked = redactExecutionLogText("mysql -u root --password hunter2 mydb");
		expect(masked).not.toContain("hunter2");
		expect(masked).toContain("mydb");
	});

	it("masks a --token=value flag", () => {
		const masked = redactExecutionLogText("gh auth login --token=ghp_inlineFlagValue");
		expect(masked).not.toContain("ghp_inlineFlagValue");
	});

	it("masks a PEM private key body written through the Write tool", () => {
		const pem = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEowIBAAKCAQEAxLongBase64BodyHere",
			"AnotherLineOfBase64Payload",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const masked = redactExecutionLogText(`writing key:\n${pem}\ndone`);
		expect(masked).not.toContain("MIIEowIBAAKCAQEAxLongBase64BodyHere");
		expect(masked).toContain("done");
	});

	it("masks a JWT appearing bare in stdout", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s3cr3tSignaturePart";
		const masked = redactExecutionLogText(`token is ${jwt}`);
		expect(masked).not.toContain("s3cr3tSignaturePart");
	});

	it("leaves an ordinary command untouched", () => {
		const command = "bun test server/services/execution-log-service.test.ts";
		expect(redactExecutionLogText(command)).toBe(command);
	});
});

describe("isSensitiveExecutionLogKey", () => {
	it("matches credential keys across casing conventions", () => {
		for (const key of [
			"password",
			"passWord",
			"api_key",
			"apiKey",
			"API-KEY",
			"accessToken",
			"refresh_token",
			"privateKey",
			"authorization",
			"cookie",
			"passphrase",
			"clientSecret",
		]) {
			expect(isSensitiveExecutionLogKey(key)).toBe(true);
		}
	});

	it("does not match keys whose masking would gut the log", () => {
		for (const key of ["id", "name", "userId", "filePath", "command", "description", "url"]) {
			expect(isSensitiveExecutionLogKey(key)).toBe(false);
		}
	});
});

describe("redactExecutionLogPayload", () => {
	it("masks a sensitive key whose value has no recognizable shape", () => {
		// The whole reason structural traversal exists: nothing here is
		// pattern-matchable, only the key name says it is a secret.
		const masked = redactExecutionLogPayload({ password: "hunter2" }) as Record<string, unknown>;
		expect(masked.password).toBe("[REDACTED]");
	});

	it("preserves object shape so the client can still render it", () => {
		const masked = redactExecutionLogPayload({
			command: "echo hi",
			timeout: 5000,
			run_in_background: false,
			apiKey: "secret",
		}) as Record<string, unknown>;
		expect(masked.command).toBe("echo hi");
		expect(masked.timeout).toBe(5000);
		expect(masked.run_in_background).toBe(false);
		expect(masked.apiKey).toBe("[REDACTED]");
	});

	it("recurses into nested objects and arrays", () => {
		const masked = redactExecutionLogPayload({
			headers: [{ name: "Authorization", value: "Bearer sk-nested-secret" }],
			env: { nested: { token: "deep-secret" } },
		}) as Record<string, unknown>;
		const serialized = JSON.stringify(masked);
		expect(serialized).not.toContain("sk-nested-secret");
		expect(serialized).not.toContain("deep-secret");
	});

	it("masks credential shapes inside string values, not just sensitive keys", () => {
		const masked = redactExecutionLogPayload({
			command: 'curl -H "Authorization: Bearer sk-in-a-value" https://x.test',
		}) as Record<string, unknown>;
		expect(String(masked.command)).not.toContain("sk-in-a-value");
	});

	it("stops at a depth ceiling instead of recursing without a floor", () => {
		// Masking runs on every detail read, so a pathological payload must not be
		// able to turn one request into unbounded work.
		let deep: unknown = "leaf";
		for (let i = 0; i < 40; i++) deep = { next: deep };
		const serialized = JSON.stringify(redactExecutionLogPayload(deep));
		expect(serialized).toContain("depth limit");
	});

	it("passes through null and primitives unchanged", () => {
		expect(redactExecutionLogPayload(null)).toBeNull();
		expect(redactExecutionLogPayload(undefined)).toBeUndefined();
		expect(redactExecutionLogPayload(42)).toBe(42);
		expect(redactExecutionLogPayload(true)).toBe(true);
	});

	it("keeps array length so index-addressed output stays aligned", () => {
		const masked = redactExecutionLogPayload(["a", "b", "c"]) as unknown[];
		expect(masked).toHaveLength(3);
	});
});
