'use strict';
// ─────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────
const IMAGE_EXTS   = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg','tiff','tif','ico']);
const VIDEO_EXTS   = new Set(['mp4','mov','webm','mkv','avi','m4v','ogv','3gp','wmv','flv']);
const AUDIO_EXTS   = new Set(['mp3','wav','flac','aac','ogg','m4a','opus','wma','aiff','aif']);
const MEDIA_EXTS   = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);
const SESSION_KEY  = 'modngaan_session';
const SESSION_TTL  = 3 * 60 * 60 * 1000; // 3 hours in ms
const FSAPI        = !!window.showDirectoryPicker; // Chrome/Edge
const META_BATCH   = 300;
const MAX_CACHED   = 200;

// ─────────────────────────────────────────
//  STATE  (all mutable state in one place)
// ─────────────────────────────────────────
let navStack       = [];   // { kind:'fsapi'|'fb', handle, name, allFiles?, depth? }
let displayItems   = [];   // mixed folders + files currently shown
let photoItems     = [];   // displayItems filtered to files only — cached, rebuilt in buildDisplay
let dispIdxMap     = new Map(); // item object → index in displayItems — O(1) lightbox lookup
let photoIdxMap    = new Map(); // item object → index in photoItems  — O(1) lightbox lookup
let currentFolders = [];   // current level's folder items (for reFilter)
let currentFiles   = [];   // current level's file items unfiltered (for reFilter)
let objectURLs     = new Map(); // displayItem index → blob URL
let lbIndex        = 0;
let cols           = 7;
let rowH           = 0;
let VISIBLE_ROWS   = 12;
let scrollTop      = 0;
let rafPending     = false;

// ─────────────────────────────────────────
//  DOM REFS
// ─────────────────────────────────────────
const viewport    = document.getElementById('grid-viewport');
const spacer      = document.getElementById('grid-spacer');
const gridWin     = document.getElementById('grid-window');
const emptyState  = document.getElementById('empty-state');
const statsEl     = document.getElementById('stats');
const statusEl    = document.getElementById('status');
const searchEl    = document.getElementById('search');
const sortEl      = document.getElementById('sort');
const zoomRange   = document.getElementById('zoom-range');
const breadcrumb  = document.getElementById('breadcrumb');
const btnUp       = document.getElementById('btn-up');
const lightbox    = document.getElementById('lightbox');
const lbImg       = document.getElementById('lb-img');
const lbVideo     = document.getElementById('lb-video');
const lbAudio     = document.getElementById('lb-audio');
const lbAudioWrap = document.getElementById('lb-audio-wrap');
const lbFilename  = document.getElementById('lb-filename');
const lbPosition  = document.getElementById('lb-position');
const lbMeta      = document.getElementById('lb-meta');
const searchCount = document.getElementById('search-count');
const dropOverlay = document.getElementById('drop-overlay');
const resumeBanner= document.getElementById('resume-banner');
const resumeLabel = document.getElementById('resume-label');

// ─────────────────────────────────────────
//  OPEN FOLDER
// ─────────────────────────────────────────
document.getElementById('btn-open').addEventListener('click', openFolder);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='o') { e.preventDefault(); openFolder(); }
});

async function openFolder() {
  if (FSAPI) {
    try {
      const handle = await showDirectoryPicker({ mode:'read' });
      await idbSet('root_handle', handle);
      clearSession();
      navStack = [{ kind:'fsapi', handle, name:handle.name }];
      await loadFSAPI(handle);
    } catch(e) { if (e.name!=='AbortError') statusEl.textContent = 'Error: '+e.message; }
    return;
  }
  // Firefox / Safari fallback — webkitdirectory
  const inp = document.createElement('input');
  inp.type='file'; inp.webkitdirectory=true; inp.multiple=true;
  inp.addEventListener('change', () => {
    if (!inp.files.length) return;
    const all = [...inp.files];
    clearSession();
    const rootName = all[0].webkitRelativePath.split('/')[0] || 'Folder';
    navStack = [{ kind:'fb', name:rootName, allFiles:all, depth:1 }];
    renderFallback(all, 1);
  });
  inp.click();
}

// ─────────────────────────────────────────
//  LOAD — FSAPI (Chrome/Edge)
// ─────────────────────────────────────────
async function loadFSAPI(dirHandle) {
  resetView();
  statusEl.textContent = 'Reading…';

  const folders=[], files=[];
  for await (const entry of dirHandle.values()) {
    if (entry.name.startsWith('.')) continue;
    if (entry.kind==='directory') {
      folders.push({ type:'folder', name:entry.name, handle:entry, count:null });
    } else {
      const ext = entry.name.split('.').pop().toLowerCase();
      if (MEDIA_EXTS.has(ext)) {
        const mediaType = VIDEO_EXTS.has(ext) ? 'video' : AUDIO_EXTS.has(ext) ? 'audio' : 'image';
        files.push({ type:'file', name:entry.name, handle:entry, size:0, lastModified:0, mediaType });
      }
    }
  }

  // Show folder tiles immediately (no metadata needed)
  buildDisplay(folders, []);
  if (files.length) statusEl.textContent = `Loading ${files.length.toLocaleString()} files…`;

  // Resolve metadata in batches — progressive render
  for (let i=0; i<files.length; i+=META_BATCH) {
    await Promise.all(files.slice(i, i+META_BATCH).map(async item => {
      try { const f=await item.handle.getFile(); item.size=f.size; item.lastModified=f.lastModified; } catch{}
    }));
    buildDisplay(folders, files); // re-sort after each batch
  }

  // Count folder contents non-blocking
  folders.forEach(async fld => {
    let n=0;
    try { for await (const _ of fld.handle.values()) n++; } catch{}
    fld.count = n;
    const cell = gridWin.querySelector(`.folder-cell[data-fname="${CSS.escape(fld.name)}"]`);
    if (cell) { const ct=cell.querySelector('.f-count'); if(ct) ct.textContent=countLabel(n); }
  });
}

// ─────────────────────────────────────────
//  LOAD — Firefox/Safari fallback
//  File objects already carry size+lastModified — no async metadata needed
// ─────────────────────────────────────────
function renderFallback(allFiles, depth) {
  resetView();
  const subMap  = new Map();
  const dirFiles = [];

  for (const f of allFiles) {
    if (f.name.startsWith('.')) continue;
    const parts = f.webkitRelativePath.split('/');
    if (parts.length === depth+1) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (MEDIA_EXTS.has(ext)) {
        const mediaType = VIDEO_EXTS.has(ext) ? 'video' : AUDIO_EXTS.has(ext) ? 'audio' : 'image';
        dirFiles.push({ type:'file', name:f.name, handle:f, size:f.size, lastModified:f.lastModified, mediaType });
      }
    } else if (parts.length > depth+1) {
      const sub = parts[depth];
      if (!subMap.has(sub)) subMap.set(sub,[]);
      subMap.get(sub).push(f);
    }
  }

  const folders = [...subMap.entries()].map(([name,fls]) => ({
    type:'folder', name, handle:null, count:fls.length, _files:fls, _depth:depth+1
  }));

  buildDisplay(folders, dirFiles);
}

// ─────────────────────────────────────────
//  BUILD DISPLAY — sorts, caches, renders
// ─────────────────────────────────────────
function buildDisplay(folders, files) {
  currentFolders = folders;
  currentFiles   = files;

  // Sort folders once alphabetically
  folders.sort((a,b)=>a.name.localeCompare(b.name));

  // Filter + sort files
  const q = searchEl.value.trim().toLowerCase();
  let filt = q ? files.filter(f=>f.name.toLowerCase().includes(q)) : files.slice();

  const [field,dir] = sortEl.value.split('-');
  filt.sort((a,b)=>{
    const va = field==='name'?a.name : field==='size'?a.size : a.lastModified;
    const vb = field==='name'?b.name : field==='size'?b.size : b.lastModified;
    if (typeof va==='string') return dir==='asc'?va.localeCompare(vb):vb.localeCompare(va);
    return dir==='asc'?va-vb:vb-va;
  });

  displayItems = [...folders, ...filt];

  // ── Cache photo subset + index maps (avoids repeated filter/indexOf in lightbox) ──
  photoItems = filt; // files already sorted, no folders
  dispIdxMap.clear();
  displayItems.forEach((item,i)=>dispIdxMap.set(item,i));
  photoIdxMap.clear();
  filt.forEach((item,i)=>photoIdxMap.set(item,i));

  let photoCount=0, videoCount=0, audioCount=0;
  for (const f of filt) {
    if (f.mediaType==='image') photoCount++;
    else if (f.mediaType==='video') videoCount++;
    else if (f.mediaType==='audio') audioCount++;
  }
  const mediaParts = [];
  if (photoCount) mediaParts.push(`${photoCount} photo${photoCount!==1?'s':''}`);
  if (videoCount) mediaParts.push(`${videoCount} video${videoCount!==1?'s':''}`);
  if (audioCount) mediaParts.push(`${audioCount} audio`);
  const mediaStr = mediaParts.join(' · ') || '0 items';
  searchCount.textContent = q ? filt.length.toLocaleString() : '';
  statsEl.textContent = folders.length
    ? `${folders.length} folder${folders.length!==1?'s':''} · ${mediaStr}`
    : mediaStr;
  statusEl.textContent = `${displayItems.length} item${displayItems.length!==1?'s':''}`;

  updateBreadcrumb();
  initGrid();
  saveSession();
}

// ─────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────
async function navigateInto(item) {
  revokeAll();
  if (item.handle) {
    navStack.push({ kind:'fsapi', handle:item.handle, name:item.name });
    await loadFSAPI(item.handle);
  } else {
    navStack.push({ kind:'fb', name:item.name, allFiles:item._files, depth:item._depth });
    renderFallback(item._files, item._depth);
  }
}

async function navigateUp() {
  if (navStack.length<=1) return;
  revokeAll(); navStack.pop(); await reloadCurrent();
}

async function navigateTo(idx) {
  if (idx>=navStack.length-1) return;
  revokeAll(); navStack=navStack.slice(0,idx+1); await reloadCurrent();
}

async function reloadCurrent() {
  const cur = navStack[navStack.length-1];
  if (cur.kind==='fsapi') await loadFSAPI(cur.handle);
  else renderFallback(cur.allFiles, cur.depth);
}

btnUp.addEventListener('click', navigateUp);

function updateBreadcrumb() {
  btnUp.disabled = navStack.length<=1;
  // Reuse existing spans rather than innerHTML='' + rebuild
  const children = breadcrumb.children;
  const needed = navStack.length*2 - 1; // items + separators
  while (breadcrumb.children.length > needed) breadcrumb.lastChild.remove();
  navStack.forEach((entry,i)=>{
    const sepIdx = i*2-1, itemIdx = i*2;
    if (i>0) {
      let sep = children[sepIdx];
      if (!sep) { sep=document.createElement('span'); sep.className='bc-sep'; breadcrumb.appendChild(sep); }
      sep.textContent='/';
    }
    let el = children[itemIdx];
    if (!el) { el=document.createElement('span'); breadcrumb.appendChild(el); }
    el.className = 'bc-item'+(i===navStack.length-1?' active':'');
    el.textContent = entry.name; el.title = entry.name;
    el.onclick = i<navStack.length-1 ? ()=>navigateTo(i) : null;
  });
}

// ─────────────────────────────────────────
//  DRAG & DROP
// ─────────────────────────────────────────
let dragN=0;
document.addEventListener('dragenter', e=>{ e.preventDefault(); dragN++; dropOverlay.classList.add('show'); });
document.addEventListener('dragleave', ()=>{ if(--dragN<=0){dragN=0;dropOverlay.classList.remove('show');} });
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', async e=>{
  e.preventDefault(); dragN=0; dropOverlay.classList.remove('show');
  for (const item of e.dataTransfer.items) {
    if (item.kind!=='file') continue;
    if (item.getAsFileSystemHandle) {
      const fsh = await item.getAsFileSystemHandle();
      if (fsh.kind==='directory') {
        await idbSet('root_handle', fsh);
        clearSession(); navStack=[{kind:'fsapi',handle:fsh,name:fsh.name}];
        await loadFSAPI(fsh); return;
      }
    }
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const all=[];
      await walkEntry(entry,all);
      clearSession(); navStack=[{kind:'fb',name:entry.name,allFiles:all,depth:1}];
      renderFallback(all,1); return;
    }
  }
});

async function walkEntry(entry, out) {
  if (entry.name.startsWith('.')) return;
  if (entry.isFile) {
    await new Promise(res=>entry.file(f=>{out.push(f);res();},res));
  } else if (entry.isDirectory) {
    const r=entry.createReader(); let batch;
    do { batch=await new Promise((res,rej)=>r.readEntries(res,rej)); await Promise.all(batch.map(c=>walkEntry(c,out))); }
    while(batch.length===100);
  }
}

// ─────────────────────────────────────────
//  SEARCH & SORT
// ─────────────────────────────────────────
let searchDebounce;
searchEl.addEventListener('input', ()=>{ clearTimeout(searchDebounce); searchDebounce=setTimeout(()=>buildDisplay(currentFolders,currentFiles),150); });
sortEl.addEventListener('change', ()=>buildDisplay(currentFolders,currentFiles));

// ─────────────────────────────────────────
//  ZOOM
// ─────────────────────────────────────────
zoomRange.addEventListener('input', ()=>{
  cols = Math.max(1, 12 - +zoomRange.value);
  revokeAll(); initGrid();
});

// ─────────────────────────────────────────
//  SESSION STATE
// ─────────────────────────────────────────
function clearSession() {
  revokeAll();
  navStack=[]; displayItems=[]; photoItems=[]; dispIdxMap.clear();
  currentFolders=[]; currentFiles=[]; lbIndex=0;
  searchEl.value=''; searchCount.textContent=''; statsEl.textContent='';
  sortEl.value='date-desc';
  gridWin.innerHTML=''; gridWin.style.top='0px';
  spacer.style.height='0px'; spacer.style.display='none';
  viewport.scrollTop=0; scrollTop=0;
  closeLightbox();
  breadcrumb.innerHTML=''; btnUp.disabled=true;
  emptyState.style.display='flex';
  try { sessionStorage.removeItem(SESSION_KEY); } catch{}
}

function resetView() {
  revokeAll();
  gridWin.innerHTML=''; gridWin.style.top='0px';
  spacer.style.height='0px'; spacer.style.display='none';
  viewport.scrollTop=0; scrollTop=0;
}

function revokeAll() {
  for (const u of objectURLs.values()) URL.revokeObjectURL(u);
  objectURLs.clear();
}

// ─────────────────────────────────────────
//  VIRTUAL GRID
// ─────────────────────────────────────────
function initGrid() {
  if (!displayItems.length) { emptyState.style.display='flex'; spacer.style.display='none'; return; }
  emptyState.style.display='none'; spacer.style.display='block';
  rowH = Math.floor(viewport.clientWidth / cols);
  spacer.style.height = (Math.ceil(displayItems.length/cols)*rowH)+'px';
  VISIBLE_ROWS = Math.ceil(viewport.clientHeight/rowH)+4;
  renderWindow();
}

function renderWindow() {
  if (!rowH) return;
  const firstRow = Math.max(0, Math.floor(scrollTop/rowH)-2);
  const lastRow  = Math.min(Math.ceil(displayItems.length/cols)-1, firstRow+VISIBLE_ROWS+4);
  const firstIdx = firstRow*cols;
  const lastIdx  = Math.min(displayItems.length-1, (lastRow+1)*cols-1);
  const needed   = lastIdx-firstIdx+1;

  gridWin.style.top = (firstRow*rowH)+'px';
  gridWin.style.display='grid';
  gridWin.style.gridTemplateColumns=`repeat(${cols},1fr)`;
  gridWin.style.gap='2px';

  while (gridWin.children.length>needed) gridWin.lastChild.remove();
  while (gridWin.children.length<needed) gridWin.appendChild(document.createElement('div'));

  for (let i=0; i<needed; i++) {
    const idx  = firstIdx+i;
    const item = displayItems[idx];
    const cell = gridWin.children[i];
    if (cell.dataset.idx===String(idx)) continue;
    cell.dataset.idx=idx;
    cell.innerHTML=''; cell.className=''; cell.onclick=null; cell.onkeydown=null;
    cell.style.height=rowH+'px'; cell.tabIndex=0;
    item.type==='folder' ? renderFolderCell(cell,item) : renderPhotoCell(cell,item,idx);
  }
}

function renderFolderCell(cell, item) {
  cell.className='folder-cell';
  cell.dataset.fname=item.name;
  cell.setAttribute('aria-label','Open folder: '+item.name);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none');
  svg.setAttribute('stroke','#facc15'); svg.setAttribute('stroke-width','1.5');
  svg.style.cssText='width:38%;height:38%;max-width:52px;opacity:.8;flex-shrink:0';
  svg.innerHTML='<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>';
  cell.appendChild(svg);
  const nm=document.createElement('div'); nm.className='f-name'; nm.textContent=item.name; cell.appendChild(nm);
  const ct=document.createElement('div'); ct.className='f-count';
  ct.textContent=item.count!==null?countLabel(item.count):'…'; cell.appendChild(ct);
  const open=()=>navigateInto(item);
  cell.addEventListener('click', open);
  cell.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' ') open(); });
}

function renderPhotoCell(cell, item, idx) {
  if (item.name.startsWith('.')) { cell.style.display='none'; return; }
  cell.className='thumb-cell skeleton';
  const ov=document.createElement('div'); ov.className='name-overlay';
  const sp=document.createElement('span'); sp.className='text-white text-xs truncate w-full'; sp.textContent=item.name;
  ov.appendChild(sp); cell.appendChild(ov);

  // Video play badge
  if (item.mediaType==='video') {
    const badge=document.createElement('div'); badge.className='vid-badge';
    badge.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>';
    cell.appendChild(badge);
  }

  // Audio tile — no thumbnail, just icon + ext label
  if (item.mediaType==='audio') {
    cell.classList.add('audio-cell');
    const ab=document.createElement('div'); ab.className='audio-badge';
    ab.innerHTML=`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>`;
    const ext=document.createElement('span'); ext.className='audio-ext';
    ext.textContent=item.name.split('.').pop();
    ab.appendChild(ext); cell.appendChild(ab);
    cell.classList.remove('skeleton'); // no loading state for audio
  }

  const click=()=>{
    const pi=photoIdxMap.get(item)??-1;
    if(pi!==-1) openLightbox(pi);
  };
  cell.addEventListener('click', click);
  cell.addEventListener('keydown', e=>{ if(e.key==='Enter') click(); });
  loadThumb(cell,item,idx);
}

async function loadThumb(cell, item, idx) {
  // Audio has no visual thumbnail — tile is already rendered
  if (item.mediaType==='audio') return;

  let url=objectURLs.get(idx);
  if (!url) {
    const f=await getBlob(item); if(!f){cell.classList.remove('skeleton');return;}
    url=URL.createObjectURL(f); objectURLs.set(idx,url);
  }
  if (cell.dataset.idx!==String(idx)) return;

  if (item.mediaType==='video') {
    // Use <video> with muted+preload to render first frame as thumbnail
    const vid=document.createElement('video');
    vid.src=url; vid.muted=true; vid.preload='metadata'; vid.playsInline=true;
    vid.addEventListener('loadeddata', ()=>{ if(cell.dataset.idx===String(idx)) cell.classList.remove('skeleton'); });
    vid.addEventListener('error', ()=>cell.classList.remove('skeleton'));
    cell.insertBefore(vid,cell.firstChild);
  } else {
    const img=document.createElement('img');
    img.src=url; img.alt=item.name; img.decoding='async'; img.loading='lazy';
    img.addEventListener('load', ()=>{ if(cell.dataset.idx===String(idx)) cell.classList.remove('skeleton'); });
    img.addEventListener('error', ()=>cell.classList.remove('skeleton'));
    cell.insertBefore(img,cell.firstChild);
  }
}

async function getBlob(item) {
  if (item.handle instanceof File) return item.handle;
  try { return await item.handle.getFile(); } catch { return null; }
}

// Single scroll listener
viewport.addEventListener('scroll', ()=>{
  scrollTop=viewport.scrollTop;
  if(!rafPending){rafPending=true;requestAnimationFrame(()=>{renderWindow();rafPending=false;});}
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer=setTimeout(saveSession,500);
}, { passive:true });

let resizeT;
window.addEventListener('resize', ()=>{ clearTimeout(resizeT); resizeT=setTimeout(initGrid,200); });

// ─────────────────────────────────────────
//  LIGHTBOX — uses cached photoItems + dispIdxMap
// ─────────────────────────────────────────
async function openLightbox(photoIdx) {
  lbIndex=photoIdx; lightbox.classList.add('open');
  await showLbPhoto(photoIdx);
}

async function showLbPhoto(idx) {
  lbIndex=idx;
  const item=photoItems[idx]; if(!item) return;
  const di=dispIdxMap.get(item)??-1;
  let url=di>=0?objectURLs.get(di):null;
  if (!url) {
    const f=await getBlob(item); if(!f) return;
    url=URL.createObjectURL(f); if(di>=0) objectURLs.set(di,url);
  }

  const isVideo = item.mediaType==='video';
  const isAudio = item.mediaType==='audio';

  // Toggle img / video / audio visibility
  lbImg.style.display      = (isVideo||isAudio) ? 'none' : '';
  lbImg.style.opacity      = '0';
  lbVideo.classList.toggle('active', isVideo);
  lbAudioWrap.classList.toggle('active', isAudio);

  if (isAudio) {
    lbVideo.pause(); lbVideo.src='';
    lbAudio.pause(); lbAudio.src=url; lbAudio.load();
  } else if (isVideo) {
    lbAudio.pause(); lbAudio.src='';
    lbVideo.pause(); lbVideo.src=url; lbVideo.load();
    lbVideo.play().catch(()=>{}); // autoplay — catch if browser blocks it
  } else {
    lbAudio.pause(); lbAudio.src='';
    lbVideo.pause(); lbVideo.src='';
    lbImg.onload=()=>lbImg.style.opacity='1';
    lbImg.src=url; lbImg.alt=item.name;
  }

  const ext = item.name.split('.').pop().toUpperCase();
  lbFilename.textContent=item.name;
  lbPosition.textContent=`${(idx+1).toLocaleString()} / ${photoItems.length.toLocaleString()}`;
  lbMeta.textContent=item.size?`${(item.size/1024/1024).toFixed(1)} MB  ${item.lastModified?new Date(item.lastModified).toLocaleDateString():''}  ${ext}`:'';
  preloadAdj(idx);
}

const _preloadPending = new Set();
function preloadAdj(idx) {
  [-1,1,-2,2].forEach(off=>{
    const i=idx+off; if(i<0||i>=photoItems.length) return;
    const di=dispIdxMap.get(photoItems[i])??-1;
    if(di>=0&&!objectURLs.has(di)&&!_preloadPending.has(di)) {
      _preloadPending.add(di);
      getBlob(photoItems[i]).then(f=>{ _preloadPending.delete(di); if(f&&!objectURLs.has(di)) objectURLs.set(di,URL.createObjectURL(f)); });
    }
  });
}

function closeLightbox() {
  lightbox.classList.remove('open');
  lbImg.src=''; lbImg.style.display='';
  lbVideo.pause(); lbVideo.src=''; lbVideo.classList.remove('active');
  lbAudio.pause(); lbAudio.src=''; lbAudioWrap.classList.remove('active');
}

document.getElementById('lb-close').addEventListener('click', closeLightbox);
document.getElementById('lb-nav-prev').addEventListener('click', ()=>{ if(lbIndex>0) showLbPhoto(lbIndex-1); });
document.getElementById('lb-nav-next').addEventListener('click', ()=>{ if(lbIndex<photoItems.length-1) showLbPhoto(lbIndex+1); });
lightbox.addEventListener('click', e=>{ if(e.target===lightbox) closeLightbox(); });

// ─────────────────────────────────────────
//  KEYBOARD
// ─────────────────────────────────────────
document.addEventListener('keydown', e=>{
  if (e.key==='Backspace' && document.activeElement!==searchEl && !lightbox.classList.contains('open')) {
    e.preventDefault(); navigateUp(); return;
  }
  if (!lightbox.classList.contains('open')) return;
  if (e.key==='Escape')     closeLightbox();
  if (e.key==='ArrowLeft'  && lbIndex>0)                  { e.preventDefault(); showLbPhoto(lbIndex-1); }
  if (e.key==='ArrowRight' && lbIndex<photoItems.length-1){ e.preventDefault(); showLbPhoto(lbIndex+1); }
  if (e.key==='Home') { e.preventDefault(); showLbPhoto(0); }
  if (e.key==='End')  { e.preventDefault(); showLbPhoto(photoItems.length-1); }
});

// ─────────────────────────────────────────
//  MEMORY MANAGEMENT
// ─────────────────────────────────────────
setInterval(()=>{
  if(objectURLs.size<=MAX_CACHED) return;
  const vIdx=Math.floor(scrollTop/rowH)*cols;
  const entries=[...objectURLs.entries()];
  entries.sort((a,b)=>Math.abs(a[0]-vIdx)-Math.abs(b[0]-vIdx));
  for(let i=MAX_CACHED;i<entries.length;i++){ URL.revokeObjectURL(entries[i][1]); objectURLs.delete(entries[i][0]); }
},8000);

// ─────────────────────────────────────────
//  INDEXEDDB — cached connection, single open
// ─────────────────────────────────────────
let _db = null;
function idbOpen() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res,rej)=>{
    const req=indexedDB.open('modngaan',1);
    req.onupgradeneeded=e=>e.target.result.createObjectStore('kv');
    req.onsuccess=e=>{ _db=e.target.result; res(_db); };
    req.onerror=()=>rej(req.error);
  });
}
async function idbSet(key,val) {
  try {
    const db=await idbOpen();
    await new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(val,key); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
  } catch{}
}
async function idbGet(key) {
  try {
    const db=await idbOpen();
    return new Promise((res,rej)=>{ const tx=db.transaction('kv','readonly'); const r=tx.objectStore('kv').get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  } catch { return null; }
}

// ─────────────────────────────────────────
//  SESSION PERSISTENCE
//  - sessionStorage: path, scroll, sort, zoom
//  - IndexedDB: root directory handle (FSAPI only)
//  - TTL: 3 hours
//  - Firefox: resumes by asking user to re-open the same folder
// ─────────────────────────────────────────
let scrollSaveTimer;

function saveSession() {
  if (!navStack.length) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      path:       navStack.map(e=>e.name),
      scrollTop:  viewport.scrollTop,
      sort:       sortEl.value,
      zoom:       zoomRange.value,
      ts:         Date.now()
    }));
  } catch{}
}

window.addEventListener('load', async ()=>{
  try {
    const raw=sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const data=JSON.parse(raw);
    if (!data.path?.length || Date.now()-data.ts>SESSION_TTL) {
      sessionStorage.removeItem(SESSION_KEY); return;
    }
    const handle = FSAPI ? await idbGet('root_handle') : null;
    const pathDisplay = data.path.join(' › ');
    const timeAgo = formatTimeAgo(data.ts);
    resumeLabel.textContent = `${pathDisplay}  (${timeAgo})`;
    resumeBanner.classList.add('show');
    document.getElementById('btn-resume').addEventListener('click', ()=>{
      resumeBanner.classList.remove('show');
      resumeSession(data, handle);
    });
  } catch{}
});

document.getElementById('btn-resume-dismiss').addEventListener('click', ()=>{
  resumeBanner.classList.remove('show');
  sessionStorage.removeItem(SESSION_KEY);
});

async function resumeSession(data, rootHandle) {
  // Restore UI preferences first
  if (data.zoom) { zoomRange.value=data.zoom; cols=Math.max(1,12-+data.zoom); }
  if (data.sort) sortEl.value=data.sort;

  // ── FSAPI path (Chrome/Edge) ──
  if (rootHandle && FSAPI) {
    try {
      let perm = await rootHandle.queryPermission({ mode:'read' });
      if (perm!=='granted') perm=await rootHandle.requestPermission({ mode:'read' });
      if (perm!=='granted') throw new Error('denied');
      clearSession();
      navStack=[{ kind:'fsapi', handle:rootHandle, name:data.path[0] }];
      await loadFSAPI(rootHandle);
      await drillDown(data.path);
      await restoreScroll(data.scrollTop);
      return;
    } catch{}
  }

  // ── Fallback path (Firefox/Safari or handle missing) ──
  // Ask user to re-open the folder — only one prompt needed
  if (FSAPI) {
    statusEl.textContent = `Re-open "${data.path[0]}" to resume`;
    try {
      const handle=await showDirectoryPicker({ mode:'read' });
      await idbSet('root_handle', handle);
      clearSession();
      navStack=[{ kind:'fsapi', handle, name:handle.name }];
      await loadFSAPI(handle);
      await drillDown(data.path);
      await restoreScroll(data.scrollTop);
    } catch(e) { if(e.name!=='AbortError') statusEl.textContent='Could not resume: '+e.message; }
  } else {
    // Firefox — webkitdirectory, ask to re-open
    statusEl.textContent = `Re-open "${data.path[0]}" to resume`;
    const inp=document.createElement('input');
    inp.type='file'; inp.webkitdirectory=true; inp.multiple=true;
    inp.addEventListener('change', async ()=>{
      if (!inp.files.length) return;
      const all=[...inp.files];
      clearSession();
      const rootName=all[0].webkitRelativePath.split('/')[0]||'Folder';
      navStack=[{ kind:'fb', name:rootName, allFiles:all, depth:1 }];
      renderFallback(all,1);
      await drillDown(data.path);
      await restoreScroll(data.scrollTop);
    });
    inp.click();
  }
}

// Navigate into subfolders by name after root is loaded
async function drillDown(path) {
  for (let i=1; i<path.length; i++) {
    const match=displayItems.find(item=>item.type==='folder'&&item.name===path[i]);
    if (match) await navigateInto(match); else break;
  }
}

async function restoreScroll(top) {
  if (!top) return;
  await tick(); // wait for grid render
  viewport.scrollTop=top; scrollTop=top; renderWindow();
}

// ─────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────
function tick() { return new Promise(r=>setTimeout(r,0)); }
function countLabel(n) { return n+' item'+(n!==1?'s':''); }
function formatTimeAgo(ts) {
  const s=Math.floor((Date.now()-ts)/1000);
  if (s<60) return 'just now';
  if (s<3600) return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h ago';
}
