import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChiMentionOperationSchema,
  type ChiEntryRef,
  type ChiHandoff,
} from "@getpaseo/protocol/chi-mentions";
import { ReadOnlyStreamView } from "@/agent-stream/read-only-view";
import { MenuHeader } from "@/components/headers/menu-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { inboxDetailQueryOptions } from "./inbox-query";
import { inboxWorkspaceName, repositoryLabel } from "./inbox-model";
import { useInboxReader, type InboxContext } from "./use-inbox";
import { useViewedHandoff } from "./use-viewed-handoff";
import { usePinnedConversation } from "./use-pinned-conversation";
import { conversationKey, conversationReference } from "./pinned-conversation";
import { mentionError } from "./mention-errors";

export interface ChiConversationScreenProps {
  repo: string;
  handoffId: string;
  sourceIndex: number;
}

export function ChiConversationScreen(props: ChiConversationScreenProps) {
  const { host, scope, state, context, verifying, transportError } = useInboxReader();
  const supported = useSessionStore(
    (store) => store.sessions[host]?.serverInfo?.features?.chiPinnedTimeline === true,
  );
  const verify = useCallback(() => void scope.acquire().catch(() => undefined), [scope]);
  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/chi", params: { view: "inbox" } });
  }, []);
  const valid = ChiMentionOperationSchema.safeParse({
    action: "context",
    repo: props.repo,
    id: props.handoffId,
    index: props.sourceIndex,
  }).success;
  let content: ReactNode;
  if (!valid) {
    content = (
      <Alert
        variant="error"
        title="Conversation unavailable"
        description="This mention link is invalid."
      />
    );
  } else if (!host) {
    content = (
      <Text style={styles.hint}>
        {verifying
          ? "Verifying your Chi inbox account…"
          : transportError || "Connect a host signed in to your Chi account."}
      </Text>
    );
  } else if (!supported) {
    content = (
      <Alert
        variant="info"
        title="Update this host"
        description="This host does not support reading a pinned shared conversation. No local session will be opened instead."
      />
    );
  } else if (state.error && !state.loading) {
    content = (
      <Alert
        variant="error"
        title="Conversation unavailable"
        description={conversationReadError(state.error)}
      >
        <Button onPress={verify}>Verify mention context</Button>
      </Alert>
    );
  } else if (!context || state.loading) {
    content = <Text style={styles.hint}>Verifying shared access…</Text>;
  } else {
    content = (
      <AuthorizedConversation
        key={`${host}/${state.generation}/${props.repo}/${props.handoffId}/${props.sourceIndex}`}
        {...props}
        context={context}
      />
    );
  }
  return (
    <View style={styles.screen}>
      <MenuHeader title="Shared conversation" />
      <View style={styles.header}>
        <Button size="sm" variant="ghost" onPress={back}>
          Back to mentions
        </Button>
      </View>
      {content}
    </View>
  );
}

function AuthorizedConversation({
  context,
  repo,
  handoffId,
  sourceIndex,
}: ChiConversationScreenProps & { context: InboxContext }) {
  const cache = useQueryClient();
  const options = inboxDetailQueryOptions({
    queryKey: context.queryKey,
    repo,
    id: handoffId,
    run: context.execute,
  });
  const query = useFetchQuery({
    ...options,
    queryFn: async () => {
      try {
        const handoff = await options.queryFn();
        if (!context.isCurrent() || handoff.id !== handoffId || handoff.repo !== repo)
          throw new Error("chi-mention-context-changed");
        return handoff;
      } catch (error) {
        const protectedPages = [...context.queryKey, "conversation", repo, handoffId];
        void cache.cancelQueries({ queryKey: protectedPages }, { revert: false });
        cache.removeQueries({ queryKey: protectedPages });
        cache
          .getQueryCache()
          .find({ queryKey: options.queryKey, exact: true })
          ?.setState({ data: undefined });
        throw error;
      }
    },
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (query.isError) return <ReadError error={query.error} retry={retry} />;
  if (!query.data) return <Text style={styles.hint}>Loading the referenced conversation…</Text>;
  return <ConversationSource context={context} handoff={query.data} index={sourceIndex} />;
}

function ConversationSource({
  context,
  handoff,
  index,
}: {
  context: InboxContext;
  handoff: ChiHandoff;
  index: number;
}) {
  const viewed = useViewedHandoff(context, handoff);
  const selection = useMemo(() => {
    try {
      return { ref: conversationReference(handoff, index), error: null };
    } catch (error) {
      return { ref: null, error };
    }
  }, [handoff, index]);
  if (!selection.ref)
    return (
      <Alert
        variant="error"
        title="Conversation unavailable"
        description={conversationReadError(selection.error)}
      />
    );
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{inboxWorkspaceName(handoff)}</Text>
        <Text style={styles.hint}>
          Mention from @{handoff.author.slice(7)} · {repositoryLabel(handoff.repo)}
        </Text>
        <Text selectable style={styles.hint} testID="shared-conversation-pin">
          Read-only shared snapshot · {selection.ref.pin.count} entries ·{" "}
          {selection.ref.pin.head.slice(0, 12)}
        </Text>
        <Text style={styles.hint}>
          Minimised history. Later pages stay within this snapshot; new session activity is not
          loaded automatically.
        </Text>
        {viewed.isError ? (
          <Alert
            variant="info"
            title="Read status not saved"
            description={mentionError(viewed.error)}
          >
            <Button onPress={viewed.retry}>Retry read status</Button>
          </Alert>
        ) : null}
      </View>
      <ConversationWindow
        key={conversationKey(selection.ref)}
        context={context}
        handoffId={handoff.id}
        index={index}
        reference={selection.ref}
      />
    </View>
  );
}

function ConversationWindow({
  context,
  handoffId,
  index,
  reference,
}: {
  context: InboxContext;
  handoffId: string;
  index: number;
  reference: ChiEntryRef;
}) {
  const query = usePinnedConversation(context, handoffId, index, reference);
  const historyPagination = useMemo(
    () => ({
      hasOlder: query.hasPreviousPage,
      isLoadingOlder: query.isFetchingPreviousPage,
      progressKey: String(query.data?.pages[0]?.entries[0]?.seq ?? "initial"),
      onLoadOlder: query.loadOlder,
    }),
    [query.hasPreviousPage, query.isFetchingPreviousPage, query.data, query.loadOlder],
  );
  const newerPagination = useMemo(
    () => ({
      hasNewer: query.hasNextPage,
      isLoadingNewer: query.isFetching,
      onLoadNewer: query.loadNewer,
    }),
    [query.hasNextPage, query.isFetching, query.loadNewer],
  );
  if (query.isError) return <ReadError error={query.error} retry={query.retry} />;
  if (!query.data) return <Text style={styles.hint}>Loading conversation near this mention…</Text>;
  const targetLoaded = query.data.pages.some((page) =>
    page.entries.some((entry) => entry.seq === reference.seq),
  );
  if (targetLoaded && !query.targetItemId)
    return <ReadError error={new Error("chi-mention-unrenderable-entry")} retry={query.retry} />;
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Button size="sm" variant="ghost" onPress={query.retry}>
          Jump to mention
        </Button>
      </View>
      <ReadOnlyStreamView
        historyId={query.historyId}
        streamItems={query.items}
        targetItemId={query.targetItemId}
        historyPagination={historyPagination}
        newerPagination={newerPagination}
      />
    </View>
  );
}

function ReadError({ error, retry }: { error: unknown; retry(): void }) {
  return (
    <Alert
      variant="error"
      title="Conversation unavailable"
      description={conversationReadError(error)}
    >
      <Button onPress={retry}>Retry conversation</Button>
    </Alert>
  );
}

function conversationReadError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "chi-mentions-http-503" || code === "chi-operation-timeout")
    return "Chi is temporarily unavailable. Retry loading this snapshot.";
  if (code === "chi-mention-native-source-required" || code === "chi-mention-unrenderable-entry")
    return "This referenced entry cannot be displayed as a shared conversation. No local history was substituted.";
  return mentionError(error);
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minHeight: 0 },
  header: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
