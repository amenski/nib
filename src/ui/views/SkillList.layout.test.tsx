import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ThemeProvider, TerminalProvider } from "../contexts.js";
import SkillList from "./SkillList.js";
import { stripAnsi as strip } from "../test-helpers.js";

// Real-shaped data: skill descriptions are paragraphs (median 327 chars across
// the installed set), which is what made the old two-line layout unusable.
const SKILLS = [
  { name: "app-funnel", description: "Design or audit a mobile app's conversion funnel — App Store page, onboarding-as-story, paywall anatomy, and retention/exit-offer. Use when asked to review an app's onboarding." },
  { name: "clean-architecture", description: "Implements Uncle Bob's Clean Architecture for Spring Boot + JPA backends. Generates domain models, use cases, repository interfaces, JPA entities, mappers and controllers." },
  { name: "clean-code", description: "Write readable, maintainable code through disciplined naming, small functions, and clean error handling. Covers SRP, comment discipline and formatting." },
  { name: "commit", description: "Commit changes in this agent context" },
  { name: "flutter-expert", description: "Use when building cross-platform applications with Flutter 3+ and Dart." },
];

function setup(props: Partial<React.ComponentProps<typeof SkillList>> = {}) {
  return render(
    <ThemeProvider>
      <TerminalProvider>
        <SkillList
          skills={SKILLS as never}
          width={78}
          height={20}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          {...props}
        />
      </TerminalProvider>
    </ThemeProvider>,
  );
}

/**
 * /skills used to render each entry as a name plus its full wrapped
 * description — 7 to 11 rows per skill. With 22 skills installed that is ~198
 * rows, so a 24-row terminal showed about two entries. One row per skill makes
 * the whole set fit on one screen.
 */
describe("SkillList layout", () => {
  it("renders each visible skill on a single row", () => {
    // Entries past the page size are scrolled out, which is correct — assert
    // on the ones actually on screen.
    const lines = strip(setup().lastFrame() ?? "").split("\n");
    const visible = SKILLS.filter((s) => lines.some((l) => l.includes(s.name)));
    expect(visible.length).toBeGreaterThan(1);
    for (const s of visible) {
      const matching = lines.filter((l) => l.includes(s.name));
      expect(matching, `${s.name} should occupy exactly one row`).toHaveLength(1);
    }
  });

  it("keeps the whole list within the panel height", () => {
    // Was ~9 rows per skill; five skills alone overflowed a 24-row terminal.
    const rows = strip(setup().lastFrame() ?? "").split("\n").length;
    expect(rows).toBeLessThanOrEqual(14);
  });

  it("aligns descriptions in a column, not as wrapped prose", () => {
    const lines = strip(setup().lastFrame() ?? "").split("\n");
    const rows = SKILLS.map((s) => lines.find((l) => l.includes(s.name))!)
      .filter(Boolean);
    expect(rows.length).toBeGreaterThan(1);
    // Every description starts at the same column.
    const starts = rows.map((r) => {
      const m = r.match(/\S/g);
      return r.indexOf(SKILLS.find((s) => r.includes(s.name))!.description.slice(0, 6));
    }).filter((n) => n > 0);
    expect(new Set(starts).size).toBe(1);
  });

  it("truncates a long description rather than wrapping it", () => {
    const frame = strip(setup().lastFrame() ?? "");
    const row = frame.split("\n").find((l) => l.includes("app-funnel"))!;
    expect(row).toContain("…");
    // The tail of the description must not appear anywhere.
    expect(frame).not.toContain("retention/exit-offer");
  });

  it("shows a short description in full", () => {
    const row = strip(setup().lastFrame() ?? "").split("\n")
      .find((l) => l.includes("commit"))!;
    expect(row).toContain("Commit changes in this agent context");
  });

  it("uses key-caps in the footer", () => {
    // Same vocabulary as the model picker. Without colour a chip
    // degrades to bracketed text, which is what the test renderer shows.
    const frame = strip(setup().lastFrame() ?? "");
    expect(frame).toContain("[↑↓] move");
    expect(frame).toContain("[enter] select");
    expect(frame).toContain("[esc] close");
  });
});
