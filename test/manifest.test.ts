import { describe, expect, it } from "vitest";
import { diffFileRecords } from "../src/lib/diff.js";
import { createManifest } from "../src/lib/manifest.js";

describe("createManifest", () => {
  it("records tool, skill name, source path, file hashes, and sizes", () => {
    const manifest = createManifest({
      skillName: "agent-switchyard",
      sourcePath: "/tmp/source",
      generatedAt: "2026-05-30T00:00:00.000Z",
      files: [{ path: "SKILL.md", content: "# Skill\n", size: 8, sha256: "abc" }]
    });

    expect(manifest).toEqual({
      tool: "switchyard-multica",
      toolVersion: "0.1.0",
      skillName: "agent-switchyard",
      sourcePath: "/tmp/source",
      generatedAt: "2026-05-30T00:00:00.000Z",
      files: [{ path: "SKILL.md", sha256: "abc", size: 8 }]
    });
  });
});

describe("diffFileRecords", () => {
  it("distinguishes missing, extra, and mismatched remote files", () => {
    const diffs = diffFileRecords(
      [
        { path: "SKILL.md", sha256: "local", size: 8 },
        { path: "references/a.md", sha256: "same", size: 4 },
        { path: "scripts/local-only.sh", sha256: "local-only", size: 2 }
      ],
      [
        { path: "SKILL.md", sha256: "remote", size: 8 },
        { path: "references/a.md", sha256: "same", size: 4 },
        { path: "references/remote-only.md", sha256: "remote-only", size: 3 }
      ]
    );

    expect(diffs.map((diff) => diff.kind)).toEqual([
      "content_mismatch",
      "missing_remote",
      "extra_remote"
    ]);
  });
});
