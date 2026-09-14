import { describe, it, expect } from "vitest";
import { classifyImageSource } from "./image-source.js";

describe("classifyImageSource", () => {
  it("treats https as remote", () => {
    expect(classifyImageSource("https://example.com/cat.png")).toEqual({
      kind: "remote",
      url: "https://example.com/cat.png",
    });
  });

  it("flags plain http as rejected, not as a path", () => {
    expect(classifyImageSource("http://example.com/cat.png")).toEqual({ kind: "http" });
  });

  it("decodes a file:// URL into a local path", () => {
    expect(classifyImageSource("file:///Users/a/my%20cat.png")).toEqual({
      kind: "local",
      path: "/Users/a/my cat.png",
    });
  });

  it("treats absolute and relative paths as local", () => {
    expect(classifyImageSource("/Users/amanuel/Downloads/shot.jpeg")).toEqual({
      kind: "local",
      path: "/Users/amanuel/Downloads/shot.jpeg",
    });
    expect(classifyImageSource("./assets/logo.png")).toEqual({ kind: "local", path: "./assets/logo.png" });
    expect(classifyImageSource("logo.png")).toEqual({ kind: "local", path: "logo.png" });
  });

  it("rejects other schemes rather than misreading them as paths", () => {
    expect(classifyImageSource("data:image/png;base64,AAAA")).toEqual({ kind: "unsupported", scheme: "data" });
    expect(classifyImageSource("ftp://example.com/cat.png")).toEqual({ kind: "unsupported", scheme: "ftp" });
    expect(classifyImageSource("javascript:alert(1)")).toEqual({ kind: "unsupported", scheme: "javascript" });
  });

  it("treats a single-letter scheme as a Windows drive path", () => {
    expect(classifyImageSource("C:\\dir\\img.png")).toEqual({ kind: "local", path: "C:\\dir\\img.png" });
  });

  it("rejects a malformed file: URL instead of guessing a path", () => {
    expect(classifyImageSource("file://otherhost/x.png").kind).toBe("unsupported");
  });

  it("trims surrounding whitespace", () => {
    expect(classifyImageSource("  https://example.com/cat.png  ")).toEqual({
      kind: "remote",
      url: "https://example.com/cat.png",
    });
  });
});
