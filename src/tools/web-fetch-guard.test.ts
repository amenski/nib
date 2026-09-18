import { describe, it, expect } from "vitest";
import { isBlockedAddress, isBlockedHostnameLiteral } from "./web-fetch-guard.js";

describe("isBlockedAddress: IPv4", () => {
  it("blocks loopback 127.0.0.0/8", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.255.255.255")).toBe(true);
  });

  it("blocks private 10.0.0.0/8", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.255.255.255")).toBe(true);
  });

  it("blocks private 172.16.0.0/12 but not neighboring 172.15.x or 172.32.x", () => {
    expect(isBlockedAddress("172.16.0.0")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
    expect(isBlockedAddress("172.32.0.0")).toBe(false);
  });

  it("blocks private 192.168.0.0/16", () => {
    expect(isBlockedAddress("192.168.0.1")).toBe(true);
    expect(isBlockedAddress("192.168.255.255")).toBe(true);
  });

  it("blocks link-local/metadata 169.254.0.0/16 including 169.254.169.254", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("169.254.0.1")).toBe(true);
  });

  it("blocks 0.0.0.0/8", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });
});

describe("isBlockedAddress: IPv6", () => {
  it("blocks ::1 loopback", () => {
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("blocks fc00::/7 unique local", () => {
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fd12:3456:789a::1")).toBe(true);
  });

  it("blocks fe80::/10 link-local", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
  });

  it("blocks IPv4-mapped forms of blocked v4 ranges", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("allows IPv4-mapped forms of public addresses", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows ordinary public IPv6 addresses", () => {
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHostnameLiteral", () => {
  it("blocks localhost case-insensitively", () => {
    expect(isBlockedHostnameLiteral("localhost")).toBe(true);
    expect(isBlockedHostnameLiteral("LOCALHOST")).toBe(true);
  });

  it("allows ordinary hostnames", () => {
    expect(isBlockedHostnameLiteral("example.com")).toBe(false);
  });
});
