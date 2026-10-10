import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test.skipIf(process.platform === "win32")(
  "a proved pending send completes durably without resubmission",
  async () => {
    const { requests, directory } = await fixture();
    let sends = 0;
    let recoveries = 0;
    const input = {
      agentId: "agent",
      messageId: "accepted",
      durable: true,
      request: { text: "@reader check" },
      send: async () => {
        sends++;
        throw new Error("acknowledgement lost");
      },
    };
    await expect(requests.send(input)).rejects.toThrow("acknowledgement lost");
    const restarted = new MessageReceipts(directory);
    const recover = async (fingerprint: string) => {
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      recoveries++;
      return true;
    };
    await expect(
      restarted.send({ ...input, request: { text: "different" }, recover }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(recoveries).toBe(0);
    await Promise.all([
      restarted.send({ ...input, recover }),
      restarted.send({ ...input, recover }),
    ]);
    await new MessageReceipts(directory).send(input);
    expect(sends).toBe(1);
    expect(recoveries).toBe(1);
  },
);

test.skipIf(process.platform === "win32")(
  "a failed recovery commit retains the original pending receipt",
  async () => {
    const { requests, directory } = await fixture();
    let sends = 0;
    const input = {
      agentId: "agent",
      messageId: "accepted",
      durable: true,
      request: { text: "saved" },
      send: async () => {
        sends++;
        throw new Error("lost acknowledgement");
      },
    };
    await expect(requests.send(input)).rejects.toThrow("lost acknowledgement");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const file = path.join(directory, files[0]!);
    const before = await readFile(file, "utf8");
    try {
      await expect(
        requests.send({
          ...input,
          recover: async () => {
            await chmod(directory, 0o500);
            return true;
          },
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(directory, 0o700);
    }
    expect(await readFile(file, "utf8")).toBe(before);
    await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
      "agent_request_outcome_unknown",
    );
    await new MessageReceipts(directory).send({ ...input, recover: async () => true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ...JSON.parse(before),
      state: "completed",
    });
    expect(sends).toBe(1);
  },
);

test("absent proof and failed recovery retain the uncertain send", async () => {
  const { requests, directory } = await fixture();
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "uncertain",
    request: {},
    send: async () => {
      sends++;
      throw new Error("lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("lost");
  await expect(requests.send({ ...input, recover: async () => false })).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  await expect(
    requests.send({
      ...input,
      recover: async () => {
        throw new Error("access lost");
      },
    }),
  ).rejects.toThrow("access lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(sends).toBe(1);
});
