/**
 * CI branch / ref → parked push ref (`refs/heads/…`).
 *
 * Lives in its own module so GitHub and GitLab parsers can import it without
 * a cycle through `git-provider.ts` (that file imports both providers).
 *
 * GitHub `head_branch` and GitLab `object_attributes.ref` are usually a
 * branch name (`main`); a parked push stores the full git ref.
 */
export function normalizeCheckRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.startsWith('refs/heads/')) return value
  if (value.startsWith('refs/')) return null
  return `refs/heads/${value}`
}
