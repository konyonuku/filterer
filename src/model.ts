export type Field = { id: number; name: string; kind: 'text' | 'number' | 'date' | 'tags' | 'rating' };
/** Star ratings run from 0 to 5 in half steps; a missing value means "not rated", not 0. */
export const ratingSteps = Array.from({ length: 11 }, (_, i) => i / 2);
export const ratingText = (value: unknown) => typeof value === 'number' ? `${value} / 5` : 'Not rated';
export type ImageRef = { id: number; path: string; cover: boolean };
export type Video = { id: number; path: string; size: number; values: Record<string, unknown>; images: ImageRef[] };
export type Rule = { field: string; op: 'eq' | 'contains' | 'gte' | 'lte' | 'empty' | 'tags'; value?: unknown };
/** Tag filter: every `all` tag, at least one `any` tag (when given), and no `none` tag. */
export type TagSet = { all: string[]; any: string[]; none: string[] };
export type TagState = keyof TagSet;
const noTags = (): TagSet => ({ all: [], any: [], none: [] });
/** Reads a tag rule; a legacy single-tag `eq` rule becomes one required tag. */
export function tagSet(rule?: Rule): TagSet {
  if (rule?.op === 'eq' && rule.value != null) return { ...noTags(), all: [text(rule.value)] };
  if (rule?.op !== 'tags' || !rule.value || typeof rule.value !== 'object') return noTags();
  const value = rule.value as Partial<TagSet>;
  const list = (v: unknown) => Array.isArray(v) ? v.map(text) : [];
  return { all: list(value.all), any: list(value.any), none: list(value.none) };
}
/** Puts a tag into one state, or clears it when it is already in that state. */
export function toggleTag(set: TagSet, tag: string, state: TagState): TagSet {
  const current = (Object.keys(set) as TagState[]).find(key => set[key].includes(tag));
  const next: TagSet = { all: set.all.filter(t => t !== tag), any: set.any.filter(t => t !== tag), none: set.none.filter(t => t !== tag) };
  if (current !== state) next[state] = [...next[state], tag];
  return next;
}
export const tagSetEmpty = (set: TagSet) => !set.all.length && !set.any.length && !set.none.length;
/** Tags of one field with the number of videos carrying each, most used first. */
export function tagCounts(videos: Video[], field: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const video of videos) {
    const value = video.values[field];
    if (Array.isArray(value)) new Set(value.map(text)).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
export type Query = { search?: string; mode?: 'AND' | 'OR'; rules?: Rule[] };
export type MoveItem = { media_id: number; source: string; target: string; cross: boolean; video: boolean; state: string };
export type Plan = { id: string; items: MoveItem[]; errors: string[]; warnings: string[] };
export type History = { id: string; created: string; status: string; payload: { items?: MoveItem[]; error?: string } };
export type Snapshot = {
  root: string; fields: Field[]; videos: Video[]; folders: { name: string; query: Query }[];
  sources: { path: string; recursive: boolean }[]; history: History[]; player: string; playlist_format: string;
  column_order: string[]; filter_order: string[]; column_widths: Record<string, number>; hidden_columns: string[]; options: Options;
};
export type Options = { unclassified_folder: string; shared_folder: string; page_size: number; visible_fields: number };
export const pageSizes = [25, 50, 100, 200, 500];
/** Applies a saved order to the current keys: unknown saved keys are dropped, new keys keep their default position at the end. */
export function ordered(keys: string[], saved: string[] = []): string[] {
  const known = saved.filter((key, i) => keys.includes(key) && saved.indexOf(key) === i);
  return [...known, ...keys.filter(key => !known.includes(key))];
}
/** Moves `from` to the position of `to`, as when dropping a dragged item onto another one. */
export function moveKey(keys: string[], from: string, to: string): string[] {
  const start = keys.indexOf(from), end = keys.indexOf(to);
  if (start < 0 || end < 0 || start === end) return keys;
  const next = keys.filter(key => key !== from);
  next.splice(end, 0, from);
  return next;
}
export const filename = (path: string) => path.split(/[\\/]/).pop() || path;
export function text(value: unknown): string {
  if (value == null) return '';
  return Array.isArray(value) ? value.map(text).join(', ') : String(value);
}
export function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
export function matches(video: Video, query: Query): boolean {
  const search = (query.search || '').toLocaleLowerCase();
  if (search && !`${video.path} ${Object.values(video.values).map(text).join(' ')}`.toLocaleLowerCase().includes(search)) return false;
  const rules = query.rules || [];
  const results = rules.map(rule => {
    const value = video.values[String(rule.field)];
    if (rule.op === 'tags') {
      const set = tagSet(rule), tags = Array.isArray(value) ? value.map(text) : [];
      return set.all.every(t => tags.includes(t)) && (!set.any.length || set.any.some(t => tags.includes(t))) && !set.none.some(t => tags.includes(t));
    }
    if (rule.op === 'empty') return value == null || text(value) === '';
    if (value == null) return false;
    if (rule.op === 'eq') return Array.isArray(value) ? value.includes(rule.value) : value === rule.value;
    if (rule.op === 'contains') return text(value).toLocaleLowerCase().includes(text(rule.value).toLocaleLowerCase());
    if (typeof value === 'number') {
      const target = Number(rule.value);
      return Number.isFinite(target) && (rule.op === 'gte' ? value >= target : value <= target);
    }
    return rule.op === 'gte' ? text(value) >= text(rule.value) : text(value) <= text(rule.value);
  });
  return results.length === 0 || (query.mode === 'OR' ? results.some(Boolean) : results.every(Boolean));
}
export function sortedVideos(videos: Video[], query: Query, key: string, reverse: boolean): Video[] {
  return videos.filter(v => matches(v, query)).sort((a, b) => {
    const av = key === 'name' ? filename(a.path) : key === 'size' ? a.size : a.values[key];
    const bv = key === 'name' ? filename(b.path) : key === 'size' ? b.size : b.values[key];
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : text(av).localeCompare(text(bv), 'ko', { numeric: true });
    return cmp * (reverse ? -1 : 1);
  });
}
