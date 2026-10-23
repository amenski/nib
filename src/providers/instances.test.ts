import { describe, it, expect } from "vitest";
import { hostHeaders } from "./instances.js";
import { pkg } from "../version.js";

describe("hostHeaders", () => {
  it("gives OpenRouter its attribution pair", () => {
    expect(hostHeaders("https://openrouter.ai/api/v1", "sess-123")).toEqual({
      "HTTP-Referer": "https://github.com/amenski/nib",
      "X-OpenRouter-Title": "Nib",
    });
  });

  it("gives OpenCode Go the session header and the nib user agent", () => {
    expect(hostHeaders("https://opencode.ai/inference/go/v1", "sess-123")).toMatchObject({
      "x-opencode-session": "sess-123",
    });
    expect(hostHeaders("https://opencode.ai/inference/go/v1")!["user-agent"])
      .toMatch(new RegExp(`^${pkg.name}/${pkg.version}`));
  });

  it("falls back to a non-empty id per process when no session is given", () => {
    expect(hostHeaders("https://opencode.ai/inference/go/v1")!["x-opencode-session"]).not.toBe("");
  });

  it("sends nothing to a plain endpoint", () => {
    expect(hostHeaders("https://opencode.ai/inference/v1", "sess-123")).toBeUndefined();
    expect(hostHeaders("https://api.example.test/v1", "sess-123")).toBeUndefined();
  });

  it("sends nothing when the base URL is malformed", () => {
    expect(hostHeaders("not a url")).toBeUndefined();
  });
});
