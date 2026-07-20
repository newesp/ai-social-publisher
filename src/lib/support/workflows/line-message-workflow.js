// Task 5 shell: Task 7 adds durable message processing without changing this safe boundary.
export async function lineMessageWorkflow({ eventId, connectionId, conversationId }) {
  "use workflow";
  return { eventId, connectionId, conversationId };
}
