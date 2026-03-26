import test from "node:test";
import assert from "node:assert/strict";
import { createLoginLimiter, hashPassword, updateUserPassword, verifyPassword } from "./auth.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("hashPassword and verifyPassword work together", () => {
  const hash = hashPassword("admin123");
  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(verifyPassword("admin123", hash), true);
  assert.equal(verifyPassword("wrong", hash), false);
});

test("login limiter blocks after repeated failures", () => {
  const limiter = createLoginLimiter({ maxFailures: 2, blockMs: 60_000 });
  const ip = "127.0.0.1";

  assert.equal(limiter.check(ip).allowed, true);
  limiter.recordFailure(ip);
  assert.equal(limiter.check(ip).allowed, true);
  limiter.recordFailure(ip);
  assert.equal(limiter.check(ip).allowed, false);
  limiter.reset(ip);
  assert.equal(limiter.check(ip).allowed, true);
});

test("updateUserPassword rewrites stored password hash", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "auth-test-"));
  const userConfigPath = path.join(tempDir, "users.json");
  const originalHash = hashPassword("oldpass");

  await writeFile(userConfigPath, JSON.stringify({
    users: [
      {
        username: "admin",
        passwordHash: originalHash,
        role: "admin",
        displayName: "管理员",
      },
    ],
  }, null, 2), "utf8");

  await updateUserPassword(userConfigPath, "admin", "oldpass", "newpass123");
  const nextConfig = JSON.parse(await readFile(userConfigPath, "utf8"));
  const nextHash = nextConfig.users[0].passwordHash;

  assert.notEqual(nextHash, originalHash);
  assert.equal(verifyPassword("newpass123", nextHash), true);
});
