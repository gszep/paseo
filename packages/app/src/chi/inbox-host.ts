export function selectInboxHost(
  hosts: readonly string[],
  preferred: string | undefined,
  connected: ReadonlyMap<string, string>,
  capable: readonly string[],
) {
  const eligible = hosts.filter((id) => connected.get(id) === "online" && capable.includes(id));
  return eligible.find((id) => id === preferred) ?? eligible[0] ?? "";
}
