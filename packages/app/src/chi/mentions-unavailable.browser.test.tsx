import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

import {
  MENTIONS_UNAVAILABLE_COPY,
  MentionsUnavailableHint,
  mentionsUnavailable,
} from "./mentions-unavailable";

const destination = {
  id: "peer",
  name: "Peer",
  endpoint: "https://peer.invalid",
  audience: "shared" as const,
};

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("MentionsUnavailableHint", () => {
  it("shows the hint for a mapped peer destination", () => {
    const container = mount(
      <MentionsUnavailableHint destination={destination} mentionsAvailable={false} />,
    );
    expect(container.textContent).toContain(MENTIONS_UNAVAILABLE_COPY);
  });

  it("hides the hint for the primary destination, local, or while unknown", () => {
    expect(
      mount(<MentionsUnavailableHint destination={destination} mentionsAvailable />).textContent,
    ).toBe("");
    expect(
      mount(<MentionsUnavailableHint destination={null} mentionsAvailable={false} />).textContent,
    ).toBe("");
  });
});

describe("mentionsUnavailable", () => {
  it("gates mentions on a mapped destination with delivery available", () => {
    expect(mentionsUnavailable(null, false)).toBe(false);
    expect(mentionsUnavailable(destination, false)).toBe(true);
    expect(mentionsUnavailable(destination, true)).toBe(false);
  });
});
