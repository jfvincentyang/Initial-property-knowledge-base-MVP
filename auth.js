import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_BLOCK_MS = 10 * 60 * 1000;

export async function loadUsers(userConfigPath) {
  const raw = await readFile(userConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const users = Array.isArray(parsed.users) ? parsed.users : [];

  if (users.length === 0) {
    throw new Error("未在 config/users.json 中配置账号");
  }

  return users.map(normalizeUser);
}

export async function ensureHashedUsers(userConfigPath) {
  const raw = await readFile(userConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const users = Array.isArray(parsed.users) ? parsed.users : [];
  let changed = false;

  const nextUsers = users.map((user) => {
    if (user.passwordHash) {
      return normalizeUser(user);
    }

    changed = true;
    const password = String(user.password ?? "").trim();
    if (!password) {
      throw new Error(`账号 ${user.username ?? ""} 缺少密码配置`);
    }

    return normalizeUser({
      ...user,
      passwordHash: hashPassword(password),
      password: undefined,
    });
  });

  if (changed) {
    await writeFile(userConfigPath, JSON.stringify({ users: nextUsers }, null, 2), "utf8");
  }

  return nextUsers;
}

export async function updateUserPassword(userConfigPath, username, currentPassword, nextPassword) {
  const raw = await readFile(userConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const users = Array.isArray(parsed.users) ? parsed.users : [];
  const targetUsername = String(username ?? "").trim();
  const next = String(nextPassword ?? "").trim();

  if (!next || next.length < 6) {
    const error = new Error("新密码至少需要 6 位");
    error.statusCode = 400;
    throw error;
  }

  let found = false;
  const nextUsers = users.map((user) => {
    if (String(user.username ?? "").trim() !== targetUsername) {
      return user;
    }

    found = true;
    const currentHash = String(user.passwordHash ?? "").trim();
    if (!verifyPassword(currentPassword, currentHash)) {
      const error = new Error("当前密码不正确");
      error.statusCode = 400;
      throw error;
    }

    return {
      ...user,
      passwordHash: hashPassword(next),
      password: undefined,
    };
  });

  if (!found) {
    const error = new Error("未找到当前账号");
    error.statusCode = 404;
    throw error;
  }

  await writeFile(userConfigPath, JSON.stringify({ users: nextUsers }, null, 2), "utf8");
}

export function verifyPassword(password, passwordHash) {
  const [scheme, salt, digest] = String(passwordHash ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !digest) {
    return false;
  }

  const derived = crypto.scryptSync(String(password ?? ""), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(digest, "hex"));
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(String(password ?? ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${digest}`;
}

export function createLoginLimiter({ maxFailures = DEFAULT_MAX_FAILURES, blockMs = DEFAULT_BLOCK_MS } = {}) {
  const attempts = new Map();

  return {
    check(ipAddress) {
      const record = attempts.get(ipAddress);
      if (!record) {
        return { allowed: true };
      }

      if (record.blockUntil && record.blockUntil > Date.now()) {
        return {
          allowed: false,
          retryAfterMs: record.blockUntil - Date.now(),
        };
      }

      if (record.blockUntil && record.blockUntil <= Date.now()) {
        attempts.delete(ipAddress);
      }

      return { allowed: true };
    },

    recordFailure(ipAddress) {
      const now = Date.now();
      const record = attempts.get(ipAddress) ?? { failures: 0, blockUntil: 0 };
      record.failures += 1;

      if (record.failures >= maxFailures) {
        record.blockUntil = now + blockMs;
      }

      attempts.set(ipAddress, record);
      return record;
    },

    reset(ipAddress) {
      attempts.delete(ipAddress);
    },
  };
}

export function getClientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0];

  return forwarded || request.socket.remoteAddress || "unknown";
}

function normalizeUser(user) {
  return {
    username: String(user.username ?? "").trim(),
    passwordHash: String(user.passwordHash ?? "").trim(),
    role: user.role === "admin" ? "admin" : "user",
    displayName: String(user.displayName ?? user.username ?? "").trim(),
  };
}
