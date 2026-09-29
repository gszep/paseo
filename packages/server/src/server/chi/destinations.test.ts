import { describe, expect, it } from "vitest";
import {
  parseChiDestinations,
  resolveChiDestination,
  resolveChiDestinationForRepo,
} from "./destinations.js";

const config = {
  destinations: {
    henkaku: { name: "Henkaku", endpoint: "https://chi-backend.invalid" },
    self: { name: "Self", endpoint: "https://self.invalid" },
  },
  mappings: [
    { repo: "github:henkaku-center/chi", destination: "henkaku", audience: "shared" as const },
    { repo: "github:henkaku-center/*", destination: "self" },
  ],
};

describe("chi destination config", () => {
  it("treats a missing or empty section as local everywhere", () => {
    expect(parseChiDestinations(undefined)).toBeNull();
    expect(parseChiDestinations({ destinations: {}, mappings: [] })).toBeNull();
  });

  it("parses a populated section", () => {
    expect(parseChiDestinations(config)).toEqual(config);
  });
});

describe("chi destination resolution", () => {
  it("normalizes SSH and HTTPS remotes", () => {
    const https = resolveChiDestination(config, "https://github.com/henkaku-center/chi.git");
    const ssh = resolveChiDestination(config, "git@github.com:henkaku-center/chi.git");
    expect(https).toEqual(ssh);
    expect(https).toMatchObject({ destinationId: "henkaku", audience: "shared" });
  });

  it("resolves a mixed-case origin to the lowercased mapping and records the rule", () => {
    const resolved = resolveChiDestination(config, "https://github.com/Henkaku-Center/Chi.git");
    expect(resolved).toMatchObject({
      repo: "github:henkaku-center/chi",
      destinationId: "henkaku",
      matchedRule: "github:henkaku-center/chi",
    });
  });

  it("prefers an exact mapping over the owner wildcard", () => {
    expect(resolveChiDestinationForRepo(config, "github:henkaku-center/chi")).toMatchObject({
      destinationId: "henkaku",
    });
    expect(resolveChiDestinationForRepo(config, "github:henkaku-center/other")).toMatchObject({
      destinationId: "self",
      audience: "private",
    });
  });

  it("defaults an unspecified audience to owner-private", () => {
    expect(resolveChiDestinationForRepo(config, "github:henkaku-center/other")?.audience).toBe(
      "private",
    );
  });

  it("returns local for non-GitHub, unmatched, and unknown destinations", () => {
    expect(resolveChiDestination(config, "https://gitlab.com/henkaku-center/chi.git")).toBeNull();
    expect(resolveChiDestination(config, "not a remote")).toBeNull();
    expect(resolveChiDestinationForRepo(config, "github:someone/else")).toBeNull();
    expect(
      resolveChiDestinationForRepo(
        { destinations: {}, mappings: [{ repo: "github:a/b", destination: "missing" }] },
        "github:a/b",
      ),
    ).toBeNull();
  });

  it("returns local when no section is configured", () => {
    expect(resolveChiDestination(null, "https://github.com/henkaku-center/chi.git")).toBeNull();
  });
});
