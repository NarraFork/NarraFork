(() => {
  var __defProp = Object.defineProperty;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };
  var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

  // examples/plugins/cline-external/src/ui/panel-types.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  async function runCommand(sdk, commandId, input) {
    const raw = await sdk.request("commands.execute", {
      commandId,
      ...input === undefined ? {} : { input }
    });
    if (isRecord(raw) && "output" in raw)
      return raw.output;
    return raw;
  }
  function errorMessage(error) {
    if (error instanceof Error)
      return error.message;
    if (isRecord(error) && typeof error.message === "string")
      return error.message;
    return String(error);
  }

  // examples/plugins/cline-external/src/ui/strings.ts
  function hostI18n() {
    return globalThis.narrafork?.i18n;
  }
  function t(key, params) {
    const host = hostI18n();
    if (host)
      return host.t(TABLES, key, params);
    return interpolate(en[key] ?? String(key), params);
  }
  function activeLocale() {
    const host = hostI18n();
    if (host?.locale)
      return host.locale;
    return typeof navigator === "undefined" ? "en" : navigator.language ?? "en";
  }
  function onLocaleChange(listener) {
    return hostI18n()?.onChange(listener) ?? (() => {});
  }
  function interpolate(template, params) {
    if (!params)
      return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params) ? String(params[name]) : whole);
  }
  var en, zhCN, TABLES;
  var init_strings = __esm(() => {
    en = {
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
      signOutConfirm: "Sign out of Cline? The stored credentials are cleared; your model selection is kept.",
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
      modelsDesc: "Search the OpenRouter pool and add models; added models appear in the model list below.",
      refreshPool: "Refresh pool",
      add: "Add",
      added: "Added",
      addModel: "Add model",
      removeModel: "Remove model",
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
      nothingToImport: "Nothing to import.",
      noAccountInfo: "No account information available.",
      loadFailed: "Failed to load account: {reason}",
      actionDone: "{action} done.",
      actionFailed: "{action} failed: {reason}",
      actionBrowserSignIn: "Browser sign-in",
      actionCancelSignIn: "Cancel sign-in",
      actionImport: "Import credentials",
      actionSignOut: "Sign out",
      actionAddModel: "Add model",
      actionRemoveModel: "Remove model",
      actionRefreshPool: "Refresh pool",
      confirmTitle: "Confirm",
      confirmOk: "Confirm",
      confirmCancel: "Cancel",
      runtimeMissingTitle: "The Cline settings page could not start"
    };
    zhCN = {
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
      signOutConfirm: "确定要登出 Cline 吗？存储的凭据会被清除，已选择的模型会保留。",
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
      modelsDesc: "搜索 OpenRouter 模型池并添加模型；添加的模型会出现在下方的模型列表中。",
      refreshPool: "刷新模型池",
      add: "添加",
      added: "已添加",
      addModel: "添加模型",
      removeModel: "移除模型",
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
      nothingToImport: "没有可导入的内容。",
      noAccountInfo: "暂无账号信息。",
      loadFailed: "加载账号失败：{reason}",
      actionDone: "{action}完成。",
      actionFailed: "{action}失败：{reason}",
      actionBrowserSignIn: "浏览器登录",
      actionCancelSignIn: "取消登录",
      actionImport: "导入凭据",
      actionSignOut: "登出",
      actionAddModel: "添加模型",
      actionRemoveModel: "移除模型",
      actionRefreshPool: "刷新模型池",
      confirmTitle: "确认",
      confirmOk: "确定",
      confirmCancel: "取消",
      runtimeMissingTitle: "Cline 设置页无法启动"
    };
    TABLES = { en, "zh-CN": zhCN };
  });

  // examples/plugins/cline-external/src/ui/host-runtime.ts
  function readRuntime() {
    const candidate = globalThis.__nfPluginRuntime;
    if (!candidate || typeof candidate !== "object") {
      throw new HostRuntimeUnavailableError('The host UI runtime is missing. This view declares `runtime: "host-react"`, so the host should have injected React and Mantine before loading it.');
    }
    const runtime = candidate;
    if (runtime.version !== SUPPORTED_RUNTIME_VERSION) {
      throw new HostRuntimeUnavailableError(`The host UI runtime is version ${String(runtime.version)}, but this view was built for version ${SUPPORTED_RUNTIME_VERSION}. Update the plugin to match the host.`);
    }
    if (!runtime.React || !runtime.MantineCore || !runtime.ReactDOMClient) {
      throw new HostRuntimeUnavailableError("The host UI runtime is incomplete.");
    }
    return runtime;
  }
  var SUPPORTED_RUNTIME_VERSION = 1, HostRuntimeUnavailableError, hostRuntime, React, MantineCore, MantineHooks, hostTheme, createRoot, jsx, jsxs, Fragment, useState, useEffect, useCallback, useMemo, useRef;
  var init_host_runtime = __esm(() => {
    HostRuntimeUnavailableError = class HostRuntimeUnavailableError extends Error {
      constructor(message) {
        super(message);
        this.name = "HostRuntimeUnavailableError";
      }
    };
    hostRuntime = readRuntime();
    React = hostRuntime.React;
    MantineCore = hostRuntime.MantineCore;
    MantineHooks = hostRuntime.MantineHooks;
    hostTheme = hostRuntime.theme;
    createRoot = hostRuntime.ReactDOMClient.createRoot;
    jsx = hostRuntime.JsxRuntime.jsx;
    jsxs = hostRuntime.JsxRuntime.jsxs;
    Fragment = hostRuntime.JsxRuntime.Fragment;
    useState = hostRuntime.React.useState;
    useEffect = hostRuntime.React.useEffect;
    useCallback = hostRuntime.React.useCallback;
    useMemo = hostRuntime.React.useMemo;
    useRef = hostRuntime.React.useRef;
  });

  // examples/plugins/cline-external/src/ui/shim/jsx-dev-runtime.ts
  var init_jsx_dev_runtime = __esm(() => {
    init_host_runtime();
  });

  // examples/plugins/cline-external/src/ui/Overlay.tsx
  function PanelOverlay({ title, onClose, children, footer }) {
    useEffect(() => {
      const onKeyDown = (event) => {
        if (event.key === "Escape")
          onClose();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);
    return /* @__PURE__ */ jsx(Box, {
      style: {
        position: "absolute",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--mantine-spacing-md)",
        background: "rgba(0, 0, 0, 0.6)"
      },
      onClick: onClose,
      children: /* @__PURE__ */ jsx(Paper, {
        withBorder: true,
        radius: "md",
        shadow: "md",
        onClick: (event) => event.stopPropagation(),
        style: {
          width: "100%",
          maxWidth: 620,
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        },
        children: [
          /* @__PURE__ */ jsx(Box, {
            p: "sm",
            style: { borderBottom: "1px solid var(--mantine-color-default-border)" },
            children: /* @__PURE__ */ jsx(Text, {
              fw: 600,
              size: "sm",
              children: title
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsx(ScrollArea.Autosize, {
            mah: "100%",
            style: { flex: 1 },
            children: /* @__PURE__ */ jsx(Box, {
              p: "sm",
              children
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this),
          footer ? /* @__PURE__ */ jsx(Box, {
            p: "sm",
            style: { borderTop: "1px solid var(--mantine-color-default-border)" },
            children: footer
          }, undefined, false, undefined, this) : null
        ]
      }, undefined, true, undefined, this)
    }, undefined, false, undefined, this);
  }
  function ConfirmOverlay({
    message,
    confirmLabel,
    confirmColor = "red",
    loading,
    onConfirm,
    onCancel
  }) {
    return /* @__PURE__ */ jsx(PanelOverlay, {
      title: t("confirmTitle"),
      onClose: onCancel,
      footer: /* @__PURE__ */ jsx(Group, {
        justify: "flex-end",
        gap: "xs",
        children: [
          /* @__PURE__ */ jsx(Button, {
            size: "xs",
            variant: "default",
            onClick: onCancel,
            children: t("confirmCancel")
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsx(Button, {
            size: "xs",
            color: confirmColor,
            loading,
            onClick: onConfirm,
            children: confirmLabel ?? t("confirmOk")
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      children: /* @__PURE__ */ jsx(Stack, {
        gap: "xs",
        children: /* @__PURE__ */ jsx(Text, {
          size: "sm",
          children: message
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    }, undefined, false, undefined, this);
  }
  var Box, Button, Group, Paper, ScrollArea, Stack, Text;
  var init_Overlay = __esm(() => {
    init_host_runtime();
    init_strings();
    init_jsx_dev_runtime();
    ({ Box, Button, Group, Paper, ScrollArea, Stack, Text } = MantineCore);
  });

  // examples/plugins/cline-external/src/ui/panel.tsx
  var exports_panel = {};
  __export(exports_panel, {
    mount: () => mount
  });
  function formatTimestamp(seconds) {
    if (!seconds)
      return "";
    const date = new Date(seconds < 10000000000 ? seconds * 1000 : seconds);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(activeLocale());
  }
  async function copyText(value) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}
    try {
      const scratch = document.createElement("textarea");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      scratch.value = value;
      document.body.appendChild(scratch);
      scratch.select();
      const copied = document.execCommand("copy");
      scratch.remove();
      return copied;
    } catch {
      return false;
    }
  }
  function PoolRow({ id, name, contextLength, enabled, pending, onSetEnabled }) {
    return /* @__PURE__ */ jsx(Group2, {
      gap: "xs",
      py: 2,
      px: "xs",
      wrap: "nowrap",
      style: {
        borderRadius: 4,
        background: enabled ? "var(--mantine-color-default-hover)" : undefined
      },
      children: [
        /* @__PURE__ */ jsx(Text2, {
          size: "xs",
          ff: "monospace",
          style: { flex: 1, minWidth: 0 },
          truncate: true,
          children: id
        }, undefined, false, undefined, this),
        name && name !== id ? /* @__PURE__ */ jsx(Text2, {
          size: "xs",
          c: "dimmed",
          style: { flex: 1, minWidth: 0 },
          truncate: true,
          children: name
        }, undefined, false, undefined, this) : null,
        contextLength ? /* @__PURE__ */ jsx(Text2, {
          size: "xs",
          c: "dimmed",
          children: [
            Math.round(contextLength / 1000),
            "k"
          ]
        }, undefined, true, undefined, this) : null,
        /* @__PURE__ */ jsx(ActionIcon, {
          size: "xs",
          variant: enabled ? "filled" : "light",
          color: enabled ? "red" : "blue",
          disabled: pending,
          title: t(enabled ? "removeModel" : "addModel"),
          onClick: () => onSetEnabled(id, !enabled),
          children: enabled ? "−" : "+"
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function RecommendedRow({ id, name, tags, enabled, pending, onSetEnabled }) {
    return /* @__PURE__ */ jsx(Group2, {
      gap: "xs",
      wrap: "nowrap",
      children: [
        /* @__PURE__ */ jsx(Text2, {
          size: "xs",
          style: { flex: 1, minWidth: 0 },
          truncate: true,
          children: [
            name || id,
            tags?.length ? ` [${tags.join(", ")}]` : ""
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ jsx(Text2, {
          size: "xs",
          c: "dimmed",
          ff: "monospace",
          style: { flex: 1, minWidth: 0 },
          truncate: true,
          children: id
        }, undefined, false, undefined, this),
        enabled ? /* @__PURE__ */ jsx(Badge, {
          size: "xs",
          variant: "light",
          color: "blue",
          children: t("added")
        }, undefined, false, undefined, this) : /* @__PURE__ */ jsx(Button2, {
          size: "compact-xs",
          variant: "subtle",
          disabled: pending,
          onClick: () => onSetEnabled(id, true),
          children: t("add")
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function ClinePanel({ sdk }) {
    const [status, setStatus] = useState();
    const [loadError, setLoadError] = useState();
    const [message, setMessage] = useState();
    const [busy, setBusy] = useState(false);
    const [pendingModels, setPendingModels] = useState(() => new Set);
    const [pasteUrl, setPasteUrl] = useState("");
    const [balance, setBalance] = useState();
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [recommended, setRecommended] = useState();
    const [recommendedError, setRecommendedError] = useState();
    const [recommendedLoading, setRecommendedLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResult, setSearchResult] = useState();
    const [searchError, setSearchError] = useState();
    const [searching, setSearching] = useState(false);
    const [confirmingLogout, setConfirmingLogout] = useState(false);
    const [, bumpLocale] = useState(0);
    useEffect(() => onLocaleChange(() => bumpLocale((value) => value + 1)), []);
    const unmounted = useRef(false);
    useEffect(() => {
      return () => {
        unmounted.current = true;
      };
    }, []);
    const statusRef = useRef();
    const balanceLoadedRef = useRef(false);
    const pollTimerRef = useRef();
    const searchTimerRef = useRef();
    const searchGenerationRef = useRef(0);
    const command = useCallback((commandId, input) => runCommand(sdk, commandId, input), [sdk]);
    const refresh = useCallback(async () => {
      const output = await command("status");
      if (!output || typeof output.authenticated !== "boolean") {
        throw new Error(t("noAccountInfo"));
      }
      if (unmounted.current)
        return output;
      statusRef.current = output;
      setStatus(output);
      setLoadError(undefined);
      if (!output.authenticated) {
        balanceLoadedRef.current = false;
        setBalance(undefined);
      }
      sdk.notify("cline-external.settings.ready", {
        authenticated: output.authenticated,
        enabledModelCount: output.enabledModelCount,
        browserAuth: output.browserAuth
      });
      return output;
    }, [command, sdk]);
    const run = useCallback((label, action) => {
      if (busy)
        return;
      setBusy(true);
      setMessage({ text: `${label}…`, tone: "neutral" });
      action().then(async () => {
        await refresh();
        if (unmounted.current)
          return;
        setMessage({ text: t("actionDone", { action: label }), tone: "good" });
      }).catch((error) => {
        if (unmounted.current)
          return;
        setMessage({
          text: t("actionFailed", { action: label, reason: errorMessage(error) }),
          tone: "bad"
        });
      }).finally(() => {
        if (unmounted.current)
          return;
        setBusy(false);
      });
    }, [busy, refresh]);
    useEffect(() => {
      let cancelled = false;
      refresh().catch((error) => {
        if (cancelled)
          return;
        setLoadError(t("loadFailed", { reason: errorMessage(error) }));
      });
      return () => {
        cancelled = true;
      };
    }, [refresh]);
    const [pollTick, setPollTick] = useState(0);
    useEffect(() => {
      if (!status?.signInPending || busy)
        return;
      const timer = setTimeout(() => {
        pollTimerRef.current = undefined;
        refresh().catch(() => {}).finally(() => {
          if (!unmounted.current)
            setPollTick((value) => value + 1);
        });
      }, SIGN_IN_POLL_MS);
      pollTimerRef.current = timer;
      return () => clearTimeout(timer);
    }, [status?.signInPending, busy, refresh, pollTick]);
    useEffect(() => {
      const clear = () => {
        if (pollTimerRef.current !== undefined)
          clearTimeout(pollTimerRef.current);
        if (searchTimerRef.current !== undefined)
          clearTimeout(searchTimerRef.current);
        pollTimerRef.current = undefined;
        searchTimerRef.current = undefined;
      };
      globalThis.addEventListener("pagehide", clear);
      return () => globalThis.removeEventListener("pagehide", clear);
    }, []);
    const loadBalance = useCallback(() => {
      setBalanceLoading(true);
      command("balance").then((result) => {
        if (unmounted.current)
          return;
        const micro = isRecord(result) ? result.balance : undefined;
        setBalance(typeof micro === "number" ? {
          text: t("balance", { amount: `$${(micro / 1e6).toFixed(2)}` }),
          tone: "normal"
        } : { text: t("noBalance"), tone: "normal" });
      }).catch((error) => {
        if (unmounted.current)
          return;
        setBalance({ text: t("balanceFailed", { reason: errorMessage(error) }), tone: "bad" });
      }).finally(() => {
        if (unmounted.current)
          return;
        setBalanceLoading(false);
      });
    }, [command]);
    useEffect(() => {
      if (!status?.authenticated || balanceLoadedRef.current)
        return;
      balanceLoadedRef.current = true;
      loadBalance();
    }, [status?.authenticated, loadBalance]);
    useEffect(() => {
      setRecommendedLoading(true);
      command("recommended-models").then((result) => {
        if (unmounted.current)
          return;
        setRecommended(isRecord(result) ? result : {});
      }).catch((error) => {
        if (unmounted.current)
          return;
        setRecommendedError(t("recommendationsFailed", { reason: errorMessage(error) }));
      }).finally(() => {
        if (unmounted.current)
          return;
        setRecommendedLoading(false);
      });
    }, [command]);
    useEffect(() => {
      const query = searchQuery.trim();
      if (query.length < MIN_SEARCH_LENGTH) {
        setSearching(false);
        setSearchError(undefined);
        setSearchResult(undefined);
        return;
      }
      setSearching(true);
      setSearchError(undefined);
      const timer = setTimeout(() => {
        searchTimerRef.current = undefined;
        searchGenerationRef.current += 1;
        const generation = searchGenerationRef.current;
        command("models.search", { query, limit: 50 }).then((result) => {
          if (unmounted.current || generation !== searchGenerationRef.current)
            return;
          const models = isRecord(result) && Array.isArray(result.models) ? result.models.filter((model) => model?.id) : [];
          const total = isRecord(result) && typeof result.total === "number" ? result.total : models.length;
          setSearchResult({ models, total });
          setSearching(false);
        }).catch((error) => {
          if (unmounted.current || generation !== searchGenerationRef.current)
            return;
          setSearchError(t("actionFailed", { action: t("search"), reason: errorMessage(error) }));
          setSearching(false);
        });
      }, SEARCH_DEBOUNCE_MS);
      searchTimerRef.current = timer;
      return () => clearTimeout(timer);
    }, [searchQuery, command]);
    const modelsChangedLegacyRef = useRef(false);
    const notifyModelsChanged = useCallback(async () => {
      if (!modelsChangedLegacyRef.current) {
        try {
          await sdk.request("provider.modelsChanged");
          return;
        } catch {
          modelsChangedLegacyRef.current = true;
        }
      }
      sdk.notify("providerSettings.catalogInvalidated", { providerId: "cline" });
    }, [sdk]);
    const setModelEnabled = useCallback((id, enable) => {
      if (busy || pendingModels.size > 0)
        return;
      const current = statusRef.current?.enabledModels ?? [];
      if (enable === current.includes(id))
        return;
      const next = enable ? [...current, id] : current.filter((model) => model !== id);
      setPendingModels(new Set([id]));
      const label = t(enable ? "actionAddModel" : "actionRemoveModel");
      command("config.setEnabledModels", { models: next }).then(async () => {
        await notifyModelsChanged();
        await refresh();
      }).catch((error) => {
        if (unmounted.current)
          return;
        setMessage({
          text: t("actionFailed", { action: label, reason: errorMessage(error) }),
          tone: "bad"
        });
      }).finally(() => {
        if (unmounted.current)
          return;
        setPendingModels(new Set);
      });
    }, [busy, pendingModels, command, refresh, notifyModelsChanged]);
    const enabledSet = useMemo(() => new Set(status?.enabledModels ?? []), [status?.enabledModels]);
    const handleCopyAuthorizeUrl = useCallback((url) => {
      copyText(url).then((copied) => {
        if (unmounted.current)
          return;
        setMessage({
          text: copied ? t("urlCopied") : t("urlCopyFailed"),
          tone: copied ? "good" : "bad"
        });
      });
    }, []);
    const handleImportCallback = useCallback(() => {
      const callbackUrl = pasteUrl.trim();
      if (!callbackUrl) {
        setMessage({ text: t("nothingToImport"), tone: "bad" });
        return;
      }
      setPasteUrl("");
      run(t("actionImport"), () => command("auth.callback", { callbackUrl }));
    }, [pasteUrl, run, command]);
    if (loadError && !status) {
      return /* @__PURE__ */ jsx(Alert, {
        color: "red",
        variant: "light",
        title: t("runtimeMissingTitle"),
        children: loadError
      }, undefined, false, undefined, this);
    }
    if (!status) {
      return /* @__PURE__ */ jsx(Group2, {
        justify: "center",
        p: "lg",
        children: /* @__PURE__ */ jsx(Loader, {
          size: "sm"
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this);
    }
    const facts = [
      status.email && status.email !== status.displayName ? status.email : undefined,
      status.expiresAt ? `${t(status.expired ? "tokenExpired" : "tokenValid")} · ${formatTimestamp(status.expiresAt)}` : undefined,
      t("modelsEnabled", { count: status.enabledModelCount }),
      status.poolModelCount ? t("modelsInPool", { count: status.poolModelCount }) : undefined
    ].filter((value) => Boolean(value));
    const recommendedGroups = [
      [t("recommended"), recommended?.recommended],
      [t("free"), recommended?.free]
    ];
    const recommendedEmpty = !recommendedLoading && !recommendedError && recommendedGroups.every(([, entries]) => !entries || entries.length === 0);
    const trimmedQuery = searchQuery.trim();
    return /* @__PURE__ */ jsx(Stack2, {
      gap: "md",
      children: [
        /* @__PURE__ */ jsx(Text2, {
          fw: 600,
          size: "sm",
          children: t("title")
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsx(Paper2, {
          withBorder: true,
          radius: "md",
          p: "sm",
          children: /* @__PURE__ */ jsx(Stack2, {
            gap: "xs",
            children: [
              status.credentialError ? /* @__PURE__ */ jsx(Alert, {
                color: "red",
                variant: "light",
                children: t("credentialsUnreadable", { reason: status.credentialError })
              }, undefined, false, undefined, this) : null,
              !status.authenticated && !status.credentialError ? /* @__PURE__ */ jsx(Text2, {
                size: "sm",
                c: "yellow",
                children: t("notSignedIn")
              }, undefined, false, undefined, this) : null,
              status.authenticated ? /* @__PURE__ */ jsx(Fragment, {
                children: [
                  /* @__PURE__ */ jsx(Text2, {
                    size: "sm",
                    children: status.displayName || status.email || t("signedIn")
                  }, undefined, false, undefined, this),
                  facts.length > 0 ? /* @__PURE__ */ jsx(Text2, {
                    size: "xs",
                    c: "dimmed",
                    ff: "monospace",
                    children: facts.join("  ·  ")
                  }, undefined, false, undefined, this) : null,
                  /* @__PURE__ */ jsx(Group2, {
                    gap: "xs",
                    align: "center",
                    children: [
                      balance ? /* @__PURE__ */ jsx(Badge, {
                        size: "sm",
                        variant: "light",
                        color: balance.tone === "bad" ? "red" : "teal",
                        children: balance.text
                      }, undefined, false, undefined, this) : null,
                      /* @__PURE__ */ jsx(Button2, {
                        size: "compact-xs",
                        variant: "subtle",
                        disabled: busy || balanceLoading,
                        loading: balanceLoading,
                        onClick: loadBalance,
                        children: t("refreshBalance")
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this),
                  /* @__PURE__ */ jsx(Box2, {
                    children: /* @__PURE__ */ jsx(Button2, {
                      size: "xs",
                      variant: "light",
                      color: "red",
                      disabled: busy,
                      onClick: () => setConfirmingLogout(true),
                      children: t("signOut")
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this) : /* @__PURE__ */ jsx(Stack2, {
                gap: "xs",
                children: [
                  status.browserAuth === "available" || status.browserAuth === "port_busy" ? /* @__PURE__ */ jsx(Box2, {
                    children: /* @__PURE__ */ jsx(Button2, {
                      size: "xs",
                      variant: "light",
                      disabled: busy,
                      onClick: () => run(t("actionBrowserSignIn"), async () => {
                        const result = await command("auth.browser");
                        const url = isRecord(result) ? result.authorizeUrl : undefined;
                        if (typeof url !== "string") {
                          throw new Error("No authorization URL returned");
                        }
                      }),
                      children: t("signInBrowser")
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this) : null,
                  status.browserAuth === "port_busy" ? /* @__PURE__ */ jsx(Text2, {
                    size: "xs",
                    c: "yellow",
                    children: t("portBusy")
                  }, undefined, false, undefined, this) : null,
                  status.browserAuth === "unsupported" ? /* @__PURE__ */ jsx(Text2, {
                    size: "xs",
                    c: "yellow",
                    children: t("browserUnsupported")
                  }, undefined, false, undefined, this) : null
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        status.signInPending ? /* @__PURE__ */ jsx(Stack2, {
          gap: 4,
          children: [
            /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "dimmed",
              children: t("waitingCallback")
            }, undefined, false, undefined, this),
            status.authorizeUrl ? /* @__PURE__ */ jsx(Paper2, {
              withBorder: true,
              radius: "md",
              p: "sm",
              children: /* @__PURE__ */ jsx(Stack2, {
                gap: "xs",
                children: [
                  /* @__PURE__ */ jsx(Text2, {
                    size: "xs",
                    children: t("openToAuthorize")
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsx(Text2, {
                    size: "xs",
                    ff: "monospace",
                    c: "green",
                    style: { wordBreak: "break-all", userSelect: "all" },
                    children: status.authorizeUrl
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsx(Group2, {
                    gap: "xs",
                    children: [
                      /* @__PURE__ */ jsx(Button2, {
                        size: "compact-xs",
                        variant: "light",
                        onClick: () => handleCopyAuthorizeUrl(status.authorizeUrl ?? ""),
                        children: t("copyUrl")
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsx(Button2, {
                        size: "compact-xs",
                        variant: "light",
                        color: "red",
                        disabled: busy,
                        onClick: () => run(t("actionCancelSignIn"), () => command("auth.cancel")),
                        children: t("cancelSignIn")
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                ]
              }, undefined, true, undefined, this)
            }, undefined, false, undefined, this) : /* @__PURE__ */ jsx(Box2, {
              children: /* @__PURE__ */ jsx(Button2, {
                size: "compact-xs",
                variant: "light",
                color: "red",
                disabled: busy,
                onClick: () => run(t("actionCancelSignIn"), () => command("auth.cancel")),
                children: t("cancelSignIn")
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this) : null,
        !status.authenticated ? /* @__PURE__ */ jsx(Stack2, {
          gap: 4,
          children: [
            /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "dimmed",
              children: t("pastePrompt")
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsx(Group2, {
              gap: "xs",
              align: "flex-end",
              wrap: "nowrap",
              children: [
                /* @__PURE__ */ jsx(TextInput, {
                  size: "xs",
                  placeholder: "http://localhost:19876/auth/callback?code=…",
                  value: pasteUrl,
                  onChange: (event) => setPasteUrl(event.currentTarget.value),
                  style: { flex: 1 },
                  styles: { input: { fontFamily: "monospace" } }
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsx(Button2, {
                  size: "xs",
                  variant: "light",
                  disabled: busy,
                  onClick: handleImportCallback,
                  children: t("importCallback")
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          ]
        }, undefined, true, undefined, this) : null,
        /* @__PURE__ */ jsx(Divider, {}, undefined, false, undefined, this),
        /* @__PURE__ */ jsx(Stack2, {
          gap: "xs",
          children: [
            /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              fw: 600,
              c: "dimmed",
              children: t("recommendedAndFree")
            }, undefined, false, undefined, this),
            recommendedLoading ? /* @__PURE__ */ jsx(Group2, {
              gap: "xs",
              children: [
                /* @__PURE__ */ jsx(Loader, {
                  size: "xs"
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsx(Text2, {
                  size: "xs",
                  c: "dimmed",
                  children: t("loading")
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this) : null,
            recommendedError ? /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "red",
              children: recommendedError
            }, undefined, false, undefined, this) : null,
            recommendedGroups.map(([label, entries]) => entries && entries.length > 0 ? /* @__PURE__ */ jsx(Stack2, {
              gap: 2,
              children: [
                /* @__PURE__ */ jsx(Text2, {
                  size: "xs",
                  c: "dimmed",
                  children: label
                }, undefined, false, undefined, this),
                entries.map((entry) => {
                  const model = entry;
                  if (!model.id)
                    return null;
                  return /* @__PURE__ */ jsx(RecommendedRow, {
                    id: model.id,
                    name: model.name,
                    tags: model.tags,
                    enabled: enabledSet.has(model.id),
                    pending: pendingModels.has(model.id),
                    onSetEnabled: setModelEnabled
                  }, model.id, false, undefined, this);
                })
              ]
            }, label, true, undefined, this) : null),
            recommendedEmpty ? /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "dimmed",
              children: t("noRecommendations")
            }, undefined, false, undefined, this) : null
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ jsx(Stack2, {
          gap: "xs",
          children: [
            /* @__PURE__ */ jsx(Group2, {
              gap: "xs",
              children: [
                /* @__PURE__ */ jsx(Text2, {
                  size: "sm",
                  fw: 600,
                  children: t("models")
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsx(Button2, {
                  size: "compact-xs",
                  variant: "light",
                  disabled: busy,
                  onClick: () => run(t("actionRefreshPool"), () => command("models.refresh")),
                  children: t("refreshPool")
                }, undefined, false, undefined, this),
                status.poolModelCount ? /* @__PURE__ */ jsx(Text2, {
                  size: "xs",
                  c: "dimmed",
                  children: t("modelsInPool", { count: status.poolModelCount })
                }, undefined, false, undefined, this) : null
              ]
            }, undefined, true, undefined, this),
            /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "dimmed",
              children: t("modelsDesc")
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              fw: 600,
              c: "dimmed",
              children: t("searchPool")
            }, undefined, false, undefined, this),
            /* @__PURE__ */ jsx(TextInput, {
              size: "xs",
              placeholder: t("searchPlaceholder"),
              value: searchQuery,
              onChange: (event) => setSearchQuery(event.currentTarget.value),
              styles: { input: { fontFamily: "monospace" } }
            }, undefined, false, undefined, this),
            trimmedQuery.length > 0 && trimmedQuery.length < MIN_SEARCH_LENGTH ? /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "dimmed",
              children: t("minChars", { count: MIN_SEARCH_LENGTH })
            }, undefined, false, undefined, this) : null,
            searching ? /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "dimmed",
              children: t("searching")
            }, undefined, false, undefined, this) : null,
            searchError ? /* @__PURE__ */ jsx(Text2, {
              size: "xs",
              c: "red",
              children: searchError
            }, undefined, false, undefined, this) : null,
            searchResult && !searching ? /* @__PURE__ */ jsx(Stack2, {
              gap: 2,
              children: searchResult.models.length === 0 ? /* @__PURE__ */ jsx(Text2, {
                size: "xs",
                c: "dimmed",
                children: t("noMatches")
              }, undefined, false, undefined, this) : /* @__PURE__ */ jsx(Fragment, {
                children: [
                  /* @__PURE__ */ jsx(Text2, {
                    size: "xs",
                    c: "dimmed",
                    children: searchResult.total > searchResult.models.length ? t("shownOfRefine", {
                      shown: searchResult.models.length,
                      total: searchResult.total
                    }) : t("shownOf", {
                      shown: searchResult.models.length,
                      total: searchResult.total
                    })
                  }, undefined, false, undefined, this),
                  /* @__PURE__ */ jsx(ScrollArea2.Autosize, {
                    mah: 260,
                    children: /* @__PURE__ */ jsx(Stack2, {
                      gap: 2,
                      children: searchResult.models.map((model) => /* @__PURE__ */ jsx(PoolRow, {
                        id: model.id,
                        name: model.name,
                        contextLength: model.contextLength,
                        enabled: enabledSet.has(model.id),
                        pending: pendingModels.has(model.id),
                        onSetEnabled: setModelEnabled
                      }, model.id, false, undefined, this))
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this)
                ]
              }, undefined, true, undefined, this)
            }, undefined, false, undefined, this) : null
          ]
        }, undefined, true, undefined, this),
        message ? /* @__PURE__ */ jsx(Text2, {
          size: "xs",
          c: message.tone === "bad" ? "red" : message.tone === "good" ? "green" : "dimmed",
          children: message.text
        }, undefined, false, undefined, this) : null,
        confirmingLogout ? /* @__PURE__ */ jsx(ConfirmOverlay, {
          message: t("signOutConfirm"),
          confirmLabel: t("signOut"),
          loading: busy,
          onCancel: () => setConfirmingLogout(false),
          onConfirm: () => {
            setConfirmingLogout(false);
            run(t("actionSignOut"), () => command("auth.logout"));
          }
        }, undefined, false, undefined, this) : null
      ]
    }, undefined, true, undefined, this);
  }
  function startHeightReporting(sdk) {
    let supported = true;
    let inFlight = false;
    let lastReported = 0;
    const report = () => {
      if (!supported || inFlight)
        return;
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (height <= 0 || height === lastReported)
        return;
      inFlight = true;
      sdk.request("panel.setHeight", { height }).then(() => {
        lastReported = height;
      }).catch((error) => {
        const code = error?.code;
        if (code === "NOT_SUPPORTED" || code === "METHOD_NOT_FOUND")
          supported = false;
      }).finally(() => {
        inFlight = false;
        const current = Math.ceil(document.documentElement.scrollHeight);
        if (current > 0 && current !== lastReported)
          report();
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    report();
  }
  function mount(sdk) {
    const root = document.body;
    root.replaceChildren();
    const container = document.createElement("div");
    container.style.position = "relative";
    container.style.minHeight = "100%";
    container.style.padding = "12px";
    container.style.boxSizing = "border-box";
    root.style.margin = "0";
    root.appendChild(container);
    createRoot(container).render(/* @__PURE__ */ jsx(MantineProvider, {
      theme: hostTheme,
      children: /* @__PURE__ */ jsx(Box2, {
        children: /* @__PURE__ */ jsx(PanelErrorBoundary, {
          children: /* @__PURE__ */ jsx(ClinePanel, {
            sdk
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this)
    }, undefined, false, undefined, this));
    startHeightReporting(sdk);
  }
  var ActionIcon, Alert, Badge, Box2, Button2, Divider, Group2, Loader, MantineProvider, Paper2, ScrollArea2, Stack2, Text2, TextInput, SIGN_IN_POLL_MS = 2000, SEARCH_DEBOUNCE_MS = 300, MIN_SEARCH_LENGTH = 2, HostComponent, PanelErrorBoundary;
  var init_panel = __esm(() => {
    init_host_runtime();
    init_Overlay();
    init_strings();
    init_jsx_dev_runtime();
    ({
      ActionIcon,
      Alert,
      Badge,
      Box: Box2,
      Button: Button2,
      Divider,
      Group: Group2,
      Loader,
      MantineProvider,
      Paper: Paper2,
      ScrollArea: ScrollArea2,
      Stack: Stack2,
      Text: Text2,
      TextInput
    } = MantineCore);
    HostComponent = React.Component;
    PanelErrorBoundary = class PanelErrorBoundary extends HostComponent {
      state = {};
      static getDerivedStateFromError(error) {
        return { message: errorMessage(error) };
      }
      render() {
        const { message } = this.state;
        if (message) {
          return /* @__PURE__ */ jsx(Alert, {
            color: "red",
            variant: "light",
            title: t("runtimeMissingTitle"),
            children: message
          }, undefined, false, undefined, this);
        }
        return this.props.children;
      }
    };
  });

  // examples/plugins/cline-external/src/ui/provider-settings.tsx
  init_strings();
  function renderFatal(detail) {
    const box = document.createElement("div");
    box.style.padding = "12px";
    box.style.font = "13px/1.5 var(--nf-font, system-ui, sans-serif)";
    box.style.color = "var(--nf-color-error, #ffa8a8)";
    box.style.background = "var(--nf-color-surface, #2e1a1a)";
    box.style.borderRadius = "6px";
    box.style.margin = "12px";
    box.style.whiteSpace = "pre-wrap";
    box.style.wordBreak = "break-word";
    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.style.marginBottom = "4px";
    title.textContent = t("runtimeMissingTitle");
    box.appendChild(title);
    const body = document.createElement("div");
    body.textContent = detail;
    box.appendChild(body);
    document.body.style.margin = "0";
    document.body.appendChild(box);
  }
  var sdk = globalThis.narrafork;
  if (sdk) {
    Promise.resolve().then(() => (init_panel(), exports_panel)).then(({ mount: mount2 }) => {
      try {
        mount2(sdk);
      } catch (error) {
        renderFatal(errorMessage(error));
      }
    }, (error) => renderFatal(errorMessage(error)));
  } else {
    renderFatal("The host did not provide the plugin UI SDK (globalThis.narrafork).");
  }
})();
