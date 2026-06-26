import { describe, it, expect, vi } from "vitest";
import { BotInstance, COMMAND_DENIED_MESSAGE } from "./instance.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";

// Constructing a real BotInstance is heavy (spawns a TS3Client, AudioPlayer,
// reads avatars, etc.), and runExclusive only touches a single private field
// (`playGate`). So we exercise the ACTUAL shipped method via its prototype,
// bound to a minimal object carrying just that field. This proves the real
// serializer logic without standing up a full bot.
type Gate = { playGate: Promise<unknown> };
const runExclusive = BotInstance.prototype.runExclusive as <T>(
  this: Gate,
  fn: () => Promise<T>,
) => Promise<T>;

function makeGate(): Gate {
  return { playGate: Promise.resolve() };
}

/** An explicit, timer-free deferred so ordering is deterministic. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BotInstance.runExclusive — serialization", () => {
  it("does not start fnB until fnA settles", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const gateA = deferred();

    const pA = runExclusive.call(gate, async () => {
      order.push("A-start");
      await gateA.promise; // suspend A until we explicitly release it
      order.push("A-end");
    });

    const pB = runExclusive.call(gate, async () => {
      order.push("B-start");
      order.push("B-end");
    });

    // Give the microtask queue a chance: B must NOT have started while A is
    // still suspended on gateA.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    gateA.resolve();
    await pA;
    await pB;

    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("runs fnB even if fnA rejects (chain survives rejection)", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const gateA = deferred();

    const pA = runExclusive.call(gate, async () => {
      order.push("A-start");
      await gateA.promise;
      throw new Error("A blew up");
    });

    const pB = runExclusive.call(gate, async () => {
      order.push("B-start");
      order.push("B-end");
      return "B-result";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    gateA.reject(new Error("A blew up"));
    await expect(pA).rejects.toThrow("A blew up");

    // B still runs, only after A has fully settled.
    await expect(pB).resolves.toBe("B-result");
    expect(order).toEqual(["A-start", "B-start", "B-end"]);
  });

  it("preserves call order across three serialized tasks", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const tasks = ["X", "Y", "Z"];
    const promises = tasks.map((t) =>
      runExclusive.call(gate, async () => {
        order.push(`${t}-start`);
        await Promise.resolve();
        order.push(`${t}-end`);
      }),
    );

    await Promise.all(promises);

    expect(order).toEqual([
      "X-start",
      "X-end",
      "Y-start",
      "Y-end",
      "Z-start",
      "Z-end",
    ]);
  });
});

/** Minimal `this` carrying only what handleTextMessage's gate path touches.
 *  The gate methods live on the prototype and are attached here so calls like
 *  `this.isCommandAllowed(...)` resolve against this same object. */
function makeGateCtx(opts: {
  adminGroups?: number[];
  clients?: Array<{ id: number; serverGroups: string[] }>;
}) {
  const ctx: any = {
    config: { commandPrefix: "!", commandAliases: {}, adminGroups: opts.adminGroups ?? [] },
    logger: { info: vi.fn(), error: vi.fn() },
    tsClient: {
      sendTextMessage: vi.fn(async () => {}),
      getClientsInChannel: vi.fn(async () => opts.clients ?? []),
    },
    executeCommand: vi.fn(async () => null),
    isCommandAllowed: (BotInstance.prototype as any).isCommandAllowed,
    lookupInvokerGroups: (BotInstance.prototype as any).lookupInvokerGroups,
  };
  return ctx;
}

function makeMsg(message: string, invokerGroups: string[] = [], invokerId = "5"): TS3TextMessage {
  return { invokerName: "Tester", invokerId, invokerUid: "uid", message, targetMode: 2, invokerGroups };
}

const handleTextMessage = (BotInstance.prototype as any).handleTextMessage as (
  this: unknown,
  msg: TS3TextMessage,
) => Promise<void>;

describe("BotInstance.handleTextMessage — command permission gate", () => {
  it("runs a public command even with enforcement on", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!play 晴天"));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.sendTextMessage).not.toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("runs an admin command when enforcement is off (empty adminGroups)", async () => {
    const ctx = makeGateCtx({ adminGroups: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("runs an admin command when the event carried a matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["6"]));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.getClientsInChannel).not.toHaveBeenCalled(); // no fallback needed
  });

  it("denies an admin command when known groups do not match (no fallback, with reply)", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["8"]));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.getClientsInChannel).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("falls back to a group lookup when the event carried no groups, and allows on match", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], clients: [{ id: 5, serverGroups: ["6"] }] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.tsClient.getClientsInChannel).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the fallback finds the client but no matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], clients: [{ id: 5, serverGroups: ["8"] }] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("fails closed when the fallback cannot find the client at all", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], clients: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });
});
