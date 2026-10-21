/** Bounded, ordered excerpts spanning a recording, including its final decisions.
 * This is sampling, not a summary: gaps are explicit and never treated as contiguous speech.
 */
export function sampleTranscript(text: string, budget = 24000): string {
  if (text.length <= budget) return text;
  const gap = '\n\n[... omitted transcript ...]\n\n';
  const count = 5;
  const width = Math.floor((budget - gap.length * (count - 1)) / count);
  if (width < 1) throw new RangeError('Transcript sample budget is too small');
  const excerpts = Array.from({ length: count }, (_, index) => {
    let start = Math.floor(index * (text.length - width) / (count - 1));
    let end = start + width;
    // Do not split a UTF-16 surrogate pair at either boundary.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return text.slice(start, end);
  });
  return excerpts.join(gap);
}
