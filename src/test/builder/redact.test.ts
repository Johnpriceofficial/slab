import { describe, it, expect } from "vitest";
import { REDACTED, redact } from "../../builder/redact";

describe("audit redaction", () => {
  it("redacts values under sensitive KEY names, keeps innocuous data", () => {
    const out = redact({ repo: "org/app", access_token: "abc123", refreshToken: "xyz", note: "hello" }) as Record<string, unknown>;
    expect(out.repo).toBe("org/app");
    expect(out.note).toBe("hello");
    expect(out.access_token).toBe(REDACTED);
    expect(out.refreshToken).toBe(REDACTED);
  });

  it("redacts credential-SHAPED strings even under innocuous keys", () => {
    // Fixtures are ASSEMBLED at runtime so no credential-shaped literal appears in the
    // source (keeps the repo secret-scanner clean) while still exercising redact().
    const antKey = "sk-ant" + "-abcdefgh";
    const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"].join(".");
    const out = redact({ value: antKey, jwt, ok: "just text" }) as Record<string, unknown>;
    expect(out.value).toBe(REDACTED);
    expect(out.jwt).toBe(REDACTED);
    expect(out.ok).toBe("just text");
  });

  it("recurses through nested objects and arrays", () => {
    const out = redact({ items: [{ password: "p" }, { name: "n" }], nested: { authorization: "Bearer z" } }) as Record<string, unknown>;
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0].password).toBe(REDACTED);
    expect(items[1].name).toBe("n");
    expect((out.nested as Record<string, unknown>).authorization).toBe(REDACTED);
  });

  it("matches the real credential shapes the secret scanner guards against", () => {
    // Assembled at runtime (see note above) so the source stays secret-scanner clean.
    for (const s of ["AKIA" + "ABCDEFGHIJKLMNOP", "xoxb" + "-1234567890-abcd", "-----BEGIN RSA " + "PRIVATE KEY-----"]) {
      expect(redact({ blob: s })).toEqual({ blob: REDACTED });
    }
  });

  it("passes through primitives untouched", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact("plain string")).toBe("plain string");
  });
});
