import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, UsernameTakenError, type UserStore } from "./users.js";

describe("UserStore", () => {
  let botDb: BotDatabase;
  let users: UserStore;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
  });

  afterEach(() => {
    botDb.close();
  });

  it("countUsers is 0 on a fresh db", () => {
    expect(users.countUsers()).toBe(0);
  });

  it("createUser stores the user and bumps countUsers", async () => {
    const u = await users.createUser("alice", "pw-hunter2");
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.username).toBe("alice");
    expect(users.countUsers()).toBe(1);
  });

  it("findByUsername is case-insensitive and returns null for missing", async () => {
    await users.createUser("Alice", "pw");
    expect(users.findByUsername("ALICE")).not.toBeNull();
    expect(users.findByUsername("alice")).not.toBeNull();
    expect(users.findByUsername("bob")).toBeNull();
  });

  it("createUser rejects duplicate usernames (case-insensitive)", async () => {
    await users.createUser("Alice", "pw");
    await expect(users.createUser("alice", "pw2")).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it("verifyPassword accepts correct password and rejects wrong one", async () => {
    await users.createUser("alice", "correct-horse-battery-staple");
    const row = users.findByUsername("alice");
    expect(row).not.toBeNull();
    expect(await users.verifyPassword("correct-horse-battery-staple", row!.passwordHash)).toBe(true);
    expect(await users.verifyPassword("wrong", row!.passwordHash)).toBe(false);
  });

  it("changePassword updates the hash so the old password no longer verifies", async () => {
    const u = await users.createUser("alice", "old");
    await users.changePassword(u.id, "new");
    const row = users.findByUsername("alice");
    expect(await users.verifyPassword("old", row!.passwordHash)).toBe(false);
    expect(await users.verifyPassword("new", row!.passwordHash)).toBe(true);
  });
});
