import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtSign } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { InboxCoverageNotice } from "./inbox-coverage";
import { useInboxQuery } from "./inbox-query";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const noop = () => {};
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return { root, container };
}
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

test("incomplete coverage is visible and an incomplete zero unread count is not hidden", () => {
  const notice = mount(<InboxCoverageNotice unavailableRepos={["github:fixture/broken"]} />);
  expect(notice.container.textContent).toContain(
    "Some repositories unavailable — inbox incomplete",
  );
  expect(notice.container.textContent).toContain("Unread count is incomplete");
  for (const count of [0, 3]) {
    const { container } = mount(
      <SidebarHeaderRow
        icon={AtSign}
        label="Mentions"
        onPress={noop}
        badge={count}
        badgeIncomplete
      />,
    );
    expect(container.textContent).toContain(`${count}+`);
    expect(
      container.querySelector(`[aria-label="${count} unread mentions, count incomplete"]`),
    ).not.toBeNull();
  }
  act(() => notice.root.render(<InboxCoverageNotice unavailableRepos={[]} />));
  expect(notice.container.textContent).toBe("");
  expect(mount(<InboxCoverageNotice />).container.textContent).toBe("");
  const complete = mount(
    <SidebarHeaderRow icon={AtSign} label="Mentions" onPress={noop} badge={3} />,
  );
  expect(complete.container.textContent).not.toContain("+");
  expect(complete.container.querySelector('[aria-label="3 unread mentions"]')).not.toBeNull();
});

test("invalid availability cursor discards old pages and automatically restarts from page one", async () => {
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    repo: "*",
    generation: "a".repeat(64),
  };
  let recovered = false;
  const calls: Array<string | undefined> = [];
  let query!: ReturnType<typeof useInboxQuery>;
  function Probe() {
    query = useInboxQuery({
      queryKey: ["coverage-test"],
      inbox: true,
      enabled: true,
      context,
      run: async (operation) => {
        if (operation.action !== "inbox") throw new Error("unexpected operation");
        calls.push(operation.cursor);
        if (operation.cursor) throw new Error("chi-inbox-invalid-cursor");
        return {
          kind: "inbox",
          actor: context.actor,
          context,
          handoffs: [],
          nextCursor: recovered ? null : "old",
          unreadCount: recovered ? 120 : 60,
          ...(recovered ? {} : { unavailableRepos: ["github:o/b"] }),
        };
      },
    });
    return (
      <InboxCoverageNotice
        unavailableRepos={query.isError ? undefined : query.data?.pages[0]?.unavailableRepos}
      />
    );
  }
  const view = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(query.data?.pages[0]?.unreadCount).toBe(60));
    recovered = true;
    await act(async () => {
      await query.fetchNextPage();
    });
    await vi.waitFor(() => expect(query.data?.pages[0]?.unreadCount).toBe(120));
    expect(calls).toEqual([undefined, "old", undefined]);
    expect(query.data?.pages).toHaveLength(1);
    expect(query.data?.pageParams).toEqual([undefined]);
    expect(query.isError).toBe(false);
    expect(view.container.textContent).toBe("");
  } finally {
    cache.clear();
  }
});
