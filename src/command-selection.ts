import type { LoadedProjectState } from "./app-context.js";
import { stringFlag, type CommandFlags } from "./command-support.js";
import { changedFilesSince, dirtyFiles } from "./git.js";
import { readFeatures } from "./state.js";
import { filterFindingsByChangedOwnedFiles } from "./selection.js";
import type { FindingRecord } from "./types.js";

export async function changedFiles(root: string, flags: CommandFlags): Promise<Set<string>> {
  const changed = new Set<string>();
  const since = stringFlag(flags, "since");
  if (since !== undefined) {
    for (const file of await changedFilesSince(root, since)) {
      changed.add(file);
    }
  }
  if (flags["includeDirty"] === true) {
    for (const file of await dirtyFiles(root)) {
      changed.add(file);
    }
  }
  return changed;
}

export async function filterFindingsByFileFlags(
  loaded: LoadedProjectState,
  findings: FindingRecord[],
  flags: CommandFlags,
): Promise<FindingRecord[]> {
  if (stringFlag(flags, "since") === undefined && flags["includeDirty"] !== true) {
    return findings;
  }
  const changed = await changedFiles(loaded.root, flags);
  const features = await readFeatures(loaded.paths);
  return filterFindingsByChangedOwnedFiles(findings, features, changed);
}
