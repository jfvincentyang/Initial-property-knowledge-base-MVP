import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLoginLimiter, ensureHashedUsers, getClientIp, loadUsers, updateUserPassword, verifyPassword } from "./auth.js";
import { extractImportedDocument } from "./file-import.js";
import { createKnowledgeBase } from "./knowledge-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8000);
const NODE_ENV = process.env.NODE_ENV || "development";
const userConfigPath = path.join(__dirname, "config", "users.json");
const databasePath = path.join(__dirname, "data", "knowledge-base.sqlite");
const legacyJsonPath = path.join(__dirname, "data", "knowledge-base.json");
const importTempRoot = path.join(__dirname, "data", "imports");
const kb = createKnowledgeBase(databasePath, { legacyJsonPath });
const sessions = new Map();
const loginLimiter = createLoginLimiter();
const importDrafts = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const session = readSession(request);

    if (url.pathname === "/api/session" && request.method === "GET") {
      return sendJson(response, 200, { session: sanitizeSession(session) });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const clientIp = getClientIp(request);
      const limiterState = loginLimiter.check(clientIp);
      if (!limiterState.allowed) {
        return sendJson(response, 429, {
          error: `登录失败次数过多，请在 ${Math.ceil(limiterState.retryAfterMs / 1000)} 秒后重试`,
        });
      }

      const payload = await readJsonBody(request);
      const users = await loadUsers(userConfigPath);
      const user = users.find((item) => item.username === payload.username);

      if (!user || !verifyPassword(payload.password, user.passwordHash)) {
        loginLimiter.recordFailure(clientIp);
        return sendJson(response, 401, { error: "账号或密码不正确" });
      }

      loginLimiter.reset(clientIp);
      const sessionId = crypto.randomBytes(24).toString("hex");
      const nextSession = {
        sessionId,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
      };

      sessions.set(sessionId, nextSession);
      response.setHeader("Set-Cookie", buildCookie(sessionId, request));
      return sendJson(response, 200, { session: sanitizeSession(nextSession) });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      const sessionId = readCookie(request.headers.cookie).sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
      }

      response.setHeader("Set-Cookie", buildExpiredCookie(request));
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname === "/api/change-password" && request.method === "POST") {
      requireAuthenticated(session);
      const payload = await readJsonBody(request);
      await updateUserPassword(
        userConfigPath,
        session.username,
        payload.currentPassword,
        payload.nextPassword
      );
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname === "/api/documents" && request.method === "GET") {
      const documents = await kb.listDocuments();
      return sendJson(response, 200, { documents });
    }

    if (url.pathname === "/api/documents" && request.method === "POST") {
      requireRole(session, "admin");
      const payload = await readJsonBody(request);
      const document = await kb.addDocument(payload);
      return sendJson(response, 201, {
        document: {
          id: document.id,
          title: document.title,
          category: document.category,
          chunkCount: document.chunks.length,
        },
      });
    }

    if (url.pathname === "/api/documents/import-preview" && request.method === "POST") {
      requireRole(session, "admin");
      const payload = await readJsonBody(request);
      const extracted = await extractImportedDocument({
        filename: payload.filename,
        contentBase64: payload.contentBase64,
        tempRoot: importTempRoot,
      });

      const draftId = crypto.randomBytes(16).toString("hex");
      importDrafts.set(draftId, {
        draftId,
        title: payload.title || extracted.title,
        category: payload.category || extracted.category,
        content: extracted.content,
        sourceType: extracted.sourceType,
        createdAt: Date.now(),
        owner: session.username,
      });

      return sendJson(response, 200, {
        draft: {
          draftId,
          title: payload.title || extracted.title,
          category: payload.category || extracted.category,
          sourceType: extracted.sourceType,
          preview: extracted.content.slice(0, 3000),
          contentLength: extracted.content.length,
        },
      });
    }

    if (url.pathname === "/api/documents/import-confirm" && request.method === "POST") {
      requireRole(session, "admin");
      const payload = await readJsonBody(request);
      const draft = importDrafts.get(String(payload.draftId ?? ""));

      if (!draft || draft.owner !== session.username) {
        return sendJson(response, 404, { error: "未找到可确认的导入预览" });
      }

      const document = await kb.addDocument({
        title: draft.title,
        category: draft.category,
        content: draft.content,
      });

      importDrafts.delete(draft.draftId);

      return sendJson(response, 201, {
        document: {
          id: document.id,
          title: document.title,
          category: document.category,
          chunkCount: document.chunks.length,
          sourceType: draft.sourceType,
        },
      });
    }

    if (url.pathname.startsWith("/api/documents/") && request.method === "DELETE") {
      requireRole(session, "admin");
      const documentId = decodeURIComponent(url.pathname.slice("/api/documents/".length));
      const result = await kb.deleteDocument(documentId);
      return sendJson(response, 200, { deleted: result });
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      requireAuthenticated(session);
      const payload = await readJsonBody(request);
      const answer = await kb.answerQuestion(payload.question);
      return sendJson(response, 200, { answer });
    }

    return await serveStaticFile(url.pathname, response);
  } catch (error) {
    const statusCode = error.statusCode ?? 500;
    const message = statusCode >= 500 ? "Server error" : error.message;
    sendJson(response, statusCode, { error: message });
  }
});

await ensureHashedUsers(userConfigPath);

server.listen(PORT, async () => {
  const users = await loadUsers(userConfigPath);
  console.log(`Property KB server running at http://localhost:${PORT}`);
  console.log(`Loaded ${users.length} local accounts from config/users.json`);
  console.log(`Environment: ${NODE_ENV}`);
});

async function serveStaticFile(pathname, response) {
  const requestedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(__dirname, normalizedPath);

  if (!filePath.startsWith(__dirname) || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });

  createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const parseError = new Error("请求体不是合法 JSON");
    parseError.statusCode = 400;
    throw parseError;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readSession(request) {
  const cookies = readCookie(request.headers.cookie);
  const sessionId = cookies.sessionId;
  if (!sessionId) {
    return null;
  }
  return sessions.get(sessionId) ?? null;
}

function readCookie(headerValue) {
  const cookieHeader = String(headerValue ?? "");
  const pairs = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, ...rest] = item.split("=");
      return [key, rest.join("=")];
    });

  return Object.fromEntries(pairs);
}

function buildCookie(sessionId, request) {
  const secure = shouldUseSecureCookie(request);
  return [
    `sessionId=${sessionId}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function buildExpiredCookie(request) {
  const secure = shouldUseSecureCookie(request);
  return [
    "sessionId=",
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    "Max-Age=0",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function shouldUseSecureCookie(request) {
  if (process.env.COOKIE_SECURE === "1") {
    return true;
  }

  if (NODE_ENV === "production") {
    const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").toLowerCase();
    return forwardedProto.includes("https");
  }

  return false;
}

function sanitizeSession(session) {
  if (!session) {
    return null;
  }

  return {
    username: session.username,
    role: session.role,
    displayName: session.displayName,
  };
}

function requireAuthenticated(session) {
  if (!session) {
    const error = new Error("请先登录后再使用问答");
    error.statusCode = 401;
    throw error;
  }
}

function requireRole(session, expectedRole) {
  requireAuthenticated(session);
  if (session.role !== expectedRole) {
    const error = new Error(expectedRole === "admin" ? "当前账号没有管理权限" : "当前账号没有操作权限");
    error.statusCode = 403;
    throw error;
  }
}
