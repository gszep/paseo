import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ChiEntryRef, CoDriveView } from "@getpaseo/protocol/chi-mentions";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { InboxContext } from "./use-inbox";
import { useCoDrive } from "./use-co-drive";

type Controls = ReturnType<typeof useCoDrive> & {
  view: CoDriveView;
  current: boolean;
  size: "sm" | "md";
};

function OwnerControls({ model, state, view, current, size }: Controls) {
  const control = view.control;
  const stale =
    state.pending?.action === "grant" &&
    ((control?.generation ?? 0) > state.pending.generation ||
      view.pin.count > state.pending.expectedPin.count);
  return (
    <>
      <Text>
        Grant this session’s plain-text sends under its existing context and tool policy. No
        host-management or workspace-management token is shared.
      </Text>
      {view.canGrantHere ? (
        <Field label="Recipient GitHub handle">
          <FormTextInput
            size={size}
            initialValue={state.recipient}
            onChangeText={model.setRecipient}
            accessibilityLabel="Co-drive recipient"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!state.pending}
          />
        </Field>
      ) : (
        <Text>
          The original executor must be open and idle on this host before granting control.
        </Text>
      )}
      <Button
        disabled={
          !view.canGrantHere || !current || Boolean(state.pending) || !state.recipient.trim()
        }
        onPress={model.grant}
      >
        Grant session send access
      </Button>
      {control?.active ? <Button onPress={model.revoke}>Revoke session control</Button> : null}
      {stale ? (
        <Button onPress={model.clearStaleGrant}>Clear stale request; keep current grant</Button>
      ) : null}
      <Text>Revocation blocks new admissions. Already-admitted work may still finish.</Text>
    </>
  );
}

function RecipientControls({ model, state, view, current, size }: Controls) {
  const digest = view.control?.contextDigest ?? "";
  const send = useCallback(() => model.send(digest), [model, digest]);
  return (
    <>
      <Text>
        {view.ready
          ? "Original executor is ready."
          : "Original executor is unavailable or busy. Work will not move to this host."}
      </Text>
      {!current ? <Text>View the current shared tail before sending.</Text> : null}
      <Field label="Message to the shared session">
        <FormTextInput
          key={state.draft}
          size={size}
          initialValue={state.text}
          onChangeText={model.setText}
          accessibilityLabel="Shared session message"
          multiline
          editable={!state.pending && state.phase !== "blocked"}
        />
      </Field>
      <Button
        disabled={!view.ready || !current || Boolean(state.pending) || !state.text.trim()}
        onPress={send}
      >
        Send to shared session
      </Button>
    </>
  );
}

function OperationStatus({ model, state, view }: Pick<Controls, "model" | "state" | "view">) {
  return (
    <>
      {view.operation ? (
        <Text testID="co-drive-operation">
          {view.operation.actor}:{" "}
          {view.operation.phase === "admitted"
            ? "Admitted; awaiting canonical recording. This is not a completion claim."
            : view.operation.phase}
        </Text>
      ) : null}
      {state.pending?.action === "submit" && view.operation?.phase === "queued" ? (
        <Button onPress={model.cancel}>Cancel queued send</Button>
      ) : null}
      {state.error ? <Text accessibilityRole="alert">{state.error}</Text> : null}
    </>
  );
}

export function CoDrivePanel(props: {
  context: InboxContext;
  source: ChiEntryRef;
  pin: ChiEntryRef["pin"];
}) {
  const { model, state } = useCoDrive(props);
  const compact = useIsCompactFormFactor(),
    size = compact ? "md" : "sm";
  const view = state.view;
  if (state.phase === "loading") return <Text>Checking session control…</Text>;
  if (!view)
    return (
      <View>
        <Text accessibilityRole="alert">{state.error ?? "Session control unavailable."}</Text>
        <Button onPress={model.retry}>Retry saved control operation</Button>
      </View>
    );
  const control = view.control;
  const owner = view.ownerId === props.context.identity.actor;
  const current = view.pin.head === props.pin.head && view.pin.count === props.pin.count;
  const eligible = control?.active && control.recipient === props.context.identity.actor;
  return (
    <View style={styles.panel}>
      {control ? (
        <Text testID="co-drive-execution-context">
          Runs on {control.executor.host} · {control.executor.modelProvider}/
          {control.executor.modelId}
          {control.executor.modelVariant ? ` (${control.executor.modelVariant})` : ""}. Execution
          account: configured on the owner host, not your account; its identity is not exposed by
          the runtime. The original session context and owner tool policy apply. Tool approvals stay
          with the owner.
        </Text>
      ) : null}
      {owner && (
        <OwnerControls model={model} state={state} view={view} current={current} size={size} />
      )}
      {!owner && eligible && (
        <RecipientControls model={model} state={state} view={view} current={current} size={size} />
      )}
      {!owner && !eligible && (
        <Text>No active session-control grant. Read access does not authorize sending.</Text>
      )}
      <OperationStatus model={model} state={state} view={view} />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  panel: { padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
}));
