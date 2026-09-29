import { parseGitHubRemote } from "@henkaku-center/chi-native/repository";
import type { ChiAudience, ChiMappingConfig, MutableChiConfig } from "@getpaseo/protocol/messages";

export interface ChiDestinationsConfig {
  destinations: Record<string, { name: string; endpoint: string }>;
  mappings: ChiMappingConfig[];
}

export interface ResolvedChiDestination {
  /** Normalized `github:owner/repo`. */
  repo: string;
  destinationId: string;
  name: string;
  endpoint: string;
  audience: ChiAudience;
}

/**
 * A chi section with neither destinations nor mappings means "local everywhere":
 * the daemon keeps its legacy single-deployment behavior and no workspace is
 * retargeted. Only a populated section turns mapping resolution on.
 */
export function parseChiDestinations(
  config: MutableChiConfig | undefined,
): ChiDestinationsConfig | null {
  if (!config) return null;
  const destinations = config.destinations ?? {};
  const mappings = config.mappings ?? [];
  if (Object.keys(destinations).length === 0 && mappings.length === 0) return null;
  return { destinations, mappings };
}

function matchMapping(
  mappings: readonly ChiMappingConfig[],
  repo: string,
): ChiMappingConfig | null {
  const normalized = repo.toLowerCase();
  let wildcard: ChiMappingConfig | null = null;
  for (const mapping of mappings) {
    const candidate = mapping.repo.trim().toLowerCase();
    if (candidate === normalized) return mapping;
    const separator = candidate.lastIndexOf("/");
    if (separator === -1 || candidate.slice(separator + 1) !== "*") continue;
    if (normalized.startsWith(candidate.slice(0, separator + 1))) wildcard ??= mapping;
  }
  return wildcard;
}

/** Resolve a normalized `github:owner/repo` against exact then owner-wildcard mappings. */
export function resolveChiDestinationForRepo(
  config: ChiDestinationsConfig | null,
  repo: string,
): ResolvedChiDestination | null {
  if (!config) return null;
  const normalized = repo.toLowerCase();
  const mapping = matchMapping(config.mappings, normalized);
  if (!mapping) return null;
  const destination = config.destinations[mapping.destination];
  if (!destination) return null;
  return {
    repo: normalized,
    destinationId: mapping.destination,
    name: destination.name,
    endpoint: destination.endpoint,
    audience: mapping.audience ?? "private",
  };
}

/** Resolve a raw git `origin` URL; non-GitHub and unmatched remotes are local. */
export function resolveChiDestination(
  config: ChiDestinationsConfig | null,
  originUrl: string,
): ResolvedChiDestination | null {
  const parsed = parseGitHubRemote(originUrl);
  if (!parsed) return null;
  return resolveChiDestinationForRepo(config, `github:${parsed.owner}/${parsed.repo}`);
}

/** The configured destination whose endpoint equals `endpoint`, if any. */
export function destinationForEndpoint(
  config: ChiDestinationsConfig | null,
  endpoint: string,
): { id: string; name: string; endpoint: string } | null {
  if (!config) return null;
  for (const [id, destination] of Object.entries(config.destinations)) {
    if (destination.endpoint === endpoint) return { id, ...destination };
  }
  return null;
}
