/** Digits in a branch name that look like an Azure work item id (e.g. 12345-fix, feature/AB#12345). */
export function workItemFromBranch(branch?: string): number | undefined {
  if (!branch) return undefined;
  // No leading zeros: avoids false hits on chat/team-0001 style slugs.
  const match = branch.match(/(?:^|[/_-])(?:AB#)?([1-9]\d{3,6})(?:[-_]|$)/i) ?? branch.match(/#([1-9]\d{3,6})\b/);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
