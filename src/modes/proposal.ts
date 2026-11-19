import { renderKnownNames } from '../core/result.js';

/** At most this many lines describe a change Beaver's types do not cover. */
const MAX_JSON_LINES = 40;
/** A quoted text keeps about this many lines; the middle of a longer one is cut. */
const MAX_TEXT_LINES = 6;
/** At most this many entries of a list are named. */
const MAX_ENTRIES = 10;

export interface ProposalStyle {
  /** Old text red, new text green. */
  color: boolean;
  /** Wrap to this width (a terminal); no wrapping when unset. */
  width?: number;
  /** Display names already known, by citation tag id. */
  nameOf?: (tagId: string) => string | null;
}

type Data = Record<string, any>;

/** One logical line: its first-line prefix, the prefix of its wrapped continuation, and a colour. */
interface Line {
  lead: string;
  hang: string;
  text: string;
  tone?: 'old' | 'new';
}

const head = (text: string): Line => ({ lead: '  ', hang: '    ', text });
const detail = (text: string): Line => ({ lead: '    ', hang: '      ', text });

/** Simplified note HTML as plain text: citations named when known, tags removed, entities decoded. */
function plain(html: unknown, style: ProposalStyle): string {
  if (typeof html !== 'string') return '';
  return renderKnownNames(html, style.nameOf)
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

/** Word wrap; a word longer than the width stays whole. */
function wrap(text: string, width: number | undefined): string[] {
  if (!width || width <= 10 || text.length <= width) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  out.push(line);
  return out;
}

/**
 * A quoted text under a label ("- " old, "+ " new): wrapped, then cut in the middle when long, or
 * after its first lines with `headOnly`.
 */
function quote(label: '- ' | '+ ', text: string, style: ProposalStyle, tone: Line['tone'], headOnly = false): Line[] {
  const width = style.width ? style.width - 4 : undefined;
  let rows = text.split('\n').flatMap((l) => wrap(l, width));
  if (rows.length > MAX_TEXT_LINES + 1) {
    const cut = (n: number) => `… (${n} more lines)`;
    if (headOnly) rows = [...rows.slice(0, MAX_TEXT_LINES), cut(rows.length - MAX_TEXT_LINES)];
    else {
      const keep = MAX_TEXT_LINES / 2;
      rows = [...rows.slice(0, keep), cut(rows.length - 2 * keep), ...rows.slice(rows.length - keep)];
    }
  }
  return rows.map((text, i) => ({ lead: i === 0 ? `  ${label}` : '    ', hang: '    ', text, tone }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function list(xs: unknown[]): string {
  const names = xs.slice(0, MAX_ENTRIES).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return names.join(', ') + (xs.length > MAX_ENTRIES ? ` and ${xs.length - MAX_ENTRIES} more` : '');
}

function value(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

function itemRef(d: Data): string {
  return d.library_ref && d.zotero_key ? `${d.library_ref}-${d.zotero_key}` : String(d.zotero_key ?? '');
}

function libraryName(d: Data): string | null {
  if (typeof d.library_name === 'string' && d.library_name) return d.library_name;
  if (d.library_ref === 'u') return 'My Library';
  if (typeof d.library_ref === 'string' && d.library_ref) return `group library ${d.library_ref}`;
  return null;
}

/** "into My Library, collection C1", or null when the change names no target. */
function target(d: Data): Line | null {
  const parts: string[] = [];
  const lib = libraryName(d);
  if (lib) parts.push(lib);
  const cols = Array.isArray(d.collection_keys) ? d.collection_keys : [];
  if (cols.length) parts.push(`${cols.length === 1 ? 'collection' : 'collections'} ${list(cols)}`);
  return parts.length ? detail(`into ${parts.join(', ')}`) : null;
}

/** "Holm, B, C et al. (2023). Title" */
function citationLine(authors: string[], year: unknown, title: unknown): string {
  const who = authors.length ? `${authors.slice(0, 3).join(', ')}${authors.length > 3 ? ' et al.' : ''} ` : '';
  const yr = year ? `(${year}). ` : '';
  return `${who}${yr}${typeof title === 'string' && title ? title : '(untitled)'}`;
}

const NOTE_OPS: Record<string, string> = {
  str_replace: 'replace text',
  str_replace_all: 'replace every match',
  insert_after: 'insert after',
  insert_before: 'insert before',
  rewrite: 'rewrite the whole note',
  append: 'append',
};

/** The lines of one note edit, or null when its shape is unknown. */
function noteEdit(e: Data, style: ProposalStyle): { op: string; lines: Line[] } | null {
  const op = e.operation ?? 'str_replace';
  const word = NOTE_OPS[op];
  if (!word || typeof e.new_string !== 'string') return null;
  const lines: Line[] = [];
  if (op === 'insert_after' || op === 'insert_before') lines.push(detail(`${op === 'insert_after' ? 'after' : 'before'}: ${plain(e.old_string, style)}`));
  else if (op !== 'rewrite' && op !== 'append') lines.push(...quote('- ', plain(e.old_string, style), style, 'old'));
  lines.push(...quote('+ ', plain(e.new_string, style), style, 'new'));
  return { op: word, lines };
}

function noteName(d: Data, current: unknown): string {
  const t = [(current as Data | null)?.title, d.note_title, d.title].find((x) => typeof x === 'string' && x.trim() !== '');
  return t ? `"${t}" (${itemRef(d)})` : itemRef(d);
}

/** Pages of annotation items, in order, once each. */
function pagesOf(items: Data[]): string[] {
  const pages: string[] = [];
  for (const it of items) {
    const loc = Array.isArray(it.page_locations) ? it.page_locations[0] : undefined;
    const p =
      it.page_label ?? loc?.page_label ?? (typeof loc?.page_idx === 'number' ? loc.page_idx + 1 : undefined) ??
      (typeof it.note_position?.page_index === 'number' ? it.note_position.page_index + 1 : undefined);
    if (p !== undefined && p !== null && !pages.includes(String(p))) pages.push(String(p));
  }
  return pages;
}

function onPages(pages: string[]): string {
  return pages.length ? ` on ${pages.length === 1 ? 'page' : 'pages'} ${list(pages)}` : '';
}

function byType(type: string, d: Data, current: unknown, style: ProposalStyle): Line[] | null {
  switch (type) {
    case 'edit_note': {
      const e = noteEdit(d, style);
      return e ? [head(`Note ${noteName(d, current)}: ${e.op}`), ...e.lines] : null;
    }
    case 'edit_note_batch': {
      if (!Array.isArray(d.edits) || d.edits.length === 0) return null;
      const out = [head(`Note ${noteName(d, current)}: ${plural(d.edits.length, 'edit')}`)];
      for (const [i, raw] of d.edits.entries()) {
        const e = noteEdit(raw, style);
        if (!e) return null;
        out.push(head(`${i + 1}. ${e.op}`), ...e.lines);
      }
      return out;
    }
    case 'create_note':
      if (typeof d.content !== 'string') return null;
      return [head(`New note${d.title ? ` "${d.title}"` : ''}`), ...quote('+ ', plain(d.content, style), style, 'new', true)];
    case 'create_item': {
      const item: Data | undefined = d.item;
      if (!item || typeof item !== 'object') return null;
      const authors = Array.isArray(item.authors) ? item.authors.map(String) : [];
      const out = [head(`New item: ${citationLine(authors, item.year, item.title)}`)];
      const t = target(d);
      return t ? [...out, t] : out;
    }
    case 'import_item': {
      const item: Data | undefined = d.item ?? d.pending_resolution?.fallback_item;
      let text: string;
      if (item && typeof item === 'object') {
        const authors = (Array.isArray(item.creators) ? item.creators : [])
          .map((c: Data) => c.lastName ?? c.name)
          .filter((x: unknown): x is string => typeof x === 'string' && x !== '');
        const year = typeof item.date === 'string' ? /\d{4}/.exec(item.date)?.[0] : undefined;
        text = citationLine(authors, year, item.title);
      } else {
        const src = d.source?.input ?? d.source?.url;
        if (typeof src !== 'string' || !src) return null;
        text = src;
      }
      const out = [head(`Import: ${text}`)];
      const t = target(d);
      return t ? [...out, t] : out;
    }
    case 'edit_metadata': {
      if (!Array.isArray(d.edits) && !Array.isArray(d.creators)) return null;
      const out = [head(`Item ${itemRef(d)}:`)];
      for (const e of Array.isArray(d.edits) ? d.edits : []) out.push(detail(`${e.field}: ${value(e.old_value)} → ${value(e.new_value)}`));
      if (Array.isArray(d.creators)) {
        const who = (c: Data) => c.name ?? [c.lastName, c.firstName].filter(Boolean).join(', ');
        out.push(detail(`creators: ${(d.old_creators ?? []).map(who).join('; ') || '(none)'} → ${d.creators.map(who).join('; ') || '(none)'}`));
      }
      return out;
    }
    case 'create_collection': {
      if (typeof d.name !== 'string') return null;
      const ids = Array.isArray(d.item_ids) ? d.item_ids : [];
      const inside = d.parent_key ? ` inside collection ${d.parent_key}` : '';
      return [head(`New collection "${d.name}"${inside}${ids.length ? `, with ${plural(ids.length, 'item')}: ${list(ids)}` : ''}`)];
    }
    case 'organize_items': {
      if (!Array.isArray(d.item_ids)) return null;
      const out = [head(`${plural(d.item_ids.length, 'item')}: ${list(d.item_ids)}`)];
      const change = (what: string, xs: unknown) => {
        if (Array.isArray(xs) && xs.length) out.push(detail(`${what}: ${list(xs)}`));
      };
      change('add tags', d.tags?.add);
      change('remove tags', d.tags?.remove);
      change('add to collections', d.collections?.add);
      change('remove from collections', d.collections?.remove);
      return out;
    }
    case 'manage_tags':
      if (d.action === 'rename') return [head(`Rename tag "${d.name}" to "${d.new_name ?? ''}" in the library`)];
      if (d.action === 'delete') return [head(`Delete tag "${d.name}" from the library`)];
      return null;
    case 'manage_collections':
      if (d.action === 'rename') return [head(`Rename collection ${d.collection_key} to "${d.new_name ?? ''}"`)];
      if (d.action === 'move') return [head(`Move collection ${d.collection_key} ${d.new_parent_key ? `into collection ${d.new_parent_key}` : 'to the top level'}`)];
      if (d.action === 'delete') return [head(`Delete collection ${d.collection_key}`)];
      return null;
    case 'create_highlight_annotations':
    case 'create_note_annotations': {
      if (!Array.isArray(d.items)) return null;
      const word = type === 'create_highlight_annotations' ? 'highlight' : 'note annotation';
      return [head(`${plural(d.items.length, word)}${onPages(pagesOf(d.items))}`)];
    }
    case 'highlight_annotation': {
      const loc = Array.isArray(d.highlight_locations) ? d.highlight_locations[0] : undefined;
      const out = [head(`1 highlight${onPages(pagesOf([{ page_locations: loc ? [loc] : [] }]))}`)];
      return typeof d.text === 'string' && d.text ? [...out, ...quote('+ ', d.text, style, 'new', true)] : out;
    }
    case 'note_annotation': {
      const out = [head(`1 note annotation${onPages(pagesOf([{ note_position: d.note_position }]))}`)];
      return typeof d.comment === 'string' && d.comment ? [...out, ...quote('+ ', d.comment, style, 'new', true)] : out;
    }
    case 'edit_annotations': {
      if (d.operation === 'delete' && Array.isArray(d.annotation_refs)) return [head(`Delete ${plural(d.annotation_refs.length, 'annotation')}`)];
      if (d.operation === 'edit' && Array.isArray(d.edits)) {
        const n = d.edits.reduce((sum: number, g: Data) => sum + (Array.isArray(g.annotation_refs) ? g.annotation_refs.length : 0), 0);
        return [head(`Edit ${plural(n, 'annotation')}`)];
      }
      return null;
    }
    default:
      return null;
  }
}

function render(lines: Line[], style: ProposalStyle): string {
  const tone = (s: string, t: Line['tone']) => (style.color && t ? `\x1b[${t === 'old' ? 31 : 32}m${s}\x1b[0m` : s);
  const out: string[] = [];
  for (const l of lines) {
    // Quoted rows come wrapped already; other lines wrap here.
    const rows = l.tone ? [l.text] : wrap(l.text, style.width ? style.width - l.hang.length : undefined);
    rows.forEach((row, i) => {
      const lead = i === 0 ? l.lead : l.hang;
      const pad = /^ */.exec(lead)![0];
      out.push(pad + tone(lead.slice(pad.length) + row, l.tone));
    });
  }
  return out.join('\n');
}

/** The proposed content of a change, as a few indented lines for a terminal. */
export function describeProposal(
  p: { actionType: string; proposedData: unknown; currentValue?: unknown; excluded: boolean },
  style: ProposalStyle = { color: false },
): string {
  if (p.excluded) return '  (details hidden: the change touches a library excluded from Beaver)';
  const d = p.proposedData;
  if (d === null || d === undefined) return '  (Beaver sent no details)';
  let lines: Line[] | null = null;
  if (typeof d === 'object' && !Array.isArray(d)) {
    try {
      lines = byType(p.actionType, d as Data, p.currentValue, style);
    } catch {
      lines = null;
    }
  }
  if (lines) return render(lines, style);
  let json = JSON.stringify(d, null, 2).split('\n').map((l) => `  ${l}`);
  if (json.length > MAX_JSON_LINES) json = [...json.slice(0, MAX_JSON_LINES - 1), `  … (${json.length - MAX_JSON_LINES + 1} more lines)`];
  return json.join('\n');
}
