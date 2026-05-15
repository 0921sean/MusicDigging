// ─────────────────────────────────────────────
//  Music Digging — app.js
// ─────────────────────────────────────────────

const LFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LFM_API_KEY = '048d40ced7589b88e9f774754a03f679';
const GEMINI_LOCAL_KEY = window.LOCAL_GEMINI_KEY || '';
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const VISION_ENDPOINT = IS_LOCAL
  ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_LOCAL_KEY}`
  : '/api/claude';
const ESCAPE_CARD_COUNT = 5;
const ESCAPE_GENRES = [
  'jazz', 'classical', 'electronic', 'hip-hop', 'reggae',
  'blues', 'folk', 'ambient', 'metal', 'bossa nova',
  'soul', 'punk', 'country', 'r&b', 'afrobeat', 'indie',
];

// ── State ──────────────────────────────────────
const state = {
  apiKey: LFM_API_KEY,
  musicApp: localStorage.getItem('musicApp') || '',
  seeds: JSON.parse(localStorage.getItem('seeds') || '[]'),
  queue: [],
  dynamicSeeds: [],   // original seeds + liked tracks (most recent first)
  escapeQueue: [],    // genre-escape queue (separate — never mixed into main)
  escapeMode: false,
  escapeRemaining: 0,
  likes: JSON.parse(localStorage.getItem('savedLikes') || '[]'),
  passed: new Set(JSON.parse(localStorage.getItem('passedTracks') || '[]')),
  isAnimating: false,
};

// ── Drag state (module-level so listeners don't stack) ──
const drag = { active: false, startX: 0, card: null };

// ── Persistence ────────────────────────────────
function persist() {
  localStorage.setItem('musicApp', state.musicApp);
  localStorage.setItem('seeds', JSON.stringify(state.seeds));
  localStorage.setItem('savedLikes', JSON.stringify(state.likes));
  localStorage.setItem('passedTracks', JSON.stringify([...state.passed]));
}

// ── Screen routing ──────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ── Toast ───────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── XSS guard ──────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Last.fm API ─────────────────────────────────
async function lfm(params) {
  const url = new URL(LFM_BASE);
  url.search = new URLSearchParams({
    ...params,
    api_key: state.apiKey,
    format: 'json',
  }).toString();

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('네트워크 오류 (' + res.status + ')');
  const data = await res.json();
  if (data.error) throw new Error(data.message || 'Last.fm 오류 ' + data.error);
  return data;
}

async function fetchSimilar(artist, track, limit = 20) {
  try {
    const data = await lfm({ method: 'track.getSimilar', artist, track, limit });
    return (data.similartracks?.track || []).map(t => ({
      id: t.artist.name + '::' + t.name,
      track: t.name,
      artist: t.artist.name,
      tags: [],
      isEscape: false,
    }));
  } catch (e) {
    console.warn('getSimilar failed:', artist, '-', track, '—', e.message);
    return [];
  }
}

async function fetchTags(artist, track) {
  try {
    const data = await lfm({ method: 'track.getTopTags', artist, track });
    return (data.toptags?.tag || []).slice(0, 3).map(t => t.name.toLowerCase());
  } catch {
    return [];
  }
}

async function fetchEscapeTracks(excludeTags) {
  const pool = ESCAPE_GENRES.filter(g => !excludeTags.includes(g));
  const genre = pool[Math.floor(Math.random() * pool.length)];
  try {
    const data = await lfm({ method: 'tag.getTopTracks', tag: genre, limit: 10 });
    return (data.tracks?.track || []).map(t => ({
      id: t.artist.name + '::' + t.name,
      track: t.name,
      artist: t.artist.name,
      tags: [genre],
      isEscape: true,
    }));
  } catch (e) {
    console.warn('getEscapeTracks failed:', e.message);
    return [];
  }
}

// ── Preview player ──────────────────────────────
const player = new Audio();
player.volume = 0.7;
let currentPreviewId = null;

async function fetchItunesData(artist, track) {
  try {
    const res = await fetch(
      'https://itunes.apple.com/search?term=' +
      encodeURIComponent(artist + ' ' + track) +
      '&entity=song&limit=1'
    );
    const data = await res.json();
    const r = data.results?.[0];
    if (!r) return { artworkUrl: null, previewUrl: null };
    return {
      artworkUrl: r.artworkUrl100?.replace('100x100bb', '600x600bb') || null,
      previewUrl: r.previewUrl || null,
    };
  } catch {
    return { artworkUrl: null, previewUrl: null };
  }
}

async function getItunesData(item) {
  if (item._itunesFetched) return;
  item._itunesFetched = true;
  const data = await fetchItunesData(item.artist, item.track);
  item.artworkUrl = data.artworkUrl;
  item.previewUrl = data.previewUrl;
}

function stopPreview() {
  player.pause();
  currentPreviewId = null;
  document.querySelectorAll('.preview-btn').forEach(b => {
    b.textContent = '▶';
    b.classList.remove('playing');
  });
  document.querySelectorAll('.preview-bar').forEach(b => b.classList.remove('active'));
}

async function togglePreview(item, btn, bar) {
  if (currentPreviewId === item.id && !player.paused) {
    stopPreview();
    return;
  }

  stopPreview();
  btn.textContent = '로딩 중...';
  btn.disabled = true;

  await getItunesData(item);

  if (!btn.isConnected) return;
  btn.disabled = false;

  const url = item.previewUrl;
  if (!url) {
    toast('미리듣기를 찾을 수 없어.');
    btn.textContent = '▶';
    return;
  }

  currentPreviewId = item.id;
  player.src = url;
  player.currentTime = 0;
  player.play();
  btn.textContent = '■';
  btn.classList.add('playing');

  // Progress bar
  bar.classList.add('active');
  const fill = bar.querySelector('.preview-bar-fill');
  fill.style.width = '0%';

  player.ontimeupdate = () => {
    if (!player.duration) return;
    fill.style.width = (player.currentTime / player.duration * 100) + '%';
  };

  player.onended = () => {
    if (currentPreviewId === item.id) {
      currentPreviewId = null;
      btn.textContent = '▶';
      btn.classList.remove('playing');
      bar.classList.remove('active');
      fill.style.width = '0%';
    }
  };
}

// ── Claude Vision Import ─────────────────────────
let importContext = 'setup';

function resizeAndEncode(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1100;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
        else { width = Math.round(width * MAX / height); height = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        const reader = new FileReader();
        reader.onload = () => resolve({ type: 'image/jpeg', data: reader.result.split(',')[1] });
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.78);
    };
    img.src = url;
  });
}

async function parseImagesWithClaude(files) {
  const images = await Promise.all([...files].map(resizeAndEncode));

  const res = await fetch(VISION_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          ...images.map(img => ({
            inline_data: { mime_type: img.type, data: img.data },
          })),
          {
            text: '이 스크린샷들은 음악 앱 재생목록입니다. 보이는 모든 곡을 아래 형식으로만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.\n\n아티스트명|||곡명\n아티스트명|||곡명',
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || err.error?.status || 'API 오류 ' + res.status);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  const seen = new Set();
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('|||'))
    .map(l => {
      const [artist, track] = l.split('|||').map(s => s.trim());
      return (artist && track) ? { artist, track, id: artist + '::' + track } : null;
    })
    .filter(Boolean)
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
}

function setImportModalBody(html) {
  document.getElementById('import-modal-body').innerHTML = html;
}

function openImportModal(context) {
  importContext = context;
  document.getElementById('import-modal-title').textContent =
    context === 'discover' ? '재생목록 추가하기' : '재생목록 가져오기';
  document.getElementById('import-modal').style.display = 'flex';
  showUploadArea();
}

function closeImportModal() {
  document.getElementById('import-modal').style.display = 'none';
}

function showUploadArea() {
  setImportModalBody(`
    <label class="upload-area" id="upload-area-label">
      <div class="upload-icon">📷</div>
      <div class="upload-text">이미지 클릭 또는 끌어다 놓기</div>
      <div class="upload-sub">재생목록 스크린샷 여러 장<br>동시 업로드 가능</div>
      <input type="file" id="import-file-input" accept="image/*" multiple style="display:none">
    </label>
  `);

  const label = document.getElementById('upload-area-label');
  const input = document.getElementById('import-file-input');

  label.addEventListener('dragover', e => { e.preventDefault(); label.classList.add('drag-over'); });
  label.addEventListener('dragleave', () => label.classList.remove('drag-over'));
  label.addEventListener('drop', e => {
    e.preventDefault();
    label.classList.remove('drag-over');
    handleImportFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => handleImportFiles(input.files));
}

async function handleImportFiles(files) {
  if (!files || !files.length) return;

  setImportModalBody(`
    <div class="import-loading">
      <div class="loading-spinner"></div>
      <div>이미지 ${files.length}장 분석 중...</div>
    </div>
  `);

  try {
    const tracks = await parseImagesWithClaude(files);

    if (!tracks.length) {
      setImportModalBody(`
        <div class="import-error">
          <div style="font-size:44px;margin-bottom:14px">🤔</div>
          <p>곡을 찾지 못했어.<br>재생목록 화면에서 곡명·아티스트가 잘 보이는 스크린샷이 잘 돼요.<br><span style="font-size:11px;opacity:0.6">YouTube Music '재생목록' 또는 '좋아요 표시한 음악' 화면 권장</span></p>
          <button class="import-action-btn" id="retry-btn" style="margin-top:20px;background:var(--surface2);color:var(--text)">다시 시도</button>
        </div>
      `);
      document.getElementById('retry-btn').addEventListener('click', showUploadArea);
      return;
    }

    const existingIds = new Set(state.seeds.map(s => s.artist + '::' + s.track));
    const newTracks = tracks.filter(t => !existingIds.has(t.id));
    const dupCount = tracks.length - newTracks.length;

    setImportModalBody(`
      <div>
        <div class="import-results-header">
          ${tracks.length}곡 발견${dupCount ? ` · 중복 ${dupCount}곡 제외` : ''} →
          <strong style="color:var(--text)">신규 ${newTracks.length}곡</strong>
        </div>
        <div class="import-track-list">
          ${tracks.map(t => {
            const dup = existingIds.has(t.id);
            return `<div class="import-track-row${dup ? ' dup' : ''}">
              <div class="import-track-name">${esc(t.track)}</div>
              <div class="import-artist-name">${esc(t.artist)}${dup ? ' · 이미 추가됨' : ''}</div>
            </div>`;
          }).join('')}
        </div>
        ${newTracks.length > 0
          ? `<button class="import-action-btn" id="import-confirm-btn">
              ${importContext === 'setup'
                ? `씨드로 추가 (${newTracks.length}곡)`
                : `추천에 반영 (${newTracks.length}곡)`}
            </button>`
          : `<p style="text-align:center;color:var(--muted);font-size:13px;padding:8px 0">모두 이미 추가된 곡이에요.</p>`
        }
      </div>
    `);

    document.getElementById('import-confirm-btn')?.addEventListener('click', () => {
      closeImportModal();
      confirmImport(newTracks);
    });

  } catch (e) {
    setImportModalBody(`
      <div class="import-error">
        <div style="font-size:44px;margin-bottom:14px">⚠️</div>
        <p style="margin-bottom:16px">${esc(e.message)}</p>
        <button class="import-action-btn" id="retry-btn" style="background:var(--surface2);color:var(--text)">다시 시도</button>
      </div>
    `);
    document.getElementById('retry-btn').addEventListener('click', showUploadArea);
  }
}

function confirmImport(tracks) {
  if (importContext === 'setup') {
    const existing = new Set(state.seeds.map(s => s.artist + '::' + s.track));
    const toAdd = tracks.filter(t => !existing.has(t.artist + '::' + t.track));
    state.seeds.push(...toAdd.map(t => ({ artist: t.artist, track: t.track })));
    persist();
    renderSeeds();
    toast(`✅ ${toAdd.length}곡 씨드에 추가됨`);
  } else {
    addSeedsAndRefresh(tracks);
  }
}

async function addSeedsAndRefresh(tracks) {
  // Prepend new tracks to dynamicSeeds so recommendations shift direction
  for (const t of [...tracks].reverse()) {
    state.dynamicSeeds.unshift({ artist: t.artist, track: t.track });
  }
  if (state.dynamicSeeds.length > 20) state.dynamicSeeds.length = 20;

  toast('🎵 새 추천 불러오는 중...');

  const results = await Promise.all(
    tracks.slice(0, 5).map(s => fetchSimilar(s.artist, s.track, 12))
  );

  const seen = new Set([
    ...state.passed,
    ...state.likes.map(l => l.id),
    ...state.queue.map(q => q.id),
  ]);

  const fresh = [];
  for (const list of results) {
    for (const t of list) {
      if (!seen.has(t.id) && !fresh.find(m => m.id === t.id)) fresh.push(t);
    }
  }

  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
  }

  // Insert right after current front card so new direction kicks in soon
  const insertAt = Math.min(1, state.queue.length);
  state.queue.splice(insertAt, 0, ...fresh.slice(0, 25));
  persist();
  toast(`✨ ${fresh.length}곡 추천 업데이트됨`);
}

// ── Setup screen ────────────────────────────────
function renderSeeds() {
  const list = document.getElementById('seed-list');
  list.innerHTML = state.seeds.map((s, i) => `
    <div class="seed-item">
      <span><strong>${esc(s.track)}</strong> — ${esc(s.artist)}</span>
      <button class="remove" data-i="${i}">×</button>
    </div>
  `).join('');

  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.seeds.splice(Number(btn.dataset.i), 1);
      renderSeeds();
    });
  });

  validateStartBtn();
}

function validateStartBtn() {
  document.getElementById('start-btn').disabled = state.seeds.length === 0;
}

function addSeed() {
  const artistEl = document.getElementById('artist-input');
  const trackEl = document.getElementById('track-input');
  const artist = artistEl.value.trim();
  const track = trackEl.value.trim();

  if (!artist || !track) {
    toast('아티스트와 노래 제목을 모두 입력해줘.');
    return;
  }
  if (state.seeds.length >= 10) {
    toast('수동 입력은 최대 10곡까지. 더 추가하려면 📷 가져오기를 써봐.');
    return;
  }

  state.seeds.push({ artist, track });
  artistEl.value = '';
  trackEl.value = '';
  artistEl.focus();
  renderSeeds();
}

async function startDigging() {
  if (!state.seeds.length) { toast('씨드 트랙을 1곡 이상 추가해줘.'); return; }

  state.musicApp = document.getElementById('music-app-select').value;
  persist();

  showScreen('discover');
  await loadQueue();
}

// ── Discover screen ─────────────────────────────
async function loadQueue() {
  setCardArea('<div class="loading-msg">추천 불러오는 중...</div>');

  state.dynamicSeeds = [...state.seeds];

  const results = await Promise.all(
    state.seeds.slice(0, 10).map(s => fetchSimilar(s.artist, s.track, 20))
  );

  const seen = new Set([...state.passed, ...state.likes.map(l => l.id)]);
  const merged = [];

  for (const list of results) {
    for (const t of list) {
      if (!seen.has(t.id) && !merged.find(m => m.id === t.id)) {
        merged.push(t);
      }
    }
  }

  // Shuffle
  for (let i = merged.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [merged[i], merged[j]] = [merged[j], merged[i]];
  }

  state.queue = merged.slice(0, 40);

  if (!state.queue.length) {
    showEmpty('Last.fm에서 추천을 가져오지 못했어.<br>다른 씨드 트랙을 써봐. (인기 아티스트가 잘 돼)');
    return;
  }

  // Prefetch tags for the first card in the background
  prefetchCardData(0);
  renderCards();
}

async function refillQueue() {
  const recentSeeds = state.dynamicSeeds.slice(0, 5);
  const results = await Promise.all(
    recentSeeds.map(s => fetchSimilar(s.artist, s.track, 15))
  );

  const seen = new Set([
    ...state.passed,
    ...state.likes.map(l => l.id),
    ...state.queue.map(q => q.id),
  ]);
  const newTracks = [];

  for (const list of results) {
    for (const t of list) {
      if (!seen.has(t.id) && !newTracks.find(m => m.id === t.id)) {
        newTracks.push(t);
      }
    }
  }

  for (let i = newTracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newTracks[i], newTracks[j]] = [newTracks[j], newTracks[i]];
  }

  state.queue.push(...newTracks.slice(0, 20));
}

async function prefetchCardData(index) {
  const queue = state.escapeMode ? state.escapeQueue : state.queue;
  const item = queue[index];
  if (!item) return;

  await Promise.all([
    item.tags.length === 0
      ? fetchTags(item.artist, item.track).then(tags => { item.tags = tags; })
      : Promise.resolve(),
    getItunesData(item),
  ]);

  const front = document.querySelector('.card.is-front');
  if (front && front.dataset.id === item.id) renderCards();
}

function renderCards() {
  const queue = state.escapeMode ? state.escapeQueue : state.queue;

  if (!queue.length) {
    if (state.escapeMode) {
      exitEscapeMode();
    } else {
      showEmpty('더 이상 추천할 노래가 없어.<br>씨드 트랙을 추가하고 새로 시작해봐.');
    }
    return;
  }

  const area = document.getElementById('card-area');
  area.innerHTML = '';

  if (queue[1]) area.appendChild(buildCard(queue[1], false));
  const front = buildCard(queue[0], true);
  area.appendChild(front);
  attachDrag(front);
}

function buildCard(item, isFront) {
  const card = document.createElement('div');
  card.className = 'card ' + (isFront ? 'is-front' : 'is-back');
  card.dataset.id = item.id;

  const tagsHtml = item.tags.length
    ? item.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
    : '<span class="tag" style="opacity:0.4">로딩 중...</span>';

  const artUrl = item.artworkUrl || '';

  const artLoading = !artUrl && !item._itunesFetched;
  card.innerHTML = `
    <div class="card-art${artLoading ? ' loading' : ''}"${artUrl ? ` style="background-image:url('${artUrl}')"` : ''}>
      ${(!artUrl && !artLoading) ? '<div class="card-art-placeholder">🎵</div>' : ''}
      ${item.isEscape ? '<span class="escape-badge">🎲 장르 탈출</span>' : ''}
      <div class="card-info-overlay">
        <div class="card-tags">${tagsHtml}</div>
        <div class="card-info-row">
          <div class="card-text">
            <div class="card-track">${esc(item.track)}</div>
            <div class="card-artist">${esc(item.artist)}</div>
          </div>
          ${isFront ? `<button class="preview-btn">▶</button>` : ''}
        </div>
      </div>
      ${isFront ? `<div class="preview-bar"><div class="preview-bar-fill"></div></div>` : ''}
    </div>
    <div class="swipe-label like">LIKE</div>
    <div class="swipe-label pass">PASS</div>
  `;

  if (isFront) {
    const btn = card.querySelector('.preview-btn');
    const bar = card.querySelector('.preview-bar');
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    btn.addEventListener('click', () => togglePreview(item, btn, bar));
  }

  return card;
}

// ── Drag ────────────────────────────────────────
function attachDrag(card) {
  card.addEventListener('mousedown', e => beginDrag(card, e.clientX));
  card.addEventListener('touchstart', e => beginDrag(card, e.touches[0].clientX), { passive: true });
}

function beginDrag(card, x) {
  if (state.isAnimating) return;
  drag.active = true;
  drag.startX = x;
  drag.card = card;
  card.style.transition = 'none';
}

window.addEventListener('mousemove', e => { if (drag.active) moveDrag(e.clientX); });
window.addEventListener('touchmove', e => { if (drag.active) moveDrag(e.touches[0].clientX); }, { passive: true });
window.addEventListener('mouseup', endDrag);
window.addEventListener('touchend', endDrag);

function moveDrag(x) {
  if (!drag.active || !drag.card) return;
  const delta = x - drag.startX;
  drag.card.style.transform = `translateX(${delta}px) rotate(${delta * 0.07}deg)`;

  const THRESHOLD = 55;
  const likeLabel = drag.card.querySelector('.swipe-label.like');
  const passLabel = drag.card.querySelector('.swipe-label.pass');

  if (delta > THRESHOLD) {
    likeLabel.style.opacity = Math.min((delta - THRESHOLD) / 50, 1);
    passLabel.style.opacity = 0;
  } else if (delta < -THRESHOLD) {
    passLabel.style.opacity = Math.min((-delta - THRESHOLD) / 50, 1);
    likeLabel.style.opacity = 0;
  } else {
    likeLabel.style.opacity = 0;
    passLabel.style.opacity = 0;
  }
}

function endDrag() {
  if (!drag.active || !drag.card) return;
  const delta = Number(drag.card.style.transform.match(/translateX\((-?\d+\.?\d*)px\)/)?.[1] || 0);
  drag.active = false;

  if (Math.abs(delta) > 80) {
    commitSwipe(delta > 0 ? 'right' : 'left');
  } else {
    drag.card.style.transition = 'transform 0.3s';
    drag.card.style.transform = '';
    drag.card = null;
  }
}

// ── Swipe logic ─────────────────────────────────
function swipeCard(direction) {
  if (state.isAnimating) return;
  const front = document.querySelector('.card.is-front');
  if (!front) return;
  commitSwipe(direction, front);
}

function commitSwipe(direction, card) {
  card = card || drag.card || document.querySelector('.card.is-front');
  if (!card || state.isAnimating) return;
  drag.card = null;

  state.isAnimating = true;
  card.style.transition = 'transform 0.35s ease-in';
  card.style.transform = `translateX(${direction === 'right' ? '160%' : '-160%'}) rotate(${direction === 'right' ? 22 : -22}deg)`;

  const queue = state.escapeMode ? state.escapeQueue : state.queue;
  const item = queue[0];

  stopPreview();

  if (direction === 'right') {
    state.likes.unshift({ id: item.id, track: item.track, artist: item.artist, timestamp: Date.now() });
    state.dynamicSeeds.unshift({ artist: item.artist, track: item.track });
    if (state.dynamicSeeds.length > 10) state.dynamicSeeds.pop();
    toast('♥ ' + item.track);
  } else {
    state.passed.add(item.id);
  }

  queue.shift();

  if (state.escapeMode) {
    state.escapeRemaining--;
    if (state.escapeRemaining <= 0) exitEscapeMode(true);
    else updateEscapeBtn();
  }

  if (!state.escapeMode && state.queue.length < 8) refillQueue();

  persist();

  setTimeout(() => {
    state.isAnimating = false;
    prefetchCardData(0);
    renderCards();
  }, 360);
}

// ── Genre escape ────────────────────────────────
async function handleEscape() {
  if (state.escapeMode) return;

  const btn = document.getElementById('escape-btn');
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';

  // Get user's usual genre tags from seeds
  const tagArrays = await Promise.all(state.seeds.map(s => fetchTags(s.artist, s.track)));
  const userTags = [...new Set(tagArrays.flat())];

  const tracks = await fetchEscapeTracks(userTags);

  btn.style.opacity = '';
  btn.style.pointerEvents = '';

  if (!tracks.length) {
    toast('장르 탈출 추천을 가져오지 못했어. 다시 시도해봐.');
    return;
  }

  state.escapeQueue = tracks;
  state.escapeMode = true;
  state.escapeRemaining = ESCAPE_CARD_COUNT;
  updateEscapeBtn();
  renderCards();
  toast('🎲 장르 탈출 모드 — 5곡 후 돌아와');
}

function exitEscapeMode(announce = false) {
  state.escapeMode = false;
  state.escapeQueue = [];
  state.escapeRemaining = 0;
  updateEscapeBtn();
  if (announce) toast('메인 추천으로 돌아왔어.');
  renderCards();
}

function updateEscapeBtn() {
  const btn = document.getElementById('escape-btn');
  const pill = document.getElementById('escape-pill');
  if (state.escapeMode) {
    btn.classList.add('active');
    pill.style.display = 'inline';
    pill.textContent = state.escapeRemaining;
  } else {
    btn.classList.remove('active');
    pill.style.display = 'none';
  }
}

// ── Likes screen ────────────────────────────────
function showLikes() {
  const list = document.getElementById('likes-list');
  if (!state.likes.length) {
    list.innerHTML = '<div class="empty"><div class="icon">💔</div><p>아직 좋아요한 노래가 없어.<br>스와이프하면서 채워봐.</p></div>';
  } else {
    list.innerHTML = state.likes.map(l => `
      <div class="like-row">
        <div class="info">
          <div class="t">${esc(l.track)}</div>
          <div class="a">${esc(l.artist)}</div>
        </div>
        <a class="yt-btn"
           href="https://music.youtube.com/search?q=${encodeURIComponent(l.artist + ' ' + l.track)}"
           target="_blank">
          YT ↗
        </a>
      </div>
    `).join('');
  }
  showScreen('likes');
}

// ── Helpers ─────────────────────────────────────
function setCardArea(html) {
  document.getElementById('card-area').innerHTML = html;
}

function showEmpty(msg) {
  setCardArea(`<div class="empty"><div class="icon">🎵</div><p>${msg}</p></div>`);
}

// ── Wire up events ──────────────────────────────
document.getElementById('add-seed-btn').addEventListener('click', addSeed);
document.getElementById('track-input').addEventListener('keydown', e => { if (e.key === 'Enter') addSeed(); });
document.getElementById('artist-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('track-input').focus(); });
document.getElementById('setup-nav-btn').addEventListener('click', () => showScreen('setup'));
document.getElementById('start-btn').addEventListener('click', startDigging);
document.getElementById('pass-btn').addEventListener('click', () => swipeCard('left'));
document.getElementById('like-btn').addEventListener('click', () => swipeCard('right'));
document.getElementById('escape-btn').addEventListener('click', handleEscape);
document.getElementById('likes-nav-btn').addEventListener('click', showLikes);
document.getElementById('back-btn').addEventListener('click', () => showScreen('discover'));
document.getElementById('setup-import-btn').addEventListener('click', () => openImportModal('setup'));
document.getElementById('discover-import-btn').addEventListener('click', () => openImportModal('discover'));
document.getElementById('import-modal-close').addEventListener('click', closeImportModal);
document.getElementById('import-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeImportModal();
});

// ── Init ────────────────────────────────────────
(function init() {
  if (state.musicApp) document.getElementById('music-app-select').value = state.musicApp;

  if (state.seeds.length > 0) {
    showScreen('discover');
    loadQueue();
  }

  renderSeeds();
})();
