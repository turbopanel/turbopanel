export function bucketFloor(ms: number, resolutionSeconds: number): number {
  const bucketMs = resolutionSeconds * 1000
  return Math.floor(ms / bucketMs) * bucketMs
}
