import { describe, expect, test } from "bun:test";
import { isAllowedOrigin, isLoopbackName } from "@/server/originGuard";

describe("isLoopbackName", () => {
  test("localhost and any .localhost name are loopback", () => {
    expect(isLoopbackName("localhost")).toBe(true);
    expect(isLoopbackName("flux360.localhost")).toBe(true);
    expect(isLoopbackName("a.b.localhost")).toBe(true);
  });

  test("a name that merely contains localhost is not loopback", () => {
    expect(isLoopbackName("localhost.evil.com")).toBe(false);
    expect(isLoopbackName("evil.localhost.attacker.com")).toBe(false);
    expect(isLoopbackName("notlocalhost")).toBe(false);
  });
});

describe("origin guard", () => {
  test("the proxied tag name is accepted", () => {
    expect(isAllowedOrigin("http://flux360.localhost")).toBe(true);
    expect(isAllowedOrigin("http://flux360.localhost:6474")).toBe(true);
    expect(isAllowedOrigin("https://flux360.localhost")).toBe(true);
  });

  test("the forwarded port is accepted", () => {
    expect(isAllowedOrigin("http://localhost:6474")).toBe(true);
    expect(isAllowedOrigin("http://localhost")).toBe(true);
  });

  test("a remote origin is rejected", () => {
    expect(isAllowedOrigin("http://evil.com")).toBe(false);
    expect(isAllowedOrigin("https://flux360.example.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.com")).toBe(false);
  });

  test("a non-url origin such as the literal null is rejected", () => {
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
  });
});
