import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { Command } from "commander";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import {
  readPersistedConfig,
  getPersistedConfigValue,
  editPersistedConfig,
} from "@getpaseo/server/configuration";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { readPrivateInput } from "../../utils/private-input.js";

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /password|(?:api|private|access)[_-]?key|token|secret|authorization/i.test(key)
        ? "[redacted]"
        : redact(item),
    ]),
  );
}

function result(data: Record<string, unknown>) {
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "configuration",
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}

function homeOf(options: CommandOptions) {
  if (options.daemonTarget.kind !== "instance")
    throw new Error("Configuration edits require --home");
  return options.daemonTarget.home;
}

async function applySaved(home: string, options: CommandOptions) {
  const nextCommand = `paseo daemon start --home ${JSON.stringify(home)}`;
  const instance = await readDaemonInstance(home);
  if (!instance?.listen)
    return result({
      action: "saved",
      applied: false,
      message: "Saved; not applied to a running daemon",
      nextCommand,
    });
  let client;
  try {
    client = await connectToDaemon({ target: options.daemonTarget, timeout: 1_500 });
  } catch {
    return result({
      action: "saved",
      applied: false,
      message: "Saved; not applied to a running daemon",
      nextCommand: `paseo daemon reload --home ${JSON.stringify(home)}`,
    });
  }
  try {
    const reload = await client.reloadDaemonConfig();
    return result({ action: "saved", ...reload });
  } catch (error) {
    throw { code: "CONFIG_SAVED_RELOAD_FAILED", message: `Saved; reload failed: ${String(error)}` };
  } finally {
    await client.close();
  }
}

export function daemonConfigCommand(): Command {
  const config = new Command("config").description(
    "Read or edit persistent local configuration (local operation)",
  );
  addLocalDaemonOptions(config.command("get [path]")).action(
    withOutput(async (field: string | undefined, options: CommandOptions, _command: Command) => {
      const persisted = readPersistedConfig(homeOf(options));
      const value = field ? getPersistedConfigValue(persisted, field) : persisted;
      return result({
        source: "configured",
        path: field ?? null,
        set: value !== undefined,
        value:
          field && /password|(?:api|private|access)[_-]?key|token|secret|authorization/i.test(field)
            ? "[redacted]"
            : redact(value),
      });
    }),
  );
  addLocalDaemonOptions(config.command("set <path> [value]"))
    .option("--string", "Interpret value literally as a string")
    .option("--stdin", "Read the value privately from standard input, never argv")
    .option("--secret", "Read a string from a masked local terminal prompt")
    .option("--no-apply", "Save only; do not ask a running daemon to reload")
    .action(
      withOutput(
        async (
          field: string,
          raw: string | undefined,
          options: CommandOptions,
          _command: Command,
        ) => {
          const privateInput = Boolean(options.stdin || options.secret);
          if (privateInput && raw !== undefined)
            throw new Error("Do not combine a value argument with private input");
          if (privateInput)
            raw = await readPrivateInput({ stdin: options.stdin, secret: options.secret });
          if (raw === undefined) throw new Error("Provide a value, --stdin or --secret");
          let value: unknown = raw;
          if (!options.string && !options.secret) {
            try {
              value = JSON.parse(raw);
            } catch {
              /* Unquoted input is a string. */
            }
          }
          if (privateInput) {
            try {
              editPersistedConfig(homeOf(options), field, { value });
            } catch {
              throw new Error("Private configuration update failed; inspect configuration locally");
            }
          } else editPersistedConfig(homeOf(options), field, { value });
          if (options.apply === false)
            return result({
              action: "saved",
              applied: false,
              message: "Saved only; running daemon configuration was not changed",
            });
          return applySaved(homeOf(options), options);
        },
      ),
    );
  addLocalDaemonOptions(config.command("unset <path>")).action(
    withOutput(async (field: string, options: CommandOptions, _command: Command) => {
      editPersistedConfig(homeOf(options), field, { unset: true });
      return applySaved(homeOf(options), options);
    }),
  );
  return config;
}
