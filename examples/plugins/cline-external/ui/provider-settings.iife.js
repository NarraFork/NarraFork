(() => {
  // examples/plugins/cline-external/src/ui/provider-settings.ts
  var STRINGS = {
    en: {
      title: "Cline account",
      notSignedIn: "Not signed in.",
      signedIn: "Signed in",
      credentialsUnreadable: "Stored credentials are unreadable: {reason}. Sign out and sign in again.",
      tokenValid: "token valid",
      tokenExpired: "token expired",
      modelsEnabled: "{count} models enabled",
      modelsInPool: "{count} models in pool",
      signInBrowser: "Sign in with browser",
      portBusy: "Callback port 19876 is in use, possibly by the built-in Cline provider signing in. You can retry, or paste the callback URL below.",
      browserUnsupported: "This environment cannot receive a browser callback. Use the paste option below.",
      waitingCallback: "Waiting for the browser callback…",
      cancelSignIn: "Cancel sign-in",
      pastePrompt: "Or paste the callback URL your browser was redirected to:",
      importCallback: "Import callback URL",
      signOut: "Sign out",
      openToAuthorize: "Open this URL to authorize, then return here:",
      copyUrl: "Copy URL",
      urlCopied: "Authorization URL copied.",
      urlCopyFailed: "Could not copy — select the URL above instead.",
      refreshBalance: "Refresh balance",
      loadingBalance: "Loading balance…",
      balance: "Balance: {amount}",
      noBalance: "No balance data available.",
      balanceFailed: "Balance failed: {reason}",
      models: "Models",
      modelsDesc: "Only the models you enable here are offered to the agent.",
      enabled: "Enabled",
      selectedCount: "{count} selected",
      unsavedChanges: "unsaved changes",
      saveSelection: "Save selection",
      refreshPool: "Refresh pool",
      revert: "Revert",
      recommendedAndFree: "Recommended and free",
      recommended: "Recommended",
      free: "Free",
      loading: "Loading…",
      noRecommendations: "No recommendations available.",
      recommendationsFailed: "Recommendations failed: {reason}",
      searchPool: "Search the model pool",
      searchPlaceholder: "e.g. claude sonnet",
      search: "Search",
      searching: "Searching…",
      minChars: "Type at least {count} characters to search.",
      noMatches: "No matches.",
      shownOf: "{shown} of {total} shown",
      shownOfRefine: "{shown} of {total} shown · refine the query to narrow it",
      contextSuffix: "{size}k ctx",
      alreadyEnabled: "enabled",
      nothingToImport: "Nothing to import.",
      noAccountInfo: "No account information available.",
      loadFailed: "Failed to load account: {reason}",
      actionDone: "{action} done.",
      actionFailed: "{action} failed: {reason}",
      actionBrowserSignIn: "Browser sign-in",
      actionCancelSignIn: "Cancel sign-in",
      actionImport: "Import credentials",
      actionSignOut: "Sign out",
      actionSaveModels: "Save models",
      actionRefreshPool: "Refresh pool"
    },
    "zh-CN": {
      title: "Cline 账号",
      notSignedIn: "未登录。",
      signedIn: "已登录",
      credentialsUnreadable: "存储的凭据无法读取：{reason}。请登出后重新登录。",
      tokenValid: "令牌有效",
      tokenExpired: "令牌已过期",
      modelsEnabled: "已启用 {count} 个模型",
      modelsInPool: "模型池共 {count} 个",
      signInBrowser: "使用浏览器登录",
      portBusy: "回调端口 19876 已被占用，可能是内置 Cline 供应商正在登录。可以重试，或在下方粘贴回调 URL。",
      browserUnsupported: "当前环境无法接收浏览器回调，请使用下方的粘贴方式。",
      waitingCallback: "等待浏览器回调…",
      cancelSignIn: "取消登录",
      pastePrompt: "或粘贴浏览器跳转到的回调 URL：",
      importCallback: "导入回调 URL",
      signOut: "登出",
      openToAuthorize: "打开此 URL 完成授权，然后返回此页：",
      copyUrl: "复制 URL",
      urlCopied: "授权 URL 已复制。",
      urlCopyFailed: "无法复制 — 请手动选中上方 URL。",
      refreshBalance: "刷新余额",
      loadingBalance: "正在加载余额…",
      balance: "余额：{amount}",
      noBalance: "暂无余额数据。",
      balanceFailed: "获取余额失败：{reason}",
      models: "模型",
      modelsDesc: "只有在此启用的模型才会提供给智能体。",
      enabled: "已启用",
      selectedCount: "已选 {count} 个",
      unsavedChanges: "有未保存的更改",
      saveSelection: "保存选择",
      refreshPool: "刷新模型池",
      revert: "撤销",
      recommendedAndFree: "推荐与免费",
      recommended: "推荐",
      free: "免费",
      loading: "加载中…",
      noRecommendations: "暂无推荐。",
      recommendationsFailed: "获取推荐失败：{reason}",
      searchPool: "搜索模型池",
      searchPlaceholder: "例如 claude sonnet",
      search: "搜索",
      searching: "搜索中…",
      minChars: "请输入至少 {count} 个字符以搜索。",
      noMatches: "无匹配结果。",
      shownOf: "显示 {shown} / {total}",
      shownOfRefine: "显示 {shown} / {total} · 细化关键词可缩小范围",
      contextSuffix: "{size}k 上下文",
      alreadyEnabled: "已启用",
      nothingToImport: "没有可导入的内容。",
      noAccountInfo: "暂无账号信息。",
      loadFailed: "加载账号失败：{reason}",
      actionDone: "{action}完成。",
      actionFailed: "{action}失败：{reason}",
      actionBrowserSignIn: "浏览器登录",
      actionCancelSignIn: "取消登录",
      actionImport: "导入凭据",
      actionSignOut: "登出",
      actionSaveModels: "保存模型",
      actionRefreshPool: "刷新模型池"
    }
  };
  var COLORS = {
    text: "var(--nf-color-text, #e6e6e6)",
    muted: "var(--nf-color-dimmed, #8b8b8b)",
    bad: "var(--nf-color-error, #ff8a8a)",
    good: "var(--nf-color-success, #7ee0a2)",
    warn: "var(--nf-color-warning, #c9a227)",
    panel: "var(--nf-color-surface, #2a2a2e)",
    border: "var(--nf-color-border, #3a3a40)",
    input: "var(--nf-color-body, #1a1a1e)"
  };
  var FONTS = {
    ui: "var(--nf-font, system-ui, sans-serif)",
    mono: "var(--nf-font-mono, ui-monospace, monospace)"
  };
  var SIGN_IN_POLL_MS = 2000;
  var SEARCH_DEBOUNCE_MS = 300;
  var MIN_SEARCH_LENGTH = 2;
  (() => {
    const sdk = globalThis.narrafork;
    if (!sdk)
      return;
    const root = document.body;
    function text(key, params) {
      if (sdk?.i18n)
        return sdk.i18n.t(STRINGS, key, params);
      const template = STRINGS.en?.[key] ?? key;
      if (!params)
        return template;
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
        const value = params[name];
        return value === undefined ? match : String(value);
      });
    }
    const style = (element2, css) => {
      Object.assign(element2.style, css);
    };
    function element(tag, css = {}, text2) {
      const node = document.createElement(tag);
      if (text2 !== undefined)
        node.textContent = text2;
      style(node, css);
      return node;
    }
    function button(label, onClick, tone = "normal") {
      const node = element("button", {
        padding: "4px 10px",
        font: `12px ${FONTS.ui}`,
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
    let pollTimer;
    let searchTimer;
    let searchGeneration = 0;
    let balanceLoaded = false;
    let rebuildPersistentAreas = false;
    let balanceText;
    async function command(commandId, input) {
      const raw = await sdk.request("commands.execute", {
        commandId,
        ...input === undefined ? {} : { input }
      });
      if (isRecord(raw) && "output" in raw)
        return raw.output;
      return raw;
    }
    function syncSignInPoll(status) {
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      if (!status.signInPending)
        return;
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        if (busy) {
          if (lastStatus)
            syncSignInPoll(lastStatus);
          return;
        }
        refresh().catch(() => {
          if (lastStatus)
            syncSignInPoll(lastStatus);
        });
      }, SIGN_IN_POLL_MS);
    }
    globalThis.addEventListener("pagehide", () => {
      if (pollTimer !== undefined)
        clearTimeout(pollTimer);
      if (searchTimer !== undefined)
        clearTimeout(searchTimer);
      pollTimer = undefined;
      searchTimer = undefined;
    });
    const header = element("div", {
      font: `600 14px/1.9 ${FONTS.ui}`,
      color: COLORS.text
    });
    header.textContent = text("title");
    root.appendChild(header);
    const account = element("div", { font: `13px/1.7 ${FONTS.ui}` });
    root.appendChild(account);
    const signIn = element("div", { margin: "10px 0" });
    root.appendChild(signIn);
    const balanceArea = element("div", { marginTop: "12px" });
    root.appendChild(balanceArea);
    const modelsArea = element("div", { marginTop: "16px" });
    root.appendChild(modelsArea);
    const recommendedArea = element("div", { marginTop: "12px" });
    root.appendChild(recommendedArea);
    const searchArea = element("div", { marginTop: "12px" });
    root.appendChild(searchArea);
    const statusLine = element("div", {
      font: `12px/1.7 ${FONTS.ui}`,
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
        setStatus(text("actionDone", { action: label }), "good");
        return refresh();
      }).catch((error) => {
        setStatus(text("actionFailed", { action: label, reason: String(error) }), "bad");
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
        warning.textContent = text("credentialsUnreadable", { reason: status.credentialError });
        account.appendChild(warning);
        return;
      }
      if (!status.authenticated) {
        const notSignedIn = element("div", { color: COLORS.warn });
        notSignedIn.textContent = text("notSignedIn");
        account.appendChild(notSignedIn);
        return;
      }
      const who = element("div", { color: COLORS.text });
      who.textContent = status.displayName || status.email || text("signedIn");
      account.appendChild(who);
      const facts = [
        status.email && status.email !== status.displayName ? status.email : undefined,
        status.expiresAt ? `${text(status.expired ? "tokenExpired" : "tokenValid")} · ${formatTimestamp(status.expiresAt)}` : undefined,
        text("modelsEnabled", { count: status.enabledModelCount }),
        status.poolModelCount ? text("modelsInPool", { count: status.poolModelCount }) : undefined
      ].filter((value) => Boolean(value));
      account.appendChild(element("div", { font: `12px/1.7 ${FONTS.mono}`, color: COLORS.muted }, facts.join("  ·  ")));
    }
    function renderSignIn(status) {
      signIn.replaceChildren();
      if (status.browserAuth !== "unsupported") {
        signIn.appendChild(button(text("signInBrowser"), () => run(text("actionBrowserSignIn"), async () => {
          const result = await command("auth.browser");
          const url = isRecord(result) ? result.authorizeUrl : undefined;
          if (typeof url !== "string")
            throw new Error("No authorization URL returned");
        })));
      }
      const note = element("div", {
        font: `11px/1.6 ${FONTS.ui}`,
        color: status.browserAuth === "available" ? COLORS.muted : COLORS.warn,
        marginTop: "4px",
        marginBottom: "6px"
      });
      if (status.browserAuth === "port_busy") {
        note.textContent = text("portBusy");
      } else if (status.browserAuth === "unsupported") {
        note.textContent = text("browserUnsupported");
      } else if (status.signInPending) {
        note.textContent = text("waitingCallback");
      }
      if (note.textContent)
        signIn.appendChild(note);
      if (status.authorizeUrl)
        showAuthorizeUrl(status.authorizeUrl);
      if (status.signInPending) {
        signIn.appendChild(button(text("cancelSignIn"), () => run(text("actionCancelSignIn"), () => command("auth.cancel"))));
      }
      signIn.appendChild(element("div", { font: `12px/1.6 ${FONTS.ui}`, color: COLORS.muted, marginTop: "8px" }, text("pastePrompt")));
      const pasteBox = element("input", {
        width: "100%",
        padding: "5px 8px",
        marginTop: "4px",
        font: `12px ${FONTS.mono}`,
        color: COLORS.text,
        background: COLORS.input,
        border: `1px solid ${COLORS.border}`,
        borderRadius: "4px",
        boxSizing: "border-box"
      });
      pasteBox.placeholder = "http://localhost:19876/auth/callback?code=…";
      signIn.appendChild(pasteBox);
      const importButton = button(text("importCallback"), () => {
        const callbackUrl = pasteBox.value.trim();
        if (!callbackUrl) {
          setStatus(text("nothingToImport"), "bad");
          return;
        }
        pasteBox.value = "";
        run(text("actionImport"), () => command("auth.callback", { callbackUrl }));
      });
      style(importButton, { marginTop: "6px" });
      signIn.appendChild(importButton);
      if (status.authenticated) {
        const signOut = button(text("signOut"), () => run(text("actionSignOut"), () => command("auth.logout")), "bad");
        style(signOut, { marginTop: "6px" });
        signIn.appendChild(signOut);
      }
    }
    async function copyText(text2) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text2);
          return true;
        }
      } catch {}
      try {
        const scratch = element("textarea", {
          position: "fixed",
          opacity: "0"
        });
        scratch.value = text2;
        document.body.appendChild(scratch);
        scratch.select();
        const copied = document.execCommand("copy");
        scratch.remove();
        return copied;
      } catch {
        return false;
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
      box.appendChild(element("div", { font: `12px/1.6 ${FONTS.ui}`, color: COLORS.text }, text("openToAuthorize")));
      const link = element("a", {
        font: `12px/1.6 ${FONTS.mono}`,
        color: COLORS.good,
        wordBreak: "break-all"
      });
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = url;
      box.appendChild(link);
      const copy = button(text("copyUrl"), () => {
        copyText(url).then((copied) => {
          setStatus(copied ? text("urlCopied") : text("urlCopyFailed"), copied ? "good" : "bad");
        });
      });
      style(copy, { marginTop: "6px" });
      box.appendChild(copy);
      signIn.appendChild(box);
    }
    function balanceBox() {
      const existing = balanceArea.querySelector("[data-balance]");
      if (existing)
        existing.remove();
      const box = element("div", {
        marginTop: "6px",
        padding: "6px 10px",
        background: COLORS.panel,
        borderRadius: "5px",
        font: `12px/1.6 ${FONTS.ui}`,
        color: COLORS.muted
      });
      box.setAttribute("data-balance", "1");
      balanceArea.appendChild(box);
      return box;
    }
    function loadBalance() {
      const box = balanceBox();
      box.textContent = text("loadingBalance");
      command("balance").then((result) => {
        const micro = isRecord(result) ? result.balance : undefined;
        balanceText = typeof micro === "number" ? {
          text: text("balance", { amount: `$${(micro / 1e6).toFixed(2)}` }),
          tone: "normal"
        } : { text: text("noBalance"), tone: "normal" };
      }).catch((error) => {
        balanceText = { text: text("balanceFailed", { reason: String(error) }), tone: "bad" };
      }).finally(() => {
        if (!balanceText)
          return;
        const target = balanceArea.querySelector("[data-balance]") ?? balanceBox();
        target.textContent = balanceText.text;
        target.style.color = balanceText.tone === "bad" ? COLORS.bad : COLORS.text;
      });
    }
    function renderBalance(status) {
      balanceArea.replaceChildren();
      if (!status.authenticated)
        return;
      balanceArea.appendChild(button(text("refreshBalance"), loadBalance));
      if (!balanceLoaded) {
        balanceLoaded = true;
        loadBalance();
        return;
      }
      if (balanceText) {
        const box = balanceBox();
        box.textContent = balanceText.text;
        box.style.color = balanceText.tone === "bad" ? COLORS.bad : COLORS.text;
      }
    }
    function syncModelRowChecks() {
      for (const area of [recommendedArea, searchArea]) {
        for (const box of area.querySelectorAll("input[type=checkbox][data-model-id]")) {
          const input = box;
          const id = input.getAttribute("data-model-id");
          if (id)
            input.checked = selection.has(id);
        }
      }
    }
    function modelRow(id, label, detail) {
      const row = element("label", {
        display: "block",
        padding: "3px 0",
        font: `12px/1.6 ${FONTS.ui}`,
        color: COLORS.text,
        cursor: "pointer"
      });
      const box = element("input", { marginRight: "6px" });
      box.type = "checkbox";
      box.checked = selection.has(id);
      box.setAttribute("data-model-id", id);
      box.addEventListener("change", () => {
        if (box.checked)
          selection.add(id);
        else
          selection.delete(id);
        if (lastStatus)
          renderModels(lastStatus);
        else
          renderSelectionSummary();
        syncModelRowChecks();
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(label));
      if (detail) {
        const note = element("span", {
          color: COLORS.muted,
          font: `11px ${FONTS.mono}`,
          marginLeft: "6px"
        });
        note.textContent = detail;
        row.appendChild(note);
      }
      return row;
    }
    const selectionSummary = element("div", {
      font: `12px/1.7 ${FONTS.ui}`,
      color: COLORS.muted,
      marginTop: "6px"
    });
    function renderSelectionSummary() {
      const saved = new Set(lastStatus?.enabledModels ?? []);
      const changed = saved.size !== selection.size || [...selection].some((id) => !saved.has(id));
      selectionSummary.textContent = changed ? `${text("selectedCount", { count: selection.size })} · ${text("unsavedChanges")}` : text("selectedCount", { count: selection.size });
      selectionSummary.style.color = changed ? COLORS.warn : COLORS.muted;
    }
    function renderModels(status) {
      modelsArea.replaceChildren();
      modelsArea.appendChild(element("div", { font: `600 13px/1.8 ${FONTS.ui}`, color: COLORS.text }, text("models")));
      modelsArea.appendChild(element("div", { font: `12px/1.6 ${FONTS.ui}`, color: COLORS.muted }, text("modelsDesc")));
      if (selection.size > 0) {
        const enabledBox = element("div", { marginTop: "8px" });
        enabledBox.appendChild(element("div", { font: `600 12px/1.8 ${FONTS.ui}`, color: COLORS.muted }, text("enabled")));
        for (const id of [...selection].sort())
          enabledBox.appendChild(modelRow(id, id));
        modelsArea.appendChild(enabledBox);
      }
      modelsArea.appendChild(selectionSummary);
      renderSelectionSummary();
      const actions = element("div", { marginTop: "6px" });
      actions.appendChild(button(text("saveSelection"), () => run(text("actionSaveModels"), () => command("config.setEnabledModels", { models: [...selection] }))));
      actions.appendChild(button(text("refreshPool"), () => run(text("actionRefreshPool"), () => command("models.refresh"))));
      actions.appendChild(button(text("revert"), () => {
        selection = new Set(status.enabledModels ?? []);
        renderModels(status);
      }));
      modelsArea.appendChild(actions);
    }
    function renderRecommended() {
      const box = element("div", {});
      box.appendChild(element("div", { font: `600 12px/1.8 ${FONTS.ui}`, color: COLORS.muted }, text("recommendedAndFree")));
      const list = element("div", {});
      list.textContent = text("loading");
      box.appendChild(list);
      recommendedArea.replaceChildren(box);
      command("recommended-models").then((result) => {
        if (!isRecord(result)) {
          list.textContent = text("noRecommendations");
          return;
        }
        const groups = [
          [text("recommended"), result.recommended],
          [text("free"), result.free]
        ];
        list.replaceChildren();
        for (const [label, entries] of groups) {
          if (!Array.isArray(entries) || entries.length === 0)
            continue;
          list.appendChild(element("div", { font: `11px/1.8 ${FONTS.ui}`, color: COLORS.muted, marginTop: "4px" }, label));
          for (const entry of entries) {
            if (!entry?.id)
              continue;
            const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
            list.appendChild(modelRow(entry.id, `${entry.name || entry.id}${tags}`, entry.id));
          }
        }
        if (!list.hasChildNodes())
          list.textContent = text("noRecommendations");
      }).catch((error) => {
        list.textContent = text("recommendationsFailed", { reason: String(error) });
        list.style.color = COLORS.bad;
      });
    }
    function renderSearch() {
      const box = element("div", {});
      box.appendChild(element("div", { font: `600 12px/1.8 ${FONTS.ui}`, color: COLORS.muted }, text("searchPool")));
      const field = element("input", {
        width: "100%",
        padding: "5px 8px",
        marginTop: "4px",
        font: `12px ${FONTS.mono}`,
        color: COLORS.text,
        background: COLORS.input,
        border: `1px solid ${COLORS.border}`,
        borderRadius: "4px",
        boxSizing: "border-box"
      });
      field.placeholder = text("searchPlaceholder");
      box.appendChild(field);
      const results = element("div", {
        marginTop: "6px",
        maxHeight: "260px",
        overflowY: "auto"
      });
      box.appendChild(results);
      searchArea.replaceChildren(box);
      const search = () => {
        const query = field.value.trim();
        searchGeneration += 1;
        const generation = searchGeneration;
        if (query.length < MIN_SEARCH_LENGTH) {
          results.replaceChildren();
          results.style.color = COLORS.muted;
          if (query.length > 0) {
            results.textContent = text("minChars", { count: MIN_SEARCH_LENGTH });
          }
          return;
        }
        results.replaceChildren();
        results.style.color = COLORS.muted;
        results.textContent = text("searching");
        command("models.search", { query, limit: 50 }).then((result) => {
          if (generation !== searchGeneration)
            return;
          const models = isRecord(result) && Array.isArray(result.models) ? result.models : [];
          const total = isRecord(result) && typeof result.total === "number" ? result.total : 0;
          results.replaceChildren();
          results.style.color = COLORS.muted;
          if (models.length === 0) {
            results.textContent = text("noMatches");
            return;
          }
          results.appendChild(element("div", { font: `11px/1.7 ${FONTS.ui}`, color: COLORS.muted }, total > models.length ? text("shownOfRefine", { shown: models.length, total }) : text("shownOf", { shown: models.length, total })));
          for (const model of models) {
            if (!model?.id)
              continue;
            const details = [
              model.contextLength ? text("contextSuffix", { size: Math.round(model.contextLength / 1024) }) : "",
              selection.has(model.id) ? text("alreadyEnabled") : ""
            ].filter(Boolean);
            results.appendChild(modelRow(model.id, model.name || model.id, details.join(" · ")));
          }
        }).catch((error) => {
          if (generation !== searchGeneration)
            return;
          results.replaceChildren();
          results.textContent = text("actionFailed", {
            action: text("search"),
            reason: String(error)
          });
          results.style.color = COLORS.bad;
        });
      };
      const searchButton = button(text("search"), search);
      style(searchButton, { marginTop: "6px" });
      box.appendChild(searchButton);
      field.addEventListener("input", () => {
        if (searchTimer !== undefined)
          clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchTimer = undefined;
          search();
        }, SEARCH_DEBOUNCE_MS);
      });
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter")
          return;
        if (searchTimer !== undefined) {
          clearTimeout(searchTimer);
          searchTimer = undefined;
        }
        search();
      });
    }
    async function refresh() {
      const output = await command("status");
      if (!output || typeof output.authenticated !== "boolean") {
        account.textContent = text("noAccountInfo");
        return;
      }
      const first = lastStatus === undefined;
      const savedChanged = JSON.stringify(lastStatus?.enabledModels ?? []) !== JSON.stringify(output.enabledModels);
      lastStatus = output;
      if (first || savedChanged)
        selection = new Set(output.enabledModels ?? []);
      if (!output.authenticated) {
        balanceLoaded = false;
        balanceText = undefined;
      }
      renderAccount(output);
      renderSignIn(output);
      renderBalance(output);
      renderModels(output);
      if (first || rebuildPersistentAreas) {
        rebuildPersistentAreas = false;
        renderRecommended();
        renderSearch();
      } else {
        syncModelRowChecks();
      }
      syncSignInPoll(output);
      sdk.notify("cline-external.settings.ready", {
        authenticated: output.authenticated,
        enabledModelCount: output.enabledModelCount,
        browserAuth: output.browserAuth
      });
    }
    sdk.i18n?.onChange(() => {
      rebuildPersistentAreas = true;
      refresh().catch(() => {});
    });
    refresh().catch((error) => {
      account.textContent = text("loadFailed", { reason: String(error) });
      account.style.color = COLORS.bad;
    });
  })();
})();
