import { afterEach, expect, test, vi } from "vitest";
import type {
  CoDriveView,
  ChiMentionContext,
  ChiMentionOperation,
} from "@getpaseo/protocol/chi-mentions";
import { openCoDrive } from "./co-drive-model";

const forms: ReturnType<typeof openCoDrive>[] = [];
afterEach(() => {
  for (const form of forms.splice(0)) form.close();
});
function fixture() {
  const context: ChiMentionContext = {
    actor: "github:bob",
    repo: "*",
    deployment: "https://fixture.invalid",
    generation: "c".repeat(64),
    evidenceVersion: 3,
    coDrive: true,
  };
  const pin = {
    v: 3 as const,
    deployment: "fixture",
    repo: "github:fixture/repo",
    sourceId: "a".repeat(64),
    count: 1,
    head: "b".repeat(64),
  };
  const view: CoDriveView = {
    sourceId: pin.sourceId,
    pin,
    ownerId: "github:alice",
    ready: true,
    surface: "send-text",
    operation: null,
    control: {
      v: 3,
      generation: 1,
      active: true,
      recipient: context.actor,
      contextDigest: "d".repeat(64),
      readyPin: pin,
      readyUntil: 9999999999999,
      pending: null,
      executor: {
        instanceId: "host:opencode",
        nativeSessionId: "ses_original",
        bindingRevision: 1,
        host: "Owner host",
        provider: "opencode",
        modelProvider: "fixture",
        modelId: "model",
        modelVariant: null,
        account: "owner-host-configured",
        policyDigest: "e".repeat(64),
      },
    },
  };
  const stored = new Map<string, string>();
  let active = true,
    lost = false;
  const execute = vi.fn(async (op: ChiMentionOperation) => {
    if (op.action !== "control") throw new Error("unexpected action");
    if (op.request.action === "submit") {
      const request = op.request;
      view.operation = {
        ...request,
        v: 3,
        actor: context.actor,
        digest: "f".repeat(64),
        phase: "queued",
        admissionId: null,
        entry: null,
      };
      if (lost) throw new Error("lost reply");
    }
    return { kind: "control" as const, actor: context.actor, view: structuredClone(view) };
  });
  const open = () => {
    const model = openCoDrive({
      context: { ...context },
      source: { pin, seq: 0 },
      pin,
      storage: {
        getItem: async (key) => stored.get(key) ?? null,
        setItem: async (key, value) => {
          stored.set(key, value);
        },
        removeItem: async (key) => {
          stored.delete(key);
        },
      },
      isCurrent: () => active,
      execute,
      uuid: () => "00000000-0000-4000-8000-000000000001",
    });
    forms.push(model);
    model.start();
    return model;
  };
  return {
    context,
    view,
    pin,
    stored,
    execute,
    open,
    loseReply: () => {
      lost = true;
    },
    revokeContext: () => {
      active = false;
    },
  };
}
test("opening and refreshing control only read; stale pins and displayed contexts cannot send", async () => {
  const f = fixture(),
    model = f.open();
  await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
  model.setText("Synthetic message");
  model.send("0".repeat(64));
  model.selectPin({ ...f.pin, head: "0".repeat(64) });
  model.send(f.view.control!.contextDigest);
  await model.refresh();
  expect(
    f.execute.mock.calls.every(([op]) => op.action === "control" && op.request.action === "read"),
  ).toBe(true);
});
test("lost send reply is immutable and reload reconciles without resubmitting", async () => {
  const f = fixture(),
    model = f.open();
  await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
  f.loseReply();
  model.setText("Synthetic message");
  model.send(f.view.control!.contextDigest);
  await vi.waitFor(() => expect(model.getState().phase).toBe("failed"));
  expect(f.stored.size).toBe(1);
  model.close();
  const resumed = f.open();
  await vi.waitFor(() => expect(resumed.getState().phase).toBe("pending"));
  resumed.setText("different text");
  expect(resumed.getState().text).toBe("Synthetic message");
  expect(
    f.execute.mock.calls.filter(
      ([op]) => op.action === "control" && op.request.action === "submit",
    ),
  ).toHaveLength(1);
  f.view.operation!.phase = "recorded";
  f.view.operation!.entry = { pin: f.pin, seq: 0 };
  await resumed.refresh();
  expect(f.stored.size).toBe(0);
  expect(resumed.getState().view!.operation!.phase).toBe("recorded");
});
test("authorization-context change blocks recovery rather than retargeting saved work", async () => {
  const f = fixture(),
    model = f.open();
  await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
  f.loseReply();
  model.setText("Synthetic message");
  model.send(f.view.control!.contextDigest);
  await vi.waitFor(() => expect(model.getState().phase).toBe("failed"));
  model.close();
  f.context.generation = "9".repeat(64);
  const count = f.execute.mock.calls.length;
  const resumed = f.open();
  await vi.waitFor(() => expect(resumed.getState().phase).toBe("blocked"));
  expect(f.execute.mock.calls.length).toBe(count);
  expect(f.stored.size).toBe(1);
});
test("offline status and context loss deny new sends and clear protected views", async () => {
  const f = fixture(),
    model = f.open();
  await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
  f.view.ready = false;
  await model.refresh();
  model.setText("Synthetic message");
  model.send(f.view.control!.contextDigest);
  expect(f.stored.size).toBe(0);
  f.revokeContext();
  await model.refresh();
  expect(model.getState().phase).toBe("blocked");
  expect(model.getState().view).toBeNull();
});

test("a delayed read cannot restore controls after a concurrent failed send", async () => {
  const f = fixture(),
    model = f.open();
  await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
  let resolve!: (value: { kind: "control"; actor: string; view: CoDriveView }) => void;
  f.execute.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const delayed = model.refresh();
  f.loseReply();
  model.setText("Synthetic message");
  model.send(f.view.control!.contextDigest);
  await vi.waitFor(() => expect(model.getState().phase).toBe("failed"));
  resolve({ kind: "control", actor: f.context.actor, view: structuredClone(f.view) });
  await delayed;
  expect(model.getState().view).toBeNull();
});

test("rejected submit is editable again only after explicit cancellation proof, not an absent read", async () => {
  const f = fixture();
  f.execute.mockImplementation(async (op) => {
    if (op.action !== "control") throw Error("unexpected action");
    if (op.request.action === "submit") throw Error("chi-control-http-409");
    if (op.request.action === "cancel") {
      const input = op.request.submission!;
      f.view.operation = {
        ...input,
        v: 3,
        actor: f.context.actor,
        digest: "f".repeat(64),
        phase: "canceled",
        admissionId: null,
        entry: null,
      };
    }
    return { kind: "control", actor: f.context.actor, view: structuredClone(f.view) };
  });
  const model = f.open();
  await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
  model.setText("immutable rejected send");
  model.send(f.view.control!.contextDigest);
  await vi.waitFor(() => expect(model.getState().phase).toBe("failed"));
  await model.refresh();
  expect(model.getState().pending).not.toBeNull();
  expect(f.stored.size).toBe(1);
  model.setText("not yet editable");
  expect(model.getState().text).toBe("immutable rejected send");
  await model.cancel();
  expect(model.getState().pending).toBeNull();
  expect(f.stored.size).toBe(0);
  model.setText("new draft");
  expect(model.getState().text).toBe("new draft");
});

test.each([404, 409])(
  "cancel response %s is not proof that an ambiguous send was unadmitted",
  async (status) => {
    const f = fixture(),
      model = f.open();
    await vi.waitFor(() => expect(model.getState().phase).toBe("ready"));
    f.loseReply();
    model.setText("ambiguous send");
    model.send(f.view.control!.contextDigest);
    await vi.waitFor(() => expect(model.getState().phase).toBe("failed"));
    f.execute.mockRejectedValueOnce(new Error(`chi-control-http-${status}`));
    await model.cancel();
    expect(model.getState().pending?.action).toBe("submit");
    expect(f.stored.size).toBe(1);
    model.setText("must not replace");
    expect(model.getState().text).toBe("ambiguous send");
  },
);
