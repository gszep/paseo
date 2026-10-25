import { Command } from "commander";
import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { speechCredentialStatus } from "./credentials.js";

export function createSpeechCommand(): Command {
  const speech = new Command("speech").description("Speech commands");
  const credentials = speech
    .command("credentials")
    .description("Private speech credential checks; no daemon or provider changes");
  for (const operation of ["status", "verify"] as const) {
    addLocalDaemonOptions(credentials.command(operation))
      .requiredOption("--provider <provider>", "Speech credential provider (deepgram)")
      .option("--stdin", "Read a private prospective key from stdin without saving")
      .option("--secret", "Read a prospective key in a masked local prompt without saving")
      .action(
        withOutput(async (options: CommandOptions, _command: Command) => {
          if (options.provider !== "deepgram")
            throw new Error("Supported credential provider: deepgram");
          return speechCredentialStatus(options, operation === "verify");
        }),
      );
  }
  return speech;
}
