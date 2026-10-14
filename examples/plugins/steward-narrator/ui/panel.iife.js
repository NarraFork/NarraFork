(() => {
	// The host loads this external entry only after its authenticated SDK handshake.
	const sdk = globalThis.narrafork;
	const root = document.getElementById("narrafork-plugin-root") || document.body;
	const element = (tag, className, text) => {
		const node = document.createElement(tag);
		node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	};
	const panel = element("main", "steward-panel");
	panel.setAttribute("aria-labelledby", "steward-title");
	const heading = element("h1", "steward-title", "管家叙述者");
	heading.id = "steward-title";
	panel.appendChild(heading);
	panel.appendChild(element("p", "steward-intro", "一个绑定，只属于你。"));

	const summary = element("section", "steward-summary");
	const statusRow = element("div", "steward-status-row");
	statusRow.appendChild(element("span", "steward-label", "状态"));
	const status = element("strong", "steward-status", "正在读取…");
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	statusRow.appendChild(status);
	summary.appendChild(statusRow);
	summary.appendChild(element("div", "steward-label", "当前绑定 ID"));
	const bindingId = element("code", "steward-binding-id", "—");
	summary.appendChild(bindingId);
	const detail = element("p", "steward-detail", "正在向宿主确认绑定状态。");
	summary.appendChild(detail);
	panel.appendChild(summary);

	const actions = element("div", "steward-actions");
	const bindButton = element(
		"button",
		"steward-button steward-button-primary",
		"将当前叙述者设为管家",
	);
	bindButton.type = "button";
	bindButton.disabled = true;
	const refreshButton = element("button", "steward-button steward-button-secondary", "更新");
	refreshButton.type = "button";
	refreshButton.disabled = true;
	actions.appendChild(bindButton);
	actions.appendChild(refreshButton);
	panel.appendChild(actions);

	const composer = element("section", "steward-composer");
	composer.appendChild(element("h2", "steward-composer-title", "安全代发"));
	const recipientLabel = element("label", "steward-field-label", "收件叙述者");
	const recipientSelect = element("select", "steward-recipient");
	recipientSelect.id = "steward-recipient";
	recipientSelect.setAttribute("aria-label", "收件叙述者");
	recipientSelect.disabled = true;
	const recipientPlaceholder = element("option", "", "正在读取可访问的叙述者…");
	recipientPlaceholder.value = "";
	recipientSelect.appendChild(recipientPlaceholder);
	recipientLabel.appendChild(recipientSelect);
	composer.appendChild(recipientLabel);
	const messageLabel = element("label", "steward-field-label", "消息");
	const messageInput = element("textarea", "steward-message");
	messageInput.id = "steward-message";
	messageInput.maxLength = 16000;
	messageInput.rows = 4;
	messageInput.placeholder = "写一条要发送给所选叙述者的消息…";
	messageInput.setAttribute("aria-label", "消息");
	messageInput.disabled = true;
	messageLabel.appendChild(messageInput);
	composer.appendChild(messageLabel);
	const sendButton = element(
		"button",
		"steward-button steward-button-primary steward-send",
		"通过宿主安全发送",
	);
	sendButton.type = "button";
	sendButton.disabled = true;
	composer.appendChild(sendButton);
	panel.appendChild(composer);

	const feedback = element("p", "steward-feedback", "");
	feedback.setAttribute("role", "status");
	feedback.setAttribute("aria-live", "polite");
	panel.appendChild(feedback);
	panel.appendChild(
		element(
			"p",
			"steward-safety",
			"收件人仅来自当前用户可读的叙述者。每次代发仍由宿主重新验证绑定、用户归属和目标 ACL；面板不会获得额外权限。",
		),
	);
	root.appendChild(panel);

	if (!sdk || typeof sdk.commands?.execute !== "function" || typeof sdk.getContext !== "function") {
		status.textContent = "不可用";
		status.dataset.state = "error";
		detail.textContent = "请在 NarraFork 叙述者侧栏中打开此面板。";
		return;
	}

	let currentNarratorId = null;
	let binding = null;
	let busy = false;
	let recipientsReady = false;
	const setBusy = (value) => {
		busy = value;
		panel.setAttribute("aria-busy", String(value));
		bindButton.disabled = value || !currentNarratorId;
		refreshButton.disabled = value;
		recipientSelect.disabled = value || !recipientsReady;
		messageInput.disabled = value || !binding;
		sendButton.disabled = value || !binding || !recipientSelect.value;
	};
	const readBinding = (result) => {
		let value = result;
		for (let depth = 0; depth < 5; depth += 1) {
			if (value === null) return null;
			if (!value || typeof value !== "object") break;
			if (value.status === "failed" || value.status === "cancelled") {
				throw new Error(value.error?.message || "宿主拒绝了此次操作。");
			}
			if (Object.hasOwn(value, "output")) {
				value = value.output;
				continue;
			}
			if (Object.hasOwn(value, "binding")) {
				value = value.binding;
				continue;
			}
			if (
				typeof value.stewardNarratorId === "string" &&
				value.stewardNarratorId.trim() &&
				typeof value.boundAt === "string" &&
				Number.isInteger(value.revision) &&
				value.revision >= 1
			) {
				return value;
			}
			break;
		}
		throw new Error("宿主返回的绑定状态无效，请更新重试。");
	};
	const ensureCommandSucceeded = (result) => {
		let value = result;
		for (let depth = 0; depth < 5; depth += 1) {
			if (!value || typeof value !== "object") break;
			if (value.status === "failed" || value.status === "cancelled") {
				throw new Error(value.error?.message || "宿主拒绝了此次操作。");
			}
			if (Object.hasOwn(value, "output")) {
				value = value.output;
				continue;
			}
			break;
		}
		return value;
	};
	const readRecipientPage = (result) => {
		let value = result;
		for (let depth = 0; depth < 5; depth += 1) {
			if (!value || typeof value !== "object") break;
			if (value.status === "failed" || value.status === "cancelled") {
				throw new Error(value.error?.message || "宿主拒绝了收件人查询。");
			}
			if (Object.hasOwn(value, "output")) {
				value = value.output;
				continue;
			}
			if (Array.isArray(value.items)) return value;
			break;
		}
		throw new Error("宿主返回的收件人列表无效，请更新重试。");
	};
	const showBinding = (value) => {
		binding = value;
		bindingId.textContent = value?.stewardNarratorId || "尚未绑定";
		status.dataset.state = value ? "bound" : "unbound";
		status.textContent = !value
			? "未绑定"
			: value.stewardNarratorId === currentNarratorId
				? "当前叙述者已绑定"
				: "已绑定其他叙述者";
		if (value) {
			const date = new Date(value.boundAt);
			detail.textContent = `修订 ${value.revision} · ${Number.isNaN(date.getTime()) ? "绑定时间不可用" : date.toLocaleString("zh-CN")}`;
		} else {
			detail.textContent = "将此面板所属的当前叙述者设为你的管家。";
		}
		if (!currentNarratorId) detail.textContent = "面板未绑定叙述者，请从叙述者侧栏重新打开。";
	};
	const loadRecipients = async () => {
		recipientsReady = false;
		recipientSelect.disabled = true;
		recipientPlaceholder.textContent = "正在读取可访问的叙述者…";
		const recipients = [];
		let cursor;
		const seenCursors = new Set();
		for (;;) {
			const input = { limit: 100, ...(cursor ? { cursor } : {}) };
			const page = readRecipientPage(await sdk.commands.execute("steward.recipients", input));
			for (const row of page.items) {
				if (row && typeof row.id === "string" && row.id.trim()) recipients.push(row);
			}
			if (!page.nextCursor) break;
			const key = `${page.nextCursor.updatedAt}:${page.nextCursor.id}`;
			if (seenCursors.has(key)) throw new Error("收件人分页游标重复，已停止读取。");
			seenCursors.add(key);
			cursor = page.nextCursor;
		}
		const options = recipients.map((row) => {
			const title =
				typeof row.title === "string" && row.title.trim()
					? row.title.trim()
					: typeof row.handle === "string" && row.handle.trim()
						? row.handle.trim()
						: row.id;
			const option = element("option", "", `${title} · ${row.id}`);
			option.value = row.id;
			return option;
		});
		recipientSelect.replaceChildren(recipientPlaceholder, ...options);
		recipientPlaceholder.textContent = options.length
			? "选择可访问的叙述者…"
			: "没有可访问的叙述者";
		recipientsReady = true;
		recipientSelect.disabled = busy;
	};
	const run = async (commandId, isBinding) => {
		if (busy || (isBinding && !currentNarratorId)) return;
		setBusy(true);
		feedback.dataset.state = "pending";
		feedback.textContent = isBinding ? "正在更新绑定…" : "正在更新状态…";
		try {
			const context = await sdk.getContext();
			currentNarratorId =
				typeof context?.narrator?.id === "string" && context.narrator.id.trim()
					? context.narrator.id
					: null;
			if (isBinding && !currentNarratorId) throw new Error("当前面板未绑定叙述者，无法设置管家。");
			// No identity or role is sent. The host's authenticated UI context is authoritative.
			const result = await sdk.commands.execute(commandId, {});
			const value = readBinding(result);
			if (isBinding && !value) throw new Error("宿主尚未确认绑定，请更新状态后重试。");
			showBinding(value);
			await loadRecipients();
			feedback.dataset.state = "success";
			feedback.textContent = isBinding ? "绑定已更新。" : "状态与可访问收件人已更新。";
		} catch (error) {
			status.dataset.state = "error";
			status.textContent = "更新失败";
			feedback.dataset.state = "error";
			feedback.textContent = `失败：${error instanceof Error ? error.message : "操作未完成，请更新重试。"}`;
		} finally {
			setBusy(false);
		}
	};
	bindButton.addEventListener("click", () => run("steward.bind", true));
	refreshButton.addEventListener("click", () => run("steward.binding", false));
	recipientSelect.addEventListener("change", () => setBusy(busy));
	messageInput.addEventListener("input", () => setBusy(busy));
	sendButton.addEventListener("click", async () => {
		const targetNarratorId = recipientSelect.value;
		const message = messageInput.value;
		if (busy || !binding || !targetNarratorId || !message.trim()) return;
		setBusy(true);
		feedback.dataset.state = "pending";
		feedback.textContent = "正在由宿主验证绑定和目标 ACL 并发送…";
		try {
			ensureCommandSucceeded(
				await sdk.commands.execute("steward.panelSend", { targetNarratorId, message }),
			);
			messageInput.value = "";
			feedback.dataset.state = "success";
			feedback.textContent = "消息已由宿主安全发送。";
		} catch (error) {
			feedback.dataset.state = "error";
			feedback.textContent = `发送失败：${error instanceof Error ? error.message : "操作未完成，请更新后重试。"}`;
		} finally {
			setBusy(false);
		}
	});
	void run("steward.binding", false);
})();
