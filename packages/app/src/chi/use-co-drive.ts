import { useEffect, useState, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChiEntryRef } from "@getpaseo/protocol/chi-mentions";
import type { InboxContext } from "./use-inbox";
import { openCoDrive } from "./co-drive-model";

export function useCoDrive(input: {
  context: InboxContext;
  source: ChiEntryRef;
  pin: ChiEntryRef["pin"];
}) {
  const [model] = useState(() =>
    openCoDrive({
      context: input.context.identity,
      source: input.source,
      pin: input.pin,
      storage: AsyncStorage,
      isCurrent: input.context.isCurrent,
      execute: input.context.execute,
      uuid: () => crypto.randomUUID(),
    }),
  );
  useEffect(() => {
    model.start();
    return () => model.close();
  }, [model]);
  useEffect(() => model.selectPin(input.pin), [model, input.pin]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}
