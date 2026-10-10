import { expect, test } from "vitest";
import { confirmsNativeSubmission } from "./native.js";

const message = {
  id: "msg_native",
  type: "user",
  text: "@reader check",
  metadata: { paseoClientMessageId: "saved-send" },
};
const native = {
  info: { id: "ses_original", location: { directory: "/fixture" } },
  messages: [message],
};
const input = {
  native,
  sessionId: "ses_original",
  cwd: "/fixture",
  messageId: "saved-send",
  text: "@reader check",
};

test("only the exact persisted native user message confirms a saved send", () => {
  expect(confirmsNativeSubmission(input)).toBe(true);
  expect(confirmsNativeSubmission({ ...input, native: { data: native } })).toBe(true);
  for (const override of [
    { sessionId: "ses_other" },
    { cwd: "/other" },
    { messageId: "another-send" },
    { text: "different" },
    { native: { ...native, messages: [] } },
    { native: { ...native, data: { ...native, messages: [] } } },
    { native: { data: null } },
    { native: { ...native, messages: [message, message] } },
    { native: { ...native, messages: [{ ...message, type: "assistant" }] } },
    { native: { ...native, messages: [{ ...message, metadata: {} }] } },
    { native: { ...native, messages: [{ ...message, id: "" }] } },
    { native: { ...native, messages: [message, { ...message, text: "conflicting" }] } },
  ])
    expect(confirmsNativeSubmission({ ...input, ...override })).toBe(false);
});
