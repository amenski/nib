import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { runBashTimed } from "../tools/bash.js";
import { MCPClient } from "../mcp/client.js";
import type { SandboxLevel } from "./seatbelt.js";

// ── egress probes (macOS) — release gate 4 ──
//
// docs/security-network-broker.md ships no broad-egress exception and states
// the claim this file verifies: "Sandboxed children cannot connect directly,
// including via DNS, proxies, Unix helpers, or spawned descendants." The
// original release probe failed to establish that for Git — a failed connect
// is *not* evidence of a Seatbelt denial, because a refused connection fails
// identically. Every row below therefore measures the **destination's** own
// connection counter, not the child's error text:
//
//   - control   (no level)   → the listener records a connection
//   - contained (the level)  → the listener records none
//
// This distinction is load-bearing, not pedantic. Measured 2026-09-16: git's
// contained failure reads "Failed to connect to 127.0.0.1 port N ... Couldn't
// connect to server" — byte-identical to what a refused connection produces —
// and both directions exit non-zero (control: HTTP protocol error, contained:
// connect failure). DNS is the same shape: the control and the contained run
// both print DNSFAIL, differing only in errno. The counter is the only signal
// that separates "Seatbelt denied this" from "this was never going to work".
//
// Every fixture is local. The one non-loopback destination is 192.0.2.1
// (TEST-NET-1, RFC 5737), which is reserved and guaranteed unrouted, so even
// the *control* there sends a packet nowhere; no public endpoint is contacted
// by any probe in this file, and the proxy row's target is a `.invalid` name
// (RFC 2606) served only by the local listener.

const onDarwin = process.platform === "darwin";
const itOnDarwin = it.skipIf(!onDarwin);

interface Listener {
  /** Connections accepted since this server started. */
  connections: () => number;
  port: number;
  close: () => void;
}

/** A hermetic local HTTP listener that counts every accepted connection.
 *  Responds `ok` to any path, so the control direction completes. */
function startListener(): Promise<Listener> {
  return new Promise((resolve) => {
    let seen = 0;
    const server: Server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
    server.on("connection", () => { seen += 1; });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        connections: () => seen,
        close: () => server.close(),
      });
    });
  });
}

/** A local UDP listener that counts datagrams and answers each with a
 *  NOERROR/empty-answer DNS header, so a client that reaches it stops
 *  retrying (ENODATA = "arrived, no records" — arrival is what matters). */
function startUdpListener(): Promise<{ packets: () => number; port: number; close: () => void }> {
  return new Promise((resolve) => {
    let seen = 0;
    const socket = createSocket("udp4");
    socket.on("message", (msg: Buffer, from: { port: number; address: string }) => {
      seen += 1;
      const reply = Buffer.from(msg.subarray(0, msg.length));
      reply[2] = 0x81; // QR=1, RD=1
      reply[3] = 0x80; // RA=1, NOERROR
      reply[6] = 0; reply[7] = 0; // no answer records
      socket.send(reply, from.port, from.address);
    });
    socket.bind(0, "127.0.0.1", () => {
      resolve({
        port: (socket.address() as AddressInfo).port,
        packets: () => seen,
        close: () => socket.close(),
      });
    });
  });
}

/** Run a shell command through the real Bash entry point, contained or not. */
async function runShell(command: string, ws: string, level?: SandboxLevel): Promise<string> {
  const result = await runBashTimed(command, ws, ws, 30_000, false, level);
  return result.content + (result.error ? `\n${result.error}` : "");
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Asserts the property for one mechanism: the control reaches the listener and
 * the contained run does not, with the child reporting a failure either way.
 */
async function expectNoEgress(
  ws: string,
  command: string,
  count: () => number,
  reached: string,
  blocked: string,
): Promise<void> {
  const beforeControl = count();
  const control = await runShell(command, ws);
  expect(control).toContain(reached);
  expect(count() - beforeControl).toBeGreaterThan(0);

  const beforeContained = count();
  const contained = await runShell(command, ws, "workspace-write");
  expect(contained).toContain(blocked);
  expect(contained).not.toContain(reached);
  expect(count() - beforeContained).toBe(0);
}

function workspace(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "nib-egress-"));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

describe("network egress (macOS) — release gate 4", () => {
  itOnDarwin("Node fetch reaches a loopback listener uncontained, and never when contained", async () => {
    const listener = await startListener();
    const f = workspace();
    try {
      // The baseline row, with the control the earlier loopback tests lacked
      // (they asserted `connections() === 0` without proving the listener was
      // reachable at all).
      const command =
        `node -e 'fetch("http://127.0.0.1:${listener.port}/").then(r=>console.log("REACHED",r.status))` +
        `.catch(e=>console.log("BLOCKED",(e.cause&&e.cause.code)||e.message))'`;
      await expectNoEgress(f.ws, command, listener.connections, "REACHED", "BLOCKED");
    } finally {
      listener.close();
      f.cleanup();
    }
  }, 60_000);

  itOnDarwin("Python's socket connect is contained too (a different syscall path)", async () => {
    const listener = await startListener();
    const f = workspace();
    try {
      const command =
        `python3 - <<'PY'\n` +
        `import errno, socket\n` +
        `try:\n` +
        `    s = socket.create_connection(("127.0.0.1", ${listener.port}), 3)\n` +
        `    print("PYREACHED")\n` +
        `    s.close()\n` +
        `except OSError as e:\n` +
        `    print("PYFAIL", errno.errorcode.get(e.errno, e.errno))\n` +
        `PY`;
      await expectNoEgress(f.ws, command, listener.connections, "PYREACHED", "PYFAIL");
    } finally {
      listener.close();
      f.cleanup();
    }
  }, 60_000);

  itOnDarwin("Git cannot reach an HTTP remote when contained (the original ambiguous probe)", async () => {
    const listener = await startListener();
    const f = workspace();
    try {
      // The release probe could not tell Seatbelt denial from connection
      // refusal here. Neither can git's output — both directions fail with a
      // connect-shaped or protocol-shaped error and a non-zero status (note
      // the `$?` is git's own, not a pipeline's). The counter decides it.
      const command = `git ls-remote http://127.0.0.1:${listener.port}/repo 2>&1; echo "GIT-EXIT $?"`;
      const beforeControl = listener.connections();
      const control = await runShell(command, f.ws);
      expect(listener.connections() - beforeControl).toBeGreaterThan(0);
      expect(control).toContain("GIT-EXIT");

      const beforeContained = listener.connections();
      const contained = await runShell(command, f.ws, "workspace-write");
      expect(listener.connections() - beforeContained).toBe(0);
      expect(contained).toContain("unable to access");
    } finally {
      listener.close();
      f.cleanup();
    }
  }, 60_000);

  itOnDarwin("an npm lifecycle script cannot reach the network (the child's child)", async () => {
    const listener = await startListener();
    const f = workspace();
    try {
      // npm is a child of the shell and the script is a child of npm, so this
      // is the "spawned descendants" half of the broker requirement.
      writeFileSync(
        join(f.ws, "package.json"),
        JSON.stringify({
          name: "nib-egress-fixture",
          version: "1.0.0",
          private: true,
          scripts: { egress: "node egress.js" },
        }),
      );
      writeFileSync(
        join(f.ws, "egress.js"),
        `fetch("http://127.0.0.1:${listener.port}/")\n` +
          `  .then((r) => console.log("REACHED", r.status))\n` +
          `  .catch((e) => console.log("BLOCKED", (e.cause && e.cause.code) || e.message));\n`,
      );
      await expectNoEgress(f.ws, "npm run --silent egress", listener.connections, "REACHED", "BLOCKED");
    } finally {
      listener.close();
      f.cleanup();
    }
  }, 90_000);

  itOnDarwin("a local stdio MCP server cannot reach the network", async () => {
    const listener = await startListener();
    const f = workspace();
    try {
      // A malicious MCP server is the realistic exfiltration surface: it is
      // launched by us, speaks a protocol we parse, and previously could not
      // even start under containment (see child-paths.test.ts). It reports
      // what its own fetch did through a file in the workspace, which is the
      // one write it is allowed.
      const script = join(f.ws, "mcp-egress.cjs");
      const report = join(f.ws, "mcp-egress.json");
      writeFileSync(
        script,
        `const fs=require("fs");\n` +
          `function report(status, detail){fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({status,detail:String(detail)}));}\n` +
          `fetch("http://127.0.0.1:${listener.port}/")\n` +
          `  .then((r)=>report("REACHED", r.status))\n` +
          `  .catch((e)=>report("BLOCKED", (e.cause && e.cause.code) || e.message));\n` +
          `let buf = "";\n` +
          `process.stdin.setEncoding("utf8");\n` +
          `process.stdin.on("data", (chunk) => {\n` +
          `  buf += chunk;\n` +
          `  let i;\n` +
          `  while ((i = buf.indexOf("\\n")) !== -1) {\n` +
          `    const line = buf.slice(0, i).trim();\n` +
          `    buf = buf.slice(i + 1);\n` +
          `    if (!line) continue;\n` +
          `    let msg; try { msg = JSON.parse(line); } catch { continue; }\n` +
          `    if (msg.method === "initialize") {\n` +
          `      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "egress", version: "1" } } }) + "\\n");\n` +
          `    }\n` +
          `  }\n` +
          `});\n`,
      );

      const runServer = async (sandboxLevel?: SandboxLevel) => {
        rmSync(report, { force: true });
        const client = new MCPClient();
        try {
          await client.connect(process.execPath, [script], undefined, {
            cwd: f.ws,
            trustedRoot: f.ws,
            ...(sandboxLevel ? { sandboxLevel } : {}),
          });
          // The handshake is the allowed ordinary operation for this surface.
          await waitFor(() => existsSync(report));
          return JSON.parse(readFileSync(report, "utf8")) as { status: string; detail: string };
        } finally {
          client.disconnect();
        }
      };

      const beforeControl = listener.connections();
      const control = await runServer();
      expect(control.status).toBe("REACHED");
      expect(listener.connections() - beforeControl).toBeGreaterThan(0);

      const beforeContained = listener.connections();
      const contained = await runServer("workspace-write");
      expect(contained.status).toBe("BLOCKED");
      expect(listener.connections() - beforeContained).toBe(0);
    } finally {
      listener.close();
      f.cleanup();
    }
  }, 90_000);

  itOnDarwin("curl through a local proxy is still a socket connect, so it is still denied", async () => {
    const listener = await startListener();
    const f = workspace();
    try {
      // The proxy is the local listener; the target is a `.invalid` name
      // (RFC 2606, never resolvable) so nothing real can be contacted even if
      // the connect were allowed — the request would be answered by the
      // fixture. `-x` makes curl use the proxy for an absolute-form request
      // without resolving the target itself.
      const command =
        `curl -sS --max-time 5 -x http://127.0.0.1:${listener.port} http://egress.invalid/ ` +
        `&& echo "CURL-REACHED" || echo "CURL-FAILED"`;
      const beforeControl = listener.connections();
      const control = await runShell(command, f.ws);
      expect(control).toContain("CURL-REACHED");
      expect(listener.connections() - beforeControl).toBeGreaterThan(0);

      const beforeContained = listener.connections();
      const contained = await runShell(command, f.ws, "workspace-write");
      expect(contained).toContain("CURL-FAILED");
      expect(listener.connections() - beforeContained).toBe(0);
    } finally {
      listener.close();
      f.cleanup();
    }
  }, 60_000);

  itOnDarwin("UDP cannot even be bound when contained (no DNS or tunnel egress)", async () => {
    const udp = await startUdpListener();
    const f = workspace();
    try {
      // Measured: the contained child dies at `bind` with EPERM, before any
      // send — UDP is closed at socket creation, not at send time. The error
      // listener keeps the failure readable instead of an unhandled 'error'.
      const command =
        `node -e 'const d=require("dgram").createSocket("udp4");` +
        `d.on("error",e=>{console.log("UDPFAIL",e.code);process.exit(0)});` +
        `d.send(Buffer.from("probe"),${udp.port},"127.0.0.1",(e)=>console.log(e?"UDPFAIL "+e.code:"UDPSENT"));` +
        `setTimeout(()=>process.exit(0),500)'`;
      await expectNoEgress(f.ws, command, udp.packets, "UDPSENT", "UDPFAIL");
    } finally {
      udp.close();
      f.cleanup();
    }
  }, 60_000);

  itOnDarwin("a UDP send to an unrouted address fails the same way (no route out)", async () => {
    const f = workspace();
    try {
      // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved for documentation and
      // guaranteed unrouted, so neither direction can contact anything. The
      // control proves the send path itself works when uncontained.
      const command =
        `node -e 'const d=require("dgram").createSocket("udp4");` +
        `d.on("error",e=>{console.log("UDPFAIL",e.code);process.exit(0)});` +
        `d.send(Buffer.from("probe"),9,"192.0.2.1",(e)=>console.log(e?"UDPFAIL "+e.code:"UDPSENT"));` +
        `setTimeout(()=>process.exit(0),500)'`;
      expect(await runShell(command, f.ws)).toContain("UDPSENT");

      const contained = await runShell(command, f.ws, "workspace-write");
      expect(contained).toContain("UDPFAIL");
      expect(contained).not.toContain("UDPSENT");
    } finally {
      f.cleanup();
    }
  }, 60_000);

  itOnDarwin("a Unix-domain daemon socket outside the write roots is not reachable", async () => {
    // The broker requirement names "Unix helpers" alongside DNS and proxies.
    // A Unix socket connect is not governed by the network rules at all — it is
    // a file operation on the socket node — so it needs its own measurement
    // rather than an inference from the TCP rows. The socket lives under the
    // real $HOME (outside every write root, and inside the gate-1 read deny),
    // which is where an agent or container socket would actually be.
    const root = mkdtempSync(join(homedir(), ".nib-egress-"));
    const socketPath = join(root, "daemon.sock");
    let seen = 0;
    const server = createNetServer();
    server.on("connection", () => { seen += 1; });
    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const f = workspace();
    try {
      await listening;
      const command =
        `node -e 'const s=require("net").connect(${JSON.stringify(socketPath)});` +
        `s.on("connect",()=>{console.log("UNIXREACHED");s.end()});` +
        `s.on("error",e=>console.log("UNIXFAIL",e.code))'`;
      await expectNoEgress(f.ws, command, () => seen, "UNIXREACHED", "UNIXFAIL");
    } finally {
      server.close();
      f.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  itOnDarwin("DNS over UDP to a custom resolver never leaves the process", async () => {
    const udp = await startUdpListener();
    const f = workspace();
    try {
      // `dns.setServers` + `resolve4` uses c-ares, which issues the query from
      // this process — so the profile sees it. Both directions print DNSFAIL,
      // so this row cannot use the shared helper: the control's *arrival*
      // evidence is that it received the fixture's own empty answer (ENODATA,
      // "the query got there and the server had no records"), and the
      // contained run's evidence is that it never received it.
      //
      // Residual, NOT covered by this row: `dns.lookup`/`getaddrinfo` goes
      // through the system resolver (mDNSResponder), which performs the
      // network I/O *outside* this process, where no Seatbelt rule can apply.
      // Whether a resolver-mediated lookup still succeeds under containment
      // was not demonstrated — it would need either a public DNS query or a
      // reconfigured system resolver, both out of scope for these probes.
      const command =
        `node -e 'const dns=require("dns");dns.setServers(["127.0.0.1:${udp.port}"]);` +
        `dns.promises.resolve4("egress.fixture.test",{timeout:700,tries:1})` +
        `.then(a=>console.log("DNSOK",a)).catch(e=>console.log("DNSFAIL",e.code))'`;

      const beforeControl = udp.packets();
      const control = await runShell(command, f.ws);
      expect(udp.packets() - beforeControl).toBeGreaterThan(0);
      expect(control).toContain("DNSFAIL ENODATA");

      const beforeContained = udp.packets();
      const contained = await runShell(command, f.ws, "workspace-write");
      expect(udp.packets() - beforeContained).toBe(0);
      expect(contained).toContain("DNSFAIL");
      expect(contained).not.toContain("ENODATA");
    } finally {
      udp.close();
      f.cleanup();
    }
  }, 60_000);
});
