export const HANDOFF_ACKNOWLEDGEMENT_TEXT = "已轉交人工客服，請稍候。";

export function buildHandoffAcknowledgementBody(recipient) {
  return JSON.stringify({
    to: recipient,
    messages: [{ type: "text", text: HANDOFF_ACKNOWLEDGEMENT_TEXT }],
  });
}
