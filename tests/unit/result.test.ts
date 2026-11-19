import { describe, expect, it } from 'vitest';
import type { Citation } from '../../src/client/types.js';
import { displayNamesOf, formatSourceList, readAnswer, readTranscript, renderCitations, renderKnownNames, sourcesFromCitations } from '../../src/core/result.js';
import { fixture } from '../helpers/fakeBeaver.js';

function citation(over: Partial<Citation> & { key?: string; lib?: string }): Citation {
  const key = over.key ?? 'AAAA1111';
  const lib = over.lib ?? 'u';
  const ref = { kind: 'zotero' as const, library_id: 1, zotero_key: key, library_ref: lib };
  const { key: _k, lib: _l, ...rest } = over;
  return { citation_id: `c-${key}-${Math.random()}`, requested_ref: ref, resolved_ref: ref, raw_tag: '<citation/>', ...rest };
}

const sourceWith = (byKey: Record<string, Citation>) => byKey;

describe('sourcesFromCitations', () => {
  it('turns the live response fixture into one source', () => {
    const src = fixture('thread-run-a').citations.by_key;
    const sources = sourcesFromCitations(src);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      n: 1,
      display_name: 'Holm 2023',
      item_key: 'PVX9VYC4',
      library_ref: 'u',
      zotero_uri: 'zotero://select/library/items/PVX9VYC4',
      reference: 'Holm, Sune (2023). The Fairness in Algorithmic Fairness. Res Publica, 29(2), 265-281.',
    });
    expect(sources[0]).not.toHaveProperty('pages');
  });

  it('a live PDF citation names the parent item and carries the printed page label', () => {
    const src = fixture('thread-attachment-page').citations.by_key;
    const sources = sourcesFromCitations(src);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      n: 1,
      display_name: 'Holm 2023',
      item_key: 'PVX9VYC4',
      library_ref: 'u',
      zotero_uri: 'zotero://select/library/items/PVX9VYC4',
      pages: [266],
    });
  });

  it('drops non-numeric page labels and prefers labels over physical pages', () => {
    const s = sourcesFromCitations(
      sourceWith({
        a: { ...citation({ key: 'AAAA1111', pages: [2] }), page_labels: { '1': 'iv' } },
        b: { ...citation({ key: 'AAAA1111', pages: [9] }), page_labels: { '4': '12' } },
      }),
    );
    expect(s[0].pages).toEqual([12]);
  });

  it('builds a group URI for a group library', () => {
    const s = sourcesFromCitations(sourceWith({ a: citation({ key: 'GGGG2222', lib: 'g2480564', display_name: 'X 1999' }) }));
    expect(s[0].zotero_uri).toBe('zotero://select/groups/2480564/items/GGGG2222');
    expect(s[0].library_ref).toBe('g2480564');
  });

  it('merges citations of one item and unions their pages', () => {
    const s = sourcesFromCitations(
      sourceWith({
        a: citation({ key: 'AAAA1111', pages: [3] }),
        b: citation({ key: 'AAAA1111', pages: [1] }),
        c: citation({ key: 'BBBB2222', display_name: 'Other' }),
      }),
    );
    expect(s.map((x) => [x.n, x.item_key])).toEqual([[1, 'AAAA1111'], [2, 'BBBB2222']]);
    expect(s[0].pages).toEqual([1, 3]);
  });

  it('treats the same key in two libraries as two items', () => {
    const s = sourcesFromCitations(sourceWith({ a: citation({ key: 'AAAA1111', lib: 'u' }), b: citation({ key: 'AAAA1111', lib: 'g5' }) }));
    expect(s).toHaveLength(2);
  });

  it('skips invalid citations and citations without a zotero ref', () => {
    const noRef: Citation = { citation_id: 'x', raw_tag: '<citation/>' };
    const s = sourcesFromCitations(sourceWith({ a: citation({ key: 'AAAA1111', invalid: true }), b: noRef, c: citation({ key: 'CCCC3333' }) }));
    expect(s.map((x) => x.item_key)).toEqual(['CCCC3333']);
  });

  it('prefers the resolved ref, falls back to the requested ref, and the reference falls back to the display name', () => {
    const requested = { kind: 'zotero' as const, library_id: 1, zotero_key: 'REQQ1111', library_ref: 'u' };
    const resolved = { kind: 'zotero' as const, library_id: 1, zotero_key: 'RESS2222', library_ref: 'u' };
    const s = sourcesFromCitations(
      sourceWith({
        a: { citation_id: 'a', raw_tag: '', requested_ref: requested, resolved_ref: resolved, display_name: 'Name A' },
        b: { citation_id: 'b', raw_tag: '', requested_ref: requested, display_name: 'Name B' },
      }),
    );
    expect(s[0].item_key).toBe('RESS2222');
    expect(s[0].reference).toBe('Name A');
    expect(s[1].item_key).toBe('REQQ1111');
  });

  it('returns an empty list for no citations', () => {
    expect(sourcesFromCitations(sourceWith({}))).toEqual([]);
  });
});

describe('formatSourceList', () => {
  it('prints number, reference and URI per source', () => {
    const src = fixture('thread-run-a').citations.by_key;
    expect(formatSourceList(sourcesFromCitations(src))).toBe(
      '[1] Holm, Sune (2023). The Fairness in Algorithmic Fairness. Res Publica, 29(2), 265-281.\n    zotero://select/library/items/PVX9VYC4',
    );
  });

  it('adds the cited pages when Beaver named them', () => {
    const base = { display_name: 'A 2020', item_key: 'K', library_ref: 'u', zotero_uri: 'zotero://x' };
    expect(formatSourceList([{ ...base, n: 1, reference: 'A (2020). T.', pages: [265, 270] }])).toBe('[1] A (2020). T.\n    cited: pp. 265, 270\n    zotero://x');
    expect(formatSourceList([{ ...base, n: 1, reference: 'A (2020). T.', pages: [3] }])).toContain('cited: p. 3');
  });

  it('prints nothing for no sources', () => {
    expect(formatSourceList([])).toBe('');
  });
});

describe('renderCitations', () => {
  const holm = fixture('thread-attachment-page').citations.by_key;

  it("writes each tag as (Name, printed page), as Beaver's exporter did", () => {
    const md = fixture('thread-attachment-page').blocks[0].markdown;
    expect(renderCitations(md, holm)).toBe(
      'Holm argues that seemingly incompatible algorithmic fairness criteria are applications of one account of fairness, and differ over what grounds people’s claims to an allocated good. (Holm 2023, 266)\n\n> “All four performance parity criteria can be understood as applications of a single principle of fairness defended by John Broome (1990) according to which fairness in the distribution of a good between people consists in the proportional satisfaction of their claims to the good.” — p. 266. (Holm 2023, 266)',
    );
  });

  it('an item citation without pages is (Name); a tag without a usable citation is left out with its blanks', () => {
    const byKey = {
      ...fixture('thread-run-a').citations.by_key,
      'zotero:u-EXCL0000': { citation_id: 'x', excluded: true },
    };
    expect(renderCitations('A <citation id="u-PVX9VYC4"/>. B <citation id="u-EXCL0000"/>. C <citation id="u-NONE0000"/>.', byKey)).toBe('A (Holm 2023). B. C.');
  });

  it('page ranges: consecutive labels as a range, others listed', () => {
    const c = (labels: Record<string, string>): Record<string, Citation> => ({
      'zotero:u-K:s1': { ...citation({ key: 'K', display_name: 'K 2020' }), raw_tag: '<citation id="u-K" loc="s1"/>', page_labels: labels },
    });
    const tag = '<citation id="u-K" loc="s1"/>';
    expect(renderCitations(`x ${tag}`, c({ '3': '4', '4': '5', '5': '6' }))).toBe('x (K 2020, 4–6)');
    expect(renderCitations(`x ${tag}`, c({ '1': 'iv', '9': '10' }))).toBe('x (K 2020, iv, 10)');
  });

  it("finds a citation by Beaver's lookup key when no tag matches exactly", () => {
    const byKey = { 'zotero:u-K:s2.4': { ...citation({ key: 'K', display_name: 'K 2020' }), raw_tag: undefined } };
    expect(renderCitations('x <citation loc="s2.4" id="u-K"/>', byKey)).toBe('x (K 2020)');
  });
});

describe('citations in a row', () => {
  const cite = (key: string, name: string, labels: Record<string, string> = {}, loc = ''): [string, Citation] => [
    `zotero:u-${key}${loc ? `:${loc}` : ''}`,
    { ...citation({ key, display_name: name }), raw_tag: `<citation id="u-${key}"${loc ? ` loc="${loc}"` : ''}/>`, page_labels: labels },
  ];
  const byKey = Object.fromEntries([
    cite('G', 'Green 2022', { '89': '90' }, 's1'),
    cite('G', 'Green 2022', { '87': '88' }, 's2'),
    cite('W', 'Wong 2020'),
  ]);

  it('citations separated by nothing or blanks share one bracket; the same source twice in a row once, pages merged', () => {
    const md = 'A claim <citation id="u-G" loc="s1"/> <citation id="u-W"/>. Another<citation id="u-G" loc="s1"/><citation id="u-G" loc="s2"/>. Apart <citation id="u-W"/>, then <citation id="u-W"/>.';
    expect(renderCitations(md, byKey)).toBe('A claim (Green 2022, 90; Wong 2020). Another(Green 2022, 88, 90). Apart (Wong 2020), then (Wong 2020).');
  });

  it('a group without any usable citation is left out', () => {
    expect(renderCitations('X <citation id="u-NONE"/> <citation id="u-NADA"/>.', byKey)).toBe('X.');
  });
});

describe('citation tags inside code', () => {
  const byKey = fixture('thread-run-a').citations.by_key;
  const tag = '<citation id="u-PVX9VYC4"/>';

  it('a fenced code block and an inline code span keep a literal tag; prose around them is rendered', () => {
    const md = `Use ${tag} here.\n\n\`\`\`xml\n<x>${tag}</x>\n\`\`\`\n\nWrite \`${tag}\` to cite. Again ${tag}.`;
    expect(renderCitations(md, byKey)).toBe(`Use (Holm 2023) here.\n\n\`\`\`xml\n<x>${tag}</x>\n\`\`\`\n\nWrite \`${tag}\` to cite. Again (Holm 2023).`);
  });

  it('an unclosed fence protects the rest of the text', () => {
    expect(renderCitations(`A ${tag}\n~~~\n${tag}`, byKey)).toBe(`A (Holm 2023)\n~~~\n${tag}`);
  });
});

describe('renderKnownNames', () => {
  it('names the tags it knows, drops the others and a tag cut off at the end', () => {
    const nameOf = (id: string) => (id === 'u-A' ? 'A 2020' : null);
    expect(renderKnownNames('One <citation id="u-A"/>, two <citation id="u-B"/>. Three <citat', nameOf)).toBe('One (A 2020), two. Three');
    expect(renderKnownNames('No names <citation id="u-A"/>.')).toBe('No names.');
  });
});

describe('displayNamesOf', () => {
  it('maps the tag ids of the citations to their names; excluded citations have none', () => {
    const names = displayNamesOf({ ...fixture('thread-attachment-page').citations.by_key, 'zotero:u-X': { citation_id: 'x', excluded: true } });
    expect(names.get('u-D6AG238X')).toBe('Holm 2023');
    expect(names.has('u-X')).toBe(false);
  });
});

describe('readAnswer and readTranscript', () => {
  it('the answer is the rendered markdown; references the formatted references', () => {
    const r = readAnswer(fixture('thread-run-a'));
    expect(r.answer.endsWith('can be understood. (Holm 2023)')).toBe(true);
    expect(r.references).toBe('Holm, Sune (2023). The Fairness in Algorithmic Fairness. Res Publica, 29(2), 265-281.');
    expect(r.sources).toHaveLength(1);
  });

  it('the transcript keeps prompts, activity and answers in order', () => {
    const t = readTranscript(fixture('thread-full'));
    expect(t.body.split('\n\n')).toEqual([
      '> **User:** In one sentence: what is one paper in my library about algorithmic fairness? Cite it.',
      'I’ll find a relevant paper in your library and cite its record.',
      '*Item search: "algorithmic fairness" (5 results)*',
      expect.stringMatching(/can be understood\. \(Holm 2023\)$/),
      '> **User:** Reply with the single word OK.',
      'OK',
    ]);
  });

  it('a multi-line prompt stays one quote; a note keeps its title', () => {
    const t = readTranscript({
      thread_id: 't',
      title: 'x',
      blocks: [
        { type: 'user', text: 'one\ntwo' },
        { type: 'note', title: 'Summary', markdown: 'Body.' },
      ],
      citations: { by_key: {} },
    });
    expect(t.body).toBe('> **User:** one\n> two\n\n**Summary**\n\nBody.');
  });
});
