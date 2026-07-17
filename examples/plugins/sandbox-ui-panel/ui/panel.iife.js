(() => {
	globalThis.NarraForkExamplePanel = {
		mount(root) {
			if (root) root.textContent = "Sandbox panel ready";
		},
	};
})();
