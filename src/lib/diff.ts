export type DiffKind = "missing_remote" | "extra_remote" | "content_mismatch";

export interface FileRecord {
  path: string;
  sha256: string;
  size: number;
}

export interface DiffRecord {
  kind: DiffKind;
  path: string;
  local?: FileRecord;
  remote?: FileRecord;
}

export function diffFileRecords(local: FileRecord[], remote: FileRecord[]): DiffRecord[] {
  const diffs: DiffRecord[] = [];
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const remoteByPath = new Map(remote.map((file) => [file.path, file]));

  for (const localFile of local) {
    const remoteFile = remoteByPath.get(localFile.path);
    if (!remoteFile) {
      diffs.push({ kind: "missing_remote", path: localFile.path, local: localFile });
      continue;
    }

    if (remoteFile.sha256 !== localFile.sha256) {
      diffs.push({
        kind: "content_mismatch",
        path: localFile.path,
        local: localFile,
        remote: remoteFile
      });
    }
  }

  for (const remoteFile of remote) {
    if (!localByPath.has(remoteFile.path)) {
      diffs.push({ kind: "extra_remote", path: remoteFile.path, remote: remoteFile });
    }
  }

  return diffs;
}
