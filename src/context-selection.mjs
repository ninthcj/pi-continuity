/** Find a measured, fitting prefix of removals with O(log n) full renders instead of O(n). */
export function fitRemovalPrefix({ size, budget, apply, count, failure }) {
  let measurements = 0;
  const measure = () => { measurements++; return count(); };
  const initialTokens = measure();
  if (!budget || initialTokens <= budget) return { initialTokens, tokens: initialTokens, removed: 0, measurements };
  apply(size);
  if (measure() > budget) throw failure();
  let low = 0, high = size;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    apply(middle);
    if (measure() <= budget) high = middle;
    else low = middle;
  }
  // Always verify the actual selected rendering. A non-monotonic custom counter
  // may change which fitting prefix is found, but cannot publish an over-budget result.
  apply(high);
  const tokens = measure();
  if (tokens > budget) throw failure();
  return { initialTokens, tokens, removed: high, measurements };
}
