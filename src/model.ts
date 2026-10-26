export type Field = { id: number; name: string; kind: 'text' | 'number' | 'date' | 'tags' | 'rating' };
/** Star ratings run from 0 to 5 in half steps; a missing value means "not rated", not 0. */
export const ratingSteps = Array.from({ length: 11 }, (_, i) => i / 2);
export const ratingText = (value: unknown) => typeof value === 'number' ? `${value} / 5` : 'Not rated';
export type ImageRef = { id: number; path: string; cover: boolean };
export type Video = { id: number; path: string; size: number; values: Record<string, unknown>; images: ImageRef[]; plays: number; last_played: number | null;
  duration_ms?: number | null; width?: number | null; height?: number | null };
/** Built-in columns the app fills itself, keyed like field ids but never numeric. */
export const builtinLabels: Record<string, string> = { name: 'File name', duration: 'Duration', resolution: 'Resolution', size: 'Size', plays: 'Plays', last_played: 'Last played', format: 'Format', folder: 'Folder' };
/** Default order after File name and the user fields. */
export const builtinColumnKeys = ['duration', 'resolution', 'size', 'plays', 'last_played', 'format', 'folder'];
/** Built-in columns that also get a filter, with the filter control they use. */
export const builtinFilters: { id: string; name: string; kind: 'number' | 'text' | 'date' }[] = [
  { id: 'duration', name: 'Duration (min)', kind: 'number' }, { id: 'resolution', name: 'Resolution', kind: 'text' },
  { id: 'plays', name: 'Plays', kind: 'number' }, { id: 'format', name: 'Format', kind: 'text' }, { id: 'last_played', name: 'Last played', kind: 'date' },
];
/** `1:58:20` or `4:05`; empty when unknown. */
export function durationText(ms: number | null | undefined): string {
  if (!ms) return '';
  const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
export const resolutionText = (video: Video) => video.width && video.height ? `${video.width}×${video.height}` : '';
/** Quality class by the longer side, so portrait and wide-screen videos land in the expected class. */
export const qualityClasses = ['4K', '1440p', '1080p', '720p', 'SD'];
export function qualityOf(video: Video): string | null {
  if (!video.width || !video.height) return null;
  const long = Math.max(video.width, video.height);
  return long >= 3840 ? '4K' : long >= 2560 ? '1440p' : long >= 1920 ? '1080p' : long >= 1280 ? '720p' : 'SD';
}
export const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');
export const formatOf = (path: string) => (/\.([^.\\/]+)$/.exec(path)?.[1] || '').toUpperCase();
const pad = (n: number) => String(n).padStart(2, '0');
/** Local `YYYY-MM-DD HH:mm` (or just the date) for Unix seconds. */
export function localTime(seconds: number | null | undefined, dateOnly = false): string {
  if (seconds == null) return '';
  const d = new Date(seconds * 1000);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Value used for sorting a column: built-ins come from the file and play records, fields from the stored values. */
export function columnValue(video: Video, key: string): unknown {
  switch (key) {
    case 'name': return filename(video.path);
    case 'duration': return video.duration_ms || null;
    case 'resolution': return video.width && video.height ? video.width * video.height : null;
    case 'size': return video.size;
    case 'plays': return video.plays;
    case 'last_played': return video.last_played;
    case 'format': return formatOf(video.path);
    case 'folder': return folderOf(video.path);
    default: return video.values[key];
  }
}
/** Value used by filters; dates compare as local `YYYY-MM-DD`. */
export function filterValue(video: Video, key: string): unknown {
  if (key === 'last_played') return localTime(video.last_played, true) || null;
  if (key === 'duration') return video.duration_ms ? video.duration_ms / 60000 : null;
  if (key === 'resolution') return qualityOf(video);
  return columnValue(video, key);
}
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
/**
 * Puts the tags a filter matched first: AND tags, then OR tags, each in the order they were picked
 * in the filter, then the remaining tags in their stored order. `matched` marks the filter hits.
 */
export function filterFirstTags(tags: string[], rule?: Rule): { tags: string[]; matched: Set<string> } {
  const set = tagSet(rule);
  const first = [...set.all, ...set.any].filter((tag, i, all) => tags.includes(tag) && all.indexOf(tag) === i);
  return { tags: [...first, ...tags.filter(tag => !first.includes(tag))], matched: new Set(first) };
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
/** ffprobe status on this computer; without it media info comes from Windows media properties. */
export type MediaTools = { ffprobe: string | null; version: string | null; winget: boolean; package: string; dismissed: boolean };
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
/**
 * Moves a group of keys (kept in their current relative order) next to `to`, as when dropping `from`,
 * one of the group, onto `to`: after `to` when `from` started before it, otherwise before it.
 */
export function moveKeys(keys: string[], group: string[], from: string, to: string): string[] {
  if (group.includes(to) || !keys.includes(from) || !keys.includes(to)) return keys;
  const moving = keys.filter(key => group.includes(key) || key === from);
  const rest = keys.filter(key => !moving.includes(key));
  const at = rest.indexOf(to) + (keys.indexOf(from) < keys.indexOf(to) ? 1 : 0);
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
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
    const value = filterValue(video, String(rule.field));
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
    const av = columnValue(a, key), bv = columnValue(b, key);
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : text(av).localeCompare(text(bv), 'ko', { numeric: true });
    return cmp * (reverse ? -1 : 1);
  });
}
