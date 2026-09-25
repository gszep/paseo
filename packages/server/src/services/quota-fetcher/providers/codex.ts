import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  balanceToneFromRemaining,
  toneFromUsedPct,
  fetchProviderApi,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const CodexAuthSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .optional(),
});

const CodexWindowSchema = z.object({
  used_percent: ApiNumberSchema.optional(),
  reset_at: ApiNumberSchema.optional(),
});

const CodexUsageResponseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
      secondary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  code_review_rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: ApiNumberSchema.optional(),
    })
    .nullish(),
});

// OpenCode stores its ChatGPT OAuth login in the `credential` table of its SQLite
// database; the same subscription serves Paseo's OpenCode agents.
const OpenCodeCredentialSchema = z.object({
  type: z.literal("oauth"),
  access: z.string(),
  expires: ApiNumberSchema.optional(),
  metadata: z.object({ accountID: z.string().optional() }).optional(),
});

// @types/node@20 predates the node:sqlite typings; declare the slice we use.
interface OpenCodeStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface OpenCodeDatabase {
  prepare(sql: string): OpenCodeStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => OpenCodeDatabase;
}

type CodexWindow = z.infer<typeof CodexWindowSchema>;
type CodexUsageResponse = z.infer<typeof CodexUsageResponseSchema>;

interface CodexCredential {
  source: "codex-cli" | "opencode";
  accessToken: string;
  accountId?: string;
  expiresAt: number | null;
}

interface CodexQuotaProviderOptions {
  logger: Logger;
  codexHome?: string;
  opencodeDataDir?: string;
  fetch?: ProviderApiFetch;
}

function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function resolveOpenCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_DATA_HOME"];
  return join(xdg || join(homedir(), ".local", "share"), "opencode");
}

function codexWindow(
  window: CodexWindow | null | undefined,
): { usedPct: number; resetsAt: string | null } | null {
  if (!window) return null;
  return {
    usedPct: window.used_percent ?? 0,
    resetsAt: window.reset_at != null ? new Date(window.reset_at * 1000).toISOString() : null,
  };
}

export class CodexQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "codex";
  readonly displayName = "Codex";

  private readonly logger: Logger;
  private readonly codexHome: string;
  private readonly opencodeDataDir: string;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: CodexQuotaProviderOptions) {
    this.logger = options.logger;
    this.codexHome = options.codexHome || process.env["CODEX_HOME"] || join(homedir(), ".codex");
    this.opencodeDataDir = options.opencodeDataDir ?? resolveOpenCodeDataDir();
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const now = Date.now();
    const credentials = [
      ...(await this.readCodexAuth()),
      ...(await this.readOpenCodeCredentials()),
    ].filter((credential) => credential.expiresAt === null || credential.expiresAt > now);

    // Read-only on credentials; the Codex CLI and OpenCode own refresh. See docs/providers.md.
    for (const credential of credentials) {
      const resp = await this.callCodexApi(credential.accessToken, credential.accountId);
      if (resp === "NEEDS_AUTH") {
        this.logger.debug({ source: credential.source }, "Codex usage credential rejected");
        continue;
      }
      return this.toUsage(resp);
    }
    return unavailableUsage(this);
  }

  private toUsage(resp: CodexUsageResponse): ProviderUsage {
    const session = codexWindow(resp.rate_limit?.primary_window);
    const weekly = codexWindow(resp.rate_limit?.secondary_window);
    const codeReview = codexWindow(resp.code_review_rate_limit?.primary_window);
    const windows: ProviderUsageWindow[] = [];

    if (session) {
      windows.push(
        windowFromUsedPct({
          id: "session",
          label: "Session",
          utilizationPct: session.usedPct,
          resetsAt: session.resetsAt,
          tone: toneFromUsedPct(session.usedPct),
        }),
      );
    }
    if (weekly) {
      windows.push(
        windowFromUsedPct({
          id: "weekly",
          label: "Weekly",
          utilizationPct: weekly.usedPct,
          resetsAt: weekly.resetsAt,
          tone: toneFromUsedPct(weekly.usedPct),
        }),
      );
    }
    if (codeReview) {
      windows.push(
        windowFromUsedPct({
          id: "code_review",
          label: "Code review",
          utilizationPct: codeReview.usedPct,
          resetsAt: codeReview.resetsAt,
          tone: toneFromUsedPct(codeReview.usedPct),
        }),
      );
    }

    const balances: ProviderUsageBalance[] = [];
    if (resp.credits?.balance !== undefined) {
      balances.push({
        id: "credits",
        label: "Credits",
        remaining: resp.credits.balance,
        unit: "usd",
        tone: balanceToneFromRemaining(resp.credits.balance),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: resp.plan_type ?? null,
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  private async readCodexAuth(): Promise<CodexCredential[]> {
    const candidates = [
      ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
      join(homedir(), ".config", "codex", "auth.json"),
      join(this.codexHome, "auth.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const auth = CodexAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
        const accessToken = auth.tokens?.access_token;
        if (!accessToken) continue;
        return [
          {
            source: "codex-cli",
            accessToken,
            accountId: auth.tokens?.account_id,
            expiresAt: jwtExpiry(accessToken),
          },
        ];
      } catch {
        continue;
      }
    }
    return [];
  }

  private async readOpenCodeCredentials(): Promise<CodexCredential[]> {
    const path = join(this.opencodeDataDir, "opencode.db");
    if (!existsSync(path)) return [];
    // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
    // node:sqlite typings yet, while the runtime (Node 22+) provides it.
    const sqliteSpecifier: string = "node:sqlite";
    let sqlite: NodeSqliteModule;
    try {
      sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
    } catch (err) {
      this.logger.debug({ err }, "node:sqlite unavailable; cannot read OpenCode credentials");
      return [];
    }
    let db: OpenCodeDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true });
      const rows = db
        .prepare(
          "SELECT value FROM credential WHERE integration_id = 'openai' ORDER BY time_updated DESC",
        )
        .all();
      const credentials: CodexCredential[] = [];
      for (const row of rows) {
        if (typeof row["value"] !== "string") continue;
        const parsed = OpenCodeCredentialSchema.safeParse(JSON.parse(row["value"]));
        if (!parsed.success) continue;
        credentials.push({
          source: "opencode",
          accessToken: parsed.data.access,
          accountId: parsed.data.metadata?.accountID,
          expiresAt: parsed.data.expires ?? jwtExpiry(parsed.data.access),
        });
      }
      return credentials;
    } catch (err) {
      // Locked/permission/schema failures land here; log so an unavailable
      // Codex card stays diagnosable.
      this.logger.debug({ err, path }, "Failed to read OpenCode credentials");
      return [];
    } finally {
      db?.close();
    }
  }

  private async callCodexApi(
    token: string,
    accountId?: string,
  ): Promise<CodexUsageResponse | "NEEDS_AUTH"> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers,
      },
    );
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex usage API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexUsageResponseSchema.parse(JSON.parse(text));
  }
}
