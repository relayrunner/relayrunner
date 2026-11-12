// Comparing relayrunner CLI versions: the CLI uses it to tell someone at the terminal about a
// newer release, and the API to mark machines running an outdated CLI.

/** Whether `candidate` is a newer release than `current`. Only plain x.y.z releases count, so a prerelease never reads as newer. */
export function isNewerVersion(candidate: string, current: string) {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

function parse(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
