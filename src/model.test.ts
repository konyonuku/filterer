import { describe, expect, it } from 'vitest';
import { filename, matches, moveKey, moveKeys, ordered, ratingSteps, ratingText, sortedVideos, tagCounts, tagSet, text, toggleTag, type Query, type Rule, type Video } from './model';

const videos: Video[] = [
  { id: 1, path: 'C:\\Sources\\Dragön & 01.mp4', size: 50, values: { '1': ['Dragön', 'Adventure'], '2': 90, '3': '2025-03-01' }, images: [] },
  { id: 2, path: '/videos/Wörk 10.mp4', size: 10, values: { '1': ['Nature'], '2': 80, '3': '2024-10-01' }, images: [] },
  { id: 3, path: '/videos/Wörk 2.mp4', size: 20, values: { '1': null, '2': null }, images: [] },
];
describe('saved filter compatibility and list ordering', () => {
  it('matches multiple tags exactly and searches metadata', () => {
    expect(matches(videos[0], { rules: [{ field: '1', op: 'eq', value: 'Dragön' }] })).toBe(true);
    expect(matches(videos[0], { rules: [{ field: '1', op: 'eq', value: 'Drag' }] })).toBe(false);
    expect(matches(videos[0], { search: 'Adventure' })).toBe(true);
  });
  it('supports AND, OR, numeric and ISO date comparisons', () => {
    const rules = [{ field: '2', op: 'gte' as const, value: 85 }, { field: '3', op: 'lte' as const, value: '2024-12-31' }];
    expect(sortedVideos(videos, { rules, mode: 'AND' }, 'name', false)).toHaveLength(0);
    expect(sortedVideos(videos, { rules, mode: 'OR' }, 'name', false)).toHaveLength(2);
  });
  it('finds empty values and preserves unknown versus zero', () => {
    expect(sortedVideos(videos, { rules: [{ field: '2', op: 'empty' }] }, 'name', false).map(v => v.id)).toEqual([3]);
    expect(matches(videos[2], { rules: [{ field: '2', op: 'gte', value: 0 }] })).toBe(false);
  });
  it('sorts numerically and places absent values last in both directions', () => {
    expect(sortedVideos(videos, {}, '2', true).map(v => v.id)).toEqual([1, 2, 3]);
    expect(sortedVideos(videos.slice(1), {}, 'name', false).map(v => v.id)).toEqual([3, 2]);
  });
  it('handles both platform paths and multi-value labels', () => {
    expect(filename(videos[0].path)).toBe('Dragön & 01.mp4');
    expect(text(videos[0].values['1'])).toBe('Dragön, Adventure');
    expect(text(null)).toBe('');
  });
});
describe('column and filter ordering', () => {
  it('applies a saved order, drops removed keys and appends new ones', () => {
    expect(ordered(['name', '1', '2', 'size'], ['size', '9', '2', 'size'])).toEqual(['size', '2', 'name', '1']);
    expect(ordered(['1', '2'])).toEqual(['1', '2']);
  });
  it('moves a dragged key onto the drop target in both directions', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveKey(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveKey(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });
});
describe('star ratings', () => {
  const rated: Video[] = [
    { id: 1, path: 'a.mp4', size: 1, values: { r: 4.5 }, images: [] },
    { id: 2, path: 'b.mp4', size: 1, values: { r: 0 }, images: [] },
    { id: 3, path: 'c.mp4', size: 1, values: {}, images: [] },
  ];
  const ids = (rules: Query['rules']) => sortedVideos(rated, { rules }, 'name', false).map(v => v.id);
  it('keeps unrated apart from zero stars in filters', () => {
    expect(ids([{ field: 'r', op: 'gte', value: 0 }])).toEqual([1, 2]);
    expect(ids([{ field: 'r', op: 'eq', value: 0 }])).toEqual([2]);
    expect(ids([{ field: 'r', op: 'lte', value: 4.5 }])).toEqual([1, 2]);
    expect(ids([{ field: 'r', op: 'empty' }])).toEqual([3]);
  });
  it('sorts by rating with unrated last and describes values', () => {
    expect(sortedVideos(rated, {}, 'r', true).map(v => v.id)).toEqual([1, 2, 3]);
    expect(sortedVideos(rated, {}, 'r', false).map(v => v.id)).toEqual([2, 1, 3]);
    expect(ratingSteps).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
    expect([ratingText(0), ratingText(3.5), ratingText(undefined)]).toEqual(['0 / 5', '3.5 / 5', 'Not rated']);
  });
});
describe('tag filters', () => {
  const tagged: Video[] = [
    { id: 1, path: 'a.mp4', size: 1, values: { t: ['Drama', 'Action'] }, images: [] },
    { id: 2, path: 'b.mp4', size: 1, values: { t: ['Drama', 'Comedy', 'Horror'] }, images: [] },
    { id: 3, path: 'c.mp4', size: 1, values: { t: ['Comedy'] }, images: [] },
    { id: 4, path: 'd.mp4', size: 1, values: {}, images: [] },
  ];
  const ids = (value: object) => sortedVideos(tagged, { rules: [{ field: 't', op: 'tags', value }] }, 'name', false).map(v => v.id);
  it('combines required, any-of and excluded tags', () => {
    expect(ids({ all: ['Drama'], any: [], none: [] })).toEqual([1, 2]);
    expect(ids({ all: [], any: ['Action', 'Comedy'], none: [] })).toEqual([1, 2, 3]);
    expect(ids({ all: [], any: [], none: ['Drama'] })).toEqual([3, 4]);
    expect(ids({ all: ['Drama'], any: ['Action', 'Comedy'], none: ['Horror'] })).toEqual([1]);
  });
  it('toggles states and reads legacy single-tag rules', () => {
    let set = toggleTag(tagSet(), 'Drama', 'all');
    expect(set).toEqual({ all: ['Drama'], any: [], none: [] });
    set = toggleTag(set, 'Drama', 'none');
    expect(set).toEqual({ all: [], any: [], none: ['Drama'] });
    expect(toggleTag(set, 'Drama', 'none')).toEqual({ all: [], any: [], none: [] });
    const legacy: Rule = { field: 't', op: 'eq', value: 'Comedy' };
    expect(tagSet(legacy)).toEqual({ all: ['Comedy'], any: [], none: [] });
    expect(sortedVideos(tagged, { rules: [legacy] }, 'name', false).map(v => v.id)).toEqual([2, 3]);
  });
  it('counts tags by use', () => {
    expect(tagCounts(tagged, 't')).toEqual([['Comedy', 2], ['Drama', 2], ['Action', 1], ['Horror', 1]]);
  });
});
describe('moving a group of columns', () => {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8'];
  it('drops the group after a later target and before an earlier one', () => {
    expect(moveKeys(keys, ['2', '6', '7'], '2', '3')).toEqual(['1', '3', '2', '6', '7', '4', '5', '8']);
    expect(moveKeys(keys, ['2', '6', '7'], '6', '1')).toEqual(['2', '6', '7', '1', '3', '4', '5', '8']);
    expect(moveKeys(keys, ['7', '2'], '7', '8')).toEqual(['1', '3', '4', '5', '6', '8', '2', '7']);
  });
  it('matches single moves and ignores drops onto the group', () => {
    expect(moveKeys(keys, ['4'], '4', '6')).toEqual(moveKey(keys, '4', '6'));
    expect(moveKeys(keys, ['6'], '6', '2')).toEqual(moveKey(keys, '6', '2'));
    expect(moveKeys(keys, ['2', '6'], '2', '6')).toEqual(keys);
  });
});
