// @bun
// examples/plugins/cline-external/src/fetch.ts
import { ProxyAgent } from "undici";
var cached;
function agentFor(url) {
  if (cached?.url === url)
    return cached.agent;
  const previous = cached?.agent;
  const agent = new ProxyAgent(url);
  cached = { url, agent };
  if (previous)
    previous.close().catch(() => {
      return;
    });
  return agent;
}
function resetProxyAgents() {
  const previous = cached?.agent;
  cached = undefined;
  if (previous)
    previous.close().catch(() => {
      return;
    });
}
var DEFAULT_REQUEST_TIMEOUT_MS = 60000;

class RequestTimeoutError extends Error {
  name = "RequestTimeoutError";
  constructor(url, timeoutMs) {
    super(`request to ${safeLabel(url)} timed out after ${timeoutMs}ms`);
  }
}
function safeLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "upstream";
  }
}
async function pfetch(url, init, proxyUrl, options) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const dispatched = (extra) => ({
    ...init,
    ...extra,
    ...proxyUrl ? { dispatcher: agentFor(proxyUrl) } : {}
  });
  if (init?.signal || timeoutMs <= 0)
    return fetch(url, dispatched());
  const controller = new AbortController;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, dispatched({ signal: controller.signal }));
  } catch (error) {
    if (timedOut)
      throw new RequestTimeoutError(url, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// examples/plugins/cline-external/src/rpc.ts
var RPC_PROTOCOL = "narrafork.rpc/1";
var MAX_HEADER_BYTES = 8 * 1024;
var MAX_FRAME_BYTES = 16 * 1024 * 1024;
var MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;
var encoder = new TextEncoder;
var decoder = new TextDecoder("utf-8", { fatal: true });
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function log(message, detail) {
  const suffix = detail === undefined ? "" : ` ${safeJson(detail)}`;
  process.stderr.write(`[cline-external] ${message}${suffix}
`);
}
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function append(left, right) {
  const next = new Uint8Array(new ArrayBuffer(left.byteLength + right.byteLength));
  next.set(left);
  next.set(right, left.byteLength);
  return next;
}
function delimiterIndex(bytes) {
  for (let index = 0;index <= bytes.byteLength - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return index;
    }
  }
  return -1;
}
function contentLength(header) {
  let length;
  for (const line of header.split(`\r
`)) {
    const separator = line.indexOf(":");
    if (separator <= 0)
      throw new Error("invalid RPC header");
    if (line.slice(0, separator).trim().toLowerCase() !== "content-length")
      continue;
    if (length !== undefined)
      throw new Error("duplicate Content-Length header");
    const value = line.slice(separator + 1).trim();
    if (!/^\d+$/.test(value))
      throw new Error("invalid Content-Length header");
    length = Number(value);
  }
  if (length === undefined || !Number.isSafeInteger(length)) {
    throw new Error("missing Content-Length header");
  }
  return length;
}
function send(message, callback) {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r
Content-Type: application/json; charset=utf-8\r
\r
`);
  process.stdout.write(append(header, body), callback);
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function reject(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...data === undefined ? {} : { data } }
  });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
var nextRequestId = 1;
var pendingRequests = new Map;
var HOST_REQUEST_TIMEOUT_MS = 30000;
function request(method, params) {
  const id = `p2h-${nextRequestId++}`;
  return new Promise((resolve, rejectFn) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      const error = new Error(`Host request timed out: ${method}`);
      error.code = -32001;
      rejectFn(error);
    }, HOST_REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject: rejectFn, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function handleResponse(message) {
  if (typeof message.method === "string")
    return false;
  if (!("id" in message))
    return false;
  if (!(("result" in message) || ("error" in message)))
    return false;
  const id = String(message.id);
  const pending = pendingRequests.get(id);
  if (!pending)
    return true;
  clearTimeout(pending.timer);
  pendingRequests.delete(id);
  if ("error" in message && isRecord(message.error)) {
    const err = message.error;
    const error = new Error(typeof err.message === "string" ? err.message : "Host request failed");
    error.code = typeof err.code === "number" ? err.code : -32603;
    error.data = err.data;
    pending.reject(error);
  } else {
    pending.resolve(message.result);
  }
  return true;
}
function listen(onRequest) {
  let buffer = new Uint8Array(0);
  const parseFrames = () => {
    while (buffer.byteLength > 0) {
      const delimiter = delimiterIndex(buffer);
      if (delimiter < 0) {
        if (buffer.byteLength > MAX_HEADER_BYTES)
          throw new Error("RPC header exceeds limit");
        return;
      }
      if (delimiter > MAX_HEADER_BYTES)
        throw new Error("RPC header exceeds limit");
      const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
      if (length > MAX_FRAME_BYTES)
        throw new Error("RPC frame exceeds limit");
      const bodyStart = delimiter + 4;
      const frameEnd = bodyStart + length;
      if (buffer.byteLength < frameEnd)
        return;
      const message = JSON.parse(decoder.decode(buffer.slice(bodyStart, frameEnd)));
      buffer = buffer.slice(frameEnd);
      if (!isRecord(message) || message.jsonrpc !== "2.0")
        continue;
      if (handleResponse(message))
        continue;
      if (typeof message.method === "string" && "id" in message) {
        onRequest(message);
      }
    }
  };
  process.stdin.on("data", (chunk) => {
    try {
      const bytes = new Uint8Array(chunk.byteLength);
      bytes.set(chunk);
      buffer = append(buffer, bytes);
      if (buffer.byteLength > MAX_BUFFER_BYTES)
        throw new Error("RPC input buffer exceeds limit");
      parseFrames();
    } catch (error) {
      log("fatal framing error", { error: error instanceof Error ? error.message : "unknown" });
      process.exit(2);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// examples/plugins/cline-external/src/auth.ts
var CLINE_VERSION = "3.74.0";
var DEFAULT_CHAT_BASE_URL = "https://api.cline.bot/api/v1";
function accountBaseFrom(chatBaseUrl) {
  const base = trimSlashes(chatBaseUrl?.trim() || DEFAULT_CHAT_BASE_URL);
  return base.endsWith("/api/v1") ? base.slice(0, -"/api/v1".length) : base;
}
var EXPIRY_BUFFER_SECONDS = 5 * 60;
var MAX_REFRESH_RETRIES = 3;
var CALLBACK_PORT = 19876;
var OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
function buildClineHeaders() {
  return {
    "User-Agent": `Cline/${CLINE_VERSION}`,
    "X-PLATFORM": "node",
    "X-PLATFORM-VERSION": process.versions.bun ?? process.version,
    "X-CLIENT-TYPE": "extension",
    "X-CLIENT-VERSION": CLINE_VERSION,
    "X-CORE-VERSION": CLINE_VERSION
  };
}
function buildOpenRouterHeaders() {
  return {
    ...buildClineHeaders(),
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline"
  };
}
function buildClineAccountHeaders(accessToken) {
  const headers = {
    ...buildClineHeaders(),
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${withWorkosPrefix(accessToken)}`;
  }
  return headers;
}
function withWorkosPrefix(accessToken) {
  return accessToken.startsWith("workos:") ? accessToken : `workos:${accessToken}`;
}
function isTokenExpired(credentials, nowMs = Date.now()) {
  return credentials.expiresAt < nowMs / 1000 + EXPIRY_BUFFER_SECONDS;
}
async function refreshAccessToken(credentials, apiBaseUrl, proxyUrl) {
  const endpoint = `${trimSlashes(apiBaseUrl)}/api/v1/auth/refresh`;
  let lastError = "unknown error";
  for (let attempt = 0;attempt < MAX_REFRESH_RETRIES; attempt += 1) {
    try {
      const response = await pfetch(endpoint, {
        method: "POST",
        headers: buildClineAccountHeaders(),
        body: JSON.stringify({
          refreshToken: credentials.refreshToken,
          grantType: "refresh_token"
        })
      }, proxyUrl);
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          return { status: "invalid", reason: `refresh rejected with ${response.status}` };
        }
        lastError = `refresh failed with ${response.status}`;
        continue;
      }
      const json = await response.json();
      if (!json.success || !json.data?.accessToken) {
        lastError = "refresh returned no access token";
        continue;
      }
      const expiresAt = new Date(json.data.expiresAt).getTime();
      return {
        status: "refreshed",
        credentials: {
          accessToken: json.data.accessToken,
          refreshToken: json.data.refreshToken || credentials.refreshToken,
          expiresAt: Number.isFinite(expiresAt) ? expiresAt / 1000 : Date.now() / 1000 + 3600,
          email: json.data.userInfo?.email || credentials.email,
          displayName: json.data.userInfo?.name || credentials.displayName,
          ...credentials.userId ? { userId: credentials.userId } : {},
          startedAt: credentials.startedAt
        }
      };
    } catch (error) {
      lastError = error instanceof Error ? error.name : "request failed";
    }
  }
  return { status: "failed", reason: lastError };
}
function parseCallbackUrl(callbackUrl) {
  let url;
  try {
    url = new URL(withCallbackScheme(callbackUrl.trim()));
  } catch {
    throw new AuthInputError("That does not look like a URL");
  }
  const codeParam = url.searchParams.get("code");
  if (!codeParam) {
    throw new AuthInputError("No 'code' parameter found in the callback URL");
  }
  let decoded;
  try {
    decoded = Buffer.from(decodeURIComponent(codeParam), "base64").toString("utf-8");
  } catch {
    throw new AuthInputError("Failed to decode the callback code parameter");
  }
  const jsonEnd = decoded.lastIndexOf("}");
  if (jsonEnd === -1) {
    throw new AuthInputError("No JSON payload found in the callback code");
  }
  let data;
  try {
    data = JSON.parse(decoded.slice(0, jsonEnd + 1));
  } catch {
    throw new AuthInputError("The callback payload is not valid JSON");
  }
  if (!data.accessToken)
    throw new AuthInputError("No accessToken in the callback payload");
  if (!data.refreshToken)
    throw new AuthInputError("No refreshToken in the callback payload");
  const expiresAtMs = data.expiresAt ? new Date(data.expiresAt).getTime() : Number.NaN;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs / 1000 : Date.now() / 1000 + 3600,
    email: data.email || "",
    displayName: data.name || [data.firstName, data.lastName].filter(Boolean).join(" ") || "",
    startedAt: Date.now()
  };
}
function withCallbackScheme(value) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return value;
  const candidate = value.startsWith("//") ? value.slice(2) : value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?)/i.test(candidate)) {
    return `http://${candidate}`;
  }
  return value;
}

class AuthInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthInputError";
  }
}

class PortInUseError extends Error {
  constructor(port) {
    super(`Callback port ${port} is already in use. The built-in Cline provider may be signing in; retry, or paste the callback URL instead.`);
    this.name = "PortInUseError";
  }
}
function probeBrowserAuth() {
  try {
    const server = Bun.serve({
      port: CALLBACK_PORT,
      hostname: "127.0.0.1",
      fetch: () => new Response("probe", { status: 404 })
    });
    server.stop(true);
    return "available";
  } catch (error) {
    return isAddressInUse(error) ? "port_busy" : "unsupported";
  }
}
function isAddressInUse(error) {
  if (!error || typeof error !== "object")
    return false;
  const code = error.code;
  if (typeof code === "string" && code.includes("EADDRINUSE"))
    return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("EADDRINUSE") || message.includes("address already in use");
}
async function startBrowserAuth(apiBaseUrl, proxyUrl) {
  const baseUrl = trimSlashes(apiBaseUrl);
  const callbackUrl = `http://localhost:${CALLBACK_PORT}/auth/callback`;
  const authEndpoint = new URL(`${baseUrl}/api/v1/auth/authorize`);
  authEndpoint.searchParams.set("client_type", "extension");
  authEndpoint.searchParams.set("callback_url", callbackUrl);
  authEndpoint.searchParams.set("redirect_uri", callbackUrl);
  let resolveCode = () => {
    return;
  };
  let rejectCode = () => {
    return;
  };
  const codePromise = new Promise((resolve, reject2) => {
    resolveCode = resolve;
    rejectCode = reject2;
  });
  let server;
  try {
    server = Bun.serve({
      port: CALLBACK_PORT,
      hostname: "127.0.0.1",
      fetch(request2) {
        const url = new URL(request2.url);
        if (url.pathname !== "/auth/callback") {
          return new Response("Not found", { status: 404 });
        }
        resolveCode(request2.url);
        return new Response("<html><body><h2>Signed in.</h2><p>You can close this window.</p><script>window.close()</script></body></html>", { headers: { "Content-Type": "text/html" } });
      }
    });
  } catch (error) {
    if (isAddressInUse(error))
      throw new PortInUseError(CALLBACK_PORT);
    throw error;
  }
  let settled = false;
  const shutdown = () => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
    server.stop(true);
  };
  const timer = setTimeout(() => {
    rejectCode(new Error("Sign-in timed out after 5 minutes"));
    shutdown();
  }, OAUTH_TIMEOUT_MS);
  const cancel = (reason) => {
    rejectCode(new Error(reason));
    shutdown();
  };
  let authorizeUrl;
  try {
    authorizeUrl = await requestAuthorizeUrl(authEndpoint.toString(), proxyUrl);
  } catch (error) {
    cancel("Sign-in could not be started");
    throw error;
  }
  const completion = codePromise.then((fullUrl) => {
    shutdown();
    return parseCallbackUrl(fullUrl);
  });
  completion.catch(() => {
    return;
  });
  return { authorizeUrl, completion, cancel };
}
async function requestAuthorizeUrl(endpoint, proxyUrl) {
  const response = await pfetch(endpoint, { method: "GET", redirect: "manual", headers: buildClineAccountHeaders() }, proxyUrl);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location)
      throw new Error("Cline returned a redirect with no Location header");
    return location;
  }
  if (response.ok) {
    const data = await response.json();
    if (!data.redirect_url)
      throw new Error("Cline returned no redirect_url");
    return data.redirect_url;
  }
  log("authorize request failed", { status: response.status });
  throw new Error(`Cline authorization request failed with ${response.status}`);
}
async function fetchUserInfo(accessToken, apiBaseUrl, proxyUrl) {
  const response = await pfetch(`${trimSlashes(apiBaseUrl)}/api/v1/users/me`, { headers: buildClineAccountHeaders(accessToken) }, proxyUrl);
  if (!response.ok)
    return;
  const json = await response.json();
  if (!json.data)
    return;
  return {
    ...json.data.id ? { id: json.data.id } : {},
    ...json.data.email ? { email: json.data.email } : {},
    ...json.data.displayName || json.data.name ? { displayName: json.data.displayName || json.data.name } : {}
  };
}
async function fetchBalance(accessToken, userId, apiBaseUrl, proxyUrl) {
  const response = await pfetch(`${trimSlashes(apiBaseUrl)}/api/v1/users/${encodeURIComponent(userId)}/balance`, { headers: buildClineAccountHeaders(accessToken) }, proxyUrl);
  if (!response.ok)
    return;
  const json = await response.json();
  if (!json.success || !json.data)
    return;
  return json.data;
}
function trimSlashes(value) {
  return value.replace(/\/+$/, "");
}

// examples/plugins/cline-external/src/credentials.ts
import { createHash } from "crypto";
var CREDENTIALS_KEY = "provider.cline.credentials";
var ENABLED_MODELS_KEY = "provider.cline.enabledModels";

class InvalidCredentialsError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidCredentialsError";
  }
}

class MissingCredentialError extends Error {
  constructor(message = "Cline is not signed in") {
    super(message);
    this.name = "MissingCredentialError";
  }
}
function text(value) {
  if (typeof value !== "string")
    return;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
function parseCredentials(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCredentialsError("Stored Cline credentials are not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new InvalidCredentialsError("Stored Cline credentials are not an object");
  }
  const accessToken = text(parsed.accessToken);
  const refreshToken = text(parsed.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new InvalidCredentialsError("Stored Cline credentials are missing a token");
  }
  const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
  const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now();
  return {
    accessToken,
    refreshToken,
    expiresAt,
    email: text(parsed.email) ?? "",
    displayName: text(parsed.displayName) ?? "",
    ...text(parsed.userId) ? { userId: text(parsed.userId) } : {},
    startedAt
  };
}
function serializeCredentials(credentials) {
  return JSON.stringify(credentials);
}
async function loadCredentials() {
  const result = await request("secrets.get", { key: CREDENTIALS_KEY });
  const value = isRecord(result) ? result.value : undefined;
  if (typeof value !== "string" || value.length === 0)
    return;
  return parseCredentials(value);
}
async function requireCredentials() {
  const credentials = await loadCredentials();
  if (!credentials)
    throw new MissingCredentialError;
  return credentials;
}
async function storeCredentials(credentials) {
  await request("secrets.set", {
    key: CREDENTIALS_KEY,
    value: serializeCredentials(credentials)
  });
  rememberFresh(credentials);
}
async function clearCredentials() {
  await request("secrets.delete", { key: CREDENTIALS_KEY });
  cachedFresh = undefined;
  inFlightRefresh = undefined;
}
var cachedFresh;
var inFlightRefresh;
function fingerprint(credentials) {
  return createHash("sha256").update(credentials.refreshToken).digest("hex");
}
function rememberFresh(credentials) {
  cachedFresh = { key: fingerprint(credentials), credentials };
}
function resetCredentialCache() {
  cachedFresh = undefined;
  inFlightRefresh = undefined;
}
function credentialsFromConfig(config) {
  const raw = isRecord(config) ? config.credentials : undefined;
  if (typeof raw !== "string" || raw.length === 0)
    return;
  return parseCredentials(raw);
}
async function accessTokenFor(credentials, chatBaseUrl, proxyUrl) {
  if (!isTokenExpired(credentials))
    return credentials.accessToken;
  const key = fingerprint(credentials);
  if (cachedFresh?.key === key && !isTokenExpired(cachedFresh.credentials)) {
    return cachedFresh.credentials.accessToken;
  }
  if (inFlightRefresh) {
    const settled = await inFlightRefresh;
    return settled.accessToken;
  }
  const attempt = (async () => {
    const outcome = await refreshAccessToken(credentials, accountBaseFrom(chatBaseUrl), proxyUrl);
    if (outcome.status === "refreshed") {
      await storeCredentials(outcome.credentials);
      log("access token refreshed");
      return outcome.credentials;
    }
    if (outcome.status === "invalid") {
      await clearCredentials().catch(() => {
        return;
      });
      throw new MissingCredentialError("Cline sign-in has expired. Sign in again from the provider settings.");
    }
    throw new Error(`Could not refresh the Cline access token (${outcome.reason})`);
  })();
  inFlightRefresh = attempt;
  try {
    return (await attempt).accessToken;
  } finally {
    if (inFlightRefresh === attempt)
      inFlightRefresh = undefined;
  }
}
function parseEnabledModels(raw) {
  if (typeof raw !== "string" || raw.length === 0)
    return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("stored enabledModels is not valid JSON; treating as empty");
    return [];
  }
  if (!Array.isArray(parsed)) {
    log("stored enabledModels is not an array; treating as empty");
    return [];
  }
  const seen = new Set;
  for (const entry of parsed) {
    const id = text(entry);
    if (id)
      seen.add(id);
  }
  return [...seen];
}
async function loadEnabledModels() {
  const result = await request("secrets.get", { key: ENABLED_MODELS_KEY });
  return parseEnabledModels(isRecord(result) ? result.value : undefined);
}

// examples/plugins/cline-external/src/host-hints.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var currentProxyUrl;
function activeProxyUrl() {
  return currentProxyUrl;
}
function applyHostHints(params) {
  const hostHints = isRecord2(params) ? params.hostHints : undefined;
  const outbound = isRecord2(hostHints) ? hostHints.outbound : undefined;
  const proxyUrl = isRecord2(outbound) ? outbound.proxyUrl : undefined;
  currentProxyUrl = typeof proxyUrl === "string" && proxyUrl ? proxyUrl : undefined;
}

// examples/plugins/cline-external/src/models.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
var OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
var RECOMMENDED_MODELS_PATH = "/api/v1/ai/cline/recommended-models";
var POOL_TTL_MS = 30 * 60 * 1000;
var DEFAULT_CONTEXT_WINDOW = 128000;
var MAX_MODELS = 50;
var RECOMMENDED_FALLBACK = {
  recommended: [
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Anthropic Claude Sonnet 4.6",
      description: "Latest Sonnet release with strong coding and agent performance",
      tags: ["NEW"]
    },
    {
      id: "anthropic/claude-opus-4.6",
      name: "Anthropic Claude Opus 4.6",
      description: "Most intelligent model for agents and coding",
      tags: ["BEST"]
    }
  ],
  free: [
    {
      id: "kwaipilot/kat-coder-pro",
      name: "KwaiKAT Kat Coder Pro",
      description: "KwaiKAT's most advanced agentic coding model",
      tags: ["FREE"]
    }
  ]
};
function dataDir() {
  const base = process.env.NF_PLUGIN_DATA_DIR?.trim();
  const dir = base ? join(base, "cline") : join(tmpdir(), `cline-external-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
  } catch {}
  return dir;
}
function poolCachePath() {
  return join(dataDir(), "openrouter-models.json");
}
function recommendedCachePath() {
  return join(dataDir(), "recommended-models.json");
}
var memoryPool;
function readPoolCache() {
  if (memoryPool)
    return memoryPool;
  try {
    const parsed = JSON.parse(readFileSync(poolCachePath(), "utf-8"));
    if (!Array.isArray(parsed.models))
      return;
    memoryPool = parsed;
    return parsed;
  } catch {
    return;
  }
}
function writePoolCache(cache) {
  memoryPool = cache;
  try {
    writeFileSync(poolCachePath(), JSON.stringify(cache));
  } catch {}
}
function resetModelCaches() {
  memoryPool = undefined;
  memoryRecommended = undefined;
}
async function fetchModelPool(proxyUrl) {
  const response = await pfetch(OPENROUTER_MODELS_URL, { headers: buildOpenRouterHeaders() }, proxyUrl);
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed with ${response.status}`);
  }
  const json = await response.json();
  const models = [];
  for (const entry of json.data ?? []) {
    if (!entry.id)
      continue;
    models.push({
      id: entry.id,
      ...entry.name ? { name: entry.name } : {},
      ...typeof entry.context_length === "number" ? { contextLength: entry.context_length } : {},
      ...entry.pricing?.prompt ? { promptPrice: entry.pricing.prompt } : {},
      ...entry.pricing?.completion ? { completionPrice: entry.pricing.completion } : {}
    });
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}
async function getModelPool(options = {}) {
  const cached2 = readPoolCache();
  if (!options.force && cached2 && Date.now() - cached2.fetchedAt < POOL_TTL_MS) {
    return cached2.models;
  }
  try {
    const models = await fetchModelPool(options.proxyUrl);
    writePoolCache({ fetchedAt: Date.now(), models });
    return models;
  } catch (error) {
    if (cached2) {
      log("model pool refresh failed; serving cached pool", {
        error: error instanceof Error ? error.name : "unknown"
      });
      return cached2.models;
    }
    throw error;
  }
}
function cachedModelPool() {
  return readPoolCache()?.models ?? [];
}
function buildCatalog(enabledModels) {
  if (enabledModels.length === 0) {
    log("listModels called before any model was enabled");
    return { models: [], stale: true };
  }
  const selected = enabledModels.length > MAX_MODELS ? enabledModels.slice(0, MAX_MODELS) : enabledModels;
  if (selected.length !== enabledModels.length) {
    log("enabled model list truncated to the declared page size", {
      enabled: enabledModels.length,
      returned: selected.length
    });
  }
  const pool = new Map(cachedModelPool().map((model) => [model.id, model]));
  const models = selected.map((id) => {
    const entry = pool.get(id);
    return {
      id,
      displayName: entry?.name || id,
      contextWindow: entry?.contextLength ?? DEFAULT_CONTEXT_WINDOW,
      capabilities: {
        chat: true,
        generate: true,
        streaming: true,
        tools: true,
        reasoning: false,
        sessionMode: "stateless"
      }
    };
  });
  return {
    models,
    catalogVersion: `cline-${models.length}-${hashIds(selected)}`,
    cacheTtlMs: 300000
  };
}
function hashIds(ids) {
  let hash = 0;
  for (const id of ids) {
    for (let index = 0;index < id.length; index += 1) {
      hash = hash * 31 + id.charCodeAt(index) | 0;
    }
  }
  return (hash >>> 0).toString(36);
}
function contextWindowFor(modelId) {
  const entry = cachedModelPool().find((model) => model.id === modelId);
  return entry?.contextLength ?? DEFAULT_CONTEXT_WINDOW;
}
function searchPool(pool, query, limit) {
  const normalized = query.toLowerCase().trim();
  if (!normalized)
    return { models: pool.slice(0, limit), total: pool.length };
  const terms = normalized.split(/\s+/);
  const matched = pool.filter((model) => {
    const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return { models: matched.slice(0, limit), total: matched.length };
}
var memoryRecommended;
async function fetchRecommendedModels(accountBaseUrl, proxyUrl) {
  if (memoryRecommended && Date.now() - memoryRecommended.fetchedAt < POOL_TTL_MS) {
    return memoryRecommended.data;
  }
  try {
    const response = await pfetch(`${accountBaseUrl.replace(/\/+$/, "")}${RECOMMENDED_MODELS_PATH}`, { headers: buildOpenRouterHeaders() }, proxyUrl);
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const data = json.data ?? {
      recommended: json.recommended ?? [],
      free: json.free ?? []
    };
    if (data.recommended.length > 0 || data.free.length > 0) {
      memoryRecommended = { fetchedAt: Date.now(), data };
      try {
        writeFileSync(recommendedCachePath(), JSON.stringify(data));
      } catch {}
      return data;
    }
    throw new Error("recommended models response was empty");
  } catch (error) {
    log("recommended models request failed; using cache or fallback", {
      error: error instanceof Error ? error.name : "unknown"
    });
    try {
      const cached2 = JSON.parse(readFileSync(recommendedCachePath(), "utf-8"));
      if (Array.isArray(cached2.recommended) && Array.isArray(cached2.free))
        return cached2;
    } catch {}
    return RECOMMENDED_FALLBACK;
  }
}

// examples/plugins/cline-external/src/commands.ts
class CommandInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandInputError";
  }
}
var MAX_STORED_MODELS = 200;
var MAX_MODEL_ID_LENGTH = 200;
var MAX_SECRET_VALUE_BYTES = 64 * 1024;
function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CommandInputError(`${field} is required`);
  }
  return value.trim();
}
var pending;
function cancelPendingAuth(reason = "Sign-in cancelled") {
  if (!pending)
    return false;
  pending.cancel(reason);
  pending = undefined;
  return true;
}
function chatBase(context) {
  return context.chatBaseUrl?.trim() || DEFAULT_CHAT_BASE_URL;
}
async function status(_input, context) {
  let credentials;
  let credentialError;
  try {
    credentials = await loadCredentials();
  } catch (error) {
    credentialError = error instanceof Error ? error.message : "Stored credentials are unreadable";
  }
  const enabledModels = await loadEnabledModels();
  const browserAuth = pending ? "port_busy" : probeBrowserAuth();
  return {
    output: {
      authenticated: credentials !== undefined,
      ...credentialError ? { credentialError } : {},
      ...credentials?.email ? { email: credentials.email } : {},
      ...credentials?.displayName ? { displayName: credentials.displayName } : {},
      ...credentials ? { expiresAt: credentials.expiresAt } : {},
      ...credentials ? { expired: isTokenExpired(credentials) } : {},
      hasUserId: Boolean(credentials?.userId),
      enabledModelCount: enabledModels.length,
      enabledModels,
      poolModelCount: cachedModelPool().length,
      browserAuth,
      signInPending: pending !== undefined,
      ...pending ? { authorizeUrl: pending.authorizeUrl } : {},
      chatBaseUrl: chatBase(context)
    }
  };
}
async function authBrowser(_input, context) {
  cancelPendingAuth("Superseded by a new sign-in");
  const flow = await startBrowserAuth(accountBaseFrom(chatBase(context)), activeProxyUrl());
  pending = flow;
  flow.completion.then(async (credentials) => {
    await storeCredentials(credentials);
    log("browser sign-in completed");
  }).catch((error) => {
    log("browser sign-in did not complete", {
      error: error instanceof Error ? error.message : "unknown"
    });
  }).finally(() => {
    if (pending === flow)
      pending = undefined;
  });
  return { output: { authorizeUrl: flow.authorizeUrl } };
}
async function authCancel() {
  return { output: { cancelled: cancelPendingAuth() } };
}
async function authCallback(input) {
  const callbackUrl = requireString(isRecord(input) ? input.callbackUrl : undefined, "callbackUrl");
  let credentials;
  try {
    credentials = parseCallbackUrl(callbackUrl);
  } catch (error) {
    if (error instanceof AuthInputError)
      throw new CommandInputError(error.message);
    throw error;
  }
  cancelPendingAuth("Credentials were imported from a pasted URL");
  return {
    output: {
      ok: true,
      email: credentials.email,
      displayName: credentials.displayName
    },
    secretWrites: [{ key: CREDENTIALS_KEY, value: serializeCredentials(credentials) }]
  };
}
async function authLogout() {
  cancelPendingAuth("Signed out");
  await clearCredentials().catch(() => {
    return;
  });
  return {
    output: { ok: true },
    secretWrites: [{ key: CREDENTIALS_KEY, value: null }]
  };
}
async function balance(_input, context) {
  const credentials = await requireCredentials();
  const base = chatBase(context);
  const proxyUrl = activeProxyUrl();
  const accountBase = accountBaseFrom(base);
  const accessToken = await accessTokenFor(credentials, base, proxyUrl);
  let userId = credentials.userId;
  const writes = [];
  if (!userId) {
    const info = await fetchUserInfo(accessToken, accountBase, proxyUrl);
    if (!info?.id) {
      throw new Error("Cline did not return a user id, so the balance cannot be fetched");
    }
    userId = info.id;
    const updated = {
      ...credentials,
      accessToken,
      userId,
      ...info.email ? { email: info.email } : {},
      ...info.displayName ? { displayName: info.displayName } : {}
    };
    await storeCredentials(updated);
    writes.push({ key: CREDENTIALS_KEY, value: serializeCredentials(updated) });
  }
  const result = await fetchBalance(accessToken, userId, accountBase, proxyUrl);
  if (!result)
    throw new Error("Cline did not return a balance");
  return {
    output: { balance: result.balance, userId: result.userId },
    ...writes.length > 0 ? { secretWrites: writes } : {}
  };
}
async function recommendedModels(_input, context) {
  const data = await fetchRecommendedModels(accountBaseFrom(chatBase(context)), activeProxyUrl());
  return { output: data };
}
async function modelsRefresh() {
  const models = await getModelPool({ force: true, proxyUrl: activeProxyUrl() });
  return { output: { count: models.length } };
}
async function modelsSearch(input) {
  const query = isRecord(input) && typeof input.query === "string" ? input.query : "";
  const rawLimit = isRecord(input) ? input.limit : undefined;
  const limit = typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  const pool = await getModelPool({ proxyUrl: activeProxyUrl() });
  const { models, total } = searchPool(pool, query, limit);
  return { output: { models, total, poolSize: pool.length } };
}
async function setEnabledModels(input) {
  const raw = isRecord(input) ? input.models : undefined;
  if (!Array.isArray(raw))
    throw new CommandInputError("models must be an array");
  const seen = new Set;
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new CommandInputError("models must contain only strings");
    }
    const id = entry.trim();
    if (!id)
      continue;
    if (id.length > MAX_MODEL_ID_LENGTH) {
      throw new CommandInputError(`Model id is too long: ${id.slice(0, 40)}\u2026`);
    }
    seen.add(id);
  }
  if (seen.size > MAX_STORED_MODELS) {
    throw new CommandInputError(`Too many models selected: ${seen.size} > ${MAX_STORED_MODELS}`);
  }
  const models = [...seen];
  const value = JSON.stringify(models);
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
    throw new CommandInputError("The model selection is too large to store");
  }
  return {
    output: {
      count: models.length,
      servedToAgent: Math.min(models.length, MAX_MODELS),
      truncated: models.length > MAX_MODELS
    },
    secretWrites: [{ key: ENABLED_MODELS_KEY, value }]
  };
}
var COMMAND_HANDLERS = {
  status,
  "auth.browser": authBrowser,
  "auth.cancel": authCancel,
  "auth.callback": authCallback,
  "auth.logout": authLogout,
  balance,
  "recommended-models": recommendedModels,
  "models.refresh": modelsRefresh,
  "models.search": modelsSearch,
  "config.setEnabledModels": setEnabledModels
};
function findCommand(contributionId) {
  return COMMAND_HANDLERS[contributionId];
}

// examples/plugins/cline-external/src/event-mapping.ts
function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

class UsageAccumulator {
  usage = {};
  dirty = false;
  observe(chunk) {
    const source = chunk.usage;
    if (!source)
      return false;
    let changed = false;
    const next = [
      ["promptTokens", positiveInt(source.prompt_tokens)],
      ["completionTokens", positiveInt(source.completion_tokens)],
      ["reasoningTokens", positiveInt(source.completion_tokens_details?.reasoning_tokens)],
      ["cachedInputTokens", positiveInt(source.prompt_tokens_details?.cached_tokens)]
    ];
    for (const [key, value] of next) {
      if (value !== undefined && this.usage[key] !== value) {
        this.usage[key] = value;
        changed = true;
      }
    }
    if (changed)
      this.dirty = true;
    return changed;
  }
  setContextWindow(tokens) {
    const value = positiveInt(tokens);
    if (value === undefined)
      return;
    this.usage.contextWindow = value;
  }
  snapshot() {
    if (!this.dirty)
      return;
    return { ...this.usage };
  }
}

class StreamMapper {
  usage;
  tools = new Map;
  stopReason = "end_turn";
  responseId;
  failure;
  constructor(usage) {
    this.usage = usage;
  }
  map(chunk) {
    const events = [];
    if (chunk.id && !this.responseId)
      this.responseId = chunk.id;
    if (chunk.error) {
      this.failure = {
        classification: "api",
        code: String(chunk.error.code ?? chunk.error.type ?? "UPSTREAM_ERROR"),
        message: chunk.error.message || "Cline API reported an error",
        retryable: false,
        phase: "stream"
      };
      this.stopReason = "error";
      events.push({ type: "error", error: this.failure });
      return events;
    }
    if (this.usage.observe(chunk)) {
      const snapshot = this.usage.snapshot();
      if (snapshot)
        events.push({ type: "usage", usage: snapshot });
    }
    const choice = chunk.choices?.[0];
    if (!choice)
      return events;
    const content = choice.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      events.push({ type: "text.delta", text: content });
    }
    for (const delta of choice.delta?.tool_calls ?? []) {
      events.push(...this.mapToolCallDelta(delta));
    }
    if (choice.finish_reason) {
      events.push(...this.closeOpenToolCalls());
      this.stopReason = mapFinishReason(choice.finish_reason, this.tools.size > 0);
    }
    return events;
  }
  mapToolCallDelta(delta) {
    const events = [];
    const index = delta.index;
    let accumulator = this.tools.get(index);
    if (!accumulator) {
      if (!delta.id)
        return events;
      accumulator = { id: delta.id, name: delta.function?.name ?? "", args: "", ended: false };
      this.tools.set(index, accumulator);
      if (accumulator.name) {
        events.push({ type: "tool_call.start", toolUseId: accumulator.id, name: accumulator.name });
      }
    } else if (!accumulator.name && delta.function?.name) {
      accumulator.name = delta.function.name;
      events.push({ type: "tool_call.start", toolUseId: accumulator.id, name: accumulator.name });
    }
    if (accumulator.ended)
      return events;
    const fragment = delta.function?.arguments;
    if (typeof fragment === "string" && fragment.length > 0) {
      accumulator.args += fragment;
      events.push({
        type: "tool_call.delta",
        toolUseId: accumulator.id,
        argumentsDelta: fragment
      });
      if (accumulator.name && isParsableJson(accumulator.args)) {
        accumulator.ended = true;
        events.push({ type: "tool_call.end", toolUseId: accumulator.id });
      }
    }
    return events;
  }
  closeOpenToolCalls() {
    const events = [];
    for (const accumulator of this.tools.values()) {
      if (accumulator.ended)
        continue;
      accumulator.ended = true;
      if (!accumulator.name)
        continue;
      events.push({ type: "tool_call.end", toolUseId: accumulator.id });
    }
    return events;
  }
  failed() {
    return this.failure !== undefined;
  }
  finalEvent() {
    const usage = this.usage.snapshot();
    if (this.failure) {
      return {
        type: "done",
        status: "failed",
        stopReason: "error",
        ...this.responseId ? { responseId: this.responseId } : {},
        ...usage ? { usage } : {}
      };
    }
    return {
      type: "done",
      status: "completed",
      stopReason: this.stopReason,
      ...this.responseId ? { responseId: this.responseId } : {},
      ...usage ? { usage } : {}
    };
  }
  toolArguments() {
    return [...this.tools.values()].filter((entry) => entry.name).map((entry) => ({ id: entry.id, name: entry.name, args: entry.args }));
  }
}
function mapFinishReason(reason, hasToolCalls) {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_output_tokens";
    case "content_filter":
      return "content_filter";
    case "stop":
      return hasToolCalls ? "tool_use" : "end_turn";
    default:
      return hasToolCalls ? "tool_use" : "unknown";
  }
}
function isParsableJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
var MAX_SSE_PENDING_CHARS = 8 * 1024 * 1024;
var MAX_SSE_TOTAL_BYTES = 128 * 1024 * 1024;

class StreamTooLargeError extends Error {
  name = "StreamTooLargeError";
}
function splitSseLines(buffer) {
  const lines = buffer.split(`
`);
  const rest = lines.pop() ?? "";
  const payloads = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "data: [DONE]")
      continue;
    if (!trimmed.startsWith("data: "))
      continue;
    payloads.push(trimmed.slice(6));
  }
  return { payloads, rest };
}
function parseChunk(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return;
  }
}
async function consumeStream(body, mapper, onEvent, signal, limits) {
  const maxPendingChars = limits?.maxPendingChars ?? MAX_SSE_PENDING_CHARS;
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_SSE_TOTAL_BYTES;
  const decoder2 = new TextDecoder;
  const reader = body.getReader();
  let buffer = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      if (signal.aborted)
        return;
      totalBytes += value.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new StreamTooLargeError(`upstream response exceeded ${maxTotalBytes} bytes without completing`);
      }
      buffer += decoder2.decode(value, { stream: true });
      const { payloads, rest } = splitSseLines(buffer);
      buffer = rest;
      if (buffer.length > maxPendingChars) {
        throw new StreamTooLargeError(`upstream sent a single SSE line longer than ${maxPendingChars} characters`);
      }
      for (const payload of payloads) {
        const chunk = parseChunk(payload);
        if (!chunk)
          continue;
        for (const event of mapper.map(chunk))
          onEvent(event);
        if (mapper.failed())
          return;
      }
    }
  } finally {
    reader.releaseLock();
    body.cancel().catch(() => {
      return;
    });
  }
}
function classifyClineError(error) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError") {
    return { classification: "cancelled", code: "CANCELLED", message: "Request was cancelled" };
  }
  if (name === "StreamTooLargeError") {
    return {
      classification: "transport",
      code: "RESPONSE_TOO_LARGE",
      message,
      retryable: false
    };
  }
  if (name === "RequestTimeoutError") {
    return {
      classification: "transport",
      code: "REQUEST_TIMEOUT",
      message,
      retryable: true
    };
  }
  if (name === "MissingCredentialError") {
    return {
      classification: "invalid_state",
      code: "NOT_CONFIGURED",
      message,
      retryable: false
    };
  }
  if (name === "InvalidCredentialsError") {
    return {
      classification: "invalid_state",
      code: "INVALID_CONFIG",
      message,
      retryable: false
    };
  }
  const statusCode = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
  const status2 = typeof statusCode === "number" ? statusCode : undefined;
  if (status2 !== undefined)
    return classifyStatus(status2, message);
  return { classification: "transport", code: "REQUEST_FAILED", message, retryable: true };
}
function classifyStatus(status2, message) {
  if (status2 === 400) {
    return looksLikeContextOverflow(message) ? {
      classification: "api",
      code: "CONTEXT_LENGTH_EXCEEDED",
      message,
      retryable: false,
      statusCode: status2
    } : {
      classification: "api",
      code: "BAD_REQUEST",
      message,
      retryable: false,
      statusCode: status2
    };
  }
  if (status2 === 401 || status2 === 403) {
    return {
      classification: "api",
      code: "AUTH_FAILED",
      message,
      retryable: false,
      statusCode: status2
    };
  }
  if (status2 === 402) {
    return {
      classification: "api",
      code: "QUOTA_EXHAUSTED",
      message,
      retryable: false,
      statusCode: status2
    };
  }
  if (status2 === 429) {
    return {
      classification: "api",
      code: "THROTTLED",
      message,
      retryable: true,
      statusCode: status2
    };
  }
  if (status2 === 408 || status2 >= 500) {
    return {
      classification: "api",
      code: "UPSTREAM_ERROR",
      message,
      retryable: true,
      statusCode: status2
    };
  }
  return {
    classification: "api",
    code: "UPSTREAM_ERROR",
    message,
    retryable: false,
    statusCode: status2
  };
}
function looksLikeContextOverflow(message) {
  const lower = message.toLowerCase();
  return lower.includes("context length") || lower.includes("context_length") || lower.includes("context window") || lower.includes("maximum context") || lower.includes("too many tokens") || lower.includes("prompt is too long");
}

// examples/plugins/cline-external/src/history.ts
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function textOf(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function dataUrl(mediaType, dataBase64) {
  const type = mediaType.includes("/") ? mediaType : `image/${mediaType}`;
  return `data:${type};base64,${dataBase64}`;
}
function flattenToolResultContent(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const block of content) {
    if (!isRecord3(block))
      continue;
    if (block.type === "text") {
      const text2 = textOf(block.text);
      if (text2)
        parts.push(text2);
      continue;
    }
    if (block.type === "image") {
      parts.push("[image omitted: tool results cannot carry images on this provider]");
    }
  }
  return parts.join(`
`);
}
function toolResultMessages(blocks) {
  const messages = [];
  for (const block of blocks) {
    if (!isRecord3(block))
      continue;
    const toolUseId = textOf(block.toolUseId) ?? textOf(block.tool_call_id);
    if (!toolUseId)
      continue;
    const content = flattenToolResultContent(block.content);
    messages.push({
      role: "tool",
      tool_call_id: toolUseId,
      content
    });
  }
  return messages;
}
function partitionContent(content) {
  const textParts = [];
  const images = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of content) {
    if (!isRecord3(block))
      continue;
    switch (block.type) {
      case "text": {
        const text2 = textOf(block.text);
        if (text2)
          textParts.push(text2);
        break;
      }
      case "image": {
        const mediaType = textOf(block.mediaType);
        const dataBase64 = textOf(block.dataBase64);
        if (mediaType && dataBase64) {
          images.push({ type: "image_url", image_url: { url: dataUrl(mediaType, dataBase64) } });
        }
        break;
      }
      case "tool_call": {
        const toolUseId = textOf(block.toolUseId);
        const name = textOf(block.name);
        if (!toolUseId || !name)
          break;
        toolCalls.push({
          id: toolUseId,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(isRecord3(block.input) ? block.input : {})
          }
        });
        break;
      }
      case "tool_result":
        toolResults.push(block);
        break;
      default:
        break;
    }
  }
  return { text: textParts.join(`
`), images, toolCalls, toolResults };
}
function userMessage(text2, images) {
  if (images.length === 0) {
    return text2 ? { role: "user", content: text2 } : undefined;
  }
  const parts = [
    { type: "text", text: text2 || "[user sent image(s)]" },
    ...images
  ];
  return { role: "user", content: parts };
}
function convertHistory(history) {
  const messages = [];
  for (const entry of history) {
    if (!isRecord3(entry))
      continue;
    const role = entry.role;
    const content = Array.isArray(entry.content) ? entry.content : [];
    const { text: text2, images, toolCalls, toolResults } = partitionContent(content);
    if (role === "tool") {
      messages.push(...toolResultMessages(toolResults));
      continue;
    }
    if (role === "assistant") {
      if (!text2 && toolCalls.length === 0)
        continue;
      const message = { role: "assistant", content: text2 || "" };
      if (toolCalls.length > 0)
        message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }
    if (role === "system") {
      if (text2)
        messages.push({ role: "system", content: text2 });
      continue;
    }
    if (role === "user") {
      messages.push(...toolResultMessages(toolResults));
      const message = userMessage(text2, images);
      if (message)
        messages.push(message);
    }
  }
  return messages;
}
function isContinuationMarker(text2) {
  return text2 === ".";
}
function appendCurrentTurn(messages, current) {
  const toolResults = Array.isArray(current.toolResults) ? current.toolResults : [];
  messages.push(...toolResultMessages(toolResults));
  const text2 = typeof current.text === "string" ? current.text : "";
  const images = [];
  if (Array.isArray(current.images)) {
    for (const image of current.images) {
      if (!isRecord3(image))
        continue;
      const mediaType = textOf(image.mediaType);
      const dataBase64 = textOf(image.dataBase64);
      if (mediaType && dataBase64) {
        images.push({ type: "image_url", image_url: { url: dataUrl(mediaType, dataBase64) } });
      }
    }
  }
  if (isContinuationMarker(text2) && images.length === 0)
    return;
  const message = userMessage(isContinuationMarker(text2) ? "" : text2, images);
  if (message)
    messages.push(message);
}
function convertTools(tools) {
  const converted = [];
  for (const tool of tools) {
    if (!isRecord3(tool))
      continue;
    const name = textOf(tool.name);
    if (!name)
      continue;
    converted.push({
      type: "function",
      function: {
        name,
        description: textOf(tool.description) ?? "",
        parameters: isRecord3(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} }
      }
    });
  }
  return converted;
}
function withSystemPrompt(messages, systemPrompt) {
  if (!systemPrompt)
    return messages;
  return [{ role: "system", content: systemPrompt }, ...messages];
}

// examples/plugins/cline-external/src/server.ts
var PLUGIN_ID = "com.narrafork.cline-external";
var PLUGIN_VERSION = "0.1.0";
var PROVIDER_PROTOCOL = "1.0";
var LOCAL_ID = "cline";
var initialized = false;
var active = false;
var runtimeId;
var generation;
var operations = new Map;
function emit(operationId, event) {
  const operation = operations.get(operationId);
  if (!operation)
    return;
  operation.seq += 1;
  notify("provider.event", {
    protocolVersion: PROVIDER_PROTOCOL,
    operationId,
    seq: operation.seq,
    event
  });
}
function finish(operationId, event) {
  if (!operations.has(operationId))
    return;
  emit(operationId, event);
  operations.delete(operationId);
}
function configOf(params) {
  const config = isRecord(params) ? params.config : undefined;
  return isRecord(config) ? config : {};
}
function chatBaseOf(config) {
  const raw = config.baseUrl;
  const base = typeof raw === "string" ? raw.trim() : "";
  return (base || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, "");
}
function modelOf(params) {
  return isRecord(params) && typeof params.modelId === "string" ? params.modelId : "";
}
function describeProvider(id, params) {
  const versions = isRecord(params) && Array.isArray(params.protocolVersions) ? params.protocolVersions : [];
  if (!versions.includes(PROVIDER_PROTOCOL)) {
    reject(id, -32001, "No supported provider protocol version", {
      code: "INCOMPATIBLE",
      offered: versions
    });
    return;
  }
  respond(id, {
    selectedProtocolVersion: PROVIDER_PROTOCOL,
    plugin: { id: PLUGIN_ID, name: "Cline (External)", version: PLUGIN_VERSION },
    providers: [
      {
        localId: LOCAL_ID,
        displayName: "Cline (External)",
        description: "Models from the Cline API gateway, which proxies OpenRouter.",
        defaultModelId: "anthropic/claude-sonnet-4.6",
        configSchema: {
          type: "object",
          properties: {
            credentials: { type: "string", writeOnly: true, "x-narrafork-secret": true },
            enabledModels: { type: "string", writeOnly: true, "x-narrafork-secret": true },
            baseUrl: { type: "string", default: DEFAULT_CHAT_BASE_URL }
          },
          additionalProperties: false
        },
        capabilities: {
          validateConfig: true,
          listModels: true,
          chat: true,
          generate: true,
          reasoningContinuation: false,
          inputImages: true
        },
        limits: {
          maxConcurrentChat: 2,
          maxConcurrentGenerate: 1,
          maxConfigBytes: 131072,
          maxModelPageSize: 50
        }
      }
    ]
  });
}
function listModels(id, params) {
  applyHostHints(params);
  const config = configOf(params);
  respond(id, buildCatalog(parseEnabledModels(config.enabledModels)));
}
async function validateConfig(id, params) {
  applyHostHints(params);
  const config = configOf(params);
  let credentials;
  try {
    credentials = credentialsFromConfig(config);
  } catch (error) {
    respond(id, {
      valid: false,
      issues: [
        {
          path: "/credentials",
          message: error instanceof Error ? error.message : "Credentials are unreadable"
        }
      ]
    });
    return;
  }
  if (!credentials) {
    respond(id, {
      valid: false,
      issues: [{ path: "/credentials", message: "Cline is not signed in" }]
    });
    return;
  }
  const mode = isRecord(params) && params.mode === "connectivity" ? "connectivity" : "syntax";
  if (mode !== "connectivity") {
    respond(id, { valid: true, issues: [] });
    return;
  }
  try {
    await accessTokenFor(credentials, chatBaseOf(config), activeProxyUrl());
    const enabled = parseEnabledModels(config.enabledModels);
    respond(id, {
      valid: true,
      issues: [],
      capabilities: { modelCount: enabled.length }
    });
  } catch (error) {
    respond(id, {
      valid: false,
      issues: [
        {
          path: "/credentials",
          message: error instanceof Error ? error.message : "Could not reach Cline"
        }
      ]
    });
  }
}
function chatHeaders(accessToken) {
  return {
    ...buildOpenRouterHeaders(),
    "Content-Type": "application/json",
    Authorization: `Bearer ${withWorkosPrefix(accessToken)}`
  };
}

class UpstreamError extends Error {
  statusCode;
  constructor(status2, body) {
    super(`Cline API error ${status2}${body ? `: ${body.slice(0, 500)}` : ""}`);
    this.name = "UpstreamError";
    this.statusCode = status2;
  }
}
var MAX_ERROR_BODY_BYTES = 8 * 1024;
async function readErrorBody(response) {
  if (!response.body)
    return "";
  const reader = response.body.getReader();
  const decoder2 = new TextDecoder;
  let text2 = "";
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done)
        break;
      bytes += value.byteLength;
      text2 += decoder2.decode(value, { stream: true });
    }
  } catch {} finally {
    reader.releaseLock();
    response.body.cancel().catch(() => {
      return;
    });
  }
  return text2.slice(0, MAX_ERROR_BODY_BYTES);
}
async function openStream(baseUrl, accessToken, body, signal, proxyUrl) {
  const response = await pfetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: chatHeaders(accessToken),
    body: JSON.stringify(body),
    signal
  }, proxyUrl);
  if (!response.ok) {
    throw new UpstreamError(response.status, await readErrorBody(response));
  }
  if (!response.body)
    throw new Error("Cline API returned no response body");
  return response.body;
}
async function startChat(id, params) {
  applyHostHints(params);
  const operationId = isRecord(params) && typeof params.operationId === "string" ? params.operationId : undefined;
  if (!operationId) {
    reject(id, -32602, "chat requires an operationId", { code: "INVALID_PARAMS" });
    return;
  }
  if (operations.has(operationId)) {
    reject(id, -32602, "duplicate operationId", { code: "INVALID_PARAMS" });
    return;
  }
  const config = configOf(params);
  const request2 = isRecord(params) ? params.request : undefined;
  const modelId = modelOf(params);
  const controller = new AbortController;
  operations.set(operationId, { seq: 0, controller });
  respond(id, { accepted: true, operationId });
  const usage = new UsageAccumulator;
  usage.setContextWindow(contextWindowFor(modelId));
  const mapper = new StreamMapper(usage);
  try {
    const credentials = credentialsFromConfig(config);
    if (!credentials)
      throw new MissingCredentialError;
    const baseUrl = chatBaseOf(config);
    const proxyUrl = activeProxyUrl();
    const accessToken = await accessTokenFor(credentials, baseUrl, proxyUrl);
    const messages = convertHistory(isRecord(request2) && Array.isArray(request2.history) ? request2.history : []);
    appendCurrentTurn(messages, isRecord(isRecord(request2) ? request2.current : undefined) ? request2.current : {});
    const tools = convertTools(isRecord(request2) && Array.isArray(request2.tools) ? request2.tools : []);
    const body = {
      model: modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (tools.length > 0)
      body.tools = tools;
    emit(operationId, { type: "request_started" });
    const stream = await openStream(baseUrl, accessToken, body, controller.signal, proxyUrl);
    await consumeStream(stream, mapper, (event) => emit(operationId, event), controller.signal);
    if (controller.signal.aborted) {
      finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
      return;
    }
    finish(operationId, mapper.finalEvent());
  } catch (error) {
    const classified = classifyClineError(error);
    if (classified.classification === "cancelled") {
      finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
      return;
    }
    emit(operationId, { type: "error", error: classified });
    finish(operationId, {
      type: "done",
      status: "failed",
      stopReason: "error",
      ...usage.snapshot() ? { usage: usage.snapshot() } : {}
    });
  }
}
async function startGenerate(id, params) {
  applyHostHints(params);
  const operationId = isRecord(params) && typeof params.operationId === "string" ? params.operationId : undefined;
  if (!operationId) {
    reject(id, -32602, "generate requires an operationId", { code: "INVALID_PARAMS" });
    return;
  }
  if (operations.has(operationId)) {
    reject(id, -32602, "duplicate operationId", { code: "INVALID_PARAMS" });
    return;
  }
  const config = configOf(params);
  const request2 = isRecord(params) ? params.request : undefined;
  const modelId = modelOf(params);
  const controller = new AbortController;
  operations.set(operationId, { seq: 0, controller });
  respond(id, { accepted: true, operationId });
  const usage = new UsageAccumulator;
  usage.setContextWindow(contextWindowFor(modelId));
  const mapper = new StreamMapper(usage);
  try {
    const credentials = credentialsFromConfig(config);
    if (!credentials)
      throw new MissingCredentialError;
    const baseUrl = chatBaseOf(config);
    const proxyUrl = activeProxyUrl();
    const accessToken = await accessTokenFor(credentials, baseUrl, proxyUrl);
    emit(operationId, { type: "request_started" });
    const stream = await openStream(baseUrl, accessToken, {
      model: modelId,
      messages: generateMessages(request2),
      stream: true,
      stream_options: { include_usage: true }
    }, controller.signal, proxyUrl);
    await consumeStream(stream, mapper, (event) => {
      if (event.type.startsWith("tool_call."))
        return;
      emit(operationId, event);
    }, controller.signal);
    if (controller.signal.aborted) {
      finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
      return;
    }
    finish(operationId, mapper.finalEvent());
  } catch (error) {
    const classified = classifyClineError(error);
    if (classified.classification === "cancelled") {
      finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
      return;
    }
    emit(operationId, { type: "error", error: classified });
    finish(operationId, {
      type: "done",
      status: "failed",
      stopReason: "error",
      ...usage.snapshot() ? { usage: usage.snapshot() } : {}
    });
  }
}
function generateMessages(request2) {
  if (!isRecord(request2))
    return [];
  if (request2.mode === "history") {
    const systemInstruction2 = typeof request2.systemInstruction === "string" ? request2.systemInstruction : "";
    const content = typeof request2.content === "string" ? request2.content : "";
    return withSystemPrompt(content ? [{ role: "user", content }] : [], systemInstruction2 || undefined);
  }
  const text2 = typeof request2.text === "string" ? request2.text : "";
  const systemInstruction = typeof request2.systemInstruction === "string" ? request2.systemInstruction : "";
  return withSystemPrompt(text2 ? [{ role: "user", content: text2 }] : [], systemInstruction || undefined);
}
function cancelOperation(id, params) {
  const operationId = isRecord(params) && typeof params.operationId === "string" ? params.operationId : undefined;
  if (!operationId) {
    reject(id, -32602, "cancel requires an operationId", { code: "INVALID_PARAMS" });
    return;
  }
  const operation = operations.get(operationId);
  if (!operation) {
    respond(id, { operationId, state: "unknown_operation" });
    return;
  }
  respond(id, { operationId, state: "cancelling" });
  operation.controller.abort();
  finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
}
async function invokeCommand(id, params) {
  const contributionId = isRecord(params) ? params.contributionId : undefined;
  if (typeof contributionId !== "string") {
    reject(id, -32602, "commands.invoke requires a contributionId", { code: "INVALID_PARAMS" });
    return;
  }
  const handler = findCommand(contributionId);
  if (!handler) {
    reject(id, -32601, `Unknown command: ${contributionId}`, { code: "METHOD_NOT_FOUND" });
    return;
  }
  const input = isRecord(params) ? params.input : undefined;
  const chatBaseUrl = isRecord(input) && typeof input.chatBaseUrl === "string" ? input.chatBaseUrl : undefined;
  try {
    const result = await handler(input, { ...chatBaseUrl ? { chatBaseUrl } : {} });
    respond(id, {
      ...result.output === undefined ? {} : { output: result.output },
      ...result.secretWrites && result.secretWrites.length > 0 ? { secretWrites: result.secretWrites } : {}
    });
  } catch (error) {
    if (error instanceof CommandInputError || error instanceof AuthInputError) {
      reject(id, -32602, error.message, { code: "INVALID_PARAMS" });
      return;
    }
    if (error instanceof PortInUseError) {
      reject(id, -32603, error.message, { code: "PORT_IN_USE" });
      return;
    }
    const classified = classifyClineError(error);
    reject(id, -32603, classified.message, { code: classified.code });
  }
}
function teardown() {
  for (const operationId of [...operations.keys()]) {
    operations.get(operationId)?.controller.abort();
    finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
  }
  cancelPendingAuth("Plugin is shutting down");
  resetCredentialCache();
  resetModelCaches();
  resetProxyAgents();
}
function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const record = isRecord(params) ? params : {};
      if (record.protocol !== RPC_PROTOCOL || record.pluginId !== PLUGIN_ID) {
        reject(id, -32602, "initialize identity or protocol mismatch", { code: "INVALID_PARAMS" });
        return;
      }
      runtimeId = typeof record.runtimeId === "string" ? record.runtimeId : undefined;
      generation = typeof record.generation === "number" ? record.generation : undefined;
      initialized = true;
      respond(id, { initialized: true, protocol: RPC_PROTOCOL });
      return;
    }
    case "activate":
      if (!initialized) {
        reject(id, -32603, "Plugin must be initialized before activation");
        return;
      }
      active = true;
      respond(id, { activated: true });
      return;
    case "health":
      respond(id, {
        healthy: initialized && active,
        status: active ? "ready" : "inactive",
        runtimeId,
        generation
      });
      return;
    case "provider.describe":
      if (!active) {
        reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
        return;
      }
      describeProvider(id, params);
      return;
    case "provider.validateConfig":
      validateConfig(id, params).catch((error) => {
        reject(id, -32603, classifyClineError(error).message, { code: "INTERNAL" });
      });
      return;
    case "provider.listModels":
      listModels(id, params);
      return;
    case "provider.chat":
      if (!active) {
        reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
        return;
      }
      startChat(id, params);
      return;
    case "provider.generate":
      if (!active) {
        reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
        return;
      }
      startGenerate(id, params);
      return;
    case "provider.cancel":
      cancelOperation(id, params);
      return;
    case "commands.invoke":
      if (!active) {
        reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
        return;
      }
      invokeCommand(id, params);
      return;
    case "deactivate":
      active = false;
      teardown();
      respond(id, { deactivated: true });
      return;
    case "shutdown":
      active = false;
      initialized = false;
      teardown();
      operations.clear();
      send({ jsonrpc: "2.0", id, result: { shutdown: true } }, () => process.exit(0));
      return;
    default:
      reject(id, -32601, `Unknown method: ${method}`, { code: "METHOD_NOT_FOUND" });
  }
}
listen(handleRequest);
send({
  jsonrpc: "2.0",
  method: "hello",
  params: {
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    rpcProtocol: RPC_PROTOCOL,
    features: ["host_api.notifications", "rpc.cancel", "host_api.requests"]
  }
});
export {
  generateMessages
};
