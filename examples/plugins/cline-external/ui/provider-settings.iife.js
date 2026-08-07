(() => {
  // examples/plugins/cline-external/src/ui/provider-settings.ts
  var COLORS = {
    text: "#e6e6e6",
    muted: "#8b8b8b",
    bad: "#ff8a8a",
    good: "#7ee0a2",
    warn: "#c9a227",
    panel: "#2a2a2e",
    border: "#3a3a40",
    input: "#1a1a1e"
  };
  (() => {
    const sdk = globalThis.narrafork;
    if (!sdk)
      return;
    const root = document.body;
    const style = (element2, css) => {
      Object.assign(element2.style, css);
    };
    function element(tag, css = {}, text) {
      const node = document.createElement(tag);
      if (text !== undefined)
        node.textContent = text;
      style(node, css);
      return node;
    }
    function button(label, onClick, tone = "normal") {
      const node = element("button", {
        padding: "4px 10px",
        font: "12px system-ui, sans-serif",
        color: tone === "bad" ? COLORS.bad : COLORS.text,
        background: COLORS.panel,
        border: `1px solid ${COLORS.border}`,
        borderRadius: "5px",
        cursor: "pointer",
        marginRight: "6px"
      });
      node.textContent = label;
      node.addEventListener("click", onClick);
      return node;
    }
    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    let busy = false;
    let selection = new Set;
    let lastStatus;
    async function command(commandId, input) {
      const raw = await sdk.request("commands.execute", {
        commandId,
        ...input === undefined ? {} : { input }
      });
      if (isRecord(raw) && "output" in raw)
        return raw.output;
      return raw;
    }
    const header = element("div", {
      font: "600 14px/1.9 system-ui, sans-serif",
      color: COLORS.text
    });
    header.textContent = "Cline account";
    root.appendChild(header);
    const account = element("div", { font: "13px/1.7 system-ui, sans-serif" });
    root.appendChild(account);
    const signIn = element("div", { margin: "10px 0" });
    root.appendChild(signIn);
    const balanceArea = element("div", { marginTop: "12px" });
    root.appendChild(balanceArea);
    const modelsArea = element("div", { marginTop: "16px" });
    root.appendChild(modelsArea);
    const statusLine = element("div", {
      font: "12px/1.7 system-ui, sans-serif",
      color: COLORS.muted,
      marginTop: "12px",
      minHeight: "18px"
    });
    root.appendChild(statusLine);
    function setStatus(message, tone = "normal") {
      statusLine.textContent = message;
      statusLine.style.color = tone === "bad" ? COLORS.bad : tone === "good" ? COLORS.good : COLORS.muted;
    }
    function setBusy(isBusy) {
      busy = isBusy;
      for (const node of root.querySelectorAll("button")) {
        node.disabled = isBusy;
        node.style.opacity = isBusy ? "0.5" : "1";
      }
    }
    function run(label, action) {
      if (busy)
        return;
      setBusy(true);
      setStatus(`${label}…`);
      action().then(() => {
        setStatus(`${label} done.`, "good");
        return refresh();
      }).catch((error) => {
        setStatus(`${label} failed: ${String(error)}`, "bad");
      }).finally(() => setBusy(false));
    }
    function formatTimestamp(seconds) {
      if (!seconds)
        return "";
      const date = new Date(seconds < 10000000000 ? seconds * 1000 : seconds);
      return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    }
    function renderAccount(status) {
      account.replaceChildren();
      if (status.credentialError) {
        const warning = element("div", { color: COLORS.bad });
        warning.textContent = `Stored credentials are unreadable: ${status.credentialError}. Sign out and sign in again.`;
        account.appendChild(warning);
        return;
      }
      if (!status.authenticated) {
        const notSignedIn = element("div", { color: COLORS.warn });
        notSignedIn.textContent = "Not signed in.";
        account.appendChild(notSignedIn);
        return;
      }
      const who = element("div", { color: COLORS.text });
      who.textContent = status.displayName || status.email || "Signed in";
      account.appendChild(who);
      const facts = [
        status.email && status.email !== status.displayName ? status.email : undefined,
        status.expiresAt ? `token ${status.expired ? "expired" : "valid"} · ${formatTimestamp(status.expiresAt)}` : undefined,
        `${status.enabledModelCount} models enabled`,
        status.poolModelCount ? `${status.poolModelCount} models in pool` : undefined
      ].filter((value) => Boolean(value));
      account.appendChild(element("div", { font: "12px/1.7 ui-monospace, monospace", color: COLORS.muted }, facts.join("  ·  ")));
    }
    function renderSignIn(status) {
      signIn.replaceChildren();
      if (status.browserAuth !== "unsupported") {
        signIn.appendChild(button("Sign in with browser", () => run("Browser sign-in", async () => {
          const result = await command("auth.browser");
          const url = isRecord(result) ? result.authorizeUrl : undefined;
          if (typeof url !== "string")
            throw new Error("No authorization URL returned");
          showAuthorizeUrl(url);
        })));
      }
      const note = element("div", {
        font: "11px/1.6 system-ui, sans-serif",
        color: status.browserAuth === "available" ? COLORS.muted : COLORS.warn,
        marginTop: "4px",
        marginBottom: "6px"
      });
      if (status.browserAuth === "port_busy") {
        note.textContent = "Callback port 19876 is in use, possibly by the built-in Cline provider signing in. You can retry, or paste the callback URL below.";
      } else if (status.browserAuth === "unsupported") {
        note.textContent = "This environment cannot receive a browser callback. Use the paste option below.";
      } else if (status.signInPending) {
        note.textContent = "Waiting for the browser callback…";
      }
      if (note.textContent)
        signIn.appendChild(note);
      if (status.signInPending) {
        signIn.appendChild(button("Cancel sign-in", () => run("Cancel sign-in", () => command("auth.cancel"))));
      }
      signIn.appendChild(element("div", { font: "12px/1.6 system-ui, sans-serif", color: COLORS.muted, marginTop: "8px" }, "Or paste the callback URL your browser was redirected to:"));
      const pasteBox = element("input", {
        width: "100%",
        padding: "5px 8px",
        marginTop: "4px",
        font: "12px ui-monospace, monospace",
        color: COLORS.text,
        background: COLORS.input,
        border: `1px solid ${COLORS.border}`,
        borderRadius: "4px",
        boxSizing: "border-box"
      });
      pasteBox.placeholder = "http://localhost:19876/auth/callback?code=…";
      signIn.appendChild(pasteBox);
      const importButton = button("Import callback URL", () => {
        const callbackUrl = pasteBox.value.trim();
        if (!callbackUrl) {
          setStatus("Nothing to import.", "bad");
          return;
        }
        pasteBox.value = "";
        run("Import credentials", () => command("auth.callback", { callbackUrl }));
      });
      style(importButton, { marginTop: "6px" });
      signIn.appendChild(importButton);
      if (status.authenticated) {
        const signOut = button("Sign out", () => run("Sign out", () => command("auth.logout")), "bad");
        style(signOut, { marginTop: "6px" });
        signIn.appendChild(signOut);
      }
    }
    function showAuthorizeUrl(url) {
      const existing = signIn.querySelector("[data-authorize-url]");
      if (existing)
        existing.remove();
      const box = element("div", {
        marginTop: "8px",
        padding: "8px 10px",
        background: COLORS.panel,
        border: `1px solid ${COLORS.border}`,
        borderRadius: "5px"
      });
      box.setAttribute("data-authorize-url", "1");
      box.appendChild(element("div", { font: "12px/1.6 system-ui, sans-serif", color: COLORS.text }, "Open this URL to authorize, then return here:"));
      const link = element("a", {
        font: "12px/1.6 ui-monospace, monospace",
        color: COLORS.good,
        wordBreak: "break-all"
      });
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = url;
      box.appendChild(link);
      signIn.appendChild(box);
    }
    function renderBalance(status) {
      balanceArea.replaceChildren();
      if (!status.authenticated)
        return;
      balanceArea.appendChild(button("Check balance", () => {
        const existing = balanceArea.querySelector("[data-balance]");
        if (existing)
          existing.remove();
        const box = element("div", {
          marginTop: "6px",
          padding: "6px 10px",
          background: COLORS.panel,
          borderRadius: "5px",
          font: "12px/1.6 system-ui, sans-serif",
          color: COLORS.muted
        });
        box.setAttribute("data-balance", "1");
        box.textContent = "Loading balance…";
        balanceArea.appendChild(box);
        command("balance").then((result) => {
          const micro = isRecord(result) ? result.balance : undefined;
          if (typeof micro !== "number") {
            box.textContent = "No balance data available.";
            return;
          }
          box.textContent = `Balance: $${(micro / 1e6).toFixed(2)}`;
          box.style.color = COLORS.text;
        }).catch((error) => {
          box.textContent = `Balance failed: ${String(error)}`;
          box.style.color = COLORS.bad;
        });
      }));
    }
    function modelRow(id, label, detail) {
      const row = element("label", {
        display: "block",
        padding: "3px 0",
        font: "12px/1.6 system-ui, sans-serif",
        color: COLORS.text,
        cursor: "pointer"
      });
      const box = element("input", { marginRight: "6px" });
      box.type = "checkbox";
      box.checked = selection.has(id);
      box.addEventListener("change", () => {
        if (box.checked)
          selection.add(id);
        else
          selection.delete(id);
        renderSelectionSummary();
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(label));
      if (detail) {
        const note = element("span", {
          color: COLORS.muted,
          font: "11px ui-monospace, monospace",
          marginLeft: "6px"
        });
        note.textContent = detail;
        row.appendChild(note);
      }
      return row;
    }
    const selectionSummary = element("div", {
      font: "12px/1.7 system-ui, sans-serif",
      color: COLORS.muted,
      marginTop: "6px"
    });
    function renderSelectionSummary() {
      const saved = new Set(lastStatus?.enabledModels ?? []);
      const changed = saved.size !== selection.size || [...selection].some((id) => !saved.has(id));
      selectionSummary.textContent = `${selection.size} selected${changed ? " · unsaved changes" : ""}`;
      selectionSummary.style.color = changed ? COLORS.warn : COLORS.muted;
    }
    function renderModels(status) {
      modelsArea.replaceChildren();
      modelsArea.appendChild(element("div", { font: "600 13px/1.8 system-ui, sans-serif", color: COLORS.text }, "Models"));
      modelsArea.appendChild(element("div", { font: "12px/1.6 system-ui, sans-serif", color: COLORS.muted }, "Only the models you enable here are offered to the agent."));
      if (selection.size > 0) {
        const enabledBox = element("div", { marginTop: "8px" });
        enabledBox.appendChild(element("div", { font: "600 12px/1.8 system-ui, sans-serif", color: COLORS.muted }, "Enabled"));
        for (const id of [...selection].sort())
          enabledBox.appendChild(modelRow(id, id));
        modelsArea.appendChild(enabledBox);
      }
      modelsArea.appendChild(selectionSummary);
      renderSelectionSummary();
      const actions = element("div", { marginTop: "6px" });
      actions.appendChild(button("Save selection", () => run("Save models", () => command("config.setEnabledModels", { models: [...selection] }))));
      actions.appendChild(button("Refresh pool", () => run("Refresh pool", () => command("models.refresh"))));
      actions.appendChild(button("Revert", () => {
        selection = new Set(status.enabledModels ?? []);
        renderModels(status);
      }));
      modelsArea.appendChild(actions);
      renderRecommended();
      renderSearch();
    }
    function renderRecommended() {
      const box = element("div", { marginTop: "12px" });
      box.appendChild(element("div", { font: "600 12px/1.8 system-ui, sans-serif", color: COLORS.muted }, "Recommended and free"));
      const list = element("div", {});
      list.textContent = "Loading…";
      box.appendChild(list);
      modelsArea.appendChild(box);
      command("recommended-models").then((result) => {
        if (!isRecord(result)) {
          list.textContent = "No recommendations available.";
          return;
        }
        const groups = [
          ["Recommended", result.recommended],
          ["Free", result.free]
        ];
        list.replaceChildren();
        for (const [label, entries] of groups) {
          if (!Array.isArray(entries) || entries.length === 0)
            continue;
          list.appendChild(element("div", { font: "11px/1.8 system-ui, sans-serif", color: COLORS.muted, marginTop: "4px" }, label));
          for (const entry of entries) {
            if (!entry?.id)
              continue;
            const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
            list.appendChild(modelRow(entry.id, `${entry.name || entry.id}${tags}`, entry.id));
          }
        }
        if (!list.hasChildNodes())
          list.textContent = "No recommendations available.";
      }).catch((error) => {
        list.textContent = `Recommendations failed: ${String(error)}`;
        list.style.color = COLORS.bad;
      });
    }
    function renderSearch() {
      const box = element("div", { marginTop: "12px" });
      box.appendChild(element("div", { font: "600 12px/1.8 system-ui, sans-serif", color: COLORS.muted }, "Search the model pool"));
      const field = element("input", {
        width: "100%",
        padding: "5px 8px",
        marginTop: "4px",
        font: "12px ui-monospace, monospace",
        color: COLORS.text,
        background: COLORS.input,
        border: `1px solid ${COLORS.border}`,
        borderRadius: "4px",
        boxSizing: "border-box"
      });
      field.placeholder = "e.g. claude sonnet";
      box.appendChild(field);
      const results = element("div", {
        marginTop: "6px",
        maxHeight: "260px",
        overflowY: "auto"
      });
      box.appendChild(results);
      modelsArea.appendChild(box);
      const search = () => {
        results.replaceChildren();
        results.textContent = "Searching…";
        command("models.search", { query: field.value, limit: 50 }).then((result) => {
          const models = isRecord(result) && Array.isArray(result.models) ? result.models : [];
          const total = isRecord(result) && typeof result.total === "number" ? result.total : 0;
          results.replaceChildren();
          if (models.length === 0) {
            results.textContent = "No matches.";
            return;
          }
          results.appendChild(element("div", { font: "11px/1.7 system-ui, sans-serif", color: COLORS.muted }, `${models.length} of ${total} shown`));
          for (const model of models) {
            if (!model?.id)
              continue;
            const context = model.contextLength ? `${Math.round(model.contextLength / 1024)}k ctx` : "";
            results.appendChild(modelRow(model.id, model.name || model.id, context));
          }
        }).catch((error) => {
          results.textContent = `Search failed: ${String(error)}`;
          results.style.color = COLORS.bad;
        });
      };
      const searchButton = button("Search", search);
      style(searchButton, { marginTop: "6px" });
      box.appendChild(searchButton);
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter")
          search();
      });
    }
    async function refresh() {
      const output = await command("status");
      if (!output || typeof output.authenticated !== "boolean") {
        account.textContent = "No account information available.";
        return;
      }
      const first = lastStatus === undefined;
      const savedChanged = JSON.stringify(lastStatus?.enabledModels ?? []) !== JSON.stringify(output.enabledModels);
      lastStatus = output;
      if (first || savedChanged)
        selection = new Set(output.enabledModels ?? []);
      renderAccount(output);
      renderSignIn(output);
      renderBalance(output);
      renderModels(output);
      sdk.notify("cline-external.settings.ready", {
        authenticated: output.authenticated,
        enabledModelCount: output.enabledModelCount,
        browserAuth: output.browserAuth
      });
    }
    refresh().catch((error) => {
      account.textContent = `Failed to load account: ${String(error)}`;
      account.style.color = COLORS.bad;
    });
  })();
})();
