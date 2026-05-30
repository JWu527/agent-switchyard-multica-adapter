import { describe, expect, it } from "vitest";
import { parseTargetDirOverrides, resolveTargetDir } from "../src/lib/local-targets.js";

describe("resolveTargetDir", () => {
  it("resolves default runtime skill paths", () => {
    expect(resolveTargetDir("openclaw", "agent-switchyard", {}, "/Users/test")).toBe(
      "/Users/test/.openclaw/skills/agent-switchyard"
    );
    expect(resolveTargetDir("hermes", "agent-switchyard", {}, "/Users/test")).toBe(
      "/Users/test/.hermes/skills/agent-switchyard"
    );
    expect(resolveTargetDir("claude", "agent-switchyard", {}, "/Users/test")).toBe(
      "/Users/test/.claude/skills/agent-switchyard"
    );
  });

  it("uses CODEX_HOME for the codex target when present", () => {
    expect(resolveTargetDir("codex", "agent-switchyard", {}, "/Users/test", { CODEX_HOME: "/tmp/codex" })).toBe(
      "/tmp/codex/skills/agent-switchyard"
    );
  });

  it("falls back to ~/.codex for the codex target", () => {
    expect(resolveTargetDir("codex", "agent-switchyard", {}, "/Users/test", {})).toBe(
      "/Users/test/.codex/skills/agent-switchyard"
    );
  });

  it("falls back to ~/.codex when CODEX_HOME is empty or blank", () => {
    expect(resolveTargetDir("codex", "agent-switchyard", {}, "/Users/test", { CODEX_HOME: "" })).toBe(
      "/Users/test/.codex/skills/agent-switchyard"
    );
    expect(resolveTargetDir("codex", "agent-switchyard", {}, "/Users/test", { CODEX_HOME: "  " })).toBe(
      "/Users/test/.codex/skills/agent-switchyard"
    );
  });

  it("uses explicit target-dir overrides", () => {
    const overrides = parseTargetDirOverrides(["openclaw=/custom/openclaw"]);

    expect(resolveTargetDir("openclaw", "agent-switchyard", overrides, "/Users/test")).toBe("/custom/openclaw");
  });

  it("rejects unsafe skill names used as path segments", () => {
    for (const skillName of ["", "  ", ".", "..", "../../.ssh", "nested/skill", "nested\\skill", "bad\0name"]) {
      expect(() => resolveTargetDir("openclaw", skillName, {}, "/Users/test")).toThrow("Invalid skill name");
    }
  });

  it("rejects unknown targets", () => {
    expect(() => resolveTargetDir("bad", "agent-switchyard", {}, "/Users/test")).toThrow("Unknown target");
  });

  it("rejects malformed target-dir override values", () => {
    expect(() => parseTargetDirOverrides(["openclaw"])).toThrow("Invalid --target-dir value");
    expect(() => parseTargetDirOverrides(["=custom"])).toThrow("Invalid --target-dir value");
    expect(() => parseTargetDirOverrides(["openclaw="])).toThrow("Invalid --target-dir value");
  });

  it("rejects dangerous target-dir override values", () => {
    expect(() => parseTargetDirOverrides(["openclaw=relative/path"])).toThrow("Invalid --target-dir value");
    expect(() => parseTargetDirOverrides(["openclaw=/tmp/../escape"])).toThrow("Invalid --target-dir value");
    expect(() => parseTargetDirOverrides(["openclaw=/tmp/bad\0path"])).toThrow("Invalid --target-dir value");
  });

  it("rejects unknown target-dir override keys", () => {
    expect(() => parseTargetDirOverrides(["bad=/custom"])).toThrow("Unknown --target-dir target");
  });
});
