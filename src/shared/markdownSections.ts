// Shared markdown-heading parser. Both agent compaction summaries and
// intelligence-store learning extraction key their parsing off `## Heading`
// blocks; this is the one place that walks headings into a Map so the two
// callers can't drift on the walk itself. Heading normalization stays
// pluggable — agent compaction summaries only need `:`/`#` stripped, while
// intelligence-store input is arbitrary LLM prose that also carries
// markdown emphasis (`**bold**`) in headings, so the two callers pass
// different normalizers rather than forcing one on both.

/** Default normalizer: strips `:`/`#`, lowercases, trims. */
export function normalizeHeading(s: string): string {
  return s.toLowerCase().replace(/[:#]/g, '').trim();
}

export function splitMarkdownSections(
  text: string,
  normalize: (s: string) => string = normalizeHeading,
): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = normalize('summary');
  sections.set(current, []);
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = raw.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading?.[1]) {
      current = normalize(heading[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(raw);
  }
  return sections;
}
