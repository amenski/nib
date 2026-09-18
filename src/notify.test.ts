import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// child_process.spawn is mocked so fireNotify never launches a real process.
const spawnSpy = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnSpy(...args),
}));

import { buildNotifyEnv, fireNotify, type NotifyInput } from "./notify.js";

function base(overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    status: "completed",
    durationMs: 3200,
    body: "all done",
    title: "fix the bug",
    ...overrides,
  };
}

describe("buildNotifyEnv", () => {
  it("shapes a completed turn: STATUS/DURATION(int seconds)/BODY/TITLE, no FAIL_REASON", () => {
    const env = buildNotifyEnv(base({ durationMs: 3499 }));
    expect(env.STATUS).toBe("completed");
    expect(env.DURATION).toBe("3"); // rounded whole seconds, string
    expect(env.BODY).toBe("all done");
    expect(env.TITLE).toBe("fix the bug");
    expect(env.FAIL_REASON).toBeUndefined();
  });

  it("shapes a failed turn: STATUS=failed and FAIL_REASON present", () => {
    const env = buildNotifyEnv(base({ status: "failed", body: "", failReason: "HTTP 500: boom" }));
    expect(env.STATUS).toBe("failed");
    expect(env.FAIL_REASON).toBe("HTTP 500: boom");
    expect(env.BODY).toBe("");
  });

  it("omits FAIL_REASON on failure when the reason is empty", () => {
    const env = buildNotifyEnv(base({ status: "failed", failReason: "" }));
    expect(env.STATUS).toBe("failed");
    expect("FAIL_REASON" in env).toBe(false);
  });

  it("redacts secrets in BODY via redactSecrets", () => {
    const env = buildNotifyEnv(base({ body: "key is sk-abcdefghijklmnopqrstuvwxyz012345 done" }));
    expect(env.BODY).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(env.BODY).toContain("[redacted-api-key]");
  });

  it("passes through the user env block but contract vars win over it", () => {
    const env = buildNotifyEnv(
      base({ passthroughEnv: { SLACK_WEBHOOK_URL: "https://hooks.example/x", STATUS: "hacked" } }),
    );
    expect(env.SLACK_WEBHOOK_URL).toBe("https://hooks.example/x");
    expect(env.STATUS).toBe("completed"); // our contract var wins
  });

  it("drops undefined passthrough env values", () => {
    const env = buildNotifyEnv(base({ passthroughEnv: { A: "1", B: undefined } }));
    expect(env.A).toBe("1");
    expect("B" in env).toBe(false);
  });

  it("clamps negative durations to 0", () => {
    expect(buildNotifyEnv(base({ durationMs: -50 })).DURATION).toBe("0");
  });

  it("shapes a job_done notification with the job payload", () => {
    const env = buildNotifyEnv(base({
      status: "job_done",
      body: "listening on :3000",
      title: "npm run dev",
      job: { id: "3f2a-0000-0000", command: "npm run dev", exitCode: 0 },
    }));
    expect(env.STATUS).toBe("job_done");
    expect(env.DURATION).toBe("3");
    expect(env.BODY).toBe("listening on :3000");
    expect(env.TITLE).toBe("npm run dev");
    expect(env.JOB_ID).toBe("3f2a-0000-0000");
    expect(env.JOB_COMMAND).toBe("npm run dev");
    expect(env.JOB_EXIT).toBe("0");
    expect(env.FAIL_REASON).toBeUndefined();
  });

  it("omits JOB_EXIT when the exit code is unknown (killed job)", () => {
    const env = buildNotifyEnv(base({
      status: "job_done",
      body: "",
      title: "sleep 30",
      job: { id: "abc", command: "sleep 30", exitCode: null },
    }));
    expect(env.STATUS).toBe("job_done");
    expect(env.JOB_ID).toBe("abc");
    expect("JOB_EXIT" in env).toBe(false);
  });

  it("redacts secrets in JOB_COMMAND", () => {
    const env = buildNotifyEnv(base({
      status: "job_done",
      body: "",
      title: "curl",
      job: {
        id: "abc",
        command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345' x",
        exitCode: 1,
      },
    }));
    expect(env.JOB_COMMAND).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(env.JOB_COMMAND).toContain("[redacted-api-key]");
  });

  it("sets no JOB_* vars for non-job statuses", () => {
    const env = buildNotifyEnv(base());
    expect("JOB_ID" in env).toBe(false);
    expect("JOB_COMMAND" in env).toBe(false);
    expect("JOB_EXIT" in env).toBe(false);
  });
});

/**
 * The shared launcher reads its readiness byte off fd 3, so a mocked child has
 * to expose a stdio array. All four slots are null: the mock creates no pipes,
 * which the launcher reports as an unconfirmed spawn rather than a crash.
 */
function mockChild() {
  return { on: vi.fn(), unref: vi.fn(), stdio: [null, null, null, null] };
}

describe("fireNotify", () => {
  beforeEach(() => {
    spawnSpy.mockReset();
    spawnSpy.mockReturnValue(mockChild());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not spawn when scriptPath is undefined", () => {
    fireNotify(undefined, base());
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("spawns the configured script with argv=[] and the built env", () => {
    fireNotify("/tmp/notify.sh", base({ passthroughEnv: { SLACK_WEBHOOK_URL: "https://h/x" } }));
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnSpy.mock.calls[0] as [string, string[], any];
    expect(cmd).toBe("/tmp/notify.sh");
    expect(args).toEqual([]);
    // Not a shell: the script path is the executable, never interpolated into
    // a shell command line.
    expect(opts.shell).not.toBe(true);
    expect(opts.detached).toBe(true);
    expect(opts.env.STATUS).toBe("completed");
    expect(opts.env.SLACK_WEBHOOK_URL).toBe("https://h/x");
    // process.env is merged in.
    expect(opts.env.PATH ?? opts.env.Path).toBeDefined();
  });

  it("uses the shared contained launcher with a private temp dir and minimal env", () => {
    const ambientKey = "NIB_NOTIFY_AMBIENT_TEST";
    const previousAmbient = process.env[ambientKey];
    process.env[ambientKey] = "must-not-leak";

    try {
      fireNotify(
        "/tmp/notify.sh",
        base({ passthroughEnv: { SLACK_WEBHOOK_URL: "https://h/x" } }),
        {
          spawn: {
            cwd: "/workspace",
            trustedRoot: "/workspace",
            sandboxLevel: "workspace-write",
            writeRoots: ["/workspace/cache"],
            sessionTempDir: "/private/tmp/nib-session-test",
          },
        },
      );

      const [cmd, args, opts] = spawnSpy.mock.calls[0] as [string, string[], any];
      expect(opts.cwd).toBe("/workspace");
      expect(opts.env.TMPDIR).toBe("/private/tmp/nib-session-test");
      expect(opts.env.npm_config_cache).toBe("/private/tmp/nib-session-test/npm-cache");
      expect(opts.env.SLACK_WEBHOOK_URL).toBe("https://h/x");
      expect(opts.env[ambientKey]).toBeUndefined();

      if (process.platform === "darwin") {
        expect(cmd).toBe("/usr/bin/sandbox-exec");
        expect(args[0]).toBe("-p");
        expect(args[1]).toContain("/workspace/cache");
        // The script stays the executed target — the readiness frame's last
        // argv element, reached through `exec "$@"`, so the direct-argv
        // contract this surface has always had is unchanged.
        expect(args.at(-1)).toBe("/tmp/notify.sh");
        expect(args.at(-2)).toBe("nib-readiness");
      } else {
        expect(cmd).toBe("/tmp/notify.sh");
        expect(args).toEqual([]);
      }
    } finally {
      if (previousAmbient === undefined) delete process.env[ambientKey];
      else process.env[ambientKey] = previousAmbient;
    }
  });

  it("never throws when spawn itself throws (fire-and-forget)", () => {
    spawnSpy.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => fireNotify("/nope", base())).not.toThrow();
  });

  it("registers an async error handler and unrefs the child", () => {
    const child = mockChild();
    spawnSpy.mockReturnValue(child);
    fireNotify("/tmp/notify.sh", base());
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
