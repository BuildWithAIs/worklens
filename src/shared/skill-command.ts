// An explicit skill call, `/skill:name` optionally followed by the message.
// The main process runs it and the chat shows it with the same rule.
export function parseSkillCommand(text: string) {
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  return match ? { name: match[1], message: match[2] ?? "" } : undefined;
}
