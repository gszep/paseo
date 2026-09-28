import { useCallback } from "react";
import { useHostMutations } from "@/runtime/host-runtime";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { normalizeHostPort } from "@/utils/daemon-endpoints";
import { connectToDaemon } from "@/utils/test-daemon-connection";

/** Both camera and pasted links probe before saving through the host runtime. */
export function usePairingOffer() {
  const { upsertConnectionFromOfferUrl } = useHostMutations();
  return useCallback(
    async (raw: string) => {
      const offer = parseConnectionOfferFromUrl(raw);
      if (!offer) throw new Error("Link must include a non-empty #offer= fragment");
      const { client, hostname } = await connectToDaemon(
        {
          id: "probe",
          type: "relay",
          relayEndpoint: normalizeHostPort(offer.relay.endpoint),
          useTls: offer.relay.useTls,
          daemonPublicKeyB64: offer.daemonPublicKeyB64,
        },
        { serverId: offer.serverId },
      );
      await client.close().catch(() => undefined);
      const profile = await upsertConnectionFromOfferUrl(raw, hostname ?? undefined);
      return { profile, serverId: offer.serverId, hostname };
    },
    [upsertConnectionFromOfferUrl],
  );
}
