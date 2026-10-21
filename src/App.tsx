import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, FileVideo, Filter, Folder, FolderOpen, FolderPlus, Grid2X2, Image as ImageIcon, List, LoaderCircle, MoreHorizontal, Play, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Tag, Trash2, X } from 'lucide-react';
import { cancel, chooseFile, chooseFolder, desktop, request } from './bridge';
import { filename, size, sortedVideos, text, type Field, type ImageRef, type Plan, type Query, type Rule, type Snapshot, type Video } from './model';

type Panel = null | 'sources' | 'field' | 'edit' | 'move' | 'settings' | 'history' | 'save' | 'detail';
const kinds = { text: 'Text', number: 'Number', date: 'Date', tags: 'Tags · multiple values' };
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
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailImage, setDetailImage] = useState(0);
  const [comparisons, setComparisons] = useState<Record<string, Rule['op']>>({});
  const anchor = useRef<number | null>(null);
  const pageSize = 100;

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
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const chosen = rows.filter(r => selected.has(r.id));
  const detail = data?.videos.find(v => v.id === detailId);
  const filterFields = data?.fields.slice(0, allFilters ? undefined : 6) || [];
  const visibleFields = data?.fields.slice(0, 6) || [];
  const activeRules = query.rules || [];
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
      setPlan(null); setOverrides({}); setMultiple('group'); setGroup('Multiple values'); setAcknowledged(false); setCrossConfirmed(false); setMoveConfirmed(false);
      setResuming(false);
    }
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
          <div className="menu-anchor"><button className="icon-button" aria-label="More" aria-expanded={menu} disabled={busy} onClick={() => setMenu(!menu)}><MoreHorizontal size={20} /></button>
            {menu && <><div className="menu-dismiss" onClick={() => setMenu(false)} /><div className="dropdown-menu">
              <button onClick={() => { setMenu(false); void run({ action: 'scan' }, scanResult, 'List refreshed.'); }}><RefreshCw size={15} />Rescan source folders</button>
              <button onClick={() => openPanel('field')}><Tag size={15} />Add field</button><button onClick={() => openPanel('settings')}><Settings2 size={15} />Player settings</button><button onClick={() => openPanel('history')}><List size={15} />Move history</button>
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
          {filterFields.map(field => {
            const rule = activeRules.find(r => String(r.field) === String(field.id));
            const numeric = field.kind === 'number' || field.kind === 'date';
            const values = [...new Set(data.videos.flatMap(v => { const value = v.values[String(field.id)]; return Array.isArray(value) ? value.map(text) : value == null ? [] : [text(value)]; }))].sort((a, b) => a.localeCompare(b));
            return <div className={`filter-cell ${rule ? 'filter-active' : ''}`} key={field.id}><label htmlFor={`filter-${field.id}`}>{field.name}{rule && <i />}</label>
              {numeric ? <div className="numeric-filter"><select aria-label={`${field.name} comparison`} value={rule?.op || comparisons[String(field.id)] || 'gte'} onChange={e => { const op = e.target.value as Rule['op']; setComparisons({ ...comparisons, [String(field.id)]: op }); setRule(field, op === 'empty' || rule?.value != null && rule.value !== '' ? { field: String(field.id), op, value: rule?.value } : null); }}><option value="gte">At least</option><option value="lte">At most</option><option value="eq">Equals</option><option value="empty">Empty</option></select>
                <input id={`filter-${field.id}`} aria-label={`${field.name} filter`} disabled={rule?.op === 'empty'} placeholder="Any" type={field.kind === 'date' ? 'date' : 'number'} value={rule?.op === 'empty' ? '' : text(rule?.value)} onChange={e => setRule(field, e.target.value ? { field: String(field.id), op: rule?.op || comparisons[String(field.id)] || 'gte', value: field.kind === 'number' ? Number(e.target.value) : e.target.value } : null)} />{rule && <button className="clear-inline" aria-label={`Clear ${field.name} filter`} onClick={() => setRule(field, null)}><X size={12} /></button>}</div>
                : <select id={`filter-${field.id}`} aria-label={`${field.name} filter`} value={rule ? rule.op === 'empty' ? 'empty' : `v:${text(rule.value)}` : ''} onChange={e => setRule(field, e.target.value ? { field: String(field.id), op: e.target.value === 'empty' ? 'empty' : 'eq', value: e.target.value.slice(2) } : null)}><option value="">Any</option><option value="empty">Empty</option>{values.map(v => <option key={v} value={`v:${v}`}>{v}</option>)}</select>}
            </div>;
          })}
          {!data.fields.length && <div className="filter-onboarding"><Tag size={16} /><span>Add a field to filter by it here.</span><button className="text-button" onClick={() => openPanel('field')}>Add field</button></div>}
          {data.fields.length > 6 && <button className="text-button more-filters" onClick={() => setAllFilters(!allFilters)}>{allFilters ? 'Show default filters only' : `Show ${data.fields.length - 6} more filters`}</button>}
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

        {view === 'list' ? <div className="table-container"><table><thead><tr><th className="checkbox-col"><input type="checkbox" aria-label="Select all on this page" checked={pageRows.length > 0 && pageRows.every(v => selected.has(v.id))} onChange={e => setSelected(prev => { const next = new Set(prev); pageRows.forEach(v => e.target.checked ? next.add(v.id) : next.delete(v.id)); return next; })} /></th><th className="number-col">No.</th><th className="filename-col"><button onClick={() => sortBy('name')}>File name{sortIcon('name')}</button></th>{visibleFields.map(f => <th key={f.id} className={f.kind === 'number' ? 'numeric' : ''}><button onClick={() => sortBy(String(f.id))}>{f.name}{sortIcon(String(f.id))}</button></th>)}<th className="numeric"><button onClick={() => sortBy('size')}>Size{sortIcon('size')}</button></th><th className="actions-col" /></tr></thead>
          <tbody>{pageRows.map((video, i) => <tr key={video.id} className={selected.has(video.id) ? 'row-selected' : ''} onClick={e => toggleSelection(video, e.shiftKey)} onDoubleClick={() => void run({ action: 'play', ids: [video.id], playlist: false }, undefined, 'Video opened.')}>
            <td><input type="checkbox" aria-label={`Select ${filename(video.path)}`} checked={selected.has(video.id)} onChange={() => toggleSelection(video)} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} /></td><td className="row-number">{currentPage * pageSize + i + 1}</td><td className="filename-cell" title={video.path}><span><FileVideo size={14} /><strong>{filename(video.path)}</strong></span></td>{visibleFields.map(f => <td key={f.id} className={f.kind === 'number' ? 'numeric score-cell' : ''} title={text(video.values[String(f.id)])}>{Array.isArray(video.values[String(f.id)]) ? <span className="tag-list">{(video.values[String(f.id)] as unknown[]).slice(0, 2).map((v, n) => <span className="tag-chip" key={n}>{text(v)}</span>)}{(video.values[String(f.id)] as unknown[]).length > 2 && <small>+{(video.values[String(f.id)] as unknown[]).length - 2}</small>}</span> : text(video.values[String(f.id)]) || <span className="empty-value">—</span>}</td>)}<td className="numeric size-cell">{size(video.size)}</td><td><button className="icon-button row-detail" aria-label={`Details for ${filename(video.path)}`} onDoubleClick={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setDetailId(video.id); setDetailImage(0); setPanel('detail'); }}><MoreHorizontal size={17} /></button></td>
          </tr>)}</tbody></table></div>
          : <div className="gallery">{pageRows.map(video => <div className={`gallery-card ${selected.has(video.id) ? 'card-selected' : ''}`} key={video.id}>
            <button className="cover-button" aria-label={`Details for ${filename(video.path)}`} onClick={() => { setDetailId(video.id); setDetailImage(0); setPanel('detail'); }}><Cover image={video.images.find(i => i.cover)} workspace={data.root} /></button>
            <label className="card-title"><input type="checkbox" checked={selected.has(video.id)} onChange={() => toggleSelection(video)} /> <span title={video.path}>{filename(video.path)}</span></label><div className="card-meta"><span>{size(video.size)}</span><button className="text-button" disabled={busy} onClick={() => void run({ action: 'play', ids: [video.id], playlist: false }, undefined, 'Video opened.')}><Play size={12} />Play</button></div>
          </div>)}</div>}
        {!rows.length && <div className="empty-results">{data.videos.length ? <><Search size={28} /><h3>No videos match these conditions</h3><p>Try changing the filters or search terms.</p><button onClick={() => changeQuery({ search: '', rules: [], mode: 'AND' })}>Reset conditions</button></> : <><FolderPlus size={30} /><h3>Add your first source folder</h3><p>Videos in the folder will be loaded.</p><button className="primary" onClick={() => openPanel('sources')}>Add folder</button></>}</div>}
        <footer className="table-footer"><span>{selected.size ? `${selected.size} selected · ` : ''}{pageSize} per page<span className="footer-tip">Double-click to play · Shift-click to select a range</span></span><div><button className="icon-button" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><strong>{currentPage + 1}</strong><span>/ {pages}</span><button className="icon-button" aria-label="Next page" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div></footer>
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
      {data.fields.length ? <><label className="form-field">Field<select value={fieldId} onChange={e => { setFieldId(e.target.value); setEditValue(chosen.length === 1 ? text(chosen[0].values[e.target.value]) : ''); }}>{data.fields.map(f => <option key={f.id} value={f.id}>{f.name} · {kinds[f.kind]}</option>)}</select></label><label className="form-field">Value<input autoFocus type={selectedField?.kind === 'number' ? 'number' : selectedField?.kind === 'date' ? 'date' : 'text'} value={editValue} placeholder={selectedField?.kind === 'tags' ? 'Tag A, Tag B' : 'Enter a value'} onChange={e => setEditValue(e.target.value)} /></label><p className="form-hint">Saving an empty value clears the existing value of this field.</p><div className="modal-actions"><button onClick={close}>Cancel</button><button className="primary" disabled={busy} onClick={() => void run<Snapshot>({ action: 'set_values', ids: chosen.map(v => v.id), field: Number(fieldId), value: editValue }, s => { load(s); setPanel(null); }, 'Field values saved.')}>Apply to selected videos</button></div></>
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
        <p className="destination-hint"><Folder size={14} />{data.root}\videos\<strong>field value</strong>\file name<span>No value → Unclassified</span></p>
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

    {panel === 'settings' && data && <Modal title="Player settings" subtitle="Videos open in your existing video player." onClose={close}>
      <label className="form-field">Player executable<div className="input-with-button"><input value={player} onChange={e => setPlayer(e.target.value)} placeholder="Leave empty to use the OS default app" /><button disabled={busy} onClick={() => void chooseFile().then(p => { if (p) setPlayer(p); }).catch(e => setError(String(e)))}>Browse</button></div></label><label className="form-field">New playlist format<select value={format} onChange={e => setFormat(e.target.value)}><option value="m3u8">M3U8 · VLC / PotPlayer</option><option value="asx">ASX · Windows Media Player</option></select></label><p className="form-hint">If the default app cannot open the playlist, set the player executable.</p>
      <div className="modal-actions"><button onClick={close}>Cancel</button><button className="primary" disabled={busy} onClick={() => void run<Snapshot>({ action: 'player_settings', player, format }, s => { load(s); setPanel(null); }, 'Player settings saved.')}>Save</button></div>
    </Modal>}
    {panel === 'history' && data && <Modal title="Move history" subtitle="For interrupted moves, reconcile file locations and then retry the remaining files." onClose={close} wide>
      <div className="history-list">{data.history.length ? data.history.map(h => <article key={h.id}><div><span className={`pill ${h.status === 'attention' ? 'amber' : ''}`}>{({ complete: 'Complete', stopped: 'Stopped', attention: 'Needs review' } as Record<string, string>)[h.status] || h.status}</span><time>{new Date(/^\d+$/.test(h.created) ? Number(h.created) * 1000 : h.created).toLocaleString('en')}</time>{h.status === 'stopped' && h.payload.items?.some(i => i.state === 'planned') && <button disabled={busy} onClick={() => void run<Plan>({ action: 'resume', id: h.id }, p => { setPlan(p); setResuming(true); setAcknowledged(false); setMoveConfirmed(false); setCrossConfirmed(false); setFieldId(String(data.fields[0]?.id || '')); setPanel('move'); }, 'Review the remaining move paths of the interrupted operation.')}>Retry remaining files</button>}</div>{h.payload.error && <p className="warning-text">{h.payload.error}</p>}<details><summary>Show file paths</summary>{h.payload.items?.map((i, n) => <p key={n}><span className="pill">{i.state}</span>{i.source} → {i.target}</p>)}</details></article>) : <div className="modal-empty"><Check size={25} /><p>No move history yet.</p></div>}</div>
      <div className="modal-actions"><button disabled={busy} onClick={() => void run<{ snapshot: Snapshot; remaining: number }>({ action: 'reconcile' }, r => { load(r.snapshot); if (r.remaining) setError(`${r.remaining} unresolved records: files present at both source and destination are never deleted automatically.`); }, 'Interrupted records reconciled with file locations.')}>Reconcile interrupted records</button><button onClick={close}>Close</button></div>
    </Modal>}
    {panel === 'detail' && data && detail && <Modal title={filename(detail.path)} subtitle={`${size(detail.size)} · ${detail.images.length} ${detail.images.length === 1 ? 'image' : 'images'}`} onClose={close} wide>
      <div className="detail-layout"><div><Cover image={detail.images[detailImage]} workspace={data.root} large /><div className="image-pager"><button disabled={detailImage === 0} onClick={() => setDetailImage(detailImage - 1)}><ChevronLeft size={14} /></button><span>{detail.images.length ? detailImage + 1 : 0} / {detail.images.length}</span><button disabled={detailImage + 1 >= detail.images.length} onClick={() => setDetailImage(detailImage + 1)}><ChevronRight size={14} /></button></div></div><div><dl className="detail-fields"><dt>File location</dt><dd className="file-path">{detail.path}</dd>{data.fields.map(f => <div key={f.id}><dt>{f.name}</dt><dd>{text(detail.values[String(f.id)]) || '—'}</dd></div>)}</dl><div className="image-actions"><button disabled={busy} onClick={() => void addImage(true)}><ImageIcon size={14} />Cover image</button><button disabled={busy} onClick={() => void addImage(false)}><Plus size={14} />Additional image</button></div></div></div>
      <div className="modal-actions"><button onClick={close}>Close</button><button className="primary" disabled={busy} onClick={() => void run({ action: 'play', ids: [detail.id], playlist: false }, undefined, 'Video opened.')}><Play size={14} />Play this video</button></div>
    </Modal>}
  </div>;
}
