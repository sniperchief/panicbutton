// Local-development key custody: per-session operator keys encrypted at rest with
// AES-256-GCM under KEYSTORE_KEY (an environment secret). Plaintext keys exist only
// in memory, only while signing. See SECURITY.md for production requirements.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export class Keystore {
  private readonly key: Buffer;

  constructor(masterKeyHex: string | undefined) {
    if (!masterKeyHex || !/^[0-9a-fA-F]{64}$/.test(masterKeyHex.trim())) {
      throw new Error("KEYSTORE_KEY must be 64 hex characters (32 bytes). See README: Setup.");
    }
    this.key = Buffer.from(masterKeyHex.trim(), "hex");
  }

  /** A fresh operator key, returned only in encrypted form plus its public address. */
  generate(): { address: `0x${string}`; encrypted: string } {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, encrypted: this.encrypt(pk) };
  }

  encrypt(privateKey: `0x${string}`): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
  }

  /** Decrypt and return a signing account. Throws on tampering or a wrong master key. */
  account(encrypted: string, expectedAddress: string): PrivateKeyAccount {
    const account = privateKeyToAccount(this.decrypt(encrypted));
    if (account.address !== expectedAddress) throw new Error("keystore entry does not match the session operator");
    return account;
  }

  private decrypt(encrypted: string): `0x${string}` {
    const [v, iv, tag, body] = encrypted.split(".");
    if (v !== "v1" || !iv || !tag || !body) throw new Error("unrecognized keystore entry");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8") as `0x${string}`;
  }
}
