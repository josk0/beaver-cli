import type { Citation, CitationRef, ThreadBlock, ThreadView } from '../client/types.js';

export interface Source {
  n: number;
  display_name: string;
  reference: string;
  item_key: string;
  library_ref: string;
  zotero_uri: string;
  pages?: number[];
}

type ByKey = ThreadView['citations']['by_key'];

/** A citation tag with the blanks before it, or a closing tag. Group 1: the attributes of an opening tag. */
export const CITATION_TAG = /[ \t]*<citation\b([^>]*)>|<\/citation\s*>/g;

/** The attributes of a citation tag, e.g. `id="u-KEY" loc="s2.4"` -> {id: 'u-KEY', loc: 's2.4'}. */
export function tagAttributes(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrs.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Removes `<citation .../>` tags, also one cut off at the end of a partial text. */
export function stripCitationTags(text: string): string {
  return text
    .replace(/<citation\b[^>]*\/>/g, '')
    .replace(/<\/?citation\b[^>]*>/g, '')
    .replace(/<citation\b[^>]*$/, '')
    .replace(/<c(?:i(?:t(?:a(?:t(?:i(?:on?)?)?)?)?)?)?$/, '')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

/** `<library_ref>-<zotero_key>`, the form a citation tag's `id` takes. */
function refId(ref: CitationRef | undefined): string | null {
  return ref?.library_ref && ref.zotero_key ? `${ref.library_ref}-${ref.zotero_key}` : null;
}

/** The citation a tag names: by its exact tag, else by Beaver's lookup key (`zotero:<id>[:<loc>]`). */
export function findCitation(byKey: ByKey, tag: string, attrs: Record<string, string>): Citation | undefined {
  const usable = (c: Citation | undefined) => (c && c.excluded !== true && c.invalid !== true ? c : undefined);
  const exact = Object.values(byKey).find((c) => c.raw_tag !== undefined && c.raw_tag.trim() === tag.trim());
  if (exact) return usable(exact);
  if (!attrs.id) return undefined;
  return usable(byKey[`zotero:${attrs.id}${attrs.loc ? `:${attrs.loc}` : ''}`] ?? byKey[`zotero:${attrs.id}`]);
}

/** Display names by tag id (`u-KEY`), from every citation of a `thread` answer. */
export function displayNamesOf(byKey: ByKey): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of Object.values(byKey)) {
    if (c.excluded === true || c.invalid === true || !c.display_name) continue;
    const ids = [refId(c.requested_ref), refId(c.resolved_ref)];
    const tagId = c.raw_tag ? tagAttributes(/^<citation\b([^>]*)/.exec(c.raw_tag)?.[1] ?? '').id : undefined;
    if (tagId) ids.push(tagId);
    for (const id of ids) if (id && !names.has(id)) names.set(id, c.display_name);
  }
  return names;
}

/** The printed page labels of a citation in page order, else its physical pages. */
function pageLabelsOf(c: Citation): string[] {
  const labels = Object.entries(c.page_labels ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, l]) => l.trim())
    .filter((l) => l !== '');
  if (labels.length > 0) return labels;
  return (c.pages ?? []).map(String);
}

/** "266", "266–268" for consecutive numbers, else "iv, 266". */
function pageText(pageLabels: string[]): string {
  let labels = [...new Set(pageLabels)];
  if (labels.every((l) => /^\d+$/.test(l))) labels = labels.sort((a, b) => Number(a) - Number(b));
  if (labels.length <= 1) return labels[0] ?? '';
  const nums = labels.map((l) => (/^\d+$/.test(l) ? Number(l) : NaN));
  if (nums.every((n, i) => !Number.isNaN(n) && (i === 0 || n === nums[i - 1] + 1))) return `${labels[0]}–${labels[labels.length - 1]}`;
  return labels.join(', ');
}

/** A fenced code block (to its closing fence, or the end of the text) or an inline code span. */
const CODE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n {0,3}\3[ \t]*(?=\n|$)|$)|$)|(`+)(?!`)[\s\S]*?[^`]\4(?!`)/g;

/** [start, end) of each fenced code block and inline code span of `text`. */
export function codeRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length]);
}

/** Applies `fn` to the parts of `markdown` outside fenced code blocks and inline code spans. */
function outsideCode(markdown: string, fn: (text: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of markdown.matchAll(CODE)) {
    out += fn(markdown.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(markdown.slice(last));
}

/** Replaces every citation tag outside code by `label(tag, attrs)` (with the blanks before it), or drops it. */
/** Citation tags that follow each other with nothing or only blanks between them, with the blanks before. */
export const CITATION_GROUP = /(?:[ \t]*(?:<citation\b[^>]*>|<\/citation\s*>))+/g;

/** One source of a group of citations: its name and cited pages. */
export interface Cite {
  name: string;
  pages: string[];
}

/**
 * The sources of a group in order, the same source twice in a row once (with the pages of both), as
 * one bracket: "(Green 2022, 90; Wong 2020)". Null when no source has a name.
 */
export function groupLabel(cites: Array<Cite | null>): string | null {
  const merged: Cite[] = [];
  for (const c of cites) {
    if (!c) continue;
    const last = merged[merged.length - 1];
    if (last?.name === c.name) last.pages = [...last.pages, ...c.pages];
    else merged.push({ name: c.name, pages: [...c.pages] });
  }
  if (merged.length === 0) return null;
  return `(${merged.map((c) => (c.pages.length ? `${c.name}, ${pageText(c.pages)}` : c.name)).join('; ')})`;
}

/** The opening tags of a group, with their attributes. */
export function groupTags(group: string): Array<{ tag: string; attrs: Record<string, string> }> {
  return [...group.matchAll(/<citation\b([^>]*)>/g)].map((m) => ({ tag: m[0], attrs: tagAttributes(m[1]) }));
}

/** Replaces every group of citation tags outside code by its bracket (with the blanks before it), or drops it. */
function replaceTags(markdown: string, cite: (tag: string, attrs: Record<string, string>) => Cite | null): string {
  const out = outsideCode(markdown, (text) =>
    text.replace(CITATION_GROUP, (group) => {
      const lead = /^[ \t]*/.exec(group)![0];
      const label = groupLabel(groupTags(group).map(({ tag, attrs }) => cite(tag, attrs)));
      return label ? `${lead}${label}` : '';
    }),
  );
  return out.replace(/[ \t]+$/gm, '').trimEnd();
}

/**
 * Beaver's text with every citation tag as "(Holm 2023, 266)", citations in a row in one bracket; a
 * tag with no usable citation is left out. Code blocks and code spans stay as written.
 */
export function renderCitations(markdown: string, byKey: ByKey): string {
  return replaceTags(markdown, (tag, attrs) => {
    const c = findCitation(byKey, tag, attrs);
    return c?.display_name ? { name: c.display_name, pages: pageLabelsOf(c) } : null;
  });
}

/** A run's raw text with each citation tag as "(Name)" when `nameOf` knows it, else left out. */
export function renderKnownNames(text: string, nameOf?: (tagId: string) => string | null): string {
  // A tag cut off at the end of the text is dropped.
  const cut = text.replace(/<citation\b[^>]*$/, '').replace(/<c(?:i(?:t(?:a(?:t(?:i(?:on?)?)?)?)?)?)?$/, '');
  return replaceTags(cut, (_tag, attrs) => {
    const name = attrs.id ? nameOf?.(attrs.id) : null;
    return name ? { name, pages: [] } : null;
  });
}

/** The cited library item: for a citation of a PDF attachment, its parent item. */
function refOf(c: Citation): CitationRef | undefined {
  const ref = c.resolved_ref ?? c.requested_ref;
  if (c.citation_type === 'attachment' && c.parent_ref?.zotero_key && c.parent_ref.library_ref) return c.parent_ref;
  return ref;
}

/** Cited pages as numbers: the printed labels when there are any, else the physical pages. Non-numeric labels are left out. */
function pagesOf(c: Citation): number[] {
  const labels = Object.values(c.page_labels ?? {});
  if (labels.length > 0) return labels.filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim()));
  return c.pages ?? [];
}

function zoteroUri(libraryRef: string, key: string): string {
  const group = /^g(\d+)$/.exec(libraryRef);
  return group ? `zotero://select/groups/${group[1]}/items/${key}` : `zotero://select/library/items/${key}`;
}

/** One entry per distinct cited item, in the order Beaver lists the citations. */
export function sourcesFromCitations(byKey: ByKey): Source[] {
  const byItem = new Map<string, Source>();
  for (const c of Object.values(byKey ?? {})) {
    if (c.invalid === true || c.excluded === true) continue;
    const ref = refOf(c);
    if (!ref?.zotero_key || !ref.library_ref) continue;
    const id = `${ref.library_ref}:${ref.zotero_key}`;
    let s = byItem.get(id);
    if (!s) {
      const display = c.display_name ?? ref.zotero_key;
      s = {
        n: byItem.size + 1,
        display_name: display,
        reference: c.formatted_citation ?? display,
        item_key: ref.zotero_key,
        library_ref: ref.library_ref,
        zotero_uri: zoteroUri(ref.library_ref, ref.zotero_key),
      };
      byItem.set(id, s);
    }
    const pages = pagesOf(c);
    if (pages.length) s.pages = [...new Set([...(s.pages ?? []), ...pages])].sort((a, b) => a - b);
  }
  return [...byItem.values()];
}

export function formatSourceList(sources: Source[]): string {
  return sources
    .map((s) => {
      const pages = s.pages?.length ? `\n    cited: ${s.pages.length === 1 ? 'p.' : 'pp.'} ${s.pages.join(', ')}` : '';
      return `[${s.n}] ${s.reference}${pages}\n    ${s.zotero_uri}`;
    })
    .join('\n');
}

/** The reference list: one formatted reference per source, a blank line between them. */
export function referencesOf(sources: Source[]): string {
  return sources.map((s) => s.reference).join('\n\n');
}

function blockText(b: ThreadBlock, byKey: ByKey): string {
  switch (b.type) {
    case 'user':
      return `> **User:** ${b.text.trim().split('\n').join('\n> ')}`;
    case 'markdown':
      return renderCitations(b.markdown, byKey);
    case 'activity':
      return b.calls.map((c) => `*${c}*`).join('\n');
    case 'note':
      return `**${b.title || 'Note'}**\n\n${renderCitations(b.markdown, byKey)}`;
  }
}

/** A response (`thread` with a run id): its answer text, the reference list and the sources. */
export function readAnswer(view: ThreadView): { answer: string; references: string; sources: Source[] } {
  const byKey = view.citations?.by_key ?? {};
  const answer = view.blocks
    .filter((b) => b.type === 'markdown' || b.type === 'note')
    .map((b) => blockText(b, byKey))
    .filter((t) => t !== '')
    .join('\n\n');
  const sources = sourcesFromCitations(byKey);
  return { answer, references: referencesOf(sources), sources };
}

/** A whole chat: prompts as `> **User:**` lines, tool activity in italics, answers with their citations. */
export function readTranscript(view: ThreadView): { title: string; body: string; references: string; sources: Source[] } {
  const byKey = view.citations?.by_key ?? {};
  const body = view.blocks
    .map((b) => blockText(b, byKey))
    .filter((t) => t !== '')
    .join('\n\n');
  const sources = sourcesFromCitations(byKey);
  return { title: view.title ?? '', body, references: referencesOf(sources), sources };
}
