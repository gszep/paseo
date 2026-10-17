import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@/branding/brand", () => ({
  BRAND: {
    agentSetup: { label: "Agent setup guide", url: "https://chi.henkaku.center/AGENTS.md" },
    connect: { label: "Connect with GitHub", url: "https://chi.henkaku.center/connect/" },
  },
}));

import { CollaboratorOnboarding } from "./collaborator-onboarding";

it("points fresh hosts at the released installer guide while preserving the existing-install warning", () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<CollaboratorOnboarding />));
    expect(container.textContent).toContain("released installer, supported fresh-host setup");
    expect(container.textContent).toContain("Existing installations and history must be preserved");
    expect(container.textContent).toContain("permission before replacement");
    expect(container.textContent).not.toContain("installation is currently blocked");
    expect(container.querySelector('[data-testid="welcome-agent-setup"]')?.textContent).toBe(
      "Agent setup guide",
    );
    expect(container.querySelector('[data-testid="welcome-connect-github"]')?.textContent).toBe(
      "Connect with GitHub",
    );
    expect(container.textContent).toContain("https://chi.henkaku.center/AGENTS.md");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
