import { describe, expect, it } from "vitest";

import {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
} from "./connection-offer.js";

function encodeBase64UrlNoPadUtf8(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("connection offer", () => {
  it("decodes base64url JSON payloads", () => {
    const payload = {
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.paseo.sh:443" },
    };

    expect(decodeOfferFragmentPayload(encodeBase64UrlNoPadUtf8(JSON.stringify(payload)))).toEqual(
      payload,
    );
  });

  it.each(["https://app.paseo.sh/", "https://hosted.example.com/", ""])(
    "parses scanned or pasted offers independently of prefix %s",
    (prefix) => {
      const offer = ConnectionOfferSchema.parse({
        v: 2,
        serverId: "server-123",
        daemonPublicKeyB64: "pubkey",
        relay: { endpoint: "relay.paseo.sh:443" },
      });
      const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

      expect(parseConnectionOfferFromUrl(`  ${prefix}#offer=${encoded}\n`)).toEqual(offer);
    },
  );

  it.each(["", "https://example.com/", "#offer=", "#offer=   "])(
    "rejects scanned text without an offer: %s",
    (text) => {
      expect(parseConnectionOfferFromUrl(text)).toBeNull();
    },
  );

  it.each([
    "!bad-base64!",
    encodeBase64UrlNoPadUtf8("not json"),
    encodeBase64UrlNoPadUtf8(JSON.stringify({ v: 1 })),
  ])("rejects malformed scanned payloads: %s", (encoded) => {
    expect(() =>
      parseConnectionOfferFromUrl(`https://hosted.example.com/#offer=${encoded}`),
    ).toThrow();
  });

  it("leaves relay TLS unset when absent", () => {
    expect(
      ConnectionOfferSchema.parse({
        v: 2,
        serverId: "server-123",
        daemonPublicKeyB64: "pubkey",
        relay: { endpoint: "relay.example.com:80" },
      }),
    ).toEqual({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:80" },
    });
  });

  it("round-trips relay TLS in offers without rejecting extra relay fields", () => {
    const offer = ConnectionOfferSchema.parse({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:443", useTls: true, extra: "future" },
    });
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parseConnectionOfferFromUrl(`https://app.paseo.sh/#offer=${encoded}`)).toEqual({
      v: 2,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:443", useTls: true },
    });
  });

  it("returns null when the URL has no offer fragment", () => {
    expect(parseConnectionOfferFromUrl("https://app.paseo.sh/pair")).toBeNull();
  });
});
