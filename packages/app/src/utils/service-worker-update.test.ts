import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { serviceWorkerRegistration } from "../../scripts/service-worker.mjs";

interface Harness {
  reloads: number;
  updates: number;
  skips: number;
  visibility: string;
  activeElement: unknown;
  now: number;
  fireWindow(type: string): void;
  fireDocument(type: string): void;
  fireServiceWorker(type: string): void;
  installWorker(): void;
  setWaiting(worker: { postMessage(message: unknown): void } | null): void;
  flush(): Promise<void>;
}

function createHarness(options: { controlled?: boolean } = {}): Harness {
  const controlled = options.controlled ?? true;
  const windowListeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  const serviceWorkerListeners = new Map<string, Array<() => void>>();
  const registrationListeners = new Map<string, Array<() => void>>();
  const intervals: Array<() => void> = [];
  const state = {
    reloads: 0,
    updates: 0,
    skips: 0,
    visibility: "visible",
    activeElement: null as unknown,
    now: 1_000_000,
  };
  let installing: { state: string; listeners: Array<() => void> } | null = null;

  const registration = {
    installing,
    waiting: null as null | { postMessage(message: unknown): void },
    active: null as null | { state: string },
    addEventListener(type: string, handler: () => void) {
      const list = registrationListeners.get(type) ?? [];
      list.push(handler);
      registrationListeners.set(type, list);
    },
    update() {
      state.updates++;
      return Promise.resolve();
    },
  };

  const context = {
    window: {
      isSecureContext: true,
      location: { reload: () => void state.reloads++ },
      addEventListener(type: string, handler: () => void) {
        const list = windowListeners.get(type) ?? [];
        list.push(handler);
        windowListeners.set(type, list);
      },
    },
    document: {
      get visibilityState() {
        return state.visibility;
      },
      get activeElement() {
        return state.activeElement;
      },
      addEventListener(type: string, handler: () => void) {
        const list = documentListeners.get(type) ?? [];
        list.push(handler);
        documentListeners.set(type, list);
      },
    },
    navigator: {
      serviceWorker: {
        controller: controlled ? {} : null,
        addEventListener(type: string, handler: () => void) {
          const list = serviceWorkerListeners.get(type) ?? [];
          list.push(handler);
          serviceWorkerListeners.set(type, list);
        },
        register() {
          return Promise.resolve(registration);
        },
      },
    },
    setInterval: (handler: () => void) => {
      intervals.push(handler);
      return intervals.length;
    },
    clearInterval: () => undefined,
    Boolean,
    Date: { now: () => state.now },
    console,
  };

  runInNewContext(serviceWorkerRegistration(), context);

  function fire(map: Map<string, Array<() => void>>, type: string) {
    for (const handler of map.get(type) ?? []) handler();
  }

  const harness: Harness = {
    get reloads() {
      return state.reloads;
    },
    get updates() {
      return state.updates;
    },
    get skips() {
      return state.skips;
    },
    get visibility() {
      return state.visibility;
    },
    set visibility(value: string) {
      state.visibility = value;
    },
    get activeElement() {
      return state.activeElement;
    },
    set activeElement(value: unknown) {
      state.activeElement = value;
    },
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    fireWindow: (type) => fire(windowListeners, type),
    fireDocument: (type) => fire(documentListeners, type),
    fireServiceWorker: (type) => fire(serviceWorkerListeners, type),
    installWorker: () => {
      const worker = {
        state: "installing",
        listeners: [] as Array<() => void>,
        addEventListener(_type: string, handler: () => void) {
          worker.listeners.push(handler);
        },
      };
      installing = worker;
      registration.installing = worker as never;
      // The page observes `updatefound` and then the worker's state changes.
      fire(registrationListeners, "updatefound");
      worker.state = "installed";
      for (const handler of worker.listeners) handler();
    },
    setWaiting: (worker) => {
      registration.waiting =
        worker === null
          ? null
          : {
              postMessage: (message: unknown) => {
                state.skips++;
                // ServiceWorker.postMessage takes no targetOrigin; the lint rule assumes Window.
                // eslint-disable-next-line unicorn/require-post-message-target-origin
                worker.postMessage(message);
              },
            };
    },
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return harness;
}

it("registers on load, checks for updates on focus/visibility, and polls", async () => {
  const harness = createHarness();
  harness.fireWindow("load");
  await harness.flush();
  expect(harness.updates).toBe(0);

  harness.fireWindow("focus");
  expect(harness.updates).toBe(1);
  harness.visibility = "visible";
  harness.fireDocument("visibilitychange");
  expect(harness.updates).toBe(2);
});

it("never reloads while an editable control is focused", async () => {
  const harness = createHarness();
  harness.fireWindow("load");
  await harness.flush();
  harness.installWorker();
  harness.now += 10 * 60 * 1000;
  harness.activeElement = { tagName: "TEXTAREA", isContentEditable: false };
  harness.fireDocument("visibilitychange"); // still visible
  expect(harness.reloads).toBe(0);
});

it("reloads once idle and nothing is focused", async () => {
  const harness = createHarness();
  harness.fireWindow("load");
  await harness.flush();
  harness.installWorker();
  harness.now += 10 * 60 * 1000;
  harness.fireDocument("visibilitychange");
  expect(harness.reloads).toBe(1);
});

it("reloads as soon as the app is hidden after an update", async () => {
  const harness = createHarness();
  harness.fireWindow("load");
  await harness.flush();
  harness.installWorker();
  // Recent activity would block an idle reload, but hidden is always safe.
  harness.visibility = "hidden";
  harness.fireDocument("visibilitychange");
  expect(harness.reloads).toBe(1);
});

it("does not reload the first controller claim of a fresh install", () => {
  const harness = createHarness({ controlled: false });
  harness.fireWindow("load");
  harness.fireServiceWorker("controllerchange");
  expect(harness.reloads).toBe(0);
});

it("activates a waiting release and reloads it at the next safe moment", async () => {
  const harness = createHarness();
  harness.fireWindow("load");
  await harness.flush();

  let posted: unknown = null;
  harness.setWaiting({ postMessage: (message) => void (posted = message) });
  harness.fireWindow("focus");
  expect(harness.skips).toBe(1);
  expect(posted).toEqual({ type: "SKIP_WAITING" });
  // Visible and recently active: the release is ready but not applied yet.
  expect(harness.reloads).toBe(0);

  harness.now += 10 * 60 * 1000;
  harness.fireDocument("visibilitychange");
  expect(harness.reloads).toBe(1);
});
