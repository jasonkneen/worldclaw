const STATUS_RANK = {
  "not-retained": 0,
  "failed-no-committee": 1,
  retained: 2,
  "failed-retained": 3,
};

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value : null;
}

function artifactKey(artifact, index) {
  return text(artifact?.id) || `__anonymous_${index}`;
}

function providerKey(provider, index) {
  return text(provider?.provider) || `__anonymous_${index}`;
}

function richerEntry(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  const previousScore = Object.values(previous).filter(
    (value) => value !== null && value !== undefined && value !== "",
  ).length;
  const nextScore = Object.values(next).filter(
    (value) => value !== null && value !== undefined && value !== "",
  ).length;
  const primary = nextScore > previousScore ? next : previous;
  const secondary = primary === next ? previous : next;
  const merged = { ...secondary, ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    if (
      (merged[key] === null || merged[key] === undefined || merged[key] === "") &&
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeByKey(previousEntries, nextEntries, keyFor) {
  const merged = new Map();
  array(previousEntries).forEach((entry, index) => merged.set(keyFor(entry, index), entry));
  array(nextEntries).forEach((entry, index) => {
    const key = keyFor(entry, index);
    merged.set(key, richerEntry(merged.get(key), entry));
  });
  return [...merged.values()];
}

/**
 * Monotonic committee-ledger merge for repeated failure snapshots. Later
 * failure metadata can be added, but a sparse/remounting DOM snapshot cannot
 * erase provider rows, selections, artifact rows, or already-written image
 * file references.
 */
export function mergeCommitteeLedgerSnapshots(previous, next, failureMessage) {
  const prior = previous && typeof previous === "object" ? previous : {};
  const incoming = next && typeof next === "object" ? next : {};
  const providers = mergeByKey(prior.providers, incoming.providers, providerKey);
  const artifacts = mergeByKey(prior.artifacts, incoming.artifacts, artifactKey);
  const selection = richerEntry(prior.selection, incoming.selection) ?? null;
  const priorStatus = text(prior.status) ?? "not-retained";
  const incomingStatus = text(incoming.status) ?? "not-retained";
  const snapshotStatus =
    (STATUS_RANK[incomingStatus] ?? 0) >= (STATUS_RANK[priorStatus] ?? 0)
      ? incomingStatus
      : priorStatus;
  const status = failureMessage
    ? providers.length > 0 || artifacts.length > 0
      ? "failed-retained"
      : "failed-no-committee"
    : snapshotStatus;
  const previousFailure =
    prior.failure && typeof prior.failure === "object" ? prior.failure : undefined;
  const incomingFailure =
    incoming.failure && typeof incoming.failure === "object" ? incoming.failure : undefined;
  const failure = richerEntry(previousFailure, incomingFailure);
  const boundedFailureMessage = String(
    failureMessage || incomingFailure?.message || previousFailure?.message || "",
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
  return {
    ...prior,
    ...incoming,
    status,
    completedIterations: incoming.completedIterations ?? prior.completedIterations ?? null,
    maximumIterations: incoming.maximumIterations ?? prior.maximumIterations ?? null,
    providers,
    selection,
    artifacts,
    failure:
      boundedFailureMessage || failure
        ? {
            ...failure,
            status: "failed",
            message: boundedFailureMessage,
          }
        : undefined,
  };
}
