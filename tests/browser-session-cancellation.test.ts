import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {Agent} from "../src/kernel/agent/agent.js";
import {RunContext} from "../src/kernel/agent/run-context.js";
import {BrowserSessionService, type BrowserSessionServiceOptions} from "../src/integrations/browser/session-service.js";

const fileHooks = vi.hoisted(() => ({
  write: undefined as undefined | ((file: string) => Promise<void>),
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await fileHooks.write?.(String(args[0]));
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await fileHooks.rename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
  };
});

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

class Page {
  closed = false;
  events: string[] = [];
  snapshot?: () => Promise<void>;
  fill?: () => Promise<void>;
  enter?: () => Promise<void>;
  titleWait?: () => Promise<void>;
  runtimeDevice = {viewport: {width: 1280, height: 720}, deviceScaleFactor: 1,
    userAgent: "desktop", maxTouchPoints: 0, hasTouch: false};
  url() { return "https://example.test/"; }
  async title() { await this.titleWait?.(); return "Example"; }
  async setContent() {}
  async evaluate(fn: unknown, input?: unknown) {
    if (String(fn).includes("maxTouchPoints")) return this.runtimeDevice;
    if (input && typeof input === "object" && "script" in input) {
      await this.snapshot?.();
      return {url: this.url(), title: "Example", text: "page", pageText: "page", dialogText: "", signals: [], elements: []};
    }
    return {json: '"evaluated"'};
  }
  async goto() { this.events.push("navigate"); }
  async screenshot() { this.events.push("screenshot"); return Buffer.from("image"); }
  async pdf() { return Buffer.from("pdf"); }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
  async waitForLoadState() {}
  async waitForTimeout() {}
  locator() {
    return {first: () => ({
      waitFor: async () => {},
      fill: async () => { this.events.push("fill"); await this.fill?.(); },
      click: async () => { this.events.push("click"); },
      press: async () => { this.events.push("enter"); await this.enter?.(); },
    })};
  }
  keyboard = {
    insertText: async () => { this.events.push("insert"); },
    press: async () => { this.events.push("keyboard-enter"); },
  };
}

class Context {
  page = new Page();
  state = "initial";
  storagePaths: string[] = [];
  newPageWait?: () => Promise<void>;
  nextPage?: Page;
  storageWait?: () => Promise<void>;
  pageListener?: (page: Page) => void;
  routeHandler?: (route: any) => Promise<void>;
  websocketHandler?: (route: any) => Promise<void>;
  closed = false;
  async newPage() {
    await this.newPageWait?.();
    if (this.nextPage) return this.nextPage;
    if (this.page.closed) {
      const device = this.page.runtimeDevice;
      this.page = new Page();
      this.page.runtimeDevice = device;
    }
    return this.page;
  }
  pages() { return [this.page]; }
  async route(_pattern: string, callback: (route: any) => Promise<void>) { this.routeHandler = callback; }
  async routeWebSocket(_pattern: string, callback: (route: any) => Promise<void>) { this.websocketHandler = callback; }
  on(_event: string, listener: (page: Page) => void) { this.pageListener = listener; }
  async close() { this.closed = true; this.page.closed = true; }
  async storageState(options: {path: string}) {
    this.storagePaths.push(options.path);
    await this.storageWait?.();
    await writeFile(options.path, JSON.stringify({cookies: [], origins: [], state: this.state}));
  }
}

class Browser {
  context = new Context();
  closed = false;
  contextWait?: () => Promise<void>;
  contextInputs: unknown[] = [];
  async newContext(options: unknown) {
    this.contextInputs.push(options);
    const device = options as {viewport: {width: number; height: number}; deviceScaleFactor?: number; userAgent?: string; hasTouch?: boolean};
    this.context.page.runtimeDevice = {viewport: device.viewport ?? {width: 1280, height: 720}, deviceScaleFactor: device.deviceScaleFactor ?? 1,
      userAgent: device.userAgent ?? "desktop", maxTouchPoints: device.hasTouch ? 5 : 0, hasTouch: device.hasTouch === true};
    await this.contextWait?.();
    return this.context;
  }
  async close() { this.closed = true; }
  on() {}
}

const agent = new Agent({name: "browser-cancellation-test", instructions: "test"});
function run(signal?: AbortSignal, sessionId = "session-a", onToolProgress?: () => void) {
  return new RunContext({agent, turn: 1, maxTurns: 1, messages: [], signal,
    context: {agentKey: "test", sessionId}, onToolProgress});
}

describe("browser session cancellation", () => {
  let dataDir: string;
  const services: BrowserSessionService[] = [];
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "browser-cancellation-"));
    fileHooks.write = undefined;
    fileHooks.rename = undefined;
  });
  afterEach(async () => {
    fileHooks.write = undefined;
    fileHooks.rename = undefined;
    await Promise.all(services.splice(0).map((service) => service.close()));
    await rm(dataDir, {recursive: true, force: true});
  });
  function service(browsers: Browser[], options: BrowserSessionServiceOptions = {}) {
    const launch = vi.fn(async () => browsers.shift() as any);
    const instance = new BrowserSessionService({dataDir, actionTimeoutMs: 2_000,
      lookupHostname: async () => ["93.184.216.34"], launchBrowserImpl: launch, ...options});
    services.push(instance);
    return {instance, launch};
  }
  const cancelled = {message: "Browser action was cancelled.", details: {cancelled: true}};

  it("rejects pre-aborted work without acquiring a browser or emitting progress", async () => {
    const {instance, launch} = service([]);
    const controller = new AbortController();
    controller.abort(new Error("private caller reason"));
    const progress = vi.fn();
    await expect(instance.handle({action: "snapshot"}, run(controller.signal, "session-a", progress)))
      .rejects.toMatchObject(cancelled);
    expect(launch).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it("cancels queued work promptly, preserves admission order and lets another scope proceed", async () => {
    const first = new Browser();
    const held = gate();
    first.context.page.snapshot = () => held.promise;
    const other = new Browser();
    const {instance, launch} = service([first, other]);
    const active = instance.handle({action: "snapshot"}, run());
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const waiting = instance.handle({action: "type", selector: "input", text: "never"}, run(controller.signal));
    const waitingResult = expect(waiting).rejects.toMatchObject(cancelled);
    controller.abort();
    await waitingResult;
    const third = instance.handle({action: "screenshot"}, run());
    await instance.handle({action: "snapshot"}, run(undefined, "session-b"));
    expect(first.closed).toBe(false);
    expect(first.context.page.events).toEqual([]);
    held.resolve();
    await active;
    await third;
    expect(first.context.page.events).toEqual(["screenshot"]);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("includes queue time in the action deadline without invalidating the active session", async () => {
    const browser = new Browser();
    const held = gate();
    browser.context.page.snapshot = () => held.promise;
    const {instance, launch} = service([browser]);
    const active = instance.handle({action: "snapshot"}, run());
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await expect(instance.handle({action: "screenshot", timeoutMs: 50}, run()))
      .rejects.toMatchObject({message: "browser action screenshot timed out after 50ms.", details: {timedOut: true}});
    expect(browser.closed).toBe(false);
    held.resolve();
    await active;
    await instance.handle({action: "snapshot"}, run());
    expect(launch).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous device profiles independent when one action is canceled", async () => {
    const desktop = new Browser();
    const wide = new Browser();
    const held = gate();
    const entered = gate();
    desktop.context.page.snapshot = async () => { entered.resolve(); await held.promise; };
    const {instance, launch} = service([desktop, wide]);
    const controller = new AbortController();
    const active = instance.handle({action: "snapshot"}, run(controller.signal));
    const failed = expect(active).rejects.toMatchObject(cancelled);
    await entered.promise;
    await instance.handle({action: "snapshot", deviceProfile: "desktop-wide"}, run());
    controller.abort();
    await failed;
    held.resolve();
    await instance.handle({action: "snapshot", deviceProfile: "desktop-wide"}, run());
    expect(desktop.closed).toBe(true);
    expect(wide.closed).toBe(false);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each(["launch", "context", "page"] as const)("disposes resources arriving after cancellation during %s", async (phase) => {
    const old = new Browser();
    const replacement = new Browser();
    const held = gate();
    const entered = gate();
    const pause = async () => { entered.resolve(); await held.promise; };
    if (phase === "context") old.contextWait = pause;
    if (phase === "page") old.context.newPageWait = pause;
    const launches = [old, replacement];
    const {instance} = service([], {launchBrowserImpl: async () => {
      const browser = launches.shift()!;
      if (phase === "launch" && browser === old) await pause();
      return browser as any;
    }});
    const controller = new AbortController();
    const action = instance.handle({action: "navigate", url: "https://example.test/"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    await instance.handle({action: "snapshot"}, run());
    held.resolve();
    await vi.waitFor(() => expect(old.closed).toBe(true));
    if (phase !== "launch") await vi.waitFor(() => expect(old.context.closed).toBe(true));
    if (phase === "page") await vi.waitFor(() => expect(old.context.page.closed).toBe(true));
    expect(old.context.page.events).toEqual([]);
    expect(replacement.closed).toBe(false);
  });

  it("does not start after delayed navigation DNS resolves for a canceled action", async () => {
    const held = gate();
    const entered = gate();
    const {instance, launch} = service([], {lookupHostname: async () => {
      entered.resolve(); await held.promise; return ["93.184.216.34"];
    }});
    const controller = new AbortController();
    const action = instance.handle({action: "navigate", url: "https://example.test/"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    held.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["fill", "enter"] as const)("does not retry input after cancellation interrupts %s", async (phase) => {
    const browser = new Browser();
    const held = gate();
    const entered = gate();
    browser.context.page[phase] = async () => { entered.resolve(); await held.promise; };
    const {instance} = service([browser]);
    const controller = new AbortController();
    const progress = vi.fn();
    const action = instance.handle({action: "type", selector: "input", text: "once", submit: true},
      run(controller.signal, "session-a", progress));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    const progressCount = progress.mock.calls.length;
    held.reject(new Error("browser closed"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(browser.context.page.events).toEqual(phase === "fill" ? ["fill"] : ["fill", "enter"]);
    expect(progress).toHaveBeenCalledTimes(progressCount);
    expect(browser.closed).toBe(true);
  });

  it("closes a page that arrives late from recovery without changing the replacement session", async () => {
    const old = new Browser();
    const replacement = new Browser();
    const {instance, launch} = service([old, replacement]);
    await instance.handle({action: "snapshot"}, run());
    old.context.page.closed = true;
    const latePage = new Page();
    old.context.nextPage = latePage;
    const held = gate();
    const entered = gate();
    old.context.newPageWait = async () => { entered.resolve(); await held.promise; };
    const controller = new AbortController();
    const action = instance.handle({action: "snapshot"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    await instance.handle({action: "snapshot"}, run());
    held.resolve();
    await vi.waitFor(() => expect(latePage.closed).toBe(true));
    const popup = new Page();
    old.context.pageListener?.(popup);
    await vi.waitFor(() => expect(popup.closed).toBe(true));
    await instance.handle({action: "snapshot"}, run());
    expect(launch).toHaveBeenCalledTimes(2);
    expect(replacement.closed).toBe(false);
  });

  it("does not delete shared storage or retry context creation after cancellation", async () => {
    const initial = new Browser();
    const interrupted = new Browser();
    const replacement = new Browser();
    replacement.context.state = "replacement";
    const {instance} = service([initial, interrupted, replacement]);
    await instance.handle({action: "snapshot"}, run());
    await instance.handle({action: "close"}, run());
    const held = gate();
    const entered = gate();
    interrupted.contextWait = async () => { entered.resolve(); await held.promise; };
    const controller = new AbortController();
    const action = instance.handle({action: "snapshot"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    await instance.handle({action: "snapshot"}, run());
    held.reject(new Error("context was closed"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(interrupted.contextInputs).toHaveLength(1);
    const sharedPath = (replacement.contextInputs[0] as {storageState: string}).storageState;
    expect(JSON.parse(await readFile(sharedPath, "utf8")).state).toBe("replacement");
  });

  it.each(["route", "websocket"] as const)("blocks a pending %s after cancellation, while completed actions leave routes reusable", async (kind) => {
    const browser = new Browser();
    let pauseDns = false;
    const held = gate();
    const entered = gate();
    const {instance} = service([browser], {lookupHostname: async () => {
      if (pauseDns) { entered.resolve(); await held.promise; }
      return ["93.184.216.34"];
    }});
    const oldController = new AbortController();
    await instance.handle({action: "snapshot"}, run(oldController.signal));
    oldController.abort();
    const events: string[] = [];
    const request = () => kind === "route"
      ? browser.context.routeHandler!({request: () => ({url: () => "https://example.test/image"}),
          continue: async () => { events.push("connect"); }, abort: async () => { events.push("blocked"); }})
      : browser.context.websocketHandler!({url: () => "wss://example.test/socket",
          connectToServer: () => { events.push("connect"); }, close: async () => { events.push("blocked"); }});
    await request();
    expect(events).toEqual(["connect"]);
    pauseDns = true;
    const pending = request();
    await entered.promise;
    const actionHeld = gate();
    const actionEntered = gate();
    browser.context.page.snapshot = async () => { actionEntered.resolve(); await actionHeld.promise; };
    const controller = new AbortController();
    const action = instance.handle({action: "snapshot"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await actionEntered.promise;
    controller.abort();
    await failed;
    held.resolve(); actionHeld.resolve();
    await pending;
    expect(events).toEqual(["connect", "blocked"]);
  });

  it("blocks a pending network route once an explicit close detaches the session", async () => {
    const browser = new Browser();
    const dns = gate();
    const dnsEntered = gate();
    const {instance} = service([browser], {lookupHostname: async () => {
      dnsEntered.resolve(); await dns.promise; return ["93.184.216.34"];
    }});
    await instance.handle({action: "snapshot"}, run());
    const events: string[] = [];
    const route = browser.context.routeHandler!({request: () => ({url: () => "https://example.test/image"}),
      continue: async () => { events.push("connect"); }, abort: async () => { events.push("blocked"); }});
    await dnsEntered.promise;
    const storage = gate();
    const storageEntered = gate();
    browser.context.storageWait = async () => { storageEntered.resolve(); await storage.promise; };
    const closing = instance.handle({action: "close"}, run());
    await storageEntered.promise;
    dns.resolve();
    await route;
    expect(events).toEqual(["blocked"]);
    storage.resolve();
    await closing;
  });

  it("queues public close behind admitted work and preserves normal storage for reopening", async () => {
    const old = new Browser();
    const replacement = new Browser();
    const held = gate();
    const entered = gate();
    old.context.page.snapshot = async () => { entered.resolve(); await held.promise; };
    const {instance} = service([old, replacement]);
    const active = instance.handle({action: "snapshot"}, run());
    await entered.promise;
    const closing = instance.closeSession("session:session-a:device:desktop");
    await new Promise((resolve) => setImmediate(resolve));
    expect(old.closed).toBe(false);
    held.resolve();
    await active; await closing;
    expect(old.closed).toBe(true);
    await instance.handle({action: "snapshot"}, run());
    const sharedPath = (replacement.contextInputs[0] as {storageState: string}).storageState;
    expect(JSON.parse(await readFile(sharedPath, "utf8")).state).toBe("initial");
  });

  it("does not reap a replacement captured only after another session's slow close", async () => {
    let now = 0;
    const first = new Browser();
    const old = new Browser();
    const replacement = new Browser();
    const {instance} = service([first, old, replacement], {now: () => now, sessionIdleTtlMs: 50});
    await instance.handle({action: "snapshot"}, run());
    await instance.handle({action: "snapshot"}, run(undefined, "session-b"));
    now = 100;
    const held = gate();
    const entered = gate();
    first.context.storageWait = async () => { entered.resolve(); await held.promise; };
    const reaping = instance.reapExpiredSessions();
    await entered.promise;
    await instance.handle({action: "snapshot"}, run(undefined, "session-b"));
    held.resolve();
    await reaping;
    expect(first.closed).toBe(true);
    expect(old.closed).toBe(true);
    expect(replacement.closed).toBe(false);
  });

  it("closes immediately despite pending storage staging, which cannot overwrite replacement state", async () => {
    const old = new Browser();
    const replacement = new Browser();
    replacement.context.state = "replacement";
    const held = gate();
    const entered = gate();
    old.context.storageWait = async () => { entered.resolve(); await held.promise; };
    const {instance} = service([old, replacement]);
    const controller = new AbortController();
    const action = instance.handle({action: "snapshot"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    expect(old.closed).toBe(true);
    await instance.handle({action: "snapshot"}, run());
    const sharedPath = replacement.context.storagePaths[0]!.replace(/\.[^.]+\.tmp$/, "");
    expect(JSON.parse(await readFile(sharedPath, "utf8")).state).toBe("replacement");
    held.resolve();
    await vi.waitFor(async () => expect(await readdir(path.dirname(sharedPath))).toEqual(["artifacts", "storage-state.json"]));
    expect(JSON.parse(await readFile(sharedPath, "utf8")).state).toBe("replacement");
    expect(replacement.closed).toBe(false);
  });

  it("returns cancellation while an issued storage publication still holds replacement admission", async () => {
    const old = new Browser();
    const replacement = new Browser();
    const held = gate();
    const entered = gate();
    fileHooks.rename = async () => { entered.resolve(); await held.promise; };
    const {instance, launch} = service([old, replacement]);
    const controller = new AbortController();
    const action = instance.handle({action: "snapshot"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    const next = instance.handle({action: "snapshot"}, run());
    await new Promise((resolve) => setImmediate(resolve));
    expect(launch).toHaveBeenCalledOnce();
    expect(old.closed).toBe(true);
    fileHooks.rename = undefined;
    held.resolve();
    await next;
    expect(launch).toHaveBeenCalledTimes(2);
    expect(replacement.closed).toBe(false);
  });

  it.each(["write", "rename"] as const)("cleans an artifact after its delayed %s settles without exposing canceled output", async (phase) => {
    const old = new Browser();
    const replacement = new Browser();
    const held = gate();
    const entered = gate();
    let artifactDir = "";
    const pause = async (file: string) => {
      if (!file.includes(".png")) return;
      artifactDir = path.dirname(file); entered.resolve(); await held.promise;
    };
    if (phase === "write") fileHooks.write = pause;
    else fileHooks.rename = pause;
    const {instance} = service([old, replacement]);
    const controller = new AbortController();
    const action = instance.handle({action: "screenshot"}, run(controller.signal));
    const failed = expect(action).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    const next = instance.handle({action: "snapshot"}, run());
    if (phase === "write") await next;
    fileHooks.write = undefined; fileHooks.rename = undefined;
    held.resolve();
    await next;
    await vi.waitFor(async () => expect(await readdir(artifactDir)).toEqual([]));
    expect(replacement.closed).toBe(false);
  });

  it.each(["screenshot", "pdf"] as const)("removes only the canceled %s artifact when title reading finishes late", async (action) => {
    const old = new Browser();
    const replacement = new Browser();
    const {instance} = service([old, replacement]);
    const saved = await instance.handle({action}, run());
    const savedPath = (saved.details as {path: string}).path;
    const held = gate();
    const entered = gate();
    old.context.page.titleWait = async () => { entered.resolve(); await held.promise; };
    const controller = new AbortController();
    const pending = instance.handle({action}, run(controller.signal));
    const failed = expect(pending).rejects.toMatchObject(cancelled);
    await entered.promise;
    controller.abort();
    await failed;
    await instance.handle({action: "snapshot"}, run());
    held.resolve();
    await vi.waitFor(async () => expect(await readdir(path.dirname(savedPath))).toEqual([path.basename(savedPath)]));
    expect(await readFile(savedPath, "utf8")).toBe(action === "screenshot" ? "image" : "pdf");
    expect(replacement.closed).toBe(false);
  });
});
