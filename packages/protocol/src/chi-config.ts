import { z } from "zod";

/**
 * Chi destination configuration lives in its own module so daemon
 * configuration can parse it without loading the WebSocket wire schemas
 * (`messages.ts`). `messages.ts` re-exports these for protocol consumers.
 */

/** Who may read an uploaded source. Today's backend accepts exactly these two. */
export const ChiAudienceSchema = z.enum(["private", "shared"]);
export type ChiAudience = z.infer<typeof ChiAudienceSchema>;

/** A configured deployment peers with the default Henkaku deployment. */
export const ChiDestinationConfigSchema = z
  .object({
    name: z.string().min(1),
    endpoint: z.string().min(1),
  })
  .strict();
export type ChiDestinationConfig = z.infer<typeof ChiDestinationConfigSchema>;

export const ChiMappingConfigSchema = z
  .object({
    // `github:owner/repo` exact or an owner wildcard `github:owner/*`; exact wins.
    repo: z.string().min(1),
    destination: z.string().min(1),
    // Unspecified means owner-private.
    audience: ChiAudienceSchema.optional(),
  })
  .strict();
export type ChiMappingConfig = z.infer<typeof ChiMappingConfigSchema>;

export const MutableChiConfigSchema = z
  .object({
    destinations: z.record(z.string(), ChiDestinationConfigSchema).default({}),
    mappings: z.array(ChiMappingConfigSchema).default([]),
  })
  .strict();
export type MutableChiConfig = z.infer<typeof MutableChiConfigSchema>;
