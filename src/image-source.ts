import { fileURLToPath } from "node:url";

/**
 * Where an image reference points. `view_image` accepts either a remote image
 * URL or a local file path, and the permission layer has to know which one it
 * is: a remote target is scoped by hostname, a local one by path, and scoping
 * one as the other mis-grants (a hostname pattern never matches a path, and a
 * path pattern never matches a hostname).
 *
 * This is a deterministic function of the string (essentially its URL scheme),
 * deliberately shared by the tool handler and PermissionEngine so the two can
 * never disagree about what a given call will do — a disagreement would mean
 * approving one action and performing a different one. Neither tools/ nor
 * permissions/ imports the other, so this lives in a neutral leaf module.
 */
export type ImageSource =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string }
  | { kind: "http" }
  | { kind: "unsupported"; scheme: string };

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function classifyImageSource(value: string): ImageSource {
  const raw = value.trim();
  const match = SCHEME_RE.exec(raw);

  if (match) {
    const scheme = match[1].toLowerCase();
    if (scheme === "https") return { kind: "remote", url: raw };
    if (scheme === "http") return { kind: "http" };
    if (scheme === "file") {
      try {
        return { kind: "local", path: fileURLToPath(raw) };
      } catch {
        // A malformed file: URL (bad percent-encoding, a host we can't map)
        // is not silently reinterpreted as a relative path.
        return { kind: "unsupported", scheme };
      }
    }
    // A single-letter scheme is a Windows drive path ("C:\dir\img.png"), not a
    // URL scheme. Everything else with a scheme (data:, ftp:, javascript:, …)
    // is something this tool cannot view.
    if (match[1].length > 1) return { kind: "unsupported", scheme };
  }

  return { kind: "local", path: raw };
}
