import type {
	BusinessSocket,
	RemoteBusinessTransport,
	RemoteFrontendModule,
} from "@shared/remote-access/business-transport";

/** A transport fixture ONLY. The UI and its workers are the actual production dist. */
const calls: { path: string; method: string }[] = [];
const authOrder: string[] = [];
Reflect.set(window, "remoteFixtureCalls", calls);
Reflect.set(window, "remoteFixtureAuthOrder", authOrder);
localStorage.setItem("narrafork_lang", "en");
const user = { id: "admin", username: "admin", role: "admin", avatarImageId: null };
const narrator = {
	id: "nnnnnnnnnnnnnnnnnnnnn",
	title: "Remote production session",
	status: "idle",
	type: "primary",
	cwd: "/fixture",
	model: "",
	permissionMode: "default",
	traits: [],
	createdAt: new Date().toISOString(),
	contextProjectId: "ppppppppppppppppppppp",
	canWrite: true,
};
class FixtureSocket extends EventTarget implements BusinessSocket {
	readyState = 0;
	bufferedAmount = 0;
	binaryType: BinaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	constructor() {
		super();
		setTimeout(() => {
			this.readyState = 1;
			this.onopen?.(new Event("open"));
		}, 0);
	}
	send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
		if (typeof data !== "string") return;
		const message = JSON.parse(data);
		if (message.type === "subscribe") {
			setTimeout(
				() =>
					this.onmessage?.(
						new MessageEvent("message", {
							data: JSON.stringify({
								type: "status",
								narratorId: "nnnnnnnnnnnnnnnnnnnnn",
								status: "idle",
								permissions: [],
								buffer: [],
								messageVersion: 1,
							}),
						}),
					),
				0,
			);
		}
	}
	close(code = 1000, reason = "") {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}
}
const transport: RemoteBusinessTransport = {
	backendIdentity: {
		nfVersion: "0.1.0",
		sourceCommit: "a".repeat(40),
		repository: "owner/nf",
		bootstrapAbi: 1,
		apiEpoch: 1,
		wireVersion: 2,
		capabilities: [
			"projects",
			"narrators",
			"approvals",
			"small-attachments",
			"sse",
			"binary-socket",
		],
	},
	async authenticate() {
		authOrder.push("authenticate");
	},
	async request(path, options) {
		const method = options?.method ?? "GET";
		calls.push({ path, method });
		const pathname = path.split("?")[0];
		if (pathname === "/api/auth/login")
			return Response.json({
				mfaRequired: true,
				mfaToken: "challenge",
				methods: ["totp", "backup_code"],
			});
		if (pathname === "/api/auth/mfa/verify")
			return Response.json({ token: "nfs_fixture", user, language: "en" });
		if (pathname === "/api/auth/logout") return Response.json({ ok: true });
		if (!authOrder.length) throw new Error("Business query before authentication");
		authOrder.push(pathname);
		if (pathname === "/api/auth/me") return Response.json(user);
		if (pathname === "/api/projects")
			return Response.json([
				{ id: "ppppppppppppppppppppp", name: "Remote production project", status: "active" },
			]);
		if (pathname === "/api/projects/ppppppppppppppppppppp")
			return Response.json({
				id: "ppppppppppppppppppppp",
				name: "Remote production project",
				canWrite: true,
				gitPath: "/fixture",
			});
		if (pathname === "/api/narrators")
			return Response.json({ items: [narrator], hasMore: false, nextCursor: null, totalCount: 1 });
		if (pathname === "/api/narrators/nnnnnnnnnnnnnnnnnnnnn") return Response.json(narrator);
		if (pathname === "/api/narrators/nnnnnnnnnnnnnnnnnnnnn/messages" && method === "POST")
			return Response.json({ ok: true });
		if (pathname === "/api/narrators/nnnnnnnnnnnnnnnnnnnnn/workspace-context")
			return Response.json({
				revision: 1,
				deviceId: "local",
				cwd: "/fixture",
				pathFlavor: "posix",
				contextKey: "fixture",
				capabilities: { switchDirectory: false },
			});
		if (pathname === "/api/settings")
			return Response.json({
				agent: {},
				openaiModels: [],
				anthropicModels: [],
				nugProviders: [],
				providerReadiness: [],
				outline: { enabled: true },
			});
		if (pathname === "/api/settings/context-thresholds") return Response.json({ compactStart: 80 });
		if (pathname === "/api/health") return Response.json({ platform: "linux" });
		if (pathname === "/api/model-catalog/auto") return Response.json({ models: [] });
		if (pathname === "/api/user-preferences")
			return Response.json({
				language: "en",
				commands: [],
				recentTabs: [],
				autoLoadOlderMessages: false,
				setupWizardCompleted: true,
				notifyPwaEnabled: true,
				notifySoundEnabled: true,
				notifySoundType: "custom",
				notifySoundFileId: "old-sound",
				narratorToolbarLayout: {
					items: [{ id: "terminal" }, { id: "plugins" }, { id: "outline" }],
				},
			});
		if (pathname.endsWith("/panel-state"))
			return Response.json({
				permissions: [],
				buffer: [],
				draft: { hasDraft: false, revision: 0, updatedAt: null },
				hasMore: { permissions: false, buffer: false },
			});
		if (pathname.endsWith("/pretext-document"))
			return Response.json(Reflect.get(window, "remoteFixtureHistory"));
		if (pathname.endsWith("/tasks/current")) return Response.json({ task: null });
		if (pathname.endsWith("/draft"))
			return Response.json({ content: "", message: "", images: [], textFiles: [], revision: 0 });
		if (/\/(?:permissions|questions|commands|skills|custom-traits|buffer)$/.test(pathname))
			return Response.json([]);
		if (pathname.endsWith("/mark-read")) return Response.json({ ok: true });
		return Response.json({ error: "Fixture route is not implemented", path }, { status: 501 });
	},
	upload: async (path, body, options) => {
		calls.push({ path, method: "UPLOAD" });
		if (path !== "/api/narrators/nnnnnnnnnnnnnnnnnnnnn/messages" || !(body instanceof FormData))
			throw new Error("Unexpected fixture upload");
		options?.onProgress?.(1);
		return Response.json({ ok: true });
	},
	openSocket: () => new FixtureSocket(),
	close() {
		Reflect.set(window, "remoteFixtureClosed", true);
	},
};
const base = `/remote/frontends/${"b".repeat(64)}/`;
const module: RemoteFrontendModule = await import(`${base}mount.js`);
const root = document.getElementById("root");
if (!root || !transport.backendIdentity) throw new Error("Fixture root/identity missing");
await module.mount({
	root,
	transport,
	backendIdentity: transport.backendIdentity,
	assetBase: new URL(base, location.origin).href,
});
Reflect.set(window, "remoteFixtureMounted", true);
