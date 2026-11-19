import { describe, expect, it } from 'vitest';
import { describeProposal } from '../../src/modes/proposal.js';

const d = (actionType: string, proposedData: unknown, over: { excluded?: boolean; currentValue?: unknown } = {}, style = {}) =>
  describeProposal({ actionType, proposedData, currentValue: over.currentValue ?? null, excluded: over.excluded ?? false }, { color: false, ...style });

describe('describeProposal: notes', () => {
  it('a note edit shows the old and the new text on labelled lines, tags stripped, citations named or dropped', () => {
    const out = d(
      'edit_note',
      {
        library_ref: 'u',
        zotero_key: 'N1',
        operation: 'str_replace',
        old_string: '<p>Old <b>bold</b> <citation id="u-A"/></p>',
        new_string: '<p>New &amp; better <citation id="u-B"/></p>',
      },
      { currentValue: { title: 'Reading notes' } },
      { nameOf: (id: string) => (id === 'u-A' ? 'A 2020' : null) },
    );
    expect(out).toBe('  Note "Reading notes" (u-N1): replace text\n  - Old bold (A 2020)\n  + New & better');
  });

  it('insert, append and rewrite show what they need; colour marks old red and new green', () => {
    expect(d('edit_note', { library_ref: 'u', zotero_key: 'N1', operation: 'insert_after', old_string: 'Anchor', new_string: 'Added' })).toBe(
      '  Note u-N1: insert after\n    after: Anchor\n  + Added',
    );
    expect(d('edit_note', { library_ref: 'u', zotero_key: 'N1', operation: 'append', new_string: '<p>More</p>' })).toBe('  Note u-N1: append\n  + More');
    const coloured = d('edit_note', { library_ref: 'u', zotero_key: 'N1', old_string: 'a', new_string: 'b' }, {}, { color: true });
    expect(coloured).toContain('\x1b[31m- a\x1b[0m');
    expect(coloured).toContain('\x1b[32m+ b\x1b[0m');
  });

  it('a long text is cut in the middle, about six lines kept', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `<p>line ${i + 1}</p>`).join('');
    const out = d('edit_note', { library_ref: 'u', zotero_key: 'N1', operation: 'rewrite', new_string: lines }).split('\n');
    expect(out).toEqual(['  Note u-N1: rewrite the whole note', '  + line 1', '    line 2', '    line 3', '    … (14 more lines)', '    line 18', '    line 19', '    line 20']);
  });

  it('a batch of note edits shows each edit', () => {
    const out = d('edit_note_batch', {
      library_ref: 'u',
      zotero_key: 'N1',
      edits: [
        { index: 0, old_string: 'a', new_string: 'b' },
        { index: 1, operation: 'append', new_string: 'c' },
      ],
    });
    expect(out).toBe('  Note u-N1: 2 edits\n  1. replace text\n  - a\n  + b\n  2. append\n  + c');
  });

  it('a new note shows its title and its first lines', () => {
    expect(d('create_note', { title: 'Summary', content: '<p>One</p><p>Two</p>' })).toBe('  New note "Summary"\n  + One\n    Two');
  });

  it('wraps long lines to the width with the label indent', () => {
    const out = d('create_note', { title: 'T', content: 'word '.repeat(12).trim() }, {}, { width: 30 });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(30);
    expect(out.split('\n')[2].startsWith('    word')).toBe(true);
  });
});

describe('describeProposal: items and metadata', () => {
  it('a new item: authors, year, title and target', () => {
    expect(d('create_item', { library_name: 'My Library', collection_keys: ['C1'], item: { title: 'Fairness', authors: ['Holm, Sune', 'B', 'C', 'D'], year: 2023 } })).toBe(
      '  New item: Holm, Sune, B, C et al. (2023). Fairness\n    into My Library, collection C1',
    );
  });

  it('an import names the item from its Zotero data, else from its source', () => {
    expect(
      d('import_item', {
        library_ref: 'g5',
        source: { kind: 'doi', input: '10.1/x' },
        item: { itemType: 'journalArticle', title: 'T', date: '2020-01-02', creators: [{ lastName: 'Doe', firstName: 'J' }] },
      }),
    ).toBe('  Import: Doe (2020). T\n    into group library g5');
    expect(d('import_item', { source: { kind: 'doi', input: '10.1/x' } })).toBe('  Import: 10.1/x');
  });

  it('metadata edits as field: old → new', () => {
    expect(d('edit_metadata', { library_ref: 'u', zotero_key: 'K', edits: [{ field: 'title', old_value: 'A', new_value: 'B' }, { field: 'date', old_value: '', new_value: '2020' }] })).toBe(
      '  Item u-K:\n    title: A → B\n    date: (empty) → 2020',
    );
  });
});

describe('describeProposal: organizing', () => {
  it('tags, collections and items as short lines with a count and at most 10 entries', () => {
    expect(d('manage_tags', { action: 'rename', name: 'a', new_name: 'b' })).toBe('  Rename tag "a" to "b" in the library');
    expect(d('manage_tags', { action: 'delete', name: 'a' })).toBe('  Delete tag "a" from the library');
    expect(d('create_collection', { name: 'Reading', item_ids: ['u-A', 'u-B'] })).toBe('  New collection "Reading", with 2 items: u-A, u-B');
    const ids = Array.from({ length: 12 }, (_, i) => `u-K${i}`);
    expect(d('organize_items', { item_ids: ids, tags: { add: ['x', 'y'] }, collections: { remove: ['C1'] } })).toBe(
      '  12 items: u-K0, u-K1, u-K2, u-K3, u-K4, u-K5, u-K6, u-K7, u-K8, u-K9 and 2 more\n    add tags: x, y\n    remove from collections: C1',
    );
    expect(d('manage_collections', { action: 'move', collection_key: 'C1', new_parent_key: null })).toBe('  Move collection C1 to the top level');
  });

  it('annotations as count and pages', () => {
    const items = [{ page_label: '12' }, { page_locations: [{ page_idx: 4 }] }, { page_label: '12' }];
    expect(d('create_highlight_annotations', { items })).toBe('  3 highlights on pages 12, 5');
    expect(d('create_note_annotations', { items: [{ note_position: { page_index: 0 } }] })).toBe('  1 note annotation on page 1');
    expect(d('edit_annotations', { operation: 'delete', annotation_refs: [{}, {}] })).toBe('  Delete 2 annotations');
    expect(d('highlight_annotation', { title: 'x', text: 'quoted', highlight_locations: [{ page_idx: 2, page_label: 'iii' }] })).toBe(
      '  1 highlight on page iii\n  + quoted',
    );
  });
});

describe('describeProposal: fallback', () => {
  it('an unknown type, or a shape that does not match, is pretty-printed JSON, at most 40 lines', () => {
    expect(d('something_new', { a: 1 })).toBe('  {\n    "a": 1\n  }');
    expect(d('edit_metadata', { edits: 'not a list' })).toContain('"edits": "not a list"');
    const big = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    const lines = d('something_new', big).split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[39]).toContain('more lines');
  });

  it('an excluded library hides the details; no data says so', () => {
    expect(d('edit_note', null, { excluded: true })).toBe('  (details hidden: the change touches a library excluded from Beaver)');
    expect(d('edit_note', null)).toBe('  (Beaver sent no details)');
  });
});
