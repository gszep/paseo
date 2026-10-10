import { z } from "zod";

const nativeSchema = z
  .object({
    info: z.object({ id: z.string(), location: z.object({ directory: z.string() }) }),
    messages: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
const userSchema = z.object({
  id: z.string().min(1),
  type: z.literal("user"),
  text: z.string(),
  metadata: z.object({ paseoClientMessageId: z.string() }),
});
interface NativeSubmission {
  native: unknown;
  sessionId: string;
  cwd: string;
  messageId: string;
  text: string;
}

/** Only persisted provider metadata proves admission; timeline echoes do not. */
export function confirmsNativeSubmission(input: NativeSubmission): boolean {
  const wrapped = z.object({ data: nativeSchema }).strict().safeParse(input.native);
  const parsed = nativeSchema.safeParse(wrapped.success ? wrapped.data.data : input.native);
  if (!parsed.success) return false;
  const native = parsed.data;
  if (native.info.id !== input.sessionId || native.info.location.directory !== input.cwd)
    return false;
  const matches = native.messages.filter((message) => {
    const metadata = z.object({ paseoClientMessageId: z.string() }).safeParse(message.metadata);
    return metadata.success && metadata.data.paseoClientMessageId === input.messageId;
  });
  if (matches.length !== 1) return false;
  const user = userSchema.safeParse(matches[0]);
  return user.success && user.data.text === input.text;
}
