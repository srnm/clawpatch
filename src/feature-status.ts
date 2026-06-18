import { nowIso } from "./fs.js";
import { readFeatures, readFindings, writeFeature, type StatePaths } from "./state.js";

export async function refreshFeatureStatus(paths: StatePaths, featureId: string): Promise<void> {
  const [features, findings] = await Promise.all([readFeatures(paths), readFindings(paths)]);
  const feature = features.find((candidate) => candidate.featureId === featureId);
  if (feature === undefined) {
    return;
  }
  const featureFindings = findings.filter((finding) => finding.featureId === featureId);
  const hasUnresolved = featureFindings.some((finding) =>
    ["open", "uncertain"].includes(finding.status),
  );
  if (!hasUnresolved && featureFindings.length > 0) {
    await writeFeature(paths, { ...feature, status: "fixed", updatedAt: nowIso() });
  } else if (hasUnresolved && ["fixed", "revalidated", "reviewed"].includes(feature.status)) {
    await writeFeature(paths, { ...feature, status: "needs-fix", updatedAt: nowIso() });
  }
}
