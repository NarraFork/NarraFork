import "@frontend/lib/legacy-browser-polyfills";
import { sameRemoteBackendIdentity } from "@shared/remote-access/application";
import {
	type ConnectOptions,
	type Invitation,
	loadGrant,
	RemoteClient,
	type SavedGrant,
	takeFragmentInvitation,
} from "@shared/remote-access/browser-client";
import type { RemoteFrontendModule } from "@shared/remote-access/business-transport";
import { RecoveringTransport, type RemoteConnectionState } from "./recovering-transport";
import { integrity, sameOriginStaticUrl, selectRemoteBuild } from "./selection";

function invitationFromGrant(grant: SavedGrant): Invitation {
	return {
		instanceId: grant.instanceId,
		publicKey: grant.publicKey,
		signalUrl: grant.signalUrl,
		discoveryCapability: grant.discoveryCapability,
		pairId: "",
		pairingSecret: "",
	};
}
function loadVerifiedLink(
	href: string,
	hash: string,
	kind: "stylesheet" | "modulepreload",
): Promise<HTMLLinkElement> {
	return new Promise((resolve, reject) => {
		const link = document.createElement("link");
		link.rel = kind;
		link.href = href;
		link.crossOrigin = "anonymous";
		link.integrity = integrity(hash);
		const timer = setTimeout(() => {
			link.remove();
			reject(new Error("REMOTE_ASSET_TIMEOUT"));
		}, 30_000);
		link.onload = () => {
			clearTimeout(timer);
			resolve(link);
		};
		link.onerror = () => {
			clearTimeout(timer);
			link.remove();
			reject(new Error("REMOTE_ASSET_INTEGRITY_FAILED"));
		};
		document.head.append(link);
	});
}

export async function bootstrapRemote(
	root: HTMLElement,
	options: {
		invitation?: Invitation;
		connect?: ConnectOptions;
		importModule?: (url: string) => Promise<RemoteFrontendModule>;
	} = {},
): Promise<() => void> {
	if (navigator.serviceWorker?.controller) throw new Error("REMOTE_SERVICE_WORKER_CONTROLLED");
	const chinese = navigator.language.toLowerCase().startsWith("zh");
	let mounted = false;
	const status = (state: RemoteConnectionState) => {
		root.dataset.remoteState = state;
		window.dispatchEvent(new CustomEvent("narrafork:remote-state", { detail: state }));
		if (!mounted) root.textContent = chinese ? `远程连接：${state}` : `Remote connection: ${state}`;
	};
	status("connecting");
	let invitation = options.invitation ?? takeFragmentInvitation();
	const hostInstanceId = location.hostname.split(".")[0];
	let grant: SavedGrant | undefined;
	if (!invitation) {
		const instanceId = options.connect?.expectedInstanceId ?? hostInstanceId;
		if (!/^[a-z2-7]{52}$/.test(instanceId)) throw new Error("REMOTE_INVITATION_REQUIRED");
		grant = await loadGrant(instanceId);
		if (!grant) throw new Error("REMOTE_INVITATION_REQUIRED");
		invitation = invitationFromGrant(grant);
	}
	const pinnedInvitation = invitation;
	const connectOptions: ConnectOptions = {
		...options.connect,
		mode: "narrafork",
		persistGrant: true,
		...(grant ? { grant } : {}),
	};
	const client = await RemoteClient.connect(invitation, connectOptions);
	const transport = new RecoveringTransport(
		client,
		async () => {
			const saved = await loadGrant(pinnedInvitation.instanceId);
			if (!saved) throw new Error("REMOTE_RECONNECT_GRANT_MISSING");
			return RemoteClient.connect(invitationFromGrant(saved), { ...connectOptions, grant: saved });
		},
		status,
	);
	const links: HTMLLinkElement[] = [];
	try {
		const backendIdentity = transport.backendIdentity;
		const { manifest, assetBase, entryUrl } = await selectRemoteBuild(
			backendIdentity,
			location.origin,
		);
		const entry = manifest.files.find((file) => file.path === manifest.entry);
		if (!entry) throw new Error("REMOTE_ENTRY_UNDECLARED");
		for (const css of manifest.css) {
			const file = manifest.files.find((item) => item.path === css);
			if (!file) throw new Error("REMOTE_STYLESHEET_UNDECLARED");
			links.push(
				await loadVerifiedLink(
					sameOriginStaticUrl(new URL(css, assetBase).href, location.origin).href,
					file.sha256,
					"stylesheet",
				),
			);
		}
		links.push(await loadVerifiedLink(entryUrl, entry.sha256, "modulepreload"));
		const module = await (
			options.importModule ?? ((url: string) => import(/* @vite-ignore */ url))
		)(entryUrl);
		if (
			typeof module.mount !== "function" ||
			!sameRemoteBackendIdentity(backendIdentity, transport.backendIdentity)
		)
			throw new Error("REMOTE_MOUNT_ABI_INVALID");
		const unmount = await module.mount({ root, transport, backendIdentity, assetBase });
		mounted = true;
		return () => {
			unmount();
			transport.close();
			for (const link of links) link.remove();
		};
	} catch (error) {
		transport.close();
		for (const link of links) link.remove();
		throw error;
	}
}

/** Fixed public copy only: never render raw errors, invitation data or session credentials. */
export function showRemoteBootstrapError(
	root: HTMLElement,
	error: unknown,
	language: string,
): void {
	const chinese = language.toLowerCase().startsWith("zh");
	const code = error instanceof Error ? error.message : undefined;
	root.dataset.remoteState = "failed";
	if (code === "REMOTE_FRONTEND_NOT_AVAILABLE") {
		root.textContent = chinese
			? "没有与此 NF 后端兼容的远程前端。请托管对应版本的远程前端或升级 NF；不会自动改用最新版本。"
			: "No compatible remote frontend is hosted for this NF backend. Host the matching version or upgrade NF; the latest version will not be used as a fallback.";
	} else if (code === "REMOTE_FRONTEND_DISABLED") {
		root.textContent = chinese
			? "与此 NF 后端兼容的远程前端版本已被停用。请联系管理员检查停用原因并托管可用的匹配版本，或升级 NF；不会自动改用最新版本。"
			: "The compatible remote frontend for this NF backend is disabled. Ask the administrator to review why it was disabled and host an available matching version, or upgrade NF; the latest version will not be used as a fallback.";
	} else {
		root.textContent = chinese
			? "无法安全连接此实例或加载匹配版本。请检查邀请和托管版本后重试。"
			: "Cannot securely connect or load a matching frontend. Check the invitation and hosted version, then retry.";
	}
}

const root = typeof document === "undefined" ? null : document.getElementById("root");
if (root)
	void bootstrapRemote(root).catch((error: unknown) => {
		showRemoteBootstrapError(root, error, navigator.language);
	});
