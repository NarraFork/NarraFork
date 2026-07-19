(() => {
	const run = async () => {
		const result = {
			parentDocumentBlocked: false,
			parentStorageBlocked: false,
			opaqueStorageBlocked: false,
			networkBlocked: false,
			topNavigationBlocked: false,
			evalBlocked: false,
			contextPluginId: null,
			contextContributionId: null,
		};

		try {
			void window.parent.document.body;
		} catch {
			result.parentDocumentBlocked = true;
		}
		try {
			void window.parent.localStorage.length;
		} catch {
			result.parentStorageBlocked = true;
		}
		try {
			localStorage.setItem("narrafork_hostile_probe", "blocked");
		} catch {
			result.opaqueStorageBlocked = true;
		}
		try {
			await fetch("/api/health", { cache: "no-store" });
		} catch {
			result.networkBlocked = true;
		}
		try {
			window.top.location.replace("https://example.invalid/narrafork-hostile-probe");
		} catch {
			result.topNavigationBlocked = true;
		}
		try {
			// Deliberately resolve eval indirectly to exercise the iframe's CSP.
			const evaluate = globalThis[atob("ZXZhbA==")];
			evaluate("1 + 1");
		} catch {
			result.evalBlocked = true;
		}

		try {
			const context = await globalThis.narrafork.getContext();
			result.contextPluginId = context?.plugin?.id ?? null;
			result.contextContributionId = context?.plugin?.contributionId ?? null;
		} catch {
			// The host reports context failure separately; the sandbox probes still complete.
		}

		globalThis.narrafork.notify("hostile.probe", result);
	};

	void run();
})();
