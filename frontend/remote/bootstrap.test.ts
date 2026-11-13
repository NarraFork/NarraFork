import { expect, test } from "bun:test";
import type { RemoteBackendIdentity } from "@shared/remote-access/application";
import {
	type RemoteFrontendCatalog,
	selectRemoteFrontend,
} from "@shared/remote-access/frontend-catalog";
import { parseHTML } from "linkedom";
import { showRemoteBootstrapError } from "./bootstrap";

const identity: RemoteBackendIdentity = {
	nfVersion: "0.1.0",
	sourceCommit: "a".repeat(40),
	repository: "owner/nf",
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: ["projects"],
};

function selectionFailure(disabled: boolean): unknown {
	const entry = (version: string, buildId: string, isDisabled: boolean) => ({
		repository: identity.repository,
		nfVersion: version,
		bootstrapAbi: 1,
		apiEpoch: 1,
		wireVersion: 2,
		buildId,
		manifestPath: `/remote/frontends/${buildId}/manifest.json`,
		manifestSha256: "c".repeat(64),
		disabled: isDisabled,
	});
	const catalog: RemoteFrontendCatalog = {
		schemaVersion: 1,
		bootstrapAbi: 1,
		// A newer available version must not turn either failure into a fallback.
		entries: [
			entry("0.2.0", "b".repeat(64), false),
			...(disabled ? [entry("0.1.0", "a".repeat(64), true)] : []),
		],
	};
	try {
		selectRemoteFrontend(catalog, identity);
	} catch (error) {
		return error;
	}
	throw new Error("Expected exact-version selection to fail without latest fallback");
}

function render(error: unknown, language: string) {
	const { document } = parseHTML('<html><body><div id="error"></div></body></html>');
	const root = document.getElementById("error");
	if (!root) throw new Error("Missing test root");
	showRemoteBootstrapError(root, error, language);
	expect(root.dataset.remoteState).toBe("failed");
	return root;
}

for (const language of ["en-US", "zh-CN"]) {
	const chinese = language === "zh-CN";
	test(`${language}: missing matching version names the compatibility failure and remediation`, () => {
		const error = selectionFailure(false);
		expect(error).toEqual(new Error("REMOTE_FRONTEND_NOT_AVAILABLE"));
		const root = render(error, language);
		expect(root.textContent).toContain(
			chinese
				? "没有与此 NF 后端兼容的远程前端"
				: "No compatible remote frontend is hosted for this NF backend",
		);
		expect(root.textContent).toContain(
			chinese ? "托管对应版本的远程前端或升级 NF" : "Host the matching version or upgrade NF",
		);
		expect(root.textContent).toContain(
			chinese ? "不会自动改用最新版本" : "the latest version will not be used as a fallback",
		);
	});
	test(`${language}: disabled matching version is explicit and does not suggest a latest fallback`, () => {
		const error = selectionFailure(true);
		expect(error).toEqual(new Error("REMOTE_FRONTEND_DISABLED"));
		const root = render(error, language);
		expect(root.textContent).toContain(
			chinese
				? "兼容的远程前端版本已被停用"
				: "compatible remote frontend for this NF backend is disabled",
		);
		expect(root.textContent).toContain(chinese ? "检查停用原因" : "review why it was disabled");
		expect(root.textContent).toContain(chinese ? "升级 NF" : "upgrade NF");
		expect(root.textContent).toContain(
			chinese ? "不会自动改用最新版本" : "the latest version will not be used as a fallback",
		);
	});
	test(`${language}: other failures never expose raw errors, invitations, tokens or markup`, () => {
		for (const error of [
			new Error(
				'REMOTE_FRONTEND_NOT_AVAILABLE pairingSecret=invitation-secret token=nfs_secret <img src="/api/leak">',
			),
			new Error("REMOTE_MANIFEST_HASH_MISMATCH"),
			new Error("REMOTE_FRONTEND_SELECTION_AMBIGUOUS"),
			{ message: "REMOTE_FRONTEND_DISABLED", token: "nfs_secret" },
			"pairingSecret=invitation-secret token=nfs_secret",
		]) {
			const root = render(error, language);
			expect(root.textContent).toBe(
				chinese
					? "无法安全连接此实例或加载匹配版本。请检查邀请和托管版本后重试。"
					: "Cannot securely connect or load a matching frontend. Check the invitation and hosted version, then retry.",
			);
			expect(root.textContent).not.toContain("invitation-secret");
			expect(root.textContent).not.toContain("nfs_secret");
			expect(root.textContent).not.toContain("REMOTE_");
			expect(root.querySelector("img,script,iframe")).toBeNull();
		}
	});
}
