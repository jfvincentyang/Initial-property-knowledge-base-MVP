import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractImportedDocument } from "./file-import.js";
import { createKnowledgeBase } from "./knowledge-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 8000;
const kb = createKnowledgeBase(path.join(__dirname, "data", "knowledge-base.json"));
const userConfigPath = path.join(__dirname, "config", "users.json");
const importTempRoot = path.join(__dirname, "data", "imports");
const sessions = new Map();

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
      const payload = await readJsonBody(request);
      const users = await loadUsers();
      const user = users.find(
        (item) => item.username === payload.username && item.password === payload.password
      );

      if (!user) {
        return sendJson(response, 401, { error: "账号或密码不正确" });
      }

      const sessionId = crypto.randomBytes(24).toString("hex");
      const nextSession = {
        sessionId,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
      };

      sessions.set(sessionId, nextSession);
      response.setHeader("Set-Cookie", buildCookie(sessionId));
      return sendJson(response, 200, { session: sanitizeSession(nextSession) });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      const sessionId = readCookie(request.headers.cookie).sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
      }

      response.setHeader("Set-Cookie", buildExpiredCookie());
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

    if (url.pathname === "/api/documents/import" && request.method === "POST") {
      requireRole(session, "admin");
      const payload = await readJsonBody(request);
      const extracted = await extractImportedDocument({
        filename: payload.filename,
        contentBase64: payload.contentBase64,
        tempRoot: importTempRoot,
      });

      const document = await kb.addDocument({
        title: payload.title || extracted.title,
        category: payload.category || extracted.category,
        content: extracted.content,
      });

      return sendJson(response, 201, {
        document: {
          id: document.id,
          title: document.title,
          category: document.category,
          chunkCount: document.chunks.length,
          sourceType: extracted.sourceType,
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

server.listen(PORT, async () => {
  const users = await loadUsers();
  console.log(`Property KB server running at http://localhost:${PORT}`);
  console.log(`Loaded ${users.length} local accounts from config/users.json`);
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

async function loadUsers() {
  const raw = await readFile(userConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const users = Array.isArray(parsed.users) ? parsed.users : [];

  if (users.length === 0) {
    throw new Error("未在 config/users.json 中配置账号");
  }

  return users.map((user) => ({
    username: String(user.username ?? "").trim(),
    password: String(user.password ?? "").trim(),
    role: user.role === "admin" ? "admin" : "user",
    displayName: String(user.displayName ?? user.username ?? "").trim(),
  }));
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

function buildCookie(sessionId) {
  return `sessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax`;
}

function buildExpiredCookie() {
  return "sessionId=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
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
