import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  realpathNearestAncestor,
  resolveWriteRoots,
  isPathWithinWriteRoots,
} from "./write-roots.js";

// The single shared write-set (docs/unified-write-boundary.md §1): the pure
// source of truth both the Seatbelt layer and the file-tool containment check
// (permissions/profile.ts) consult. These tests pin down the set's composition
// and the containment predicate independently of either consumer. The
// cross-layer agreement property itself (Seatbelt ⇔ file tool) is asserted in
// permissions/profile.test.ts, against the two layers' actual outputs.

describe("resolveWriteRoots", () => {
  it("strict-sandbox returns an empty write-set (read-only everywhere)", () => {
    expect(resolveWriteRoots("strict-sandbox", "/ws", ["/extra"])).toEqual([]);
  });

  it("workspace-write: trustedRoot first (realpath-resolved), then the carve-outs", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    try {
      const roots = resolveWriteRoots("workspace-write", root);
      // trustedRoot leads, resolved to its physical form (the shape the
      // kernel matches SBPL subpaths against).
      expect(roots[0]).toBe(realpathSync(root));
      // The battery-proven carve-outs (2026-08-15): literal /tmp, $TMPDIR,
      // ~/.npm — all realpath-resolved.
      expect(roots).toContain(realpathSync("/tmp"));
      expect(roots).toContain(realpathSync(tmpdir()));
      expect(roots).toContain(realpathNearestAncestor(join(homedir(), ".npm")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("workspace-write: appends configured writeRoots, realpath-resolved, after the carve-outs", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    const extra = mkdtempSync(join(tmpdir(), "wr-extra-"));
    try {
      const roots = resolveWriteRoots("workspace-write", root, [extra]);
      expect(roots[0]).toBe(realpathSync(root));
      expect(roots[roots.length - 1]).toBe(realpathSync(extra));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it("a symlinked writeRoot resolves to its target, not the link path", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    const target = mkdtempSync(join(tmpdir(), "wr-target-"));
    const link = join(root, "link");
    symlinkSync(target, link, "dir");
    try {
      const roots = resolveWriteRoots("workspace-write", root, [link]);
      expect(roots).toContain(realpathSync(target));
      expect(roots).not.toContain(link);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("deduplicates a writeRoot that coincides with the trusted root", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    try {
      const roots = resolveWriteRoots("workspace-write", root, [root]);
      expect(roots.filter((r) => r === realpathSync(root))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a configured writeRoot that does not exist yet still resolves (nearest ancestor)", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    const future = join(root, "not", "created", "yet");
    try {
      const roots = resolveWriteRoots("workspace-write", root, [future]);
      expect(roots).toContain(realpathNearestAncestor(future));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("realpathNearestAncestor", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(realpathNearestAncestor("~/nib-wr-probe")).toBe(
      realpathNearestAncestor(join(homedir(), "nib-wr-probe")),
    );
  });
});

describe("isPathWithinWriteRoots", () => {
  it("accepts the root itself and any descendant", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    try {
      const real = realpathSync(root);
      expect(isPathWithinWriteRoots(root, [real])).toBe(true);
      expect(isPathWithinWriteRoots(join(root, "a", "b.txt"), [real])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a target outside the roots", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    try {
      // A home-dir path (not ~/.npm) is outside the root; no need to create
      // it — containment resolves the nearest existing ancestor.
      const outside = join(homedir(), "wr-out-probe", "f.txt");
      expect(isPathWithinWriteRoots(outside, [realpathSync(root)])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is directory-boundary aware: /a does not match /a2", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-a-"));
    const sibling = `${root}2`;
    try {
      expect(isPathWithinWriteRoots(sibling, [realpathSync(root)])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink inside a root that escapes it (realpath containment)", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    const outside = mkdtempSync(join(tmpdir(), "wr-out-"));
    const link = join(root, "escape");
    symlinkSync(outside, link, "dir");
    try {
      // Roots here is the single trusted root, not the full set — the point is
      // that a symlink resolving outside that root is not mistaken for inside.
      expect(isPathWithinWriteRoots(link, [realpathSync(root)])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts a not-yet-existing target under a root (nearest-ancestor resolution)", () => {
    const root = mkdtempSync(join(tmpdir(), "wr-root-"));
    try {
      const nonexistent = join(root, "not", "created", "yet.txt");
      expect(isPathWithinWriteRoots(nonexistent, [realpathSync(root)])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
