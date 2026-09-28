import { createHash } from "node:crypto";
import type { AuthState } from "@henkaku-center/chi-native/auth";

interface Session {
  generation: string;
  expires: number;
  pending: Promise<AuthState & { credentialGeneration: string }>;
}

/** Read the host credential on every access; only the remote exchange is cached. */
export function createSessionLogin(
  readToken: () => string | null,
  exchange: (token: string) => Promise<AuthState>,
) {
  let current: Session | null = null;
  function invalidate() {
    current = null;
  }
  async function login() {
    const token = readToken();
    if (!token) {
      invalidate();
      throw new Error("chi-github-login-required");
    }
    const generation = createHash("sha256").update(token).digest("hex");
    if (current?.generation === generation && current.expires > Date.now()) return current.pending;
    const entry: Session = {
      generation,
      expires: Date.now() + 60_000,
      pending: Promise.resolve().then(async () => {
        try {
          const auth = await exchange(token);
          if (current !== entry || readToken() !== token)
            throw new Error("chi-mention-context-changed");
          return { ...auth, credentialGeneration: generation };
        } catch (error) {
          if (current === entry) invalidate();
          throw error;
        }
      }),
    };
    current = entry;
    return entry.pending;
  }
  return { login, invalidate };
}
