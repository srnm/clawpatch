export type FileGroup = {
  label: string;
  files: string[];
};

export function partitionFileGroups(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
): FileGroup[] {
  return partitionAt(sourceRoot, files.toSorted(), maxFiles, 0);
}

function partitionAt(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
  depth: number,
): FileGroup[] {
  if (files.length === 0) {
    return [];
  }
  if (files.length <= maxFiles) {
    return [{ label: labelFor(sourceRoot, files, depth), files }];
  }

  const directFiles: string[] = [];
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const relativePath = file.slice(sourceRoot.length + 1);
    const parts = relativePath.split("/");
    if (parts.length <= depth + 1) {
      directFiles.push(file);
      continue;
    }
    const segment = parts[depth];
    if (segment === undefined) {
      directFiles.push(file);
      continue;
    }
    const bucket = buckets.get(segment) ?? [];
    bucket.push(file);
    buckets.set(segment, bucket);
  }

  if (buckets.size === 0) {
    return chunkFiles(labelFor(sourceRoot, files, depth), files, maxFiles);
  }

  const groups = chunkFiles(labelFor(sourceRoot, files, depth), directFiles, maxFiles);
  for (const [segment, bucketFiles] of [...buckets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (bucketFiles.length <= maxFiles) {
      groups.push({
        label: `${sourceRoot}/${bucketPrefix(bucketFiles, sourceRoot, depth, segment)}`,
        files: bucketFiles,
      });
    } else {
      groups.push(...partitionAt(sourceRoot, bucketFiles, maxFiles, depth + 1));
    }
  }
  return groups;
}

function chunkFiles(label: string, files: string[], maxFiles: number): FileGroup[] {
  if (files.length === 0) {
    return [];
  }
  if (files.length <= maxFiles) {
    return [{ label, files }];
  }
  const groups: FileGroup[] = [];
  for (let index = 0; index < files.length; index += maxFiles) {
    groups.push({
      label: `${label}#${Math.floor(index / maxFiles) + 1}`,
      files: files.slice(index, index + maxFiles),
    });
  }
  return groups;
}

function labelFor(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    return sourceRoot;
  }
  const first = files[0];
  if (first === undefined) {
    return sourceRoot;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return parts.length === 0 ? sourceRoot : `${sourceRoot}/${parts.join("/")}`;
}

function bucketPrefix(files: string[], sourceRoot: string, depth: number, segment: string): string {
  const first = files[0];
  if (first === undefined || depth === 0) {
    return segment;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return [...parts, segment].join("/");
}
