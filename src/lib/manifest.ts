export const MANIFEST_PATH = ".switchyard-multica-manifest.json";
export const DEFAULT_TOOL_VERSION = "0.1.0";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface SwitchyardMulticaManifest {
  tool: "switchyard-multica";
  toolVersion: string;
  skillName: string;
  sourcePath: string;
  generatedAt: string;
  files: ManifestFile[];
}

export function createManifest(input: {
  skillName: string;
  sourcePath: string;
  files: Array<ManifestFile & { content?: string }>;
  generatedAt?: string;
  toolVersion?: string;
}): SwitchyardMulticaManifest {
  return {
    tool: "switchyard-multica",
    toolVersion: input.toolVersion ?? DEFAULT_TOOL_VERSION,
    skillName: input.skillName,
    sourcePath: input.sourcePath,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    files: input.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size
    }))
  };
}
