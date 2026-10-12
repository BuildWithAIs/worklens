import { expect, test } from "vitest";
import { NetworkBypass } from "../src/main/network-bypass";

test("IPv4 CIDRs match both ends of the range and exclude adjacent ranges", () => {
  const bypass = new NetworkBypass("160.12.34.56/8");
  expect(bypass.hasSubnets).toBe(true);
  for (const address of ["160.0.0.0", "160.12.34.56", "160.255.255.255"])
    expect(bypass.matches(address)).toBe(true);
  for (const address of [
    "159.255.255.255",
    "161.0.0.0",
    "service.example.test",
  ])
    expect(bypass.matches(address)).toBe(false);
  expect(new NetworkBypass("192.0.2.5/32").matches("192.0.2.6")).toBe(false);
  expect(new NetworkBypass("192.0.2.5/32").matches("192.0.2.5")).toBe(true);
  expect(new NetworkBypass("0.0.0.0/0").matches("203.0.113.1")).toBe(true);
  expect(new NetworkBypass("192.0.2.128/25").matches("192.0.2.127")).toBe(
    false,
  );
  expect(new NetworkBypass("192.0.2.128/25").matches("192.0.2.255")).toBe(true);
});

test("IPv6 CIDRs cover compressed, bracketed, and IPv4-mapped addresses", () => {
  const bypass = new NetworkBypass("[2001:db8::]/32, 160.0.0.0/8");
  for (const address of [
    "2001:db8::1",
    "[2001:db8:ffff::1]",
    "::ffff:160.12.34.56",
  ])
    expect(bypass.matches(address)).toBe(true);
  for (const address of ["2001:db9::1", "::ffff:161.0.0.1"])
    expect(bypass.matches(address)).toBe(false);
  expect(new NetworkBypass("2001:db8::1/128").matches("2001:db8::2")).toBe(
    false,
  );
  expect(new NetworkBypass("2001:db8::1/128").matches("2001:db8::1")).toBe(
    true,
  );
  expect(new NetworkBypass("::/0").matches("2001:db8::1")).toBe(true);
});

test("invalid CIDRs neither bypass requests nor activate DNS lookups", () => {
  for (const entry of [
    "160.0.0.0/33",
    "160.0.0.0/-1",
    "160.0.0.0/",
    "160.0.0.0/8/1",
    "999.0.0.0/8",
    "example.test/8",
    "::/129",
    ":::/8",
    "0.0.0.0/NaN",
  ])
    expect(new NetworkBypass(entry).hasSubnets).toBe(false);
});

test("domain, wildcard, exact IP, and implicit local rules retain their behavior", () => {
  const bypass = new NetworkBypass("example.test, *.internal.test, 192.0.2.5");
  expect(bypass.hasSubnets).toBe(false);
  for (const host of [
    "example.test",
    "api.example.test",
    "APP.INTERNAL.TEST",
    "192.0.2.5",
    "localhost",
    "127.0.0.2",
    "[::1]",
  ])
    expect(bypass.matches(host)).toBe(true);
  for (const host of ["other.test", "fakeexample.test", "192.0.2.6"])
    expect(bypass.matches(host)).toBe(false);
  expect(new NetworkBypass("*").matches("anything.test")).toBe(true);
  // DNS matching only consults explicit ranges, not implicit loopback rules.
  expect(bypass.matchesSubnet("127.0.0.1")).toBe(false);
});
