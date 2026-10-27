import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keystore } from "../server/keystore.js";

const master = () => randomBytes(32).toString("hex");

describe("Keystore", () => {
  it("round-trips a generated key without exposing it", () => {
    const ks = new Keystore(master());
    const { address, encrypted } = ks.generate();
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(encrypted).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(ks.account(encrypted, address).address).toBe(address);
  });

  it("rejects tampering, a wrong master key, and a mismatched operator", () => {
    const ks = new Keystore(master());
    const { address, encrypted } = ks.generate();
    const parts = encrypted.split(".");
    const flipped = Buffer.from(parts[3]!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    parts[3] = flipped.toString("base64");
    expect(() => ks.account(parts.join("."), address)).toThrow();
    expect(() => new Keystore(master()).account(encrypted, address)).toThrow();
    expect(() => ks.account(encrypted, "0x0000000000000000000000000000000000000001")).toThrow(/does not match/);
  });

  it("refuses a malformed master key", () => {
    expect(() => new Keystore(undefined)).toThrow(/KEYSTORE_KEY/);
    expect(() => new Keystore("abc")).toThrow(/KEYSTORE_KEY/);
  });
});
