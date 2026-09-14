import type { ToolDef } from "../types.js";

/**
 * Apply the CLI `--allowed-tools` / `--disallowed-tools` filters to a tool set
 * (cli-spec.md §5, flag parity). `allowed` is an allowlist — when non-empty,
 * everything not named is dropped. `disallowed` is a denylist applied on top.
 * An empty list means "no restriction". This is a pure availability filter: it
 * removes tools from what the model is offered, so a disallowed tool is never
 * callable (strictly stronger than a permission deny that still lets the model
 * call and receive PERMISSION_DENIED).
 */
export function filterToolDefs(
  defs: ToolDef[],
  allowed: string[] | undefined,
  disallowed: string[] | undefined,
): ToolDef[] {
  let out = defs;
  if (allowed && allowed.length > 0) {
    const allowedSet = new Set(allowed);
    out = out.filter((d) => allowedSet.has(d.name));
  }
  if (disallowed && disallowed.length > 0) {
    const disallowedSet = new Set(disallowed);
    out = out.filter((d) => !disallowedSet.has(d.name));
  }
  return out;
}
