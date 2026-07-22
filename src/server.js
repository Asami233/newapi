import http from "node:http";
import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectRoot, "data");
const apiKeysFile = path.join(dataDir, "api-keys.json");

loadEnvFile(path.join(projectRoot, ".env"));
ensureDataDir();

const config = {
  port: Number(process.env.PORT || 3000),
  upstreamBaseUrl: trimTrailingSlash(process.env.UPSTREAM_BASE_URL || "https://api.deepseek.com"),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  localApiKey: process.env.LOCAL_API_KEY || "",
  downstreamApiKeys: parseStaticDownstreamKeys(process.env.DOWNSTREAM_API_KEYS || ""),
  modelAliases: parseModelAliases(process.env.MODEL_ALIASES || ""),
  models: parseModelList(process.env.MODELS || ""),
  modelListMode: parseModelListMode(process.env.MODEL_LIST_MODE || "merge")
};

const requestLogs = [];
const maxRequestLogs = 50;
const upstreamModelsCache = {
  fetchedAt: 0,
  models: [],
  source: "fallback",
  error: ""
};

let downstreamKeys = mergeStaticDownstreamKeys(loadApiKeys());

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const routePath = requestUrl.pathname;

  try {
    if (req.method === "GET" && routePath === "/") {
      sendHtml(res, renderHomePage());
      return;
    }

    if (req.method === "GET" && routePath === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && routePath === "/health") {
      sendHealth(res);
      return;
    }

    if (req.method === "GET" && routePath === "/v1/models") {
      await sendModels(req, res, startedAt);
      return;
    }

    if (req.method === "GET" && routePath === "/logs") {
      sendLogs(req, res, requestUrl);
      return;
    }

    if (req.method === "GET" && routePath === "/api/keys") {
      sendApiKeys(req, res);
      return;
    }

    if (req.method === "POST" && routePath === "/api/keys") {
      await createApiKey(req, res);
      return;
    }

    if (req.method === "DELETE" && routePath.startsWith("/api/keys/")) {
      deleteApiKey(req, res, routePath);
      return;
    }

    if (req.method === "POST" && routePath === "/v1/chat/completions") {
      await relayChatCompletions(req, res, startedAt);
      return;
    }

    sendJson(res, 404, {
      error: {
        message: "Route not found"
      }
    });
  } catch (error) {
    console.error("[relay:error]", error);
    if (!res.headersSent) {
      pushRequestLog({
        method: req.method || "",
        path: routePath,
        status: error.statusCode || 500,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      sendError(res, error);
    } else {
      res.end();
    }
  }
});

server.listen(config.port, () => {
  console.log(`newapi relay demo listening on http://localhost:${config.port}`);
});

function sendHealth(res) {
  sendJson(res, 200, {
    ok: true,
    upstreamBaseUrl: config.upstreamBaseUrl,
    localAuthEnabled: Boolean(config.localApiKey),
    downstreamKeys: downstreamKeys.filter((key) => key.active).length,
    models: getCachedOrFallbackModels().length,
    logs: requestLogs.length
  });
}

async function sendModels(req, res, startedAt) {
  const auth = getAuthContext(req);
  if (!auth) {
    recordUnauthorized(req, "/v1/models", startedAt);
    sendUnauthorized(res);
    return;
  }

  const result = await getModelsFromUpstreamOrFallback();
  recordKeyUsage(auth);
  pushRequestLog({
    method: req.method,
    path: "/v1/models",
    status: 200,
    durationMs: Date.now() - startedAt,
    authType: auth.type,
    keyName: auth.name,
    modelCount: result.models.length,
    modelSource: result.source
  });

  sendJson(res, 200, {
    object: "list",
    source: result.source,
    upstreamBaseUrl: config.upstreamBaseUrl,
    upstreamApiBaseUrl: getUpstreamApiBaseUrl(),
    data: result.models.map((model) => ({
      id: model,
      object: "model",
      created: 0,
      owned_by: result.source.startsWith("upstream") ? "upstream" : "relay-demo"
    }))
  });
}

function sendLogs(req, res, requestUrl) {
  if (!isAdmin(req)) {
    sendUnauthorized(res);
    return;
  }

  const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 12), 50);
  sendJson(res, 200, {
    object: "list",
    data: requestLogs.slice(0, limit)
  });
}

function sendApiKeys(req, res) {
  if (!isAdmin(req)) {
    sendUnauthorized(res);
    return;
  }

  sendJson(res, 200, {
    object: "list",
    data: downstreamKeys.map(publicApiKeyRecord)
  });
}

async function createApiKey(req, res) {
  if (!isAdmin(req)) {
    sendUnauthorized(res);
    return;
  }

  const body = await readJsonBody(req);
  const name = String(body.name || "default").trim().slice(0, 40) || "default";
  const plainKey = `sk-relay-${randomBytes(24).toString("hex")}`;
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    name,
    keyHash: hashToken(plainKey),
    prefix: plainKey.slice(0, 15),
    last4: plainKey.slice(-4),
    active: true,
    createdAt: now,
    lastUsedAt: "",
    requestCount: 0
  };

  downstreamKeys.unshift(record);
  saveApiKeys();

  sendJson(res, 201, {
    object: "api_key",
    key: plainKey,
    data: publicApiKeyRecord(record)
  });
}

function deleteApiKey(req, res, routePath) {
  if (!isAdmin(req)) {
    sendUnauthorized(res);
    return;
  }

  const id = decodeURIComponent(routePath.slice("/api/keys/".length));
  const key = downstreamKeys.find((item) => item.id === id);
  if (!key) {
    sendJson(res, 404, {
      error: {
        message: "API key not found"
      }
    });
    return;
  }

  if (key.source === "env") {
    sendJson(res, 400, {
      error: {
        message: "This API key comes from DOWNSTREAM_API_KEYS. Remove it from environment variables to disable it."
      }
    });
    return;
  }

  key.active = false;
  saveApiKeys();
  sendJson(res, 200, {
    ok: true,
    data: publicApiKeyRecord(key)
  });
}

async function relayChatCompletions(req, res, startedAt) {
  if (!config.upstreamApiKey) {
    pushRequestLog({
      method: req.method,
      path: "/v1/chat/completions",
      status: 500,
      durationMs: Date.now() - startedAt,
      error: "Missing UPSTREAM_API_KEY"
    });
    sendJson(res, 500, {
      error: {
        message: "Missing UPSTREAM_API_KEY in environment"
      }
    });
    return;
  }

  const auth = getAuthContext(req);
  if (!auth) {
    recordUnauthorized(req, "/v1/chat/completions", startedAt);
    sendUnauthorized(res);
    return;
  }

  const body = await readJsonBody(req);
  const upstreamBody = {
    ...body,
    model: mapModelName(body.model)
  };

  try {
    const upstreamUrl = buildUpstreamUrl("/chat/completions");
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.upstreamApiKey}`
      },
      body: JSON.stringify(upstreamBody)
    });

    const durationMs = Date.now() - startedAt;
    console.log(
      `[relay] key=${auth.name} model=${body.model || "(missing)"} upstreamModel=${upstreamBody.model || "(missing)"} status=${upstreamResponse.status} durationMs=${durationMs}`
    );
    recordKeyUsage(auth);
    pushRequestLog({
      method: req.method,
      path: "/v1/chat/completions",
      model: body.model || "",
      upstreamModel: upstreamBody.model || "",
      status: upstreamResponse.status,
      durationMs,
      authType: auth.type,
      keyName: auth.name,
      upstreamBaseUrl: config.upstreamBaseUrl
    });

    copyResponseHeaders(upstreamResponse, res);
    res.writeHead(upstreamResponse.status);

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    for await (const chunk of upstreamResponse.body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    pushRequestLog({
      method: req.method,
      path: "/v1/chat/completions",
      model: body.model || "",
      upstreamModel: upstreamBody.model || "",
      status: 502,
      durationMs: Date.now() - startedAt,
      authType: auth.type,
      keyName: auth.name,
      error: error.message,
      upstreamBaseUrl: config.upstreamBaseUrl
    });
    sendJson(res, 502, {
      error: {
        message: "Failed to call upstream API",
        detail: error.message
      }
    });
  }
}

async function getModelsFromUpstreamOrFallback() {
  const cacheTtlMs = 60_000;
  if (Date.now() - upstreamModelsCache.fetchedAt < cacheTtlMs && upstreamModelsCache.models.length > 0) {
    return {
      models: upstreamModelsCache.models,
      source: upstreamModelsCache.source
    };
  }

  if (config.upstreamApiKey) {
    try {
      const response = await fetch(buildUpstreamUrl("/models"), {
        headers: {
          authorization: `Bearer ${config.upstreamApiKey}`
        }
      });
      if (response.ok) {
        const payload = await response.json();
        const models = Array.isArray(payload.data)
          ? payload.data.map((item) => item.id).filter(Boolean)
          : [];
        if (models.length > 0) {
          upstreamModelsCache.fetchedAt = Date.now();
          const mergedModels = mergeConfiguredModels(models);
          upstreamModelsCache.models = mergedModels;
          upstreamModelsCache.source = getModelSourceLabel("upstream");
          upstreamModelsCache.error = "";
          return {
            models: mergedModels,
            source: upstreamModelsCache.source
          };
        }
      }
      upstreamModelsCache.error = `Upstream returned ${response.status}`;
    } catch (error) {
      upstreamModelsCache.error = error.message;
    }
  }

  const fallback = getFallbackModels();
  upstreamModelsCache.fetchedAt = Date.now();
  upstreamModelsCache.models = fallback;
  upstreamModelsCache.source = "fallback";
  return {
    models: fallback,
    source: "fallback"
  };
}

function getCachedOrFallbackModels() {
  if (upstreamModelsCache.models.length > 0) {
    return upstreamModelsCache.models;
  }
  return getFallbackModels();
}

function getFallbackModels() {
  if (config.models.length > 0) {
    return config.models;
  }

  if (config.modelAliases.size > 0) {
    return Array.from(config.modelAliases.keys());
  }

  return ["gpt-4o-mini"];
}

function mergeConfiguredModels(upstreamModels) {
  if (config.modelListMode === "upstream") {
    return upstreamModels;
  }

  if (config.modelListMode === "fallback") {
    return getFallbackModels();
  }

  return uniqueList([...upstreamModels, ...getFallbackModels()]);
}

function getModelSourceLabel(upstreamSource) {
  if (config.modelListMode === "merge" && config.models.length > 0) {
    return `${upstreamSource}+local`;
  }
  if (config.modelListMode === "fallback") {
    return "fallback";
  }
  return upstreamSource;
}

function getAuthContext(req) {
  const bearer = getBearerToken(req);
  if (!config.localApiKey) {
    return {
      type: "admin",
      name: "local-dev"
    };
  }

  if (bearer === config.localApiKey) {
    return {
      type: "admin",
      name: "admin"
    };
  }

  const tokenHash = hashToken(bearer);
  const keyRecord = downstreamKeys.find((key) => key.active && key.keyHash === tokenHash);
  if (!keyRecord) {
    return null;
  }

  return {
    type: "downstream",
    name: keyRecord.name,
    keyId: keyRecord.id
  };
}

function isAdmin(req) {
  return getAuthContext(req)?.type === "admin";
}

function recordKeyUsage(auth) {
  if (auth.type !== "downstream" || !auth.keyId) {
    return;
  }

  const record = downstreamKeys.find((key) => key.id === auth.keyId);
  if (!record) {
    return;
  }

  record.requestCount += 1;
  record.lastUsedAt = new Date().toISOString();
  saveApiKeys();
}

function recordUnauthorized(req, routePath, startedAt) {
  pushRequestLog({
    method: req.method,
    path: routePath,
    status: 401,
    durationMs: Date.now() - startedAt,
    error: "Unauthorized"
  });
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) {
    return "";
  }
  return authorization.slice(prefix.length).trim();
}

function sendUnauthorized(res) {
  sendJson(res, 401, {
    error: {
      message: "Unauthorized"
    }
  });
}

function publicApiKeyRecord(record) {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    last4: record.last4,
    active: record.active,
    source: record.source || "file",
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    requestCount: record.requestCount
  };
}

function mapModelName(model) {
  if (!model) {
    return model;
  }
  return config.modelAliases.get(model) || model;
}

function parseModelAliases(value) {
  const aliases = new Map();
  for (const item of value.split(",")) {
    const [localName, upstreamName] = item.split(":").map((part) => part?.trim());
    if (localName && upstreamName) {
      aliases.set(localName, upstreamName);
    }
  }
  return aliases;
}

function parseModelList(value) {
  return value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function parseModelListMode(value) {
  const mode = value.trim().toLowerCase();
  if (["upstream", "fallback", "merge"].includes(mode)) {
    return mode;
  }
  return "merge";
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseStaticDownstreamKeys(value) {
  return value
    .split(",")
    .map((item, index) => {
      const trimmed = item.trim();
      if (!trimmed) {
        return null;
      }

      const separatorIndex = trimmed.indexOf(":");
      const name = separatorIndex === -1 ? `env-key-${index + 1}` : trimmed.slice(0, separatorIndex).trim();
      const token = separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1).trim();
      if (!token) {
        return null;
      }

      return {
        id: `env-${hashToken(token).slice(0, 16)}`,
        name: name || `env-key-${index + 1}`,
        keyHash: hashToken(token),
        prefix: token.slice(0, 15),
        last4: token.slice(-4),
        active: true,
        source: "env",
        createdAt: "env",
        lastUsedAt: "",
        requestCount: 0
      };
    })
    .filter(Boolean);
}

function mergeStaticDownstreamKeys(fileKeys) {
  const fileKeyHashes = new Set(fileKeys.map((key) => key.keyHash));
  const envKeys = config.downstreamApiKeys.filter((key) => !fileKeyHashes.has(key.keyHash));
  return [...envKeys, ...fileKeys];
}

function pushRequestLog(entry) {
  requestLogs.unshift({
    id: randomUUID(),
    time: new Date().toISOString(),
    ...entry
  });

  if (requestLogs.length > maxRequestLogs) {
    requestLogs.length = maxRequestLogs;
  }
}

function copyResponseHeaders(upstreamResponse, res) {
  const allowedHeaders = [
    "content-type",
    "cache-control",
    "x-request-id",
    "openai-processing-ms"
  ];

  for (const header of allowedHeaders) {
    const value = upstreamResponse.headers.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Invalid JSON request body");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8"
  });
  res.end(html);
}

function sendError(res, error) {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, {
    error: {
      message: statusCode === 500 ? "Relay internal error" : error.message
    }
  });
}

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, {
      recursive: true
    });
  }
}

function loadApiKeys() {
  if (!fs.existsSync(apiKeysFile)) {
    return [];
  }

  try {
    const payload = JSON.parse(fs.readFileSync(apiKeysFile, "utf8"));
    return Array.isArray(payload.keys) ? payload.keys : [];
  } catch {
    return [];
  }
}

function saveApiKeys() {
  const fileBackedKeys = downstreamKeys.filter((key) => key.source !== "env");
  fs.writeFileSync(
    apiKeysFile,
    JSON.stringify(
      {
        keys: fileBackedKeys
      },
      null,
      2
    )
  );
}

function hashToken(token) {
  return createHash("sha256").update(token || "").digest("hex");
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function getUpstreamApiBaseUrl() {
  if (config.upstreamBaseUrl.endsWith("/v1")) {
    return config.upstreamBaseUrl;
  }
  return `${config.upstreamBaseUrl}/v1`;
}

function buildUpstreamUrl(apiPath) {
  const pathPart = apiPath.startsWith("/") ? apiPath.slice(1) : apiPath;
  return `${getUpstreamApiBaseUrl()}/${pathPart}`;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = stripEnvQuotes(value);
    }
  }
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function renderHomePage() {
  const indexPath = path.join(projectRoot, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    return fs.readFileSync(indexPath, "utf8");
  }

  return "<!doctype html><meta charset=\"utf-8\"><title>NewAPI Relay Demo</title><h1>NewAPI Relay Demo</h1><p>Missing public/index.html</p>";
}
