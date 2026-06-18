export type GitStatusChange = {
  status: string;
  paths: string[];
  primaryPath: string;
  secondaryPath?: string;
};

export function parseGitStatus(output: string): GitStatusChange[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const changes: GitStatusChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4 || field[2] !== " ") {
      continue;
    }
    const status = field.slice(0, 2);
    const primaryPath = field.slice(3);
    if (primaryPath.length === 0) {
      continue;
    }
    const secondaryPath = /[RC]/u.test(status) ? (fields[index + 1] ?? "") : undefined;
    if (secondaryPath !== undefined) {
      index += 1;
    }
    changes.push({
      status,
      primaryPath,
      paths:
        secondaryPath === undefined || secondaryPath.length === 0
          ? [primaryPath]
          : [primaryPath, secondaryPath],
      ...(secondaryPath === undefined || secondaryPath.length === 0 ? {} : { secondaryPath }),
    });
  }
  return changes;
}
