import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, CheckSquare, ChevronDown, Eye, EyeOff, ChevronLeft, ChevronRight, CircleHelp, FileVideo, Filter, Folder, FolderOpen, FolderPlus, GripVertical, Grid2X2, Image as ImageIcon, List, LoaderCircle, MoreHorizontal, Play, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Tag, Trash2, X } from 'lucide-react';
import { cancel, chooseFile, chooseFolder, desktop, request } from './bridge';
import { filename, moveKey, ordered, pageSizes, ratingSteps, ratingText, size, tagCounts, tagSet, tagSetEmpty, toggleTag, type TagState, sortedVideos, text, type Field, type ImageRef, type Options, type Plan, type Query, type Rule, type Snapshot, type Video } from './model';

type Panel = null | 'sources' | 'field' | 'edit' | 'move' | 'options' | 'history' | 'save' | 'detail';
const ratingFitWidth = 110;
const kinds = { text: 'Text', number: 'Number', date: 'Date', tags: 'Tags · multiple values', rating: 'Rating · 0–5 stars' };
const imageCache = new Map<string, string>();

function Cover({ image, workspace, large = false }: { image?: ImageRef; workspace: string; large?: boolean }) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setSource(''); setFailed(false);
    if (!image || !desktop) return;
    const key = `${workspace}:${image.id}:${image.path}`;
    let active = true;
    const cached = imageCache.get(key);
    if (cached) { setSource(cached); return; }
    request<string>({ action: 'image', id: image.id }).then(data => {
      imageCache.set(key, data); if (active) setSource(data);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [image, workspace]);
  return <div className={`cover ${large ? 'cover-large' : ''}`}>
    {source && !failed ? <img src={source} alt={image?.cover ? 'Cover image' : 'Additional image'} loading="lazy" onError={() => setFailed(true)} />
      : <><ImageIcon size={large ? 38 : 24} strokeWidth={1.2} /><span>{failed ? 'Cannot read image' : image ? 'Loading' : 'No image'}</span></>}
  </div>;
}

function Stars({ value }: { value: number | null }) {
  return <span className="stars" style={{ '--fill': `${(value ?? 0) * 20}%` } as CSSProperties} aria-hidden="true" />;
}

function StarDisplay({ value }: { value: unknown }) {
  if (typeof value !== 'number') return <span className="empty-value" title="Not rated">—</span>;
  return <span className="star-display" title={ratingText(value)}><Stars value={value} /><small>{value}</small></span>;
}

/** Click the left or right half of a star for x.5 or x. Arrow keys step by 0.5; Delete clears to "not rated". */
function StarTrack({ value, onChange, onHover, label = 'Rating' }: { value: number | null; onChange: (value: number | null) => void; onHover?: (value: number | null) => void; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const preview = (n: number | null) => { setHover(n); onHover?.(n); };
  const step = (delta: number) => onChange(Math.min(5, Math.max(0, value == null ? (delta > 0 ? 0.5 : 0) : value + delta)));
  const keys: Record<string, () => void> = { ArrowRight: () => step(0.5), ArrowUp: () => step(0.5), ArrowLeft: () => step(-0.5), ArrowDown: () => step(-0.5), Home: () => onChange(0), End: () => onChange(5), Delete: () => onChange(null), Backspace: () => onChange(null) };
  return <div className="star-track" role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={5} aria-valuenow={value ?? undefined} aria-valuetext={ratingText(value)}
    onKeyDown={e => { if (keys[e.key]) { e.preventDefault(); keys[e.key](); } }} onMouseLeave={() => preview(null)}>
    <span className="star-area"><Stars value={hover ?? value} />
      {ratingSteps.slice(1).map(n => <button key={n} type="button" tabIndex={-1} className="star-hit" style={{ left: `${(n - 0.5) * 20}%` }} aria-label={`${n} stars`} onMouseEnter={() => preview(n)} onClick={() => onChange(n)} />)}
      <button type="button" tabIndex={-1} className="star-hit star-edge star-zero" aria-label="0 stars" onMouseEnter={() => preview(0)} onClick={() => onChange(0)} />
      <button type="button" tabIndex={-1} className="star-hit star-edge star-max" aria-label="5 stars" onMouseEnter={() => preview(5)} onClick={() => onChange(5)} />
    </span>
  </div>;
}

function StarInput({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  return <div className="star-input">
    <StarTrack value={value} onChange={onChange} onHover={setHover} />
    <span className="star-readout">{ratingText(hover ?? value)}</span>
    <button type="button" className="text-button" disabled={value === 0} onClick={() => onChange(0)}>0 stars</button>
    <button type="button" className="text-button muted" disabled={value == null} onClick={() => onChange(null)}>Clear</button>
  </div>;
}

const tagStateLabel: Record<TagState, string> = { all: 'Must have', any: 'Any of', none: 'Excluded' };

/** Tag filter: click = must have (AND), Ctrl+click = any of (OR), right-click = exclude (NOT); repeating an action clears it. */
function TagFilter({ field, videos, rule, onChange, alignRight }: { field: Field; videos: Video[]; rule?: Rule; onChange: (rule: Rule | null) => void; alignRight: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const set = tagSet(rule);
  const untagged = rule?.op === 'empty';
  const counts = useMemo(() => tagCounts(videos, String(field.id)), [videos, field.id]);
  const shown = counts.filter(([tag]) => tag.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const stateOf = (tag: string) => (Object.keys(set) as TagState[]).find(key => set[key].includes(tag));
  const toggle = (tag: string, state: TagState) => {
    const next = toggleTag(untagged ? tagSet() : set, tag, state);
    onChange(tagSetEmpty(next) ? null : { field: String(field.id), op: 'tags', value: next });
  };
  const summary = untagged ? 'No tags' : [`${set.all.length} AND`, `${set.any.length} OR`, `${set.none.length} NOT`].filter(part => !part.startsWith('0 ')).join(' · ') || 'Any';
  const detail = (Object.keys(set) as TagState[]).filter(key => set[key].length).map(key => `${tagStateLabel[key]}: ${set[key].join(', ')}`).join('\n');
  const close = () => { setOpen(false); setSearch(''); };
  return <div className="tag-filter">
    <button id={`filter-${field.id}`} type="button" className="tag-filter-button" aria-haspopup="dialog" aria-expanded={open} title={detail || undefined} onClick={() => open ? close() : setOpen(true)}><span>{summary}</span><ChevronDown size={13} /></button>
    {open && <><div className="menu-dismiss" onClick={close} /><div className={`tag-panel${alignRight ? ' align-right' : ''}`} role="dialog" aria-label={`${field.name} tag filter`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <div className="search-box tag-search"><Search size={14} /><input autoFocus aria-label="Search tags" placeholder="Search tags" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="tag-options">{shown.map(([tag, count]) => {
        const state = stateOf(tag);
        return <button key={tag} type="button" className={`tag-option${state ? ` state-${state}` : ''}`} aria-pressed={!!state} title={state ? `${tagStateLabel[state]} · ${count} videos` : `${count} videos`}
          onClick={e => toggle(tag, e.ctrlKey || e.metaKey ? 'any' : 'all')} onContextMenu={e => { e.preventDefault(); toggle(tag, 'none'); }}
          onKeyDown={e => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); toggle(tag, 'none'); } }}>{state === 'any' && <span className="tag-mark">~</span>}<span className="tag-name">{tag}</span><small>{count}</small></button>;
      })}{!shown.length && <p className="muted tag-empty">{counts.length ? 'No matching tags.' : 'No tags yet.'}</p>}</div>
      <div className="tag-panel-footer"><span>Click: must have · Ctrl+click: any of · Right-click: exclude</span>
        <button type="button" className={`text-button${untagged ? ' active' : ''}`} aria-pressed={untagged} onClick={() => onChange(untagged ? null : { field: String(field.id), op: 'empty' })}>No tags</button>
        <button type="button" className="text-button muted" disabled={!rule} onClick={() => onChange(null)}>Clear</button></div>
    </div></>}
  </div>;
}

function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('input,select,button:not(.icon-button)') || ref.current)?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab' && ref.current) {
        const elements = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
        if (elements.length === 0) { event.preventDefault(); return; }
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={19} /></button></div>
      {children}
    </div>
  </div>;
}

export default function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [status, setStatus] = useState('Your own organizing space for local files');
  const [error, setError] = useState('');
  const [query, setQuery] = useState<Query>({ search: '', mode: 'AND', rules: [] });
  const [preset, setPreset] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'list' | 'gallery'>('list');
  const [sort, setSort] = useState({ key: 'name', reverse: false });
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const [allFilters, setAllFilters] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('text');
  const [fieldId, setFieldId] = useState('');
  const [editValue, setEditValue] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [multiple, setMultiple] = useState('group');
  const [group, setGroup] = useState('Multiple values');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [crossConfirmed, setCrossConfirmed] = useState(false);
  const [moveConfirmed, setMoveConfirmed] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [player, setPlayer] = useState('');
  const [format, setFormat] = useState('m3u8');
  const [draft, setDraft] = useState<Options>({ unclassified_folder: '', shared_folder: '', page_size: 100, visible_fields: 6 });
  const [resetOrder, setResetOrder] = useState({ column: false, filter: false, widths: false });
  const [reopenLast, setReopenLast] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailImage, setDetailImage] = useState(0);
  const [comparisons, setComparisons] = useState<Record<string, Rule['op']>>({});
  const [drag, setDrag] = useState<{ kind: 'column' | 'filter'; key: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const anchor = useRef<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [columnSelection, setColumnSelection] = useState<string[]>([]);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);
  const [unhide, setUnhide] = useState<{ x: number; y: number; chosen: string[] } | null>(null);
  const resizing = useRef(false);
  const [editing, setEditing] = useState<{ id: number; field: string; original: string } | null>(null);
  const editingRef = useRef(editing);
  const [cellValue, setCellValue] = useState('');
  const [tagDraft, setTagDraft] = useState<{ id: number; field: string } | null>(null);
  const tagDraftRef = useRef(tagDraft);
  const [tagText, setTagText] = useState('');

  const load = (snapshot: Snapshot) => { setData(snapshot); setSelected(new Set()); setPlayer(snapshot.player); setFormat(snapshot.playlist_format); };
  async function run<T,>(payload: Record<string, unknown>, done?: (value: T) => void, message = 'Done.') {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setStatus('Working…');
    try { const result = await request<T>(payload); done?.(result); setStatus(message); }
    catch (e) {
      setError(String(e)); setStatus('The operation could not be completed.');
      if (data) { try { setData(await request<Snapshot>({ action: 'snapshot' })); } catch { /* original error remains visible */ } }
    } finally { busyRef.current = false; setBusy(false); }
  }
  // Inline list editing keeps the current selection, so it applies the snapshot without load().
  function saveCell(id: number, field: string, value: string) {
    if (busyRef.current) { setError('Wait for the current operation to finish, then edit again.'); return; }
    void run<Snapshot>({ action: 'set_values', ids: [id], field: Number(field), value }, setData, 'Field value saved.');
  }
  function startEdit(id: number, field: string, value: unknown) {
    const next = { id, field, original: text(value) };
    editingRef.current = next; setEditing(next); setCellValue(next.original);
  }
  function commitCell() {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null; setEditing(null);
    if (cellValue.trim() !== current.original) saveCell(current.id, current.field, cellValue);
  }
  useEffect(() => {
    if (!desktop) return;
    void run<Snapshot | null>({ action: 'startup' }, s => { if (s) load(s); }, 'Choose a workspace to get started.');
    const unlisten = listen<string>('catalog-progress', e => setStatus(e.payload));
    const closeListener = getCurrentWindow().onCloseRequested(event => {
      if (busyRef.current) { event.preventDefault(); setError('Cancel the operation and wait for it to stop before closing the window.'); }
    });
    return () => { void unlisten.then(fn => fn()); void closeListener.then(fn => fn()); };
    // Startup IPC and progress listener are intentionally registered once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => sortedVideos(data?.videos || [], query, sort.key, sort.reverse), [data, query, sort]);
  const pageSize = data?.options.page_size || 100;
  const visibleFields = data?.options.visible_fields || 6;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const chosen = rows.filter(r => selected.has(r.id));
  const detail = data?.videos.find(v => v.id === detailId);
  const fieldsById = new Map((data?.fields || []).map(f => [String(f.id), f]));
  const filterOrder = ordered([...fieldsById.keys()], data?.filter_order);
  const filterFields = filterOrder.map(key => fieldsById.get(key)!).slice(0, allFilters ? undefined : visibleFields);
  const columnOrder = ordered(['name', ...fieldsById.keys(), 'size'], data?.column_order);
  let shownFieldColumns = 0;
  // Hidden columns keep their order and width settings, so showing them again restores both.
  const hiddenColumns = data?.hidden_columns || [];
  const shownColumns = columnOrder.filter(key => key === 'name' || key === 'size' || shownFieldColumns++ < visibleFields);
  const columns = shownColumns.filter(key => !hiddenColumns.includes(key));
  const hiddenShown = shownColumns.filter(key => hiddenColumns.includes(key));
  const columnLabel = (key: string) => key === 'name' ? 'File name' : key === 'size' ? 'Size' : fieldsById.get(key)?.name || key;
  const activeRules = query.rules || [];
  // Until a column is resized the table fills the width; afterwards every column uses an exact pixel width.
  const customWidths = Object.keys(data?.column_widths || {}).length > 0;
  const defaultWidth = (key: string) => {
    const kind = fieldsById.get(key)?.kind;
    return key === 'name' ? 280 : key === 'size' || kind === 'number' ? 85 : kind === 'rating' ? 130 : kind === 'date' ? 110 : 150;
  };
  const widthOf = (key: string) => data?.column_widths[key] ?? defaultWidth(key);
  const tableWidth = 42 + 32 + columns.reduce((sum, key) => sum + widthOf(key), 0);
  // Header widths as rendered now, so the first resize or auto-fit does not make other columns jump.
  function frozenWidths(table: HTMLTableElement) {
    const headers = [...table.querySelectorAll<HTMLElement>('th[data-col]')];
    const fixed = [...table.querySelectorAll<HTMLElement>('thead th:not([data-col])')].reduce((sum, th) => sum + th.getBoundingClientRect().width, 0);
    const widths: Record<string, number> = Object.fromEntries(headers.map(th => [th.dataset.col!, Math.round(th.getBoundingClientRect().width)]));
    const apply = () => {
      headers.forEach(th => { th.style.width = `${widths[th.dataset.col!]}px`; });
      table.style.width = `${fixed + Object.values(widths).reduce((a, b) => a + b, 0)}px`;
    };
    const restore = () => { headers.forEach(th => { th.style.width = ''; }); table.style.width = ''; };
    return { widths, apply, restore };
  }
  function saveWidths(widths: Record<string, number>) {
    const saved = { ...data?.column_widths, ...widths };
    setData(previous => previous && { ...previous, column_widths: saved });
    request({ action: 'setting', key: 'column_widths', value: saved }).catch(err => setError(String(err)));
  }
  const minWidth = (key: string) => key === 'name' ? 120 : 50;
  function startResize(e: PointerEvent<HTMLSpanElement>, key: string) {
    const table = tableRef.current;
    if (e.button !== 0 || !table) return;
    e.preventDefault(); e.stopPropagation();
    resizing.current = true;
    const handle = e.currentTarget;
    const { widths, apply, restore } = frozenWidths(table);
    const startX = e.clientX, start = widths[key];
    let moved = false;
    const move = (ev: globalThis.PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 2) return;
      moved = true;
      widths[key] = Math.min(2000, Math.max(minWidth(key), Math.round(start + ev.clientX - startX)));
      apply();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      resizing.current = false;
      // A plain click (or the first click of a double-click) must not freeze the layout.
      if (moved) saveWidths(widths); else if (!customWidths) restore();
    };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }
  /** Fits a column to its widest value across all videos, like double-clicking a column border in Excel. */
  function autoFit(key: string) {
    const table = tableRef.current;
    const context = document.createElement('canvas').getContext('2d');
    if (!table || !context || !data) return;
    const family = getComputedStyle(table).fontFamily;
    const measure = (value: string, px: number, weight = 400) => { context.font = `${weight} ${px}px ${family}`; return context.measureText(value).width; };
    const field = fieldsById.get(key);
    const content = (video: Video) => {
      if (key === 'name') return 14 + 8 + measure(filename(video.path), 11, 500);
      if (key === 'size') return measure(size(video.size), 10);
      const value = video.values[key];
      if (Array.isArray(value)) {
        const chips = value.slice(0, 2).map(v => Math.min(80, measure(text(v), 10) + 10));
        return chips.reduce((a, b) => a + b, 0) + 3 * Math.max(0, chips.length - 1) + (value.length > 2 ? 3 + measure(`+${value.length - 2}`, 9) : 0);
      }
      return measure(text(value) || '—', 11, field?.kind === 'number' ? 650 : 400);
    };
    const label = key === 'name' ? 'File name' : key === 'size' ? 'Size' : field?.name || key;
    const widest = Math.max(measure(label, 10, 600) + 6 + 12, ...data.videos.map(content));
    const { widths, apply } = frozenWidths(table);
    // Rating cells always hold five stars plus a short score, so they fit to a fixed width.
    widths[key] = field?.kind === 'rating' ? ratingFitWidth : Math.min(2000, Math.max(minWidth(key), Math.ceil(widest + 20 + 8)));
    apply();
    saveWidths(widths);
  }
  function saveHidden(hidden: string[]) {
    const next = [...new Set(hidden)];
    setData(previous => previous && { ...previous, hidden_columns: next });
    request({ action: 'setting', key: 'hidden_columns', value: next }).catch(e => setError(String(e)));
  }
  function openColumnMenu(e: MouseEvent) {
    e.preventDefault();
    const key = (e.target as Element).closest<HTMLElement>('th[data-col]')?.dataset.col;
    const keys = key ? (columnSelection.includes(key) ? columnSelection : [key]) : columnSelection;
    if (key && !columnSelection.includes(key)) setColumnSelection([key]);
    setUnhide(null);
    setColumnMenu({ x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 150), keys });
  }
  function hideColumns(keys: string[]) {
    saveHidden([...hiddenColumns, ...keys]);
    setColumnSelection([]); setColumnMenu(null);
  }
  function saveOrder(setting: 'column_order' | 'filter_order', order: string[]) {
    setData(previous => previous && { ...previous, [setting]: order });
    request({ action: 'setting', key: setting, value: order }).catch(e => setError(String(e)));
  }
  function dragSource(kind: 'column' | 'filter', key: string) {
    return {
      draggable: !busy,
      title: 'Drag to reorder',
      onDragStart: (e: DragEvent) => { if (resizing.current) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); setDrag({ kind, key }); },
      onDragEnd: () => { setDrag(null); setDragOver(null); },
    };
  }
  function dropTarget(kind: 'column' | 'filter', key: string) {
    const setting = kind === 'column' ? 'column_order' : 'filter_order';
    return {
      onDragOver: (e: DragEvent) => { if (drag?.kind !== kind) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(key); },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (drag?.kind === kind && drag.key !== key) saveOrder(setting, moveKey(kind === 'column' ? columnOrder : filterOrder, drag.key, key));
        setDrag(null); setDragOver(null);
      },
    };
  }
  const dragClass = (kind: 'column' | 'filter', key: string) => drag?.kind !== kind ? '' : drag.key === key ? ' dragging' : dragOver === key ? ' drag-over' : '';
  const changeQuery = (q: Query) => { setQuery(q); setPage(0); setSelected(new Set()); setPreset(''); };
  const setRule = (field: Field, rule: Rule | null) => changeQuery({ ...query, rules: [...activeRules.filter(r => String(r.field) !== String(field.id)), ...(rule ? [rule] : [])] });
  const close = () => { if (!busy) setPanel(null); };

  async function openWorkspace() {
    try {
      if (!desktop) { setError('Folders can only be opened in the desktop app.'); return; }
      const path = await chooseFolder();
      if (!path) return;
      await run<Snapshot>({ action: 'open', path }, s => { load(s); changeQuery({ rules: [], mode: 'AND', search: '' }); }, 'Workspace opened.');
    } catch (e) { setError(String(e)); }
  }
  function scanResult(result: { snapshot: Snapshot; warnings: string[] }) { load(result.snapshot); if (result.warnings.length) setError(result.warnings.join('\n')); }
  async function addSource() {
    try { const path = await chooseFolder(); if (path) await run({ action: 'add_source', path, recursive }, scanResult, 'Folder registered and videos loaded.'); }
    catch (e) { setError(String(e)); }
  }
  function openPanel(which: Panel) {
    setMenu(false); setName(''); setError('');
    if (which === 'edit' || which === 'move') {
      const field = data?.fields[0];
      setFieldId(field ? String(field.id) : '');
      setEditValue(chosen.length === 1 && field ? text(chosen[0].values[String(field.id)]) : '');
      setPlan(null); setOverrides({}); setMultiple('group'); setGroup(data?.options.shared_folder || 'Multiple values'); setAcknowledged(false); setCrossConfirmed(false); setMoveConfirmed(false);
      setResuming(false);
    }
    if (which === 'options' && data) { setDraft(data.options); setPlayer(data.player); setFormat(data.playlist_format); setResetOrder({ column: false, filter: false, widths: false }); request<{ reopen_last: boolean }>({ action: 'preferences' }).then(p => setReopenLast(p.reopen_last)).catch(e => setError(String(e))); }
    setPanel(which);
  }
  function toggleSelection(video: Video, shift = false) {
    setSelected(previous => {
      const next = new Set(previous);
      if (shift && anchor.current != null) {
        const start = rows.findIndex(r => r.id === anchor.current), end = rows.findIndex(r => r.id === video.id);
        rows.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(r => next.add(r.id));
      } else { if (next.has(video.id)) next.delete(video.id); else next.add(video.id); }
      return next;
    });
    anchor.current = video.id;
  }
  function sortBy(key: string) { setSort({ key, reverse: sort.key === key ? !sort.reverse : false }); }
  const sortIcon = (key: string) => sort.key === key ? (sort.reverse ? <ArrowDown size={12} /> : <ArrowUp size={12} />) : <ArrowUpDown size={11} className="dim" />;
  function selectPreset(value: string) {
    setPreset(value); setPage(0); setSelected(new Set());
    const folder = data?.folders.find(f => f.name === value);
    setQuery(folder ? structuredClone(folder.query) : { search: '', rules: [], mode: 'AND' });
  }
  const invalidatePlan = () => { setPlan(null); setMoveConfirmed(false); setCrossConfirmed(false); setAcknowledged(false); };
  const selectedField = data?.fields.find(f => String(f.id) === fieldId);
  const multiVideos = multiple === 'ask' ? chosen.filter(v => Array.isArray(v.values[fieldId]) && (v.values[fieldId] as unknown[]).length > 1) : [];
  async function addImage(cover: boolean) {
    if (!detail) return;
    try { const path = await chooseFile(true); if (path) await run<Snapshot>({ action: 'add_image', id: detail.id, path, cover }, s => { load(s); setDetailImage(0); }, 'Image added.'); }
    catch (e) { setError(String(e)); }
  }

  return <div className="app">
    <header className="topbar">
      <div className="wordmark"><span className="brand-mark"><Filter size={18} /></span>filterer<span className="edition">LOCAL EXPLORER</span></div>
      <nav><span className="nav-active">Explore videos</span><span className="local-badge"><i />Local workspace</span></nav>
      <button className="top-button" disabled={busy} onClick={() => void openWorkspace()}><FolderOpen size={15} />{data ? 'Change workspace' : 'Open workspace'}</button>
    </header>

    {columnMenu && <><div className="menu-dismiss" onClick={() => setColumnMenu(null)} onContextMenu={e => { e.preventDefault(); setColumnMenu(null); }} /><div className="dropdown-menu context-menu" role="menu" style={{ left: columnMenu.x, top: columnMenu.y }}>
      {(() => { const keys = columnMenu.keys; return <button role="menuitem" disabled={!keys.length} onClick={() => hideColumns(keys)}><EyeOff size={15} />{keys.length > 1 ? `Hide ${keys.length} columns` : keys.length ? `Hide “${columnLabel(keys[0])}”` : 'Hide column'}</button>; })()}
      <button role="menuitem" disabled={!hiddenShown.length} onClick={() => { saveHidden([]); setColumnMenu(null); }}><Eye size={15} />Show all hidden columns{hiddenShown.length ? ` (${hiddenShown.length})` : ''}</button>
      <button role="menuitem" disabled={!hiddenShown.length} onClick={() => { setUnhide({ x: columnMenu.x, y: columnMenu.y, chosen: [] }); setColumnMenu(null); }}><Eye size={15} />Show hidden columns…</button>
    </div></>}
    {unhide && <><div className="menu-dismiss" onClick={() => setUnhide(null)} /><div className="tag-panel unhide-panel" role="dialog" aria-label="Show hidden columns" style={{ left: Math.min(unhide.x, window.innerWidth - 300), top: unhide.y }} onKeyDown={e => { if (e.key === 'Escape') setUnhide(null); }}>
      <strong className="unhide-title">Hidden columns</strong>
      <div className="tag-options">{hiddenShown.map(key => { const on = unhide.chosen.includes(key); return <button key={key} type="button" autoFocus={key === hiddenShown[0]} className={`tag-option${on ? ' state-all' : ''}`} aria-pressed={on} onClick={() => setUnhide({ ...unhide, chosen: on ? unhide.chosen.filter(k => k !== key) : [...unhide.chosen, key] })}><span className="tag-name">{columnLabel(key)}</span></button>; })}</div>
      <div className="tag-panel-footer"><span>{unhide.chosen.length} selected</span><button type="button" className="text-button muted" onClick={() => setUnhide(null)}>Cancel</button><button type="button" className="primary unhide-ok" disabled={!unhide.chosen.length} onClick={() => { saveHidden(hiddenColumns.filter(k => !unhide.chosen.includes(k))); setUnhide(null); }}>OK</button></div>
    </div></>}
    {error && <div className="notice error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}

    {!data ? <main className="welcome">
      <div className="welcome-art"><FolderOpen size={42} strokeWidth={1.3} /><span><Check size={17} /></span></div>
      <span className="eyebrow">YOUR VIDEOS, YOUR RULES</span><h1>Easy to find. Easy to organize.</h1>
      <p>Load your folders and narrow them down with your own fields.<br />Selected videos can be organized into real folders by the criteria you choose.</p>
      <div className="welcome-actions"><button className="primary" disabled={busy} onClick={() => void openWorkspace()}><FolderOpen size={17} />Open / create workspace</button></div>
      <div className="welcome-steps"><div><span>01</span><strong>Load folders</strong><small>Many source folders in one workspace</small></div><div><span>02</span><strong>Classify and find</strong><small>Filter fast by tags, scores, and dates</small></div><div><span>03</span><strong>Select and organize</strong><small>Preview, then move with related files</small></div></div>
      {!desktop && <p className="browser-hint">Desktop features are available in the Tauri app.</p>}
    </main> : <main className="explorer">
      <section className="workspace-bar">
        <div className="workspace-title"><span className="workspace-icon"><Folder size={21} /></span><div><h1>{filename(data.root)}</h1><p title={data.root}>{data.root}</p></div></div>
        <div className="workspace-actions"><span className="source-count">{data.sources.length} source {data.sources.length === 1 ? 'folder' : 'folders'}</span><button disabled={busy} onClick={() => openPanel('sources')}><FolderPlus size={15} />Add folder</button>
          <button className="icon-button" aria-label="Options" title="Options" disabled={busy} onClick={() => openPanel('options')}><Settings2 size={18} /></button>
          <div className="menu-anchor"><button className="icon-button" aria-label="More" aria-expanded={menu} disabled={busy} onClick={() => setMenu(!menu)}><MoreHorizontal size={20} /></button>
            {menu && <><div className="menu-dismiss" onClick={() => setMenu(false)} /><div className="dropdown-menu">
              <button onClick={() => { setMenu(false); void run({ action: 'scan' }, scanResult, 'List refreshed.'); }}><RefreshCw size={15} />Rescan source folders</button>
              <button onClick={() => openPanel('field')}><Tag size={15} />Add field</button><button onClick={() => openPanel('history')}><List size={15} />Move history</button>
            </div></>}
          </div>
        </div>
      </section>

      <section className="screener">
        <div className="screener-heading"><div className="section-label"><SlidersHorizontal size={15} />Filters<span className="count-badge">{activeRules.length}</span></div>
          <div className="preset-controls"><select aria-label="Saved filters" value={preset} onChange={e => selectPreset(e.target.value)}><option value="">Saved filters</option>{data.folders.map(f => <option key={f.name}>{f.name}</option>)}</select>
            <button className="text-button" disabled={busy} onClick={() => openPanel('save')}>Save current filters</button><span className="divider" /><button className="text-button muted" onClick={() => changeQuery({ rules: [], mode: 'AND', search: '' })}>Reset</button><button className="icon-button" aria-label={showFilters ? 'Collapse filters' : 'Expand filters'} onClick={() => setShowFilters(!showFilters)}><ChevronDown className={showFilters ? 'rotated' : ''} size={16} /></button>
          </div>
        </div>
        {showFilters && <div className="filter-grid">
          {filterFields.map((field, index) => {
            const rule = activeRules.find(r => String(r.field) === String(field.id));
            const numeric = field.kind === 'number' || field.kind === 'date' || field.kind === 'rating';
            const values = [...new Set(data.videos.flatMap(v => { const value = v.values[String(field.id)]; return Array.isArray(value) ? value.map(text) : value == null ? [] : [text(value)]; }))].sort((a, b) => a.localeCompare(b));
            return <div className={`filter-cell ${rule ? 'filter-active' : ''}${dragClass('filter', String(field.id))}`} key={field.id} {...dropTarget('filter', String(field.id))}><label htmlFor={`filter-${field.id}`} {...dragSource('filter', String(field.id))}><GripVertical size={11} className="grip" />{field.name}{rule && <i />}</label>
              {numeric ? <div className="numeric-filter"><select aria-label={`${field.name} comparison`} value={rule?.op || comparisons[String(field.id)] || 'gte'} onChange={e => { const op = e.target.value as Rule['op']; setComparisons({ ...comparisons, [String(field.id)]: op }); setRule(field, op === 'empty' || rule?.value != null && rule.value !== '' ? { field: String(field.id), op, value: rule?.value } : null); }}><option value="gte">At least</option><option value="lte">At most</option><option value="eq">Equals</option><option value="empty">{field.kind === 'rating' ? 'Not rated' : 'Empty'}</option></select>
                {field.kind === 'rating' ? <select id={`filter-${field.id}`} aria-label={`${field.name} filter`} disabled={rule?.op === 'empty'} value={rule?.op === 'empty' ? '' : text(rule?.value)} onChange={e => setRule(field, e.target.value ? { field: String(field.id), op: rule?.op || comparisons[String(field.id)] || 'gte', value: Number(e.target.value) } : null)}><option value="">Any</option>{ratingSteps.map(n => <option key={n} value={n}>{n} ★</option>)}</select>
                : <input id={`filter-${field.id}`} aria-label={`${field.name} filter`} disabled={rule?.op === 'empty'} placeholder="Any" type={field.kind === 'date' ? 'date' : 'number'} value={rule?.op === 'empty' ? '' : text(rule?.value)} onChange={e => setRule(field, e.target.value ? { field: String(field.id), op: rule?.op || comparisons[String(field.id)] || 'gte', value: field.kind === 'number' ? Number(e.target.value) : e.target.value } : null)} />}{rule && <button className="clear-inline" aria-label={`Clear ${field.name} filter`} onClick={() => setRule(field, null)}><X size={12} /></button>}</div>
                : field.kind === 'tags' ? <TagFilter field={field} videos={data.videos} rule={rule} onChange={r => setRule(field, r)} alignRight={index % 6 >= 3} />
                : <select id={`filter-${field.id}`} aria-label={`${field.name} filter`} value={rule ? rule.op === 'empty' ? 'empty' : `v:${text(rule.value)}` : ''} onChange={e => setRule(field, e.target.value ? { field: String(field.id), op: e.target.value === 'empty' ? 'empty' : 'eq', value: e.target.value.slice(2) } : null)}><option value="">Any</option><option value="empty">Empty</option>{values.map(v => <option key={v} value={`v:${v}`}>{v}</option>)}</select>}
            </div>;
          })}
          {!data.fields.length && <div className="filter-onboarding"><Tag size={16} /><span>Add a field to filter by it here.</span><button className="text-button" onClick={() => openPanel('field')}>Add field</button></div>}
          {data.fields.length > visibleFields && <button className="text-button more-filters" onClick={() => setAllFilters(!allFilters)}>{allFilters ? 'Show default filters only' : `Show ${data.fields.length - visibleFields} more filters`}</button>}
        </div>}
        {activeRules.length > 0 && <div className="filter-summary"><span>{query.mode === 'OR' ? 'Match any condition' : 'Match all conditions'}</span><button className="text-button" onClick={() => changeQuery({ ...query, mode: query.mode === 'OR' ? 'AND' : 'OR' })}>Toggle AND / OR</button></div>}
      </section>

      <section className="results">
        <div className="results-toolbar"><div className="result-tabs"><button className={view === 'list' ? 'tab active' : 'tab'} onClick={() => setView('list')}><List size={15} />List</button><button className={view === 'gallery' ? 'tab active' : 'tab'} onClick={() => setView('gallery')}><Grid2X2 size={14} />Covers</button><span className="result-total">{rows.length.toLocaleString()}<span> / {data.videos.length.toLocaleString()}</span></span></div>
          <div className="search-box"><Search size={15} /><input aria-label="Search videos" placeholder="Search file name, path, or field values" value={query.search || ''} onChange={e => changeQuery({ ...query, search: e.target.value })} />{query.search && <button className="icon-button" aria-label="Clear search" onClick={() => changeQuery({ ...query, search: '' })}><X size={13} /></button>}</div>
        </div>
        {selected.size > 0 && <div className="selection-bar"><div><CheckSquare size={15} /><strong>{selected.size} selected</strong><button className="text-button" onClick={() => setSelected(new Set())}>Clear</button></div><div>
          <button disabled={busy} onClick={() => void run({ action: 'play', ids: chosen.map(v => v.id), playlist: true }, undefined, 'Opened a new playlist with the selected videos.')}><Play size={14} />Play</button>
          <button disabled={busy} onClick={() => openPanel('edit')}><Tag size={14} />Edit fields</button>
          <button className="primary" disabled={busy} onClick={() => openPanel('move')}><FolderOpen size={14} />Organize folders</button>
        </div></div>}

        {view === 'list' ? <div className="table-container"><table ref={tableRef} style={customWidths ? { width: tableWidth } : undefined}><thead onContextMenu={openColumnMenu}><tr><th className="checkbox-col"><input type="checkbox" aria-label="Select all on this page" checked={pageRows.length > 0 && pageRows.every(v => selected.has(v.id))} onChange={e => setSelected(prev => { const next = new Set(prev); pageRows.forEach(v => e.target.checked ? next.add(v.id) : next.delete(v.id)); return next; })} /></th>{columns.map(key => {
            const field = fieldsById.get(key);
            const className = key === 'name' ? 'filename-col' : key === 'size' || field?.kind === 'number' ? 'numeric' : '';
            return <th key={key} data-col={key} style={customWidths ? { width: widthOf(key) } : undefined} className={`draggable-col ${className}${dragClass('column', key)}${columnSelection.includes(key) ? ' col-selected' : ''}`} {...dragSource('column', key)} {...dropTarget('column', key)}><button title="Click to sort · Ctrl+click to select · Right-click for options" onClick={e => {
              if (e.ctrlKey || e.metaKey) { setColumnSelection(columnSelection.includes(key) ? columnSelection.filter(k => k !== key) : [...columnSelection, key]); return; }
              setColumnSelection([]); sortBy(key);
            }}>{key === 'name' ? 'File name' : key === 'size' ? 'Size' : field?.name}{sortIcon(key)}</button><span className="col-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${key === 'name' ? 'File name' : key === 'size' ? 'Size' : field?.name} column`} title="Drag to resize · Double-click to fit" onPointerDown={e => startResize(e, key)} onClick={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); autoFit(key); }} /></th>;
          })}<th className="actions-col" /></tr></thead>
          <tbody>{pageRows.map(video => <tr key={video.id} className={selected.has(video.id) ? 'row-selected' : ''} onClick={e => toggleSelection(video, e.shiftKey)} onDoubleClick={() => void run({ action: 'play', ids: [video.id], playlist: false }, undefined, 'Video opened.')}>
            <td><input type="checkbox" aria-label={`Select ${filename(video.path)}`} checked={selected.has(video.id)} onChange={() => toggleSelection(video)} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} /></td>{columns.map(key => {
              if (key === 'name') return <td key={key} className="filename-cell" title={video.path}><span><FileVideo size={14} /><strong>{filename(video.path)}</strong></span></td>;
              if (key === 'size') return <td key={key} className="numeric size-cell">{size(video.size)}</td>;
              const value = video.values[key];
              const kind = fieldsById.get(key)?.kind;
              const open = selected.has(video.id);
              // Selected rows edit in place; unselected rows keep the click-to-select behavior.
              const hold = open ? { onClick: (e: MouseEvent) => { if (!e.shiftKey) e.stopPropagation(); }, onDoubleClick: (e: MouseEvent) => e.stopPropagation() } : {};
              if (kind === 'rating') return <td key={key} className={`rating-cell${open ? ' rating-editable' : ''}`} {...hold}>{open
                ? <span className="star-display"><StarTrack label={`${fieldsById.get(key)?.name} rating`} value={typeof value === 'number' ? value : null} onChange={v => saveCell(video.id, key, v == null ? '' : String(v))} /><small>{typeof value === 'number' ? value : ''}</small>{typeof value === 'number' && <button className="icon-button clear-rating" aria-label="Clear rating" title="Clear rating (not rated)" onClick={() => saveCell(video.id, key, '')}><X size={11} /></button>}</span>
                : <StarDisplay value={value} />}</td>;
              if (kind === 'tags' && open) {
                const tags = Array.isArray(value) ? value.map(text) : [];
                const name = fieldsById.get(key)?.name;
                const save = (next: string[]) => saveCell(video.id, key, next.join(', '));
                const add = () => { const extra = tagText.split(',').map(t => t.trim()).filter((t, i, all) => t && !tags.includes(t) && all.indexOf(t) === i); setTagText(''); if (extra.length) save([...tags, ...extra]); };
                const closeDraft = () => { tagDraftRef.current = null; setTagDraft(null); setTagText(''); };
                const adding = tagDraft?.id === video.id && tagDraft.field === key;
                return <td key={key} className="tag-cell-editable" title={tags.join(', ')} {...hold}><span className="tag-list tag-list-edit">
                  {tags.map(t => <span className="tag-chip tag-chip-edit" key={t}><span>{t}</span><button type="button" className="tag-remove" aria-label={`Remove tag ${t}`} title="Remove tag" onClick={() => save(tags.filter(x => x !== t))}><X size={10} /></button></span>)}
                  {adding ? <input autoFocus className="tag-input" aria-label={`New ${name} tag`} placeholder="New tag" value={tagText} onChange={e => setTagText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } else if (e.key === 'Escape') { e.preventDefault(); closeDraft(); } }}
                    onBlur={() => { if (!tagDraftRef.current) return; add(); closeDraft(); }} />
                    : <button type="button" className="tag-add" aria-label={`Add ${name} tag`} title="Add tag" onClick={() => { const next = { id: video.id, field: key }; tagDraftRef.current = next; setTagText(''); setTagDraft(next); }}><Plus size={9} strokeWidth={2.6} /></button>}
                </span></td>;
              }
              if (editing?.id === video.id && editing.field === key) return <td key={key} className="editing-cell" {...hold}><input autoFocus className="cell-input" aria-label={`Edit ${fieldsById.get(key)?.name}`} type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'} placeholder={kind === 'tags' ? 'Tag A, Tag B' : ''} value={cellValue} onFocus={e => e.target.select()} onChange={e => setCellValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCell(); } else if (e.key === 'Escape') { e.preventDefault(); editingRef.current = null; setEditing(null); } }} onBlur={commitCell} /></td>;
              return <td key={key} className={`${kind === 'number' ? 'numeric score-cell' : ''}${open ? ' editable-cell' : ''}`} title={text(value) || (open ? 'Click to edit' : undefined)} {...hold} onClick={open ? e => { if (e.shiftKey) return; e.stopPropagation(); startEdit(video.id, key, value); } : undefined}>{Array.isArray(value) ? <span className="tag-list">{value.slice(0, 2).map((v, n) => <span className="tag-chip" key={n}>{text(v)}</span>)}{value.length > 2 && <small>+{value.length - 2}</small>}</span> : text(value) || <span className="empty-value">—</span>}</td>;
            })}<td><button className="icon-button row-detail" aria-label={`Details for ${filename(video.path)}`} onDoubleClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setDetailId(video.id); setDetailImage(0); setPanel('detail'); }}><MoreHorizontal size={17} /></button></td>
          </tr>)}</tbody></table></div>
          : <div className="gallery">{pageRows.map(video => <div className={`gallery-card ${selected.has(video.id) ? 'card-selected' : ''}`} key={video.id}>
            <button className="cover-button" aria-label={`Details for ${filename(video.path)}`} onClick={() => { setDetailId(video.id); setDetailImage(0); setPanel('detail'); }}><Cover image={video.images.find(i => i.cover)} workspace={data.root} /></button>
            <label className="card-title"><input type="checkbox" checked={selected.has(video.id)} onChange={() => toggleSelection(video)} /> <span title={video.path}>{filename(video.path)}</span></label><div className="card-meta"><span>{size(video.size)}</span><button className="text-button" disabled={busy} onClick={() => void run({ action: 'play', ids: [video.id], playlist: false }, undefined, 'Video opened.')}><Play size={12} />Play</button></div>
          </div>)}</div>}
        {!rows.length && <div className="empty-results">{data.videos.length ? <><Search size={28} /><h3>No videos match these conditions</h3><p>Try changing the filters or search terms.</p><button onClick={() => changeQuery({ search: '', rules: [], mode: 'AND' })}>Reset conditions</button></> : <><FolderPlus size={30} /><h3>Add your first source folder</h3><p>Videos in the folder will be loaded.</p><button className="primary" onClick={() => openPanel('sources')}>Add folder</button></>}</div>}
        <footer className="table-footer"><span>{selected.size ? `${selected.size} selected · ` : ''}{pageSize} per page<span className="footer-tip">Double-click to play · Shift-click to select a range · Click a field of a selected row to edit · Right-click a column header to hide columns</span></span><div><button className="icon-button" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><strong>{currentPage + 1}</strong><span>/ {pages}</span><button className="icon-button" aria-label="Next page" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div></footer>
      </section>
      <div className="explorer-note"><CircleHelp size={13} /><span>Filters only change the visible list. Actual file moves run from ‘Organize folders’.</span></div>
    </main>}

    <footer className="statusbar" aria-live="polite"><div>{busy ? <LoaderCircle size={13} className="spin" /> : <span className="status-dot" />}{status}</div><div>{busy && <button className="text-button" onClick={() => void cancel()}>Cancel operation</button>}<span>FILTERER 0.2</span></div></footer>

    {panel === 'sources' && data && <Modal title="Source folders" subtitle="Register video folders managed by this workspace." onClose={close}>
      <div className="source-list">{data.sources.map(s => <div className="source-item" key={s.path}><Folder size={18} /><div><strong>{filename(s.path)}</strong><small>{s.path}</small></div><span className="pill">{s.recursive ? 'Includes subfolders' : 'This folder only'}</span></div>)}{!data.sources.length && <p className="muted">No source folders registered yet.</p>}</div>
      <label className="check-label"><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} />Include subfolders when adding a folder</label>
      <div className="modal-actions"><button disabled={busy || !data.sources.length} onClick={() => void run({ action: 'scan' }, scanResult, 'Scan complete.')}><RefreshCw size={14} />Rescan</button><button className="primary" disabled={busy} onClick={() => void addSource()}><FolderPlus size={15} />Choose folder to add</button></div>
    </Modal>}
    {panel === 'field' && data && <Modal title="Add field" subtitle="Create a field to fill in per video and filter by." onClose={close}>
      <label className="form-field">Name<input autoFocus placeholder="e.g. Score, Genre, Release date" value={name} onChange={e => setName(e.target.value)} maxLength={60} /></label><label className="form-field">Type<select value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(kinds).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
      <div className="modal-actions"><button onClick={close}>Cancel</button><button className="primary" disabled={busy || !name.trim()} onClick={() => void run<Snapshot>({ action: 'add_field', name, kind }, s => { load(s); setPanel(null); }, 'Field added.')}>Add field</button></div>
    </Modal>}
    {panel === 'edit' && data && <Modal title="Edit field values" subtitle={`Apply the same value to ${chosen.length} selected ${chosen.length === 1 ? 'video' : 'videos'}.`} onClose={close}>
      {data.fields.length ? <><label className="form-field">Field<select value={fieldId} onChange={e => { setFieldId(e.target.value); setEditValue(chosen.length === 1 ? text(chosen[0].values[e.target.value]) : ''); }}>{data.fields.map(f => <option key={f.id} value={f.id}>{f.name} · {kinds[f.kind]}</option>)}</select></label>{selectedField?.kind === 'rating' ? <div className="form-field">Value<StarInput value={editValue === '' ? null : Number(editValue)} onChange={v => setEditValue(v == null ? '' : String(v))} /></div>
        : <label className="form-field">Value<input autoFocus type={selectedField?.kind === 'number' ? 'number' : selectedField?.kind === 'date' ? 'date' : 'text'} value={editValue} placeholder={selectedField?.kind === 'tags' ? 'Tag A, Tag B' : 'Enter a value'} onChange={e => setEditValue(e.target.value)} /></label>}<p className="form-hint">{selectedField?.kind === 'rating' ? 'Click the left half of a star for a half star. Clear saves “not rated”, which is different from 0 stars.' : 'Saving an empty value clears the existing value of this field.'}</p><div className="modal-actions"><button onClick={close}>Cancel</button><button className="primary" disabled={busy} onClick={() => void run<Snapshot>({ action: 'set_values', ids: chosen.map(v => v.id), field: Number(fieldId), value: editValue }, s => { load(s); setPanel(null); }, 'Field values saved.')}>Apply to selected videos</button></div></>
        : <div className="modal-empty"><Tag size={28} /><p>Create a field first.</p><button className="primary" onClick={() => openPanel('field')}>Add field</button></div>}
    </Modal>}
    {panel === 'save' && data && <Modal title="Save current filters" subtitle="Save the search and filters under a name to load them again." onClose={close}>
      <label className="form-field">Name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. High-score videos" /></label>{!activeRules.length && !query.search && <div className="notice info">No conditions are set, so a view of all videos will be saved.</div>}
      {data.folders.some(f => f.name === name.trim()) && <p className="warning-text">This replaces the saved filter with the same name.</p>}
      <div className="saved-filter-list">{data.folders.map(f => <div key={f.name}><Filter size={13} /><span>{f.name}</span><button className="icon-button" aria-label={`Delete ${f.name}`} disabled={busy} onClick={() => void run<Snapshot>({ action: 'delete_filter', name: f.name }, s => { load(s); if (preset === f.name) setPreset(''); }, 'Saved filter deleted.')}><Trash2 size={14} /></button></div>)}</div>
      <div className="modal-actions"><button onClick={close}>Close</button><button className="primary" disabled={busy || !name.trim()} onClick={() => void run<Snapshot>({ action: 'save_filter', name, query }, s => { load(s); setPreset(name.trim()); setPanel(null); }, 'Current filters saved.')}>Save</button></div>
    </Modal>}

    {panel === 'move' && data && <Modal title={resuming ? 'Retry interrupted organization' : 'Organize folders'} subtitle={resuming ? 'Move the remaining files to the destinations saved in the record.' : `Move ${chosen.length} selected ${chosen.length === 1 ? 'video' : 'videos'} and related files into real folders.`} onClose={close} wide>
      {!data.fields.length ? <div className="modal-empty"><Tag size={28} /><p>Create a field first.</p><button className="primary" onClick={() => openPanel('field')}>Add field</button></div> : <>
        {!resuming && <div className="move-controls"><label className="form-field">Organize by<select value={fieldId} disabled={busy} onChange={e => { setFieldId(e.target.value); setOverrides({}); invalidatePlan(); }}>{data.fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label><label className="form-field">When there are multiple values<select value={multiple} disabled={busy} onChange={e => { setMultiple(e.target.value); invalidatePlan(); }}><option value="group">Gather into a shared folder</option><option value="ask">Choose per video</option></select></label>{multiple === 'group' && <label className="form-field">Shared folder name<input value={group} onChange={e => { setGroup(e.target.value); invalidatePlan(); }} /></label>}</div>}
        <p className="destination-hint"><Folder size={14} />{data.root}\videos\<strong>field value</strong>\file name<span>No value → {data.options.unclassified_folder}</span></p>
        {multiVideos.length > 0 && <div className="multi-resolutions">{multiVideos.map(v => <label className="form-field" key={v.id}>{filename(v.path)}<select value={overrides[String(v.id)] || ''} onChange={e => { setOverrides({ ...overrides, [v.id]: e.target.value }); invalidatePlan(); }}><option value="">Choose destination</option>{(v.values[fieldId] as string[]).map(val => <option key={val}>{val}</option>)}</select></label>)}</div>}
        <div className="preview-heading"><strong>Move preview</strong>{!resuming && <button disabled={busy || multiVideos.some(v => !overrides[String(v.id)])} onClick={() => void run<Plan>({ action: 'plan', ids: chosen.map(v => v.id), field: Number(fieldId), multiple, group, overrides }, p => { setPlan(p); setAcknowledged(false); setMoveConfirmed(false); setCrossConfirmed(false); }, 'Review the move plan.') }><RefreshCw size={13} />{plan ? 'Check again' : 'Create preview'}</button>}</div>
        {!plan ? <div className="plan-placeholder"><FolderOpen size={27} /><p>Create a preview to review the actual move paths and related files.</p></div> : <>
          {plan.errors.length > 0 && <div className="notice error block-notice"><strong>Resolve the conflicts before moving.</strong>{plan.errors.map((e, i) => <p key={i}>{e}</p>)}</div>}
          <div className="move-table"><table><thead><tr><th>Source</th><th>Destination</th><th>Type</th></tr></thead><tbody>{plan.items.filter(i => i.state !== 'complete').map((item, i) => <tr key={i}><td title={item.source}>{filename(item.source)}</td><td title={item.target}>{item.target}</td><td><span className={item.cross ? 'pill amber' : 'pill'}>{item.cross ? 'Cross-drive' : item.video ? 'Video' : 'Related file'}</span></td></tr>)}</tbody></table></div>
          {plan.warnings.length > 0 && <div className="ambiguous-files"><strong>Files that could not be linked automatically</strong>{plan.warnings.map((w, i) => <p key={i}>{w}</p>)}<label className="check-label"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I understand these files will stay in their original location.</label></div>}
          {plan.items.some(i => i.cross && i.state !== 'complete') && <div className="cross-warning"><strong>Moving to a different drive.</strong><p>All data is transferred and verified before the source is deleted, so this may take a long time.</p><label className="check-label"><input type="checkbox" checked={crossConfirmed} onChange={e => setCrossConfirmed(e.target.checked)} />I understand the transfer cost.</label></div>}
          {plan.items.length > 0 && !plan.errors.length && <label className="check-label move-confirm"><input type="checkbox" checked={moveConfirmed} onChange={e => setMoveConfirmed(e.target.checked)} />Move the actual files to the paths above.</label>}
        </>}
        <div className="modal-actions"><span className="muted">{plan ? `${plan.items.filter(i => i.state !== 'complete').length} files` : 'Available after creating a preview.'}</span><button disabled={busy} onClick={close}>Close</button><button className="primary" disabled={busy || !plan || !plan.items.length || !!plan.errors.length || !moveConfirmed || (!!plan.warnings.length && !acknowledged) || (plan.items.some(i => i.cross && i.state !== 'complete') && !crossConfirmed)} onClick={() => plan && void run<Snapshot>({ action: 'execute', id: plan.id, cross_confirmed: crossConfirmed }, s => { load(s); setPanel(null); }, 'Selected files moved.')}><FolderOpen size={14} />Move files</button></div>
      </>}
    </Modal>}

    {panel === 'options' && data && <Modal title="Options" subtitle="Settings for this workspace. Startup applies to the app." onClose={close}>
      <section className="options-section"><h3>Startup</h3><label className="check-label"><input type="checkbox" checked={reopenLast} onChange={e => setReopenLast(e.target.checked)} />Reopen the last workspace when Filterer starts</label><p className="form-hint">Applies to all workspaces. When off, Filterer starts on the welcome screen.</p></section>
      <section className="options-section"><h3>Organizing folders</h3><div className="move-controls"><label className="form-field">Folder for videos without a value<input value={draft.unclassified_folder} maxLength={100} onChange={e => setDraft({ ...draft, unclassified_folder: e.target.value })} /></label><label className="form-field">Default shared folder for multiple values<input value={draft.shared_folder} maxLength={100} onChange={e => setDraft({ ...draft, shared_folder: e.target.value })} /></label></div><p className="form-hint">Used under {data.root}\videos\. Existing folders are not renamed.</p></section>
      <section className="options-section"><h3>List and filters</h3><div className="move-controls"><label className="form-field">Rows per page<select value={draft.page_size} onChange={e => setDraft({ ...draft, page_size: Number(e.target.value) })}>{pageSizes.map(n => <option key={n} value={n}>{n}</option>)}</select></label><label className="form-field">Default filters and columns<input type="number" min={1} max={50} value={draft.visible_fields} onChange={e => setDraft({ ...draft, visible_fields: Number(e.target.value) })} /></label></div><p className="form-hint">The first fields in filter and column order are shown by default. The rest open with “Show more filters”.</p>
        {([['column', 'Column order', columnOrder.map(key => key === 'name' ? 'File name' : key === 'size' ? 'Size' : fieldsById.get(key)?.name || key)], ['filter', 'Filter order', filterOrder.map(key => fieldsById.get(key)?.name || key)]] as const).map(([kind, label, names]) => <div className="order-row" key={kind}><div><strong>{label}</strong><span title={names.join(' · ')}>{resetOrder[kind] ? 'Resets to the default order when saved' : names.join(' · ') || 'No fields yet'}</span></div><button disabled={busy || resetOrder[kind] || !data[`${kind}_order`].length} onClick={() => setResetOrder({ ...resetOrder, [kind]: true })}><RefreshCw size={13} />Reset to default</button></div>)}
        <div className="order-row"><div><strong>Column widths</strong><span>{resetOrder.widths ? 'Resets to the default widths when saved' : Object.keys(data.column_widths).length ? 'Custom widths' : 'Default widths'}</span></div><button disabled={busy || resetOrder.widths || !Object.keys(data.column_widths).length} onClick={() => setResetOrder({ ...resetOrder, widths: true })}><RefreshCw size={13} />Reset to default</button></div>
        <p className="form-hint">To change the order, drag column headers or filter labels on the main screen. To change a width, drag the edge of a column header.</p></section>
      <section className="options-section"><h3>Player</h3><label className="form-field">Player executable<div className="input-with-button"><input value={player} onChange={e => setPlayer(e.target.value)} placeholder="Leave empty to use the OS default app" /><button disabled={busy} onClick={() => void chooseFile().then(p => { if (p) setPlayer(p); }).catch(e => setError(String(e)))}>Browse</button></div></label><label className="form-field">New playlist format<select value={format} onChange={e => setFormat(e.target.value)}><option value="m3u8">M3U8 · VLC / PotPlayer</option><option value="asx">ASX · Windows Media Player</option></select></label><p className="form-hint">If the default app cannot open the playlist, set the player executable.</p></section>
      <div className="modal-actions"><button onClick={close}>Cancel</button><button className="primary" disabled={busy || !draft.unclassified_folder.trim() || !draft.shared_folder.trim() || !(draft.visible_fields >= 1 && draft.visible_fields <= 50)} onClick={() => void run<Snapshot>({ action: 'options', player, format, options: { ...draft, unclassified_folder: draft.unclassified_folder.trim(), shared_folder: draft.shared_folder.trim(), visible_fields: Math.round(draft.visible_fields) }, ...(resetOrder.column && { column_order: [] }), ...(resetOrder.filter && { filter_order: [] }), ...(resetOrder.widths && { column_widths: {} }), reopen_last: reopenLast }, s => { load(s); setPage(0); setPanel(null); }, 'Options saved.')}>Save</button></div>
    </Modal>}
    {panel === 'history' && data && <Modal title="Move history" subtitle="For interrupted moves, reconcile file locations and then retry the remaining files." onClose={close} wide>
      <div className="history-list">{data.history.length ? data.history.map(h => <article key={h.id}><div><span className={`pill ${h.status === 'attention' ? 'amber' : ''}`}>{({ complete: 'Complete', stopped: 'Stopped', attention: 'Needs review' } as Record<string, string>)[h.status] || h.status}</span><time>{new Date(/^\d+$/.test(h.created) ? Number(h.created) * 1000 : h.created).toLocaleString('en')}</time>{h.status === 'stopped' && h.payload.items?.some(i => i.state === 'planned') && <button disabled={busy} onClick={() => void run<Plan>({ action: 'resume', id: h.id }, p => { setPlan(p); setResuming(true); setAcknowledged(false); setMoveConfirmed(false); setCrossConfirmed(false); setFieldId(String(data.fields[0]?.id || '')); setPanel('move'); }, 'Review the remaining move paths of the interrupted operation.')}>Retry remaining files</button>}</div>{h.payload.error && <p className="warning-text">{h.payload.error}</p>}<details><summary>Show file paths</summary>{h.payload.items?.map((i, n) => <p key={n}><span className="pill">{i.state}</span>{i.source} → {i.target}</p>)}</details></article>) : <div className="modal-empty"><Check size={25} /><p>No move history yet.</p></div>}</div>
      <div className="modal-actions"><button disabled={busy} onClick={() => void run<{ snapshot: Snapshot; remaining: number }>({ action: 'reconcile' }, r => { load(r.snapshot); if (r.remaining) setError(`${r.remaining} unresolved records: files present at both source and destination are never deleted automatically.`); }, 'Interrupted records reconciled with file locations.')}>Reconcile interrupted records</button><button onClick={close}>Close</button></div>
    </Modal>}
    {panel === 'detail' && data && detail && <Modal title={filename(detail.path)} subtitle={`${size(detail.size)} · ${detail.images.length} ${detail.images.length === 1 ? 'image' : 'images'}`} onClose={close} wide>
      <div className="detail-layout"><div><Cover image={detail.images[detailImage]} workspace={data.root} large /><div className="image-pager"><button disabled={detailImage === 0} onClick={() => setDetailImage(detailImage - 1)}><ChevronLeft size={14} /></button><span>{detail.images.length ? detailImage + 1 : 0} / {detail.images.length}</span><button disabled={detailImage + 1 >= detail.images.length} onClick={() => setDetailImage(detailImage + 1)}><ChevronRight size={14} /></button></div></div><div><dl className="detail-fields"><dt>File location</dt><dd className="file-path">{detail.path}</dd>{data.fields.map(f => <div key={f.id}><dt>{f.name}</dt><dd>{f.kind === 'rating' ? <StarDisplay value={detail.values[String(f.id)]} /> : text(detail.values[String(f.id)]) || '—'}</dd></div>)}</dl><div className="image-actions"><button disabled={busy} onClick={() => void addImage(true)}><ImageIcon size={14} />Cover image</button><button disabled={busy} onClick={() => void addImage(false)}><Plus size={14} />Additional image</button></div></div></div>
      <div className="modal-actions"><button onClick={close}>Close</button><button className="primary" disabled={busy} onClick={() => void run({ action: 'play', ids: [detail.id], playlist: false }, undefined, 'Video opened.')}><Play size={14} />Play this video</button></div>
    </Modal>}
  </div>;
}
