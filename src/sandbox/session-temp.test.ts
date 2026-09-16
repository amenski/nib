import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSessionTempDir } from "./session-temp.js";

describe("createSessionTempDir", () => {
  it("creates a private directory and child environment", () => {
    const sessionTemp = createSessionTempDir();
    try {
      expect(existsSync(sessionTemp.path)).toBe(true);
      expect(statSync(sessionTemp.path).mode & 0o777).toBe(0o700);
      expect(sessionTemp.environment).toMatchObject({
        TMPDIR: sessionTemp.path,
        TMP: sessionTemp.path,
        TEMP: sessionTemp.path,
        npm_config_cache: `${sessionTemp.path}/npm-cache`,
      });
    } finally {
      sessionTemp.cleanup();
    }
    expect(existsSync(sessionTemp.path)).toBe(false);
  });
});
