// ── Auth ─────────────────────────────────────────────────
function getAuthToken() { return localStorage.getItem('auth_token'); }

async function apiFetch(url, opts = {}) {
  const token = getAuthToken();
  if (token) {
    opts.headers = { ...opts.headers, 'Authorization': 'Bearer ' + token };
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    localStorage.removeItem('auth_token');
    window.location.href = '/login.html';
    throw new Error('Unauthorized');
  }
  return res;
}

function logout() {
  localStorage.removeItem('auth_token');
  window.location.href = '/login.html';
}

// ── State ────────────────────────────────────────────────
let entities = { self: null, competitors: [], all: [] };
let articleOffset = 0;
const ARTICLE_LIMIT = 50;
let searchTimer = null;

// ── Auto-Refresh System ─────────────────────────────────
// Crawl log cache & staleness detection
var _crawlLogCache = null;
var _autoRefreshInFlight = {};  // prevent double-triggers
const STALE_HOURS = 4;  // auto-crawl if data older than this

// Map: tabName → { crawlType, triggerFn, btnId }
// Tabs excluded from auto-crawl: brief (AI costs), holdings/13f (very slow), export, log, stats, trends
const TAB_CRAWL_MAP = {
  'news':        { crawlType: 'news',           triggerFn: 'triggerCrawl',           btnId: 'btnCrawlAll' },
  'fin-news':    { crawlType: 'financial-news',  triggerFn: 'triggerFinNewsCrawl',    btnId: 'btnCrawlFinNews' },
  'sec':         { crawlType: 'sec_scanner',     triggerFn: 'triggerSecScan',         btnId: 'btnSecScan' },
  'personnel':   { crawlType: 'personnel',       triggerFn: 'triggerPersonnelCrawl',  btnId: 'btnPersonnelCrawl' },
  'predictions': { crawlType: 'predictions',     triggerFn: 'triggerPredictionsCrawl',btnId: 'btnPredCrawl' },
  'aum':         { crawlType: 'aum-crawl',       triggerFn: 'triggerAumCrawl',        btnId: 'btnAumCrawl' },
  'social':      { crawlType: null,              triggerFn: 'triggerSocialCrawl',     btnId: 'btnSocialCrawl' },
  'adv':         { crawlType: 'adv_analysis',    triggerFn: 'triggerAdvCrawl',        btnId: 'btnAdvCrawl' },
  'jobs':        { crawlType: 'job_postings',    triggerFn: 'triggerJobsCrawl',       btnId: 'btnJobsCrawl' },
  'market':      { crawlType: null,              triggerFn: 'triggerMarketCrawl',     btnId: 'btnMarketCrawl' },
  'calendar':    { crawlType: 'gov_calendar',    triggerFn: 'triggerGovCrawl',        btnId: 'btnCrawlGov' },
};

async function loadCrawlLogCache() {
  try {
    var res = await apiFetch('/api/crawl-log');
    if (!res.ok) { _crawlLogCache = []; return; }
    _crawlLogCache = await res.json();
    if (!Array.isArray(_crawlLogCache)) _crawlLogCache = [];
  } catch (e) {
    _crawlLogCache = [];
  }
}

function getLastCrawlTime(crawlType) {
  if (!_crawlLogCache || !crawlType) return null;
  for (var i = 0; i < _crawlLogCache.length; i++) {
    var entry = _crawlLogCache[i];
    if (entry.crawl_type === crawlType && (entry.status === 'success' || entry.status === 'completed')) {
      var ts = entry.finished_at || entry.started_at;
      if (!ts) continue;
      var d = new Date(ts);
      if (isNaN(d.getTime())) continue;  // skip invalid dates
      return d;
    }
  }
  return null;
}

function formatStalenessLabel(date) {
  if (!date) return 'Never';
  var diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function isStale(crawlType) {
  var last = getLastCrawlTime(crawlType);
  if (!last) return true;
  return (Date.now() - last.getTime()) > STALE_HOURS * 3600 * 1000;
}

function showLastUpdated(tabName) {
  var cfg = TAB_CRAWL_MAP[tabName];
  if (!cfg) return;
  var last = getLastCrawlTime(cfg.crawlType);
  var label = formatStalenessLabel(last);
  // Find or create the timestamp badge next to the button
  var btn = cfg.btnId ? document.getElementById(cfg.btnId) : null;
  if (!btn) return;
  var badge = btn.parentElement.querySelector('.last-updated-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'last-updated-badge';
    btn.parentElement.insertBefore(badge, btn.nextSibling);
  }
  var color = !last ? 'var(--text-muted)' : isStale(cfg.crawlType) ? 'var(--gold)' : 'var(--positive)';
  badge.innerHTML = '<span style="font-size:11px;color:' + color + ';margin-left:8px;opacity:0.85">⏱ ' + label + '</span>';
}

function checkAutoRefresh(tabName) {
  var cfg = TAB_CRAWL_MAP[tabName];
  if (!cfg || !cfg.triggerFn) return;
  if (!cfg.crawlType) return; // no crawl type to check staleness
  if (_autoRefreshInFlight[tabName]) return;  // already running
  if (!isStale(cfg.crawlType)) {
    showLastUpdated(tabName);
    return;
  }
  // Auto-trigger crawl
  _autoRefreshInFlight[tabName] = true;
  console.log('[AutoRefresh] Tab "' + tabName + '" is stale, auto-crawling...');
  try {
    var fn = window[cfg.triggerFn];
    if (typeof fn === 'function') {
      Promise.resolve(fn()).then(function() {
        _autoRefreshInFlight[tabName] = false;
        loadCrawlLogCache().then(function() { showLastUpdated(tabName); });
      }).catch(function() {
        _autoRefreshInFlight[tabName] = false;
      });
    }
  } catch (e) {
    _autoRefreshInFlight[tabName] = false;
  }
  showLastUpdated(tabName);
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Auth check — redirect to login if no token
  if (!getAuthToken()) { window.location.href = '/login.html'; return; }
  await loadEntities();
  // Load crawl log for auto-refresh timestamps (await to prevent race with switchTab)
  await loadCrawlLogCache();
  // Restore last active tab, or default to Daily Brief
  var savedTab = null;
  try { savedTab = localStorage.getItem('ci_active_tab'); } catch(e) {}
  if (savedTab && document.querySelector('[data-tab="' + savedTab + '"]')) {
    switchTab(savedTab);
  } else {
    loadBrief(); // Daily Brief is the default tab
  }

  // Default calendar date range: today - 7 days to today + 90 days
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const end = new Date(now);
  end.setDate(end.getDate() + 90);
  document.getElementById('filterStartDate').value = isoDate(start);
  document.getElementById('filterEndDate').value = isoDate(end);

  // Populate AUM and SEC entity selects
  populateAumEntitySelect();
  populateSecEntitySelect();
});

// ── Entities ─────────────────────────────────────────────
async function loadEntities() {
  try {
    const res = await apiFetch('/api/entities');
    entities = await res.json();
    populateEntityFilters();
  } catch (err) {
    console.error('Failed to load entities:', err);
  }
}

function populateEntityFilters() {
  const tier1 = document.getElementById('tier1Options');
  const tier2 = document.getElementById('tier2Options');
  tier1.innerHTML = '';
  tier2.innerHTML = '';

  for (const c of entities.competitors) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (c.tier === 1) tier1.appendChild(opt);
    else tier2.appendChild(opt);
  }
}

// ── Articles ─────────────────────────────────────────────
async function loadArticles(append = false) {
  if (!append) articleOffset = 0;

  const entity = document.getElementById('filterEntity').value;
  const sentiment = document.getElementById('filterSentiment').value;
  const search = document.getElementById('filterSearch').value;

  const params = new URLSearchParams({
    entity, sentiment, search,
    limit: ARTICLE_LIMIT,
    offset: articleOffset,
  });

  try {
    const res = await apiFetch(`/api/articles?${params}`);
    const articles = await res.json();

    const container = document.getElementById('articlesList');
    if (!append) container.innerHTML = '';

    if (articles.length === 0 && !append) {
      container.innerHTML = '<div class="empty">No articles found. Run a crawl to get started.</div>';
      document.getElementById('btnLoadMore').style.display = 'none';
      return;
    }

    for (const a of articles) {
      container.appendChild(renderArticle(a));
    }

    document.getElementById('btnLoadMore').style.display =
      articles.length === ARTICLE_LIMIT ? 'inline-block' : 'none';
  } catch (err) {
    console.error('Failed to load articles:', err);
  }
}

function loadMore() {
  articleOffset += ARTICLE_LIMIT;
  loadArticles(true);
}

function renderArticle(a) {
  const div = document.createElement('div');
  div.className = `article-card${a.entity_id === 'dobbs-group' ? ' self' : ''}`;

  const isSelf = a.entity_id === 'dobbs-group';
  const pubDate = a.pub_date ? new Date(a.pub_date) : null;
  const dateStr = pubDate ? formatDateTime(pubDate) : '';
  const timeAgo = pubDate ? getTimeAgo(pubDate) : '';

  div.innerHTML = `
    <div class="article-header">
      <a href="${escHtml(a.link)}" target="_blank" rel="noopener" class="article-title">${escHtml(a.title)}</a>
      <div class="article-badges">
        <span class="sentiment-badge sentiment-${a.sentiment_label}">${a.sentiment_label}</span>
      </div>
    </div>
    <div class="article-meta">
      <span class="entity-tag${isSelf ? ' self-tag' : ''}">${escHtml(a.entity_name)}</span>
      ${a.source ? `<span class="article-source">${escHtml(a.source)}</span>` : ''}
      <span class="article-date" title="${dateStr}">${timeAgo || dateStr}</span>
    </div>
    ${a.snippet ? `<div class="article-snippet">${escHtml(a.snippet).substring(0, 300)}${a.snippet.length > 300 ? '...' : ''}</div>` : ''}
    <div class="article-footer">
      <a href="${escHtml(a.link)}" target="_blank" rel="noopener" class="read-more">Read full article &#8594;</a>
    </div>
  `;
  return div;
}

function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return '';
}

function formatDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadArticles(), 400);
}

// ── Stats ────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await apiFetch('/api/stats');
    const stats = await res.json();
    renderStats(stats);
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderStats(stats) {
  const container = document.getElementById('statsGrid');
  container.innerHTML = '';

  if (stats.length === 0) {
    container.innerHTML = '<div class="v2-empty">No data yet. Run a crawl to get started.</div>';
    return;
  }

  // Self card first
  const selfStat = stats.find(s => s.entity_id === 'dobbs-group');
  if (selfStat) {
    container.appendChild(renderStatCard(selfStat, true));
  }

  // Competitors
  for (const s of stats) {
    if (s.entity_id === 'dobbs-group') continue;
    container.appendChild(renderStatCard(s, false));
  }
}

function renderStatCard(s, isSelf) {
  const entity = entities.all.find(e => e.id === s.entity_id);
  const tier = entity ? (entity.tier === 'self' ? 'Self' : `Tier ${entity.tier}`) : '';

  const total = s.total || 1;
  const posPct = Math.round((s.positive / total) * 100);
  const neuPct = Math.round((s.neutral / total) * 100);
  const negPct = 100 - posPct - neuPct;

  const div = document.createElement('div');
  div.className = `stat-card${isSelf ? ' self-card' : ''}`;
  div.style.cursor = 'pointer';
  div.onclick = () => navigateToEntity(s.entity_id);
  div.innerHTML = `
    <div class="stat-card-header">
      <h3>
        ${escHtml(s.entity_name)}
        <span class="tier-badge">${tier}</span>
      </h3>
      <span class="stat-arrow">View Articles &#8594;</span>
    </div>
    <div class="stat-numbers">
      <div class="stat-num total"><div class="num">${s.total}</div><div class="lbl">Total</div></div>
      <div class="stat-num pos"><div class="num">${s.positive}</div><div class="lbl">Positive</div></div>
      <div class="stat-num neu"><div class="num">${s.neutral}</div><div class="lbl">Neutral</div></div>
      <div class="stat-num neg"><div class="num">${s.negative}</div><div class="lbl">Negative</div></div>
    </div>
    <div class="stat-bar">
      <div class="stat-bar-pos" style="width:${posPct}%" title="${posPct}% Positive"></div>
      <div class="stat-bar-neu" style="width:${neuPct}%" title="${neuPct}% Neutral"></div>
      <div class="stat-bar-neg" style="width:${negPct}%" title="${negPct}% Negative"></div>
    </div>
    <div class="stat-latest">Latest: ${s.latest_article ? formatDateTime(s.latest_article) : 'N/A'}</div>
  `;
  return div;
}

function navigateToEntity(entityId) {
  document.getElementById('filterEntity').value = entityId;
  document.getElementById('filterSentiment').value = 'all';
  document.getElementById('filterSearch').value = '';
  switchTab('news');
  loadArticles();
}

// ── Calendar ─────────────────────────────────────────────
async function loadEvents() {
  const category = document.getElementById('filterEventCat').value;
  const start = document.getElementById('filterStartDate').value;
  const end = document.getElementById('filterEndDate').value;

  const params = new URLSearchParams();
  if (category !== 'all') params.set('category', category);
  if (start) params.set('start', start);
  if (end) params.set('end', end);

  try {
    const res = await apiFetch(`/api/events?${params}`);
    const events = await res.json();
    renderCalendar(events);
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

function renderCalendar(events) {
  const container = document.getElementById('calendarView');
  container.innerHTML = '';

  if (events.length === 0) {
    container.innerHTML = '<div class="v2-empty">No events found. Try updating the calendar or adjusting your filters.</div>';
    return;
  }

  // KPI strip
  const today = isoDate(new Date());
  const todayCount = events.filter(e => e.event_date === today).length;
  const categories = [...new Set(events.map(e => e.category).filter(Boolean))];
  const uniqueDates = [...new Set(events.map(e => e.event_date))];
  const kpiDiv = document.createElement('div');
  kpiDiv.className = 'v2-kpi-strip';
  kpiDiv.innerHTML = `
    <div class="kpi-card"><div class="kpi-value">${events.length}</div><div class="kpi-label">Total Events</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--positive)">${todayCount}</div><div class="kpi-label">Today</div></div>
    <div class="kpi-card"><div class="kpi-value">${uniqueDates.length}</div><div class="kpi-label">Days</div></div>
    <div class="kpi-card"><div class="kpi-value">${categories.length}</div><div class="kpi-label">Categories</div></div>
  `;
  container.appendChild(kpiDiv);

  // Group by date
  const grouped = {};
  for (const e of events) {
    const d = e.event_date;
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(e);
  }

  for (const [date, dayEvents] of Object.entries(grouped)) {
    const group = document.createElement('div');
    group.className = 'cal-date-group';

    const dateObj = new Date(date + 'T12:00:00');
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
    const dateStr = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const isToday = date === today;

    group.innerHTML = `
      <div class="cal-date-header${isToday ? ' today' : ''}">
        ${dateStr} <span class="day-name">${dayName}${isToday ? ' (Today)' : ''}</span>
      </div>
    `;

    for (const evt of dayEvents) {
      const catClass = getCatClass(evt.category);
      const eventEl = document.createElement('div');
      eventEl.className = 'cal-event';
      eventEl.innerHTML = `
        <span class="event-cat ${catClass}">${escHtml(evt.category)}</span>
        <div class="event-info">
          <h4>${escHtml(evt.title)}${evt.event_time ? ` <small style="color:var(--text-muted)">${escHtml(evt.event_time)}</small>` : ''}</h4>
          ${evt.description ? `<p>${escHtml(evt.description).substring(0, 200)}</p>` : ''}
          ${evt.link ? `<a href="${escHtml(evt.link)}" target="_blank" rel="noopener">View details</a>` : ''}
        </div>
      `;
      group.appendChild(eventEl);
    }
    container.appendChild(group);
  }
}

function getCatClass(category) {
  if (!category) return '';
  const c = category.toLowerCase();
  if (c.includes('fomc') || c.includes('monetary')) return 'fomc';
  if (c.includes('federal reserve')) return 'fed';
  if (c.includes('sec')) return 'sec';
  if (c.includes('treasury')) return 'treasury';
  if (c.includes('labor')) return 'labor';
  if (c.includes('bls') || c.includes('economic')) return 'bls';
  return '';
}

// ── Crawl Log ────────────────────────────────────────────
async function loadCrawlLog() {
  try {
    const res = await apiFetch('/api/crawl-log');
    const logs = await res.json();
    renderCrawlLog(logs);
  } catch (err) {
    console.error('Failed to load crawl log:', err);
  }
}

function renderCrawlLog(logs) {
  const container = document.getElementById('crawlLogList');
  if (logs.length === 0) {
    container.innerHTML = '<div class="v2-empty">No crawl history yet.</div>';
    return;
  }

  // KPI strip
  const success = logs.filter(l => l.status === 'success' || l.status === 'completed').length;
  const failed = logs.filter(l => l.status === 'error' || l.status === 'failed').length;
  const totalFound = logs.reduce((s, l) => s + (l.articles_found || 0), 0);
  const successRate = logs.length > 0 ? Math.round((success / logs.length) * 100) : 0;

  container.innerHTML = `
    <div class="v2-kpi-strip">
      <div class="kpi-card"><div class="kpi-value">${logs.length}</div><div class="kpi-label">Total Crawls</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--positive)">${successRate}%</div><div class="kpi-label">Success Rate</div></div>
      <div class="kpi-card"><div class="kpi-value">${totalFound}</div><div class="kpi-label">Articles Found</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--negative)">${failed}</div><div class="kpi-label">Failures</div></div>
    </div>
    <div class="v2-table-card">
    <table class="v2-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Entity</th>
          <th>Found</th>
          <th>Status</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${logs.map(l => `
          <tr>
            <td>${l.started_at ? new Date(l.started_at).toLocaleString() : ''}</td>
            <td>${escHtml(l.crawl_type)}</td>
            <td>${escHtml(l.entity_id || '-')}</td>
            <td>${l.articles_found}</td>
            <td class="status-${l.status}">${l.status}</td>
            <td style="color:var(--negative); font-size:12px;">${escHtml(l.error_message || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

// ── Tab Switching ────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // Remember last active tab across page refreshes
  try { localStorage.setItem('ci_active_tab', tabName); } catch(e) {}

  // Lazy load tab data
  if (tabName === 'brief') loadBrief();
  if (tabName === 'news') loadArticles();
  if (tabName === 'fin-news') { loadFinArticles(); loadPriorityArticles(); }
  if (tabName === 'stats') { loadStats(); loadCustomEntities(); }
  if (tabName === 'aum') loadAum();
  if (tabName === 'market') loadMarketIndicators();
  if (tabName === 'holdings') loadHoldingsEntities();
  if (tabName === 'sec') { loadSecFilings(); loadFinraAlerts(); }
  if (tabName === 'adv') loadAdvAnalyses();
  if (tabName === 'trends') { loadTrends(); populateTrendEntitySelect(); }
  if (tabName === 'personnel') loadPersonnel();
  if (tabName === 'jobs') loadJobs();
  if (tabName === 'predictions') loadPredictions();
  if (tabName === 'social') loadSocialFeed();
  if (tabName === 'calendar') loadEvents();
  if (tabName === 'export') {}
  if (tabName === 'log') loadCrawlLog();

  // Auto-refresh if data is stale (>4h) + show "Last updated" timestamp
  checkAutoRefresh(tabName);
}

// ── Actions ──────────────────────────────────────────────
async function triggerCrawl() {
  const btn = document.getElementById('btnCrawlAll');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Crawling...';

  try {
    const res = await apiFetch('/api/crawl', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.newArticles} new)`;
    setTimeout(() => { btn.textContent = 'Crawl Now'; btn.disabled = false; }, 3000);
    loadArticles();
    loadStats();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Crawl Now'; btn.disabled = false; }, 3000);
  }
}

async function triggerGovCrawl() {
  const btn = document.getElementById('btnCrawlGov');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Updating...';

  try {
    const res = await apiFetch('/api/crawl/gov', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.newEvents} new)`;
    setTimeout(() => { btn.textContent = 'Update Calendar'; btn.disabled = false; }, 3000);
    if (document.getElementById('tab-calendar').classList.contains('active')) {
      loadEvents();
    }
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Update Calendar'; btn.disabled = false; }, 3000);
  }
}

// ── Priority Articles (compact strip in Financial News) ──
async function loadPriorityArticles() {
  try {
    var res = await apiFetch('/api/articles?priority=true&limit=8');
    var articles = await res.json();
    var section = document.getElementById('prioritySection');
    var container = document.getElementById('priorityArticles');
    var countEl = document.getElementById('priorityCount');

    if (!articles || articles.length === 0) {
      section.style.display = 'none';
      return;
    }

    // Dedup by title (same article can appear under multiple entities)
    var seen = {};
    articles = articles.filter(function(a) {
      var key = a.title.toLowerCase().trim();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });

    section.style.display = 'block';
    countEl.textContent = articles.length + ' articles';
    var html = '';
    articles.forEach(function(a) {
      var timeAgo = a.pub_date ? getTimeAgo(new Date(a.pub_date)) : '';
      var sentColor = a.sentiment_label === 'positive' ? 'var(--positive)' : a.sentiment_label === 'negative' ? 'var(--negative)' : 'var(--text-muted)';
      html += '<div class="priority-strip-item">';
      html += '<span class="priority-strip-dot" style="background:' + sentColor + '"></span>';
      html += '<a href="' + escHtml(a.link) + '" target="_blank" rel="noopener" class="priority-strip-link">' + escHtml(a.title) + '</a>';
      html += '<span class="priority-strip-meta">' + escHtml(a.source || '') + ' · ' + timeAgo + '</span>';
      html += '</div>';
    });
    container.innerHTML = html;
  } catch (err) {
    console.error('Failed to load priority articles:', err);
  }
}

function togglePriorityStrip() {
  var body = document.getElementById('priorityArticles');
  var chevron = document.getElementById('priorityChevron');
  if (body.style.display === 'none') {
    body.style.display = 'block';
    chevron.innerHTML = '&#9660;';
  } else {
    body.style.display = 'none';
    chevron.innerHTML = '&#9654;';
  }
}

// ── AUM ─────────────────────────────────────────────────
function populateAumEntitySelect() {
  const select = document.getElementById('aumEntity');
  if (!select) return;
  select.innerHTML = '<option value="">Select company...</option>';
  for (const e of entities.all || []) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    select.appendChild(opt);
  }
}

async function loadAum() {
  try {
    const res = await apiFetch('/api/aum');
    const data = await res.json();
    renderAumChart(data);
  } catch (err) {
    console.error('Failed to load AUM:', err);
  }
}

function renderAumChart(entries) {
  const container = document.getElementById('aumChart');
  const kpiEl = document.getElementById('aumKpi');
  if (!entries || entries.length === 0) {
    if (kpiEl) kpiEl.innerHTML = '';
    container.innerHTML = '<div class="v2-empty">No AUM data yet. Add data manually or click "Crawl AUM (EDGAR)" to scan.</div>';
    return;
  }

  const sorted = [...entries].sort((a, b) => b.aum_billions - a.aum_billions);
  const maxAum = sorted[0].aum_billions;

  // KPI strip
  const totalAum = sorted.reduce((s, e) => s + (e.aum_billions || 0), 0);
  const totalDisc = sorted.reduce((s, e) => s + (e.discretionary_billions || 0), 0);
  const withBreakdown = sorted.filter(e => e.discretionary_billions != null || (e.asset_classes && e.asset_classes.length > 0)).length;
  if (kpiEl) {
    kpiEl.innerHTML = `
      <div class="kpi-card"><div class="kpi-value">${sorted.length}</div><div class="kpi-label">Entities</div></div>
      <div class="kpi-card"><div class="kpi-value">$${formatBillions(totalAum)}</div><div class="kpi-label">Total AUM</div></div>
      <div class="kpi-card"><div class="kpi-value">$${formatBillions(totalDisc)}</div><div class="kpi-label">Discretionary</div></div>
      <div class="kpi-card"><div class="kpi-value">${withBreakdown}</div><div class="kpi-label">With Breakdown</div></div>
    `;
  }

  container.innerHTML = '';

  for (const e of sorted) {
    const pct = Math.max((e.aum_billions / maxAum) * 100, 2);
    const isSelf = e.entity_id === 'dobbs-group';
    const hasBreakdown = e.discretionary_billions != null || (e.asset_classes && e.asset_classes.length > 0);
    const row = document.createElement('div');
    row.className = `aum-row${isSelf ? ' aum-self' : ''}${hasBreakdown ? ' aum-expandable' : ''}`;

    // Discretionary / Non-Discretionary bar
    let breakdownHtml = '';
    if (hasBreakdown) {
      const disc = e.discretionary_billions || 0;
      const nonDisc = e.non_discretionary_billions || 0;
      const total = disc + nonDisc || e.aum_billions;
      const discPct = ((disc / total) * 100).toFixed(1);
      const nonDiscPct = ((nonDisc / total) * 100).toFixed(1);

      breakdownHtml += `<div class="aum-breakdown">
        <div class="aum-breakdown-section">
          <div class="aum-breakdown-title">Discretionary vs Non-Discretionary</div>
          <div class="aum-split-bar">
            <div class="aum-split-disc" style="width:${discPct}%" title="Discretionary: $${formatBillions(disc)} (${discPct}%)"></div>
            <div class="aum-split-nondisc" style="width:${nonDiscPct}%" title="Non-Discretionary: $${formatBillions(nonDisc)} (${nonDiscPct}%)"></div>
          </div>
          <div class="aum-split-legend">
            <span class="aum-legend-disc">Discretionary: $${formatBillions(disc)} (${discPct}%)</span>
            <span class="aum-legend-nondisc">Non-Disc: $${formatBillions(nonDisc)} (${nonDiscPct}%)</span>
          </div>
        </div>`;

      // Asset class bars
      if (e.asset_classes && e.asset_classes.length > 0) {
        const maxAc = Math.max(...e.asset_classes.map(ac => ac.amount_billions));
        const acColors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
        breakdownHtml += `<div class="aum-breakdown-section">
          <div class="aum-breakdown-title">Asset Class Breakdown</div>
          <div class="aum-ac-bars">`;
        e.asset_classes.forEach((ac, i) => {
          const acPct = Math.max((ac.amount_billions / maxAc) * 100, 3);
          const color = acColors[i % acColors.length];
          const totalPct = ((ac.amount_billions / e.aum_billions) * 100).toFixed(1);
          breakdownHtml += `<div class="aum-ac-row">
              <span class="aum-ac-name">${escHtml(ac.name)}</span>
              <div class="aum-ac-bar-track">
                <div class="aum-ac-bar-fill" style="width:${acPct}%;background:${color}"></div>
              </div>
              <span class="aum-ac-value">$${formatBillions(ac.amount_billions)} <small>(${totalPct}%)</small></span>
            </div>`;
        });
        breakdownHtml += `</div></div>`;
      }
      breakdownHtml += `</div>`;
    }

    row.innerHTML = `
      <div class="aum-label">
        <span class="aum-name">${hasBreakdown ? '<span class="aum-expand-icon">&#9654;</span> ' : ''}${escHtml(e.entity_name)}</span>
        <span class="aum-value">$${formatBillions(e.aum_billions)}</span>
      </div>
      <div class="aum-bar-track">
        <div class="aum-bar-fill${isSelf ? ' self-fill' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="aum-meta">
        <span>As of ${e.as_of_date || 'N/A'}</span>
        ${e.source ? `<span class="aum-source">${escHtml(e.source)}</span>` : ''}
      </div>
      ${breakdownHtml}
    `;

    if (hasBreakdown) {
      row.querySelector('.aum-label').style.cursor = 'pointer';
      row.querySelector('.aum-label').addEventListener('click', () => {
        row.classList.toggle('aum-expanded');
        const icon = row.querySelector('.aum-expand-icon');
        if (icon) icon.innerHTML = row.classList.contains('aum-expanded') ? '&#9660;' : '&#9654;';
      });
    }

    container.appendChild(row);
  }
}

function formatBillions(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'T';
  if (n >= 1) return n.toFixed(1).replace(/\.0$/, '') + 'B';
  return (n * 1000).toFixed(0) + 'M';
}

async function updateAum() {
  const entityId = document.getElementById('aumEntity').value;
  const value = parseFloat(document.getElementById('aumValue').value);
  const source = document.getElementById('aumSource').value;

  if (!entityId || isNaN(value)) {
    alert('Please select a company and enter an AUM value.');
    return;
  }

  const disc = parseFloat(document.getElementById('aumDiscretionary').value) || undefined;
  const nonDisc = parseFloat(document.getElementById('aumNonDiscretionary').value) || undefined;

  // Gather asset class inputs
  const acRows = document.querySelectorAll('#aumAssetClassInputs .form-row');
  const asset_classes = [];
  acRows.forEach(row => {
    const sel = row.querySelector('.aum-ac-select');
    const amt = row.querySelector('.aum-ac-amount');
    if (sel && amt && sel.value && parseFloat(amt.value)) {
      asset_classes.push({ name: sel.value, amount_billions: parseFloat(amt.value) });
    }
  });

  const entity = entities.all.find(e => e.id === entityId);
  try {
    await apiFetch('/api/aum', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: entityId,
        entity_name: entity ? entity.name : entityId,
        aum_billions: value,
        source: source || 'Manual entry',
        notes: '',
        discretionary_billions: disc,
        non_discretionary_billions: nonDisc,
        asset_classes: asset_classes.length > 0 ? asset_classes : undefined,
      }),
    });
    document.getElementById('aumValue').value = '';
    document.getElementById('aumSource').value = '';
    document.getElementById('aumDiscretionary').value = '';
    document.getElementById('aumNonDiscretionary').value = '';
    // Reset asset class rows to just one
    const acContainer = document.getElementById('aumAssetClassInputs');
    const rows = acContainer.querySelectorAll('.form-row');
    rows.forEach((r, i) => { if (i > 0) r.remove(); });
    const firstSel = acContainer.querySelector('.aum-ac-select');
    const firstAmt = acContainer.querySelector('.aum-ac-amount');
    if (firstSel) firstSel.value = '';
    if (firstAmt) firstAmt.value = '';
    loadAum();
  } catch (err) {
    console.error('Failed to update AUM:', err);
  }
}

function addAumAssetClassRow() {
  const container = document.getElementById('aumAssetClassInputs');
  const row = document.createElement('div');
  row.className = 'form-row';
  row.style.marginTop = '8px';
  row.innerHTML = `
    <select class="aum-ac-select">
      <option value="">Asset Class...</option>
      <option value="Equities">Equities</option>
      <option value="Fixed Income">Fixed Income</option>
      <option value="Alternatives">Alternatives</option>
      <option value="Real Assets">Real Assets</option>
      <option value="Cash & Other">Cash & Other</option>
    </select>
    <input type="number" class="aum-ac-amount" placeholder="Amount (billions)" step="0.1">
    <button class="btn btn-secondary" onclick="this.parentElement.remove()">Remove</button>
  `;
  container.appendChild(row);
}

// ── SEC Filings ─────────────────────────────────────────
function populateSecEntitySelect() {
  const select = document.getElementById('filterSecEntity');
  if (!select) return;
  for (const e of (entities.competitors || [])) {
    const opt = document.createElement('option');
    opt.value = e.name;
    opt.textContent = e.name;
    select.appendChild(opt);
  }
}

async function loadSecFilings() {
  const entity = document.getElementById('filterSecEntity').value;
  const type = document.getElementById('filterSecType').value;
  const params = new URLSearchParams();
  if (entity) params.set('entity', entity);
  if (type) params.set('type', type);
  params.set('limit', '50');

  try {
    const res = await apiFetch(`/api/sec?${params}`);
    const filings = await res.json();
    renderSecFilings(filings);
  } catch (err) {
    console.error('Failed to load SEC filings:', err);
  }
}

// Filing type reference data (mirrors server-side FILING_TYPE_INFO)
const FILING_TYPE_INFO = {
  'ADV': { label: 'Adviser Registration', desc: 'AUM, fees, conflicts, disciplinary history' },
  'ADV-W': { label: 'Adviser Withdrawal', desc: 'Investment adviser deregistration' },
  '10-K': { label: 'Annual Report', desc: 'Annual financial report with audited statements' },
  '10-Q': { label: 'Quarterly Report', desc: 'Quarterly financial update' },
  '8-K': { label: 'Current Report', desc: 'Leadership changes, M&A, material agreements' },
  '13F': { label: 'Holdings Report', desc: 'Quarterly institutional holdings ($100M+)' },
  'S-1': { label: 'IPO Registration', desc: 'Initial public offering registration' },
  'DEF 14A': { label: 'Proxy Statement', desc: 'Exec compensation, board info, proposals' },
  'N-CSR': { label: 'Fund Annual Report', desc: 'Shareholder report for investment companies' },
  '4': { label: 'Insider Trade', desc: 'Changes in beneficial ownership by insiders' },
  'SC 13D': { label: 'Beneficial Ownership', desc: 'Ownership above 5% with activist intent' },
  'SC 13G': { label: 'Passive Ownership', desc: 'Passive ownership above 5%' },
};

const SIC_DESCRIPTIONS = {
  '6020': 'Commercial Banking', '6021': 'National Commercial Banks',
  '6022': 'State Commercial Banks', '6035': 'Savings Institutions',
  '6099': 'Financial Services', '6141': 'Personal Credit',
  '6153': 'Short-Term Business Credit', '6159': 'Federal Loan Agencies',
  '6162': 'Mortgage Bankers', '6199': 'Finance Services',
  '6200': 'Security & Commodity Brokers', '6211': 'Security Brokers & Dealers',
  '6282': 'Investment Advice', '6311': 'Fire, Marine & Casualty Insurance',
  '6321': 'Health Insurance', '6399': 'Insurance', '6500': 'Real Estate',
  '6726': 'Investment Offices', '6770': 'Blank Checks',
};

// Keyword severity categories (mirrors server-side SEC_KEYWORD_CATEGORIES)
const KEYWORD_SEVERITY = {};
['enforcement','fraud','penalty','sanction','cease and desist','disgorgement',
 'insider trading','violation','criminal','whistleblower','revocation','barred','suspension'
].forEach(k => KEYWORD_SEVERITY[k] = 'critical');
['investigation','material weakness','deficiency','settlement','arbitration',
 'conflict of interest','breach','restatement','adverse','litigation','class action',
 'subpoena','regulatory action','consent order'
].forEach(k => KEYWORD_SEVERITY[k] = 'warning');
['risk','fiduciary','compliance','audit','custody','best execution','advisory fee',
 'proxy','material change','governance','disclosure','amendment','corrective action',
 'remediation','oversight'
].forEach(k => KEYWORD_SEVERITY[k] = 'monitor');

function renderSecFilings(filings) {
  const container = document.getElementById('secFilingsList');
  if (!filings || filings.length === 0) {
    container.innerHTML = '<div class="v2-empty">No filings found. Click "Scan SEC EDGAR" to search.</div>';
    return;
  }

  // KPI strip
  const critical = filings.filter(f => f.risk_level === 'critical').length;
  const warning = filings.filter(f => f.risk_level === 'warning').length;
  const monitor = filings.filter(f => f.risk_level === 'monitor' || f.risk_level === 'info').length;
  const kpiHtml = `<div class="v2-kpi-strip">
    <div class="kpi-card"><div class="kpi-value">${filings.length}</div><div class="kpi-label">Total Filings</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--negative)">${critical}</div><div class="kpi-label">Critical</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--gold)">${warning}</div><div class="kpi-label">Warning</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--text-muted)">${monitor}</div><div class="kpi-label">Monitor</div></div>
  </div>`;

  container.innerHTML = kpiHtml;
  for (const f of filings) {
    const card = document.createElement('div');
    const riskClass = f.risk_level || 'info';
    card.className = `sec-card sec-risk-${riskClass}`;

    // Group keywords by severity
    const kwEntries = Object.entries(f.keyword_hits || {}).filter(([, c]) => c > 0);
    const grouped = { critical: [], warning: [], monitor: [] };
    for (const [word, count] of kwEntries) {
      const sev = KEYWORD_SEVERITY[word.toLowerCase()] || 'monitor';
      grouped[sev].push({ word, count });
    }
    // Sort each group by count desc
    for (const g of Object.values(grouped)) g.sort((a, b) => b.count - a.count);

    const keywordHtml = ['critical', 'warning', 'monitor']
      .filter(sev => grouped[sev].length > 0)
      .map(sev => {
        const pills = grouped[sev]
          .map(({ word, count }) => `<span class="keyword-pill kw-${sev}">${escHtml(word)} <strong>${count}</strong></span>`)
          .join('');
        return `<div class="kw-group"><span class="kw-group-label kw-label-${sev}">${sev.toUpperCase()}</span>${pills}</div>`;
      })
      .join('');

    // Filing type info
    const typeInfo = FILING_TYPE_INFO[f.filing_type] || null;
    const typeLabel = typeInfo ? typeInfo.label : f.filing_type;
    const typeDesc = typeInfo ? typeInfo.desc : '';

    // SIC industry
    const sicDesc = f.sic_code ? (SIC_DESCRIPTIONS[f.sic_code] || `SIC ${f.sic_code}`) : '';

    // Detail items
    const details = [];
    if (f.period_ending) details.push(`<span class="sec-detail"><strong>Period:</strong> ${formatDateTime(f.period_ending)}</span>`);
    if (f.cik) details.push(`<span class="sec-detail"><strong>CIK:</strong> ${escHtml(f.cik)}</span>`);
    if (sicDesc) details.push(`<span class="sec-detail"><strong>Industry:</strong> ${escHtml(sicDesc)}</span>`);
    if (f.file_number) details.push(`<span class="sec-detail"><strong>File #:</strong> ${escHtml(f.file_number)}</span>`);

    // Risk badge
    const riskLabels = { critical: 'CRITICAL', warning: 'WARNING', monitor: 'MONITOR', info: 'INFO' };
    const riskBadge = `<span class="risk-badge risk-${riskClass}">${riskLabels[riskClass] || 'INFO'}${f.risk_score ? ` (${f.risk_score})` : ''}</span>`;

    card.innerHTML = `
      <div class="sec-card-header">
        <div class="sec-header-left">
          <span class="sec-type-badge">${escHtml(f.filing_type)}</span>
          ${typeDesc ? `<span class="sec-type-desc">${escHtml(typeLabel)} &mdash; ${escHtml(typeDesc)}</span>` : ''}
        </div>
        <div class="sec-header-right">
          ${riskBadge}
          <span class="sec-date">${f.filed_date ? formatDateTime(f.filed_date) : ''}</span>
        </div>
      </div>
      <div class="sec-company">${escHtml(f.company_name)}</div>
      ${details.length > 0 ? `<div class="sec-details-row">${details.join('')}</div>` : ''}
      ${f.description ? `<div class="sec-desc">${escHtml(f.description).substring(0, 300)}</div>` : ''}
      ${f.top_words && f.top_words.length > 0 ? `
        <div class="sec-top-words">
          <span class="sec-top-words-label">TOP KEYWORDS</span>
          ${f.top_words.map(w => `<span class="top-word-pill">${escHtml(w)}</span>`).join('')}
        </div>
      ` : ''}
      ${keywordHtml ? `<div class="sec-keywords-section">${keywordHtml}</div>` : ''}
      <div class="sec-footer">
        <a href="${escHtml(f.document_url)}" target="_blank" rel="noopener" class="read-more">View on SEC EDGAR &#8594;</a>
        <button class="btn btn-sm btn-secondary" onclick="aiSummarize('${escHtml(f.id || f.accession_number || '')}', '${escHtml(f.document_url)}', this)">AI Summary</button>
        ${f.entity_names && f.entity_names.length > 0 ? `<span class="sec-entities">${f.entity_names.map(n => escHtml(n)).join(', ')}</span>` : ''}
      </div>
    `;
    container.appendChild(card);
  }
}

function getKeywordClass(word) {
  return `kw-${KEYWORD_SEVERITY[word.toLowerCase()] || 'monitor'}`;
}

async function triggerSecScan() {
  const btn = document.getElementById('btnSecScan');
  const queryInput = document.getElementById('secQuery');
  const query = queryInput.value.trim();

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';

  try {
    const body = query ? { query } : {};
    const res = await apiFetch('/api/sec/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    btn.textContent = `Done! (${data.newFilings} new)`;
    setTimeout(() => { btn.textContent = 'Scan SEC EDGAR'; btn.disabled = false; }, 3000);
    loadSecFilings();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Scan SEC EDGAR'; btn.disabled = false; }, 3000);
  }
}

async function enrichSecKeywords() {
  const btn = document.getElementById('btnSecEnrich');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Enriching...';

  try {
    const res = await apiFetch('/api/sec/enrich', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.enriched} enriched)`;
    setTimeout(() => { btn.textContent = 'Enrich Keywords'; btn.disabled = false; }, 3000);
    loadSecFilings();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Enrich Keywords'; btn.disabled = false; }, 3000);
  }
}

// ── Financial News ──────────────────────────────────────
let finArticleOffset = 0;
const FIN_ARTICLE_LIMIT = 50;
let finSearchTimer = null;

async function loadFinArticles(append) {
  if (!append) finArticleOffset = 0;
  const source = document.getElementById('filterFinSource').value;
  const sentiment = document.getElementById('filterFinSentiment').value;
  const search = document.getElementById('filterFinSearch').value;

  const params = new URLSearchParams();
  if (source !== 'all') params.set('source', source);
  if (sentiment !== 'all') params.set('sentiment', sentiment);
  if (search) params.set('search', search);
  params.set('limit', FIN_ARTICLE_LIMIT);
  params.set('offset', finArticleOffset);

  try {
    const res = await apiFetch(`/api/fin-articles?${params}`);
    const articles = await res.json();
    const container = document.getElementById('finArticlesList');
    if (!append) container.innerHTML = '';

    if (articles.length === 0 && !append) {
      container.innerHTML = '<div class="empty">No financial news found. Click "Crawl Financial News" to get started.</div>';
      document.getElementById('btnFinLoadMore').style.display = 'none';
      return;
    }

    for (const a of articles) {
      container.appendChild(renderFinArticle(a));
    }

    document.getElementById('btnFinLoadMore').style.display =
      articles.length === FIN_ARTICLE_LIMIT ? 'inline-block' : 'none';
  } catch (err) {
    console.error('Failed to load financial news:', err);
  }
}

function renderFinArticle(a) {
  const div = document.createElement('div');
  div.className = 'article-card';
  const pubDate = a.pub_date ? new Date(a.pub_date) : null;
  const dateStr = pubDate ? formatDateTime(pubDate) : '';
  const timeAgo = pubDate ? getTimeAgo(pubDate) : '';

  div.innerHTML = `
    <div class="article-header">
      <a href="${escHtml(a.link)}" target="_blank" rel="noopener" class="article-title">${escHtml(a.title)}</a>
      <div class="article-badges">
        <span class="sentiment-badge sentiment-${a.sentiment_label}">${a.sentiment_label.toUpperCase()}</span>
      </div>
    </div>
    <div class="article-meta">
      <span class="entity-tag">${escHtml(a.source_name)}</span>
      <span class="article-date" title="${dateStr}">${timeAgo || dateStr}</span>
    </div>
    ${a.snippet ? `<div class="article-snippet">${escHtml(a.snippet).substring(0, 300)}${a.snippet.length > 300 ? '...' : ''}</div>` : ''}
    <div class="article-footer">
      <a href="${escHtml(a.link)}" target="_blank" rel="noopener" class="read-more">Read full article &#8594;</a>
    </div>
  `;
  return div;
}

function loadFinMore() {
  finArticleOffset += FIN_ARTICLE_LIMIT;
  loadFinArticles(true);
}

function debounceFinSearch() {
  clearTimeout(finSearchTimer);
  finSearchTimer = setTimeout(() => loadFinArticles(), 400);
}

async function triggerFinNewsCrawl() {
  const btn = document.getElementById('btnCrawlFinNews');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Crawling...';
  try {
    const res = await apiFetch('/api/fin-crawl', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.newArticles} new)`;
    setTimeout(() => { btn.textContent = 'Crawl Financial News'; btn.disabled = false; }, 3000);
    loadFinArticles();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Crawl Financial News'; btn.disabled = false; }, 3000);
  }
}

// ── Predictions ─────────────────────────────────────────
async function loadPredictions() {
  const category = document.getElementById('filterPredCat').value;
  const params = new URLSearchParams();
  if (category !== 'all') params.set('category', category);

  try {
    const res = await apiFetch(`/api/predictions?${params}`);
    const markets = await res.json();
    renderPredictions(markets);
  } catch (err) {
    console.error('Failed to load predictions:', err);
  }
}

function renderPredictions(markets) {
  const container = document.getElementById('predictionsList');
  if (!markets || markets.length === 0) {
    container.innerHTML = '<div class="v2-empty">No predictions found. Click "Refresh Predictions" to load from Polymarket.</div>';
    return;
  }

  // KPI strip
  const avgProb = markets.length > 0 ? Math.round(markets.reduce((s, m) => s + m.probability, 0) / markets.length) : 0;
  const totalVol = markets.reduce((s, m) => s + (m.volume || 0), 0);
  const highConf = markets.filter(m => m.probability >= 70).length;
  container.innerHTML = `<div class="v2-kpi-strip">
    <div class="kpi-card"><div class="kpi-value">${markets.length}</div><div class="kpi-label">Total Markets</div></div>
    <div class="kpi-card"><div class="kpi-value">${avgProb}%</div><div class="kpi-label">Avg Probability</div></div>
    <div class="kpi-card"><div class="kpi-value">$${formatVolume(totalVol)}</div><div class="kpi-label">Total Volume</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--positive)">${highConf}</div><div class="kpi-label">High Confidence</div></div>
  </div>`;
  for (const m of markets) {
    const card = document.createElement('div');
    card.className = 'prediction-card';

    const probPct = Math.round(m.probability);
    const probColor = probPct >= 70 ? 'var(--positive)' : probPct >= 40 ? 'var(--gold)' : 'var(--negative)';
    const endDate = m.end_date ? new Date(m.end_date).toLocaleDateString() : '';

    card.innerHTML = `
      <div class="pred-header">
        <span class="pred-category">${escHtml(m.category)}</span>
        <span class="pred-prob" style="color:${probColor}">${probPct}%</span>
      </div>
      <div class="pred-question">${escHtml(m.question)}</div>
      <div class="pred-bar-track">
        <div class="pred-bar-fill" style="width:${probPct}%; background:${probColor}"></div>
      </div>
      <div class="pred-meta">
        <span>Volume: $${formatVolume(m.volume)}</span>
        ${endDate ? `<span>Ends: ${endDate}</span>` : ''}
        <a href="${escHtml(m.url)}" target="_blank" rel="noopener">Polymarket &#8594;</a>
      </div>
    `;
    container.appendChild(card);
  }
}

function formatVolume(v) {
  if (!v) return '0';
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return Math.round(v).toLocaleString();
}

async function triggerPredictionsCrawl() {
  const btn = document.getElementById('btnPredCrawl');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Loading...';

  try {
    const res = await apiFetch('/api/predictions/crawl', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.newMarkets} new)`;
    setTimeout(() => { btn.textContent = 'Refresh Predictions'; btn.disabled = false; }, 3000);
    loadPredictions();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Refresh Predictions'; btn.disabled = false; }, 3000);
  }
}

// ── AUM Crawl ───────────────────────────────────────────
async function triggerAumCrawl() {
  const btn = document.getElementById('btnAumCrawl');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Crawling EDGAR...';

  try {
    const res = await apiFetch('/api/aum/crawl', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      btn.textContent = `Done! (${data.updatedCount} updated)`;
      setTimeout(() => { btn.textContent = 'Crawl AUM (EDGAR)'; btn.disabled = false; }, 3000);
      loadAum();
    } else {
      btn.textContent = 'Error: ' + (data.error || 'Unknown');
      setTimeout(() => { btn.textContent = 'Crawl AUM (EDGAR)'; btn.disabled = false; }, 3000);
    }
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Crawl AUM (EDGAR)'; btn.disabled = false; }, 3000);
  }
}

// ── Custom Entities ─────────────────────────────────────
async function addCustomEntity() {
  const nameInput = document.getElementById('customEntityName');
  const websiteInput = document.getElementById('customEntityWebsite');
  const name = nameInput.value.trim();
  const website = websiteInput.value.trim();

  if (!name) {
    alert('Please enter a company name.');
    return;
  }

  try {
    const res = await apiFetch('/api/entities/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, website }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to add entity');
      return;
    }
    nameInput.value = '';
    websiteInput.value = '';
    await loadEntities();
    loadCustomEntities();
    populateAumEntitySelect();
    populateSecEntitySelect();
  } catch (err) {
    console.error('Failed to add custom entity:', err);
  }
}

async function removeCustomEntity(entityId) {
  if (!confirm('Remove this competitor from tracking?')) return;
  try {
    await apiFetch(`/api/entities/custom?id=${encodeURIComponent(entityId)}`, { method: 'DELETE' });
    await loadEntities();
    loadCustomEntities();
    populateAumEntitySelect();
    populateSecEntitySelect();
  } catch (err) {
    console.error('Failed to remove custom entity:', err);
  }
}

async function loadCustomEntities() {
  const container = document.getElementById('customEntitiesList');
  if (!container) return;
  const custom = (entities.custom || []);
  if (custom.length === 0) {
    container.innerHTML = '<div class="v2-empty">No custom competitors added yet. Add a company name above to start tracking.</div>';
    return;
  }
  container.innerHTML = custom.map(e => `
    <div class="custom-entity-item">
      <div class="custom-entity-info">
        <span class="custom-entity-name">${escHtml(e.name)}</span>
        ${e.website ? `<a href="${escHtml(e.website)}" target="_blank" rel="noopener" class="custom-entity-link">${escHtml(e.website)}</a>` : ''}
        <span class="custom-entity-date">Added ${new Date(e.added_at).toLocaleDateString()}</span>
      </div>
      <button class="btn-remove" onclick="removeCustomEntity('${escHtml(e.id)}')" title="Remove">&times;</button>
    </div>
  `).join('');
}

// ── Daily Brief ─────────────────────────────────────────
async function loadBrief() {
  try {
    const res = await apiFetch('/api/brief');
    if (res.status === 404) {
      document.getElementById('briefContent').innerHTML =
        '<div class="empty">No brief generated yet. Click "Generate Brief" to create one.</div>';
      return;
    }
    const brief = await res.json();
    renderBrief(brief);
  } catch (err) {
    console.error('Failed to load brief:', err);
  }
}

async function refreshBrief() {
  const btn = document.getElementById('btnRefreshBrief');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';
  document.getElementById('briefContent').innerHTML =
    '<div class="loading">Analyzing data across all sources...</div>';

  try {
    const res = await apiFetch('/api/brief', { method: 'POST' });
    const brief = await res.json();
    btn.textContent = 'Generate Brief';
    btn.disabled = false;
    renderBrief(brief);
  } catch (err) {
    console.error('Brief generation error:', err);
    btn.textContent = 'Error';
    document.getElementById('briefContent').innerHTML =
      '<div class="empty">Failed to generate brief. Try again later.</div>';
    setTimeout(() => { btn.textContent = 'Generate Brief'; btn.disabled = false; }, 3000);
  }
}

function renderMiniSparkline(values, w, h) {
  w = w || 70; h = h || 22;
  if (!values || values.length < 2) return '';
  const pad = 1;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
    return x + ',' + y;
  });
  const color = values[values.length - 1] >= values[0] ? 'var(--positive)' : 'var(--negative)';
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">' +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5"/></svg>';
}

function renderMiniDonut(values, colors, size) {
  size = size || 32;
  const total = values.reduce(function(a, b) { return a + b; }, 0) || 1;
  const r = size / 2 - 2;
  const cx = size / 2, cy = size / 2;
  let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">';
  let startAngle = -Math.PI / 2;
  values.forEach(function(v, i) {
    if (v <= 0) return;
    const angle = (v / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    svg += '<path d="M' + cx + ',' + cy + ' L' + x1 + ',' + y1 + ' A' + r + ',' + r + ' 0 ' + largeArc + ' 1 ' + x2 + ',' + y2 + ' Z" fill="' + colors[i] + '"/>';
    startAngle = endAngle;
  });
  svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + Math.round(r * 0.55) + '" fill="var(--surface)"/></svg>';
  return svg;
}

function renderBrief(brief) {
  const container = document.getElementById('briefContent');
  const ts = document.getElementById('briefTimestamp');
  if (brief.generated_at) {
    ts.textContent = 'Generated: ' + new Date(brief.generated_at).toLocaleString();
  }

  const s = brief.market_sentiment || { avg_score: 0, trend: 'stable', positive_pct: 0, neutral_pct: 100, negative_pct: 0, total_articles: 0, prev_avg_score: 0 };
  const mkt = brief.market_indicators || {};
  const trendArrow = s.trend === 'improving' ? '\u25B2' : s.trend === 'declining' ? '\u25BC' : '\u2500';
  const trendCls = s.trend === 'improving' ? 'kpi-positive' : s.trend === 'declining' ? 'kpi-negative' : 'kpi-neutral';

  // Ensure arrays exist
  brief.top_stories = brief.top_stories || [];
  brief.risk_alerts = brief.risk_alerts || [];
  brief.prediction_movers = brief.prediction_movers || [];
  brief.upcoming_events = brief.upcoming_events || [];
  brief.competitor_activity = brief.competitor_activity || [];
  brief.key_themes = brief.key_themes || [];
  brief.finra_alerts = brief.finra_alerts || [];

  // ── KPI Strip ──
  const fgScore = mkt.fear_greed_score;
  const fgRating = mkt.fear_greed_rating || '—';
  const fgColor = fgScore != null ? (fgScore >= 60 ? 'kpi-positive' : fgScore <= 40 ? 'kpi-negative' : 'kpi-neutral') : 'kpi-neutral';
  const ys = mkt.yield_spread;
  const ysCls = ys != null ? (ys < 0 ? 'kpi-negative' : 'kpi-positive') : 'kpi-neutral';
  const critCount = brief.risk_alerts.filter(function(r) { return r.risk_level === 'critical'; }).length;
  const warnCount = brief.risk_alerts.filter(function(r) { return r.risk_level === 'warning'; }).length;
  const aumB = brief.total_aum_billions;

  let html = '<div class="brief-kpi-strip">';
  // Mini sentiment gauge for KPI card
  var sNorm = Math.max(0, Math.min(1, (s.avg_score + 1) / 2));
  var sHue = Math.round(sNorm * 120);
  var sGaugeColor = 'hsl(' + sHue + ', 70%, 50%)';
  var sArcR = 28, sArcLen = Math.PI * sArcR;
  var sArcOff = sArcLen * (1 - sNorm);
  html += '<div class="kpi-card brief-clickable" onclick="switchTab(&apos;news&apos;)"><div class="kpi-label">Sentiment</div><div class="kpi-gauge-wrap"><svg width="80" height="48" viewBox="0 0 80 48"><path d="M 6 42 A ' + sArcR + ' ' + sArcR + ' 0 0 1 74 42" fill="none" stroke="var(--border)" stroke-width="5" stroke-linecap="round"/><path class="kpi-gauge-fill" d="M 6 42 A ' + sArcR + ' ' + sArcR + ' 0 0 1 74 42" fill="none" stroke="' + sGaugeColor + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + sArcLen + '" stroke-dashoffset="' + sArcLen + '" data-target="' + sArcOff + '" style="filter:drop-shadow(0 0 3px ' + sGaugeColor + ');transition:stroke-dashoffset 1s"/><text x="40" y="38" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="800">' + s.avg_score.toFixed(2) + '</text></svg></div><div class="kpi-delta ' + trendCls + '">' + trendArrow + ' ' + escHtml(s.trend) + ' &middot; ' + s.total_articles + ' articles</div></div>';
  html += '<div class="kpi-card brief-clickable" onclick="switchTab(\'market\')"><div class="kpi-label">Fear &amp; Greed</div><div class="kpi-value ' + fgColor + '">' + (fgScore != null ? fgScore : '—') + '</div><div class="kpi-delta kpi-neutral">' + escHtml(fgRating) + '</div></div>';
  html += '<div class="kpi-card brief-clickable" onclick="switchTab(\'market\')"><div class="kpi-label">Yield Spread</div><div class="kpi-value ' + ysCls + '">' + (ys != null ? (ys >= 0 ? '+' : '') + ys.toFixed(2) + '%' : '—') + '</div><div class="kpi-delta kpi-neutral">10Y - 2Y Treasury</div></div>';
  html += '<div class="kpi-card brief-clickable" onclick="switchTab(\'sec\')"><div class="kpi-label">SEC Risk Alerts</div><div class="kpi-value">' + brief.risk_alerts.length + '</div><div class="kpi-delta">' + (critCount > 0 ? '<span class="kpi-negative">' + critCount + ' critical</span> ' : '') + (warnCount > 0 ? '<span style="color:var(--gold)">' + warnCount + ' warning</span>' : '') + (critCount === 0 && warnCount === 0 ? '<span class="kpi-neutral">No alerts</span>' : '') + '</div></div>';
  var ffr = mkt.fed_funds;
  html += '<div class="kpi-card brief-clickable" onclick="switchTab(\'market\')"><div class="kpi-label">Fed Funds Rate</div><div class="kpi-value">' + (ffr != null ? ffr.toFixed(2) + '%' : '—') + '</div><div class="kpi-delta kpi-neutral">Target 4.25% – 4.50%</div></div>';
  html += '<div class="kpi-card brief-clickable" onclick="switchTab(\'aum\')"><div class="kpi-label">Total AUM Tracked</div><div class="kpi-value">' + (aumB != null ? '$' + formatBillions(aumB) : '—') + '</div><div class="kpi-delta kpi-neutral">Across all entities</div></div>';
  html += '</div>';

  // ── Primary Grid ──
  html += '<div class="brief-grid-primary">';

  // Left: Top Stories (with snippets + async supplement)
  html += '<div class="brief-card" style="animation-delay:0.3s">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\u26A1 Top Stories</span><span class="brief-card-badge" style="background:var(--surface2);color:var(--text-muted)">' + brief.top_stories.length + ' stories</span></div>';
  if (brief.top_stories.length > 0) {
    var first = brief.top_stories[0];
    var firstSnippet = first.snippet ? '<div class="story-snippet">' + escHtml(first.snippet.substring(0, 180)) + (first.snippet.length > 180 ? '…' : '') + '</div>' : '';
    html += '<div class="brief-featured"><div class="story-title"><a href="' + escHtml(first.link) + '" target="_blank" rel="noopener">' + escHtml(first.title) + '</a></div>' + firstSnippet + '<div class="story-meta"><span class="story-entity">' + escHtml(first.entity_name) + '</span><span class="brief-reason brief-reason-' + first.reason.toLowerCase().replace(/\s+/g, '-') + '">' + escHtml(first.reason) + '</span><span>' + formatDateTime(first.pub_date) + '</span></div></div>';
    brief.top_stories.slice(1, 9).forEach(function(st) {
      var stSnippet = st.snippet ? '<div class="story-snippet">' + escHtml(st.snippet.substring(0, 120)) + (st.snippet.length > 120 ? '…' : '') + '</div>' : '';
      html += '<div class="brief-story-row"><span class="story-dot ' + st.sentiment_label + '"></span><div style="flex:1;min-width:0"><div class="story-title"><a href="' + escHtml(st.link) + '" target="_blank" rel="noopener">' + escHtml(st.title) + '</a></div>' + stSnippet + '<div class="story-meta"><span class="story-entity">' + escHtml(st.entity_name) + '</span><span class="brief-reason brief-reason-' + st.reason.toLowerCase().replace(/\s+/g, '-') + '">' + escHtml(st.reason) + '</span><span>' + formatDateTime(st.pub_date) + '</span></div></div></div>';
    });
  } else {
    html += '<div class="empty">No priority stories in this period.</div>';
  }
  // Placeholder for async-loaded additional articles
  html += '<div id="briefMoreStories"></div>';
  html += '</div>';

  // Right sidebar
  html += '<div class="brief-sidebar">';

  // Market Pulse
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.35s" onclick="switchTab(\'market\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCC8 Market Pulse</span></div>';
  var gaugeScore = s.avg_score;
  var normalized = Math.max(0, Math.min(1, (gaugeScore + 1) / 2));
  var arcR = 50, arcL = Math.PI * arcR;
  var dOff = arcL * (1 - normalized);
  var gHue = Math.round(normalized * 120);
  var gColor = 'hsl(' + gHue + ', 70%, 50%)';
  html += '<div style="text-align:center"><svg width="160" height="90" viewBox="0 0 160 90"><defs><filter id="mpGlow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path d="M 18 78 A ' + arcR + ' ' + arcR + ' 0 0 1 142 78" fill="none" stroke="var(--border)" stroke-width="7" stroke-linecap="round" opacity="0.4"/><path id="gaugeFill" d="M 18 78 A ' + arcR + ' ' + arcR + ' 0 0 1 142 78" fill="none" stroke="' + gColor + '" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + arcL + '" stroke-dashoffset="' + arcL + '" filter="url(#mpGlow)" style="transition:stroke-dashoffset 1.4s cubic-bezier(0.22, 1, 0.36, 1)"/><text x="80" y="70" text-anchor="middle" fill="var(--text)" font-size="18" font-weight="800">' + gaugeScore.toFixed(2) + '</text><text x="80" y="86" text-anchor="middle" fill="var(--text-muted)" font-size="9">' + s.total_articles + ' articles</text></svg></div>';
  html += '<div class="sentiment-stack"><div class="seg-pos" style="width:' + s.positive_pct + '%"></div><div class="seg-neu" style="width:' + s.neutral_pct + '%"></div><div class="seg-neg" style="width:' + s.negative_pct + '%"></div></div>';
  html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:3px"><span style="color:var(--positive)">' + s.positive_pct + '% pos</span><span>' + s.neutral_pct + '% neu</span><span style="color:var(--negative)">' + s.negative_pct + '% neg</span></div>';

  // FRED sparklines
  var sparklines = (mkt.sparklines || []);
  if (sparklines.length > 0 || mkt.vix != null || mkt.fed_funds != null) {
    html += '<div class="fred-grid">';
    if (mkt.vix != null) {
      var vixSp = sparklines.find(function(sp) { return sp.label && sp.label.toLowerCase().indexOf('vix') >= 0; });
      html += '<div class="fred-mini"><div class="fred-mini-label">VIX</div><div class="fred-mini-value">' + mkt.vix.toFixed(1) + '</div>' + (vixSp ? renderMiniSparkline(vixSp.values) : '') + '</div>';
    }
    if (mkt.fed_funds != null) {
      var ffSp = sparklines.find(function(sp) { return sp.label && sp.label.toLowerCase().indexOf('fed') >= 0; });
      html += '<div class="fred-mini"><div class="fred-mini-label">Fed Funds</div><div class="fred-mini-value">' + mkt.fed_funds.toFixed(2) + '%</div>' + (ffSp ? renderMiniSparkline(ffSp.values) : '') + '</div>';
    }
    sparklines.filter(function(sp) {
      return !(sp.label && (sp.label.toLowerCase().indexOf('vix') >= 0 || sp.label.toLowerCase().indexOf('fed') >= 0));
    }).slice(0, 2).forEach(function(sp) {
      html += '<div class="fred-mini"><div class="fred-mini-label">' + escHtml(sp.label) + '</div><div class="fred-mini-value">' + (sp.values.length > 0 ? sp.values[sp.values.length - 1].toFixed(2) : '—') + '</div>' + renderMiniSparkline(sp.values) + '</div>';
    });
    html += '</div>';
  }
  html += '</div>';

  // Regulatory Radar
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.4s" onclick="switchTab(\'sec\')">';
  var secAlerts = brief.risk_alerts || [];
  var finraAlerts = brief.finra_alerts || [];
  var allRegs = secAlerts.length + finraAlerts.length;
  var donut = renderMiniDonut([critCount, warnCount, Math.max(allRegs - critCount - warnCount, 0)], ['var(--negative)', 'var(--gold)', 'var(--primary)']);
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDEE1\uFE0F Regulatory Radar</span><span>' + donut + '</span></div>';
  if (allRegs === 0) {
    html += '<div class="empty" style="font-size:12px">No regulatory alerts.</div>';
  }
  secAlerts.slice(0, 4).forEach(function(r) {
    html += '<div class="reg-item ' + (r.risk_level || 'monitor') + '"><div style="display:flex;gap:6px;align-items:center;margin-bottom:3px"><span class="reg-badge sec">SEC</span><span class="reg-badge" style="background:var(--surface);color:var(--text-muted)">' + escHtml(r.filing_type || '') + '</span><span style="font-size:10px;color:var(--text-muted)">' + escHtml((r.risk_level || '').toUpperCase()) + '</span></div><div style="font-weight:600;font-size:12px">' + escHtml(r.company_name || '') + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + escHtml((r.description || '').substring(0, 120)) + '</div></div>';
  });
  finraAlerts.slice(0, 3).forEach(function(f) {
    html += '<div class="reg-item ' + (f.severity || 'low') + '"><div style="display:flex;gap:6px;align-items:center;margin-bottom:3px"><span class="reg-badge finra">FINRA</span><span style="font-size:10px;color:var(--text-muted)">' + escHtml((f.severity || '').toUpperCase()) + '</span></div><div style="font-weight:600;font-size:12px">' + escHtml(f.firm_name || '') + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + escHtml((f.summary || '').substring(0, 120)) + '</div></div>';
  });
  html += '</div>';

  html += '</div>'; // end sidebar
  html += '</div>'; // end primary grid

  // ── Leadership Moves (full-width, async-loaded from /api/personnel) ──
  html += '<div id="briefLeadershipCard" class="brief-card brief-leadership-card brief-clickable" style="animation-delay:0.45s" onclick="switchTab(\'personnel\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDC65 Leadership Moves</span></div>';
  html += '<div class="empty" style="font-size:12px">Loading personnel…</div>';
  html += '</div>';

  // ── Secondary Grid ──
  html += '<div class="brief-grid-secondary">';

  // Predictions
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.5s" onclick="switchTab(\'predictions\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDD2E Predictions</span></div>';
  if (brief.prediction_movers.length > 0) {
    brief.prediction_movers.slice(0, 6).forEach(function(p) {
      var pct = Math.round(p.probability);
      var pColor = pct >= 70 ? 'var(--positive)' : pct >= 40 ? 'var(--gold)' : 'var(--negative)';
      html += '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px"><span style="font-size:11px;flex:1;margin-right:8px">' + escHtml(p.question.substring(0, 80)) + '</span><span style="font-weight:700;color:' + pColor + ';font-size:13px">' + pct + '%</span></div><div style="height:4px;background:var(--surface2);border-radius:2px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:' + pColor + ';border-radius:2px;transition:width 0.6s"></div></div></div>';
    });
  } else {
    html += '<div class="empty" style="font-size:12px">No prediction data.</div>';
  }
  html += '</div>';

  // Hiring Signals
  var hiring = brief.hiring_signals || [];
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.55s" onclick="switchTab(\'jobs\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCBC Hiring Signals</span></div>';
  if (hiring.length > 0) {
    var maxHire = Math.max.apply(null, hiring.map(function(h) { return h.total_postings; }));
    hiring.forEach(function(h) {
      var pct = Math.max((h.total_postings / maxHire) * 100, 5);
      html += '<div class="hiring-row"><span class="hiring-entity">' + escHtml(h.entity_name) + '</span><div class="hiring-bar-wrap"><div class="hiring-bar" style="width:' + pct + '%"></div></div><span class="hiring-count">' + h.total_postings + '</span></div>';
      if (h.top_departments && h.top_departments.length > 0) {
        html += '<div class="hiring-depts" style="margin-left:128px;margin-bottom:4px">';
        h.top_departments.forEach(function(d) { html += '<span class="hiring-dept-pill">' + escHtml(d) + '</span>'; });
        html += '</div>';
      }
    });
  } else {
    html += '<div class="empty" style="font-size:12px">No hiring data yet.</div>';
  }
  html += '</div>';


  // Events (7d)
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.65s" onclick="switchTab(\'calendar\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCC5 Events (7d)</span><span class="brief-card-badge" style="background:var(--surface2);color:var(--text-muted)">' + brief.upcoming_events.length + '</span></div>';
  if (brief.upcoming_events.length > 0) {
    var lastDay = '';
    brief.upcoming_events.forEach(function(e) {
      var d = new Date(e.event_date + 'T12:00:00');
      var dayLabel = d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
      if (dayLabel !== lastDay) {
        html += '<div class="event-day-header">' + dayLabel + '</div>';
        lastDay = dayLabel;
      }
      html += '<div class="event-row"><span class="event-cat">' + escHtml(e.category) + '</span><span>' + escHtml(e.title.substring(0, 60)) + (e.title.length > 60 ? '...' : '') + '</span></div>';
    });
  } else {
    html += '<div class="empty" style="font-size:12px">No upcoming events.</div>';
  }
  html += '</div>';

  // Competitor Buzz
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.7s" onclick="switchTab(\'news\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCE2 Competitor Buzz</span></div>';
  if (brief.competitor_activity.length > 0) {
    var maxCA = Math.max.apply(null, brief.competitor_activity.map(function(c) { return c.article_count; }));
    brief.competitor_activity.slice(0, 8).forEach(function(c) {
      var pct = Math.max((c.article_count / maxCA) * 100, 5);
      var isSelf = c.entity_id === 'dobbs-group';
      html += '<div class="comp-row"><span class="comp-name" style="' + (isSelf ? 'color:#8b5cf6;font-weight:700' : '') + '">' + escHtml(c.entity_name) + '</span><div class="comp-bar-wrap"><div class="comp-bar ' + (isSelf ? 'self' : 'other') + '" style="width:' + pct + '%"></div></div><span class="comp-count">' + c.article_count + '</span></div>';
    });
  } else {
    html += '<div class="empty" style="font-size:12px">No activity in last 24h.</div>';
  }
  html += '</div>';

  // Social Buzz (async-loaded)
  html += '<div class="brief-card brief-clickable" id="briefSocialBuzz" style="animation-delay:0.73s" onclick="switchTab(\'social\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCF1 Social Buzz</span></div>';
  html += '<div class="empty" style="font-size:12px">Loading social data...</div>';
  html += '</div>';

  // Trending Topics (async-loaded from articles)
  html += '<div id="briefTrendingTopics" class="brief-card brief-clickable" style="animation-delay:0.75s" onclick="switchTab(\'trends\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDD25 Trending Topics</span></div>';
  html += '<div class="empty" style="font-size:12px">Loading topics…</div>';
  html += '</div>';

  // AUM Leaderboard
  var aumBoard = brief.aum_leaderboard || [];
  html += '<div class="brief-card brief-clickable" style="animation-delay:0.8s" onclick="switchTab(\'aum\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83C\uDFC6 AUM Leaderboard</span></div>';
  if (aumBoard.length > 0) {
    var maxAum = Math.max.apply(null, aumBoard.map(function(a) { return a.aum_billions; }));
    aumBoard.forEach(function(a) {
      var pct = Math.max((a.aum_billions / maxAum) * 100, 3);
      var isSelf = a.entity_name.toLowerCase().indexOf('dobbs') >= 0 || a.entity_name.toLowerCase().indexOf('graystone') >= 0;
      html += '<div class="comp-row"><span class="comp-name" style="' + (isSelf ? 'color:#8b5cf6;font-weight:700' : '') + '">' + escHtml(a.entity_name) + '</span><div class="comp-bar-wrap"><div class="comp-bar ' + (isSelf ? 'self' : 'other') + '" style="width:' + pct + '%"></div></div><span class="comp-count">$' + formatBillions(a.aum_billions) + '</span></div>';
    });
  } else {
    html += '<div class="empty" style="font-size:12px">No AUM data. Add data in the AUM tab.</div>';
  }
  html += '</div>';

  // Form ADV (async-loaded)
  html += '<div class="brief-card brief-clickable" id="briefAdvCard" style="animation-delay:0.85s" onclick="switchTab(\'adv\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCCB Form ADV</span></div>';
  html += '<div class="empty" style="font-size:12px">Loading ADV data...</div>';
  html += '</div>';

  // Financial News (async-loaded)
  html += '<div class="brief-card brief-clickable" id="briefFinNews" style="animation-delay:0.9s" onclick="switchTab(\'fin-news\')">';
  html += '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCB0 Financial Headlines</span></div>';
  html += '<div class="empty" style="font-size:12px">Loading financial news...</div>';
  html += '</div>';

  html += '</div>'; // end secondary grid

  container.innerHTML = html;

  // Animate gauges (Market Pulse + KPI mini gauge)
  setTimeout(function() {
    var fill = document.getElementById('gaugeFill');
    if (fill) fill.setAttribute('stroke-dashoffset', String(dOff));
    document.querySelectorAll('.kpi-gauge-fill').forEach(function(el) {
      el.setAttribute('stroke-dashoffset', el.getAttribute('data-target'));
    });
  }, 100);

  // Async-load supplemental stories to fill Top Stories card
  loadBriefMoreStories(brief.top_stories || []);
  // Async-load social buzz into brief card
  loadBriefSocialBuzz();
  // Async-load ADV + Financial News
  loadBriefAdv();
  loadBriefFinNews();
  // Async-load personnel directly (bypasses brief cache for diversity)
  loadBriefPersonnel();
  // Async-load trending topics from articles
  loadBriefTrendingTopics();
}

// ── Brief: Supplement Top Stories with recent articles ───
async function loadBriefMoreStories(existingStories) {
  var container = document.getElementById('briefMoreStories');
  if (!container) return;
  try {
    // Only supplement if brief has fewer than 9 stories total
    var need = 9 - existingStories.length;
    if (need <= 0) return;
    var res = await apiFetch('/api/articles?limit=' + (need + 10));
    var articles = await res.json();
    if (!articles || articles.length === 0) return;
    // Deduplicate: exclude articles already in top stories by link
    var existingLinks = {};
    existingStories.forEach(function(s) { existingLinks[s.link] = true; });
    var extras = articles.filter(function(a) { return !existingLinks[a.link]; }).slice(0, need);
    if (extras.length === 0) return;
    var inner = '<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">';
    inner += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:8px;font-weight:600">More Headlines</div>';
    extras.forEach(function(a) {
      var snip = a.snippet ? '<div class="story-snippet">' + escHtml(a.snippet.substring(0, 120)) + (a.snippet.length > 120 ? '\u2026' : '') + '</div>' : '';
      inner += '<div class="brief-story-row"><span class="story-dot ' + (a.sentiment_label || 'neutral') + '"></span><div style="flex:1;min-width:0"><div class="story-title"><a href="' + escHtml(a.link) + '" target="_blank" rel="noopener">' + escHtml(a.title || 'Untitled') + '</a></div>' + snip + '<div class="story-meta"><span class="story-entity">' + escHtml(a.entity_name || '') + '</span><span>' + formatDateTime(a.pub_date) + '</span></div></div></div>';
    });
    inner += '</div>';
    container.innerHTML = inner;
  } catch (err) {
    // silently fail — supplemental content is optional
  }
}

async function loadBriefSocialBuzz() {
  var card = document.getElementById('briefSocialBuzz');
  if (!card) return;
  try {
    var res = await apiFetch('/api/social?limit=0');
    var data = await res.json();
    var buzz = data.buzz_summary || [];
    if (buzz.length === 0) {
      card.querySelector('.empty').textContent = 'No social data. Use the Social Feed tab to scan.';
      return;
    }
    var inner = '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCF1 Social Buzz</span><span class="brief-card-badge" style="background:var(--surface2);color:var(--text-muted)">' + buzz.reduce(function(s,b){return s+b.mention_count;},0) + ' mentions</span></div>';
    var maxMentions = Math.max.apply(null, buzz.map(function(b){return b.mention_count;}));
    buzz.slice(0, 8).forEach(function(b) {
      var pct = Math.max((b.mention_count / maxMentions) * 100, 5);
      var sentColor = b.sentiment_label === 'positive' ? 'var(--positive)' : b.sentiment_label === 'negative' ? 'var(--negative)' : 'var(--text-muted)';
      var sentIcon = b.sentiment_label === 'positive' ? '\u25B2' : b.sentiment_label === 'negative' ? '\u25BC' : '\u2500';
      inner += '<div class="comp-row"><span class="comp-name">' + escHtml(b.entity_name) + '</span><div class="comp-bar-wrap"><div class="comp-bar other" style="width:' + pct + '%"></div></div><span class="comp-count" style="color:' + sentColor + '">' + sentIcon + ' ' + b.mention_count + '</span></div>';
    });
    card.innerHTML = inner;
  } catch (err) {
    var emptyEl = card.querySelector('.empty');
    if (emptyEl) emptyEl.textContent = 'Social data unavailable.';
  }
}

// ── Brief: Form ADV card ────────────────────────────────
async function loadBriefAdv() {
  var card = document.getElementById('briefAdvCard');
  if (!card) return;
  try {
    var res = await apiFetch('/api/adv');
    var analyses = await res.json();
    if (!analyses || analyses.length === 0) {
      card.querySelector('.empty').textContent = 'No ADV data. Use the Form ADV tab to scan.';
      return;
    }
    var active = analyses.filter(function(a) { return a.registration_status === 'ACTIVE'; });
    var withDisc = analyses.filter(function(a) { return a.has_disclosures; });
    var totalBranches = analyses.reduce(function(s, a) { return s + (a.branches_count || 0); }, 0);

    var inner = '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCCB Form ADV</span><span class="brief-card-badge" style="background:var(--surface2);color:var(--text-muted)">' + analyses.length + ' firms</span></div>';

    // Mini KPI row
    inner += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">';
    inner += '<div style="text-align:center;padding:6px;border-radius:8px;background:var(--surface2)"><div style="font-size:18px;font-weight:700;color:var(--positive)">' + active.length + '</div><div style="font-size:10px;color:var(--text-muted)">Active RIAs</div></div>';
    inner += '<div style="text-align:center;padding:6px;border-radius:8px;background:var(--surface2)"><div style="font-size:18px;font-weight:700;color:' + (withDisc.length > 0 ? 'var(--negative)' : 'var(--text-muted)') + '">' + withDisc.length + '</div><div style="font-size:10px;color:var(--text-muted)">Disclosures</div></div>';
    inner += '<div style="text-align:center;padding:6px;border-radius:8px;background:var(--surface2)"><div style="font-size:18px;font-weight:700;color:var(--accent)">' + totalBranches + '</div><div style="font-size:10px;color:var(--text-muted)">Branches</div></div>';
    inner += '</div>';

    // List firms with enriched details
    var sorted = analyses.slice().sort(function(a, b) { return (a.firm_name || '').localeCompare(b.firm_name || ''); });
    sorted.slice(0, 6).forEach(function(a) {
      var statusColor = a.registration_status === 'ACTIVE' ? 'var(--positive)' : 'var(--negative)';
      var discFlag = a.has_disclosures ? ' <span style="color:var(--negative);font-size:10px" title="Has disclosures">\u26A0</span>' : '';
      // Build detail chips: branches, states, filing recency
      var details = [];
      if (a.branches_count > 0) details.push(a.branches_count + (a.branches_count === 1 ? ' branch' : ' branches'));
      var statesCount = (a.notice_states && a.notice_states.length) || 0;
      if (statesCount > 0) details.push(statesCount + (statesCount === 1 ? ' state' : ' states'));
      if (a.filing_date) {
        var fd = new Date(a.filing_date);
        if (!isNaN(fd.getTime())) {
          var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          details.push('Filed ' + months[fd.getMonth()] + ' ' + fd.getFullYear());
        }
      }
      inner += '<div style="padding:5px 0;border-bottom:1px solid var(--border)">';
      inner += '<div class="comp-row" style="margin-bottom:0"><span class="comp-name">' + escHtml(a.firm_name || a.entity_name || 'Unknown') + discFlag + '</span><span class="comp-count" style="color:' + statusColor + ';font-size:11px">' + escHtml(a.registration_status || '?') + '</span></div>';
      if (details.length > 0) {
        inner += '<div style="font-size:10px;color:var(--text-muted);padding-left:2px;margin-top:2px">' + details.join(' · ') + '</div>';
      }
      inner += '</div>';
    });
    if (analyses.length > 6) {
      inner += '<div style="text-align:center;font-size:11px;color:var(--text-muted);margin-top:6px">+' + (analyses.length - 6) + ' more — see Form ADV tab</div>';
    }
    card.innerHTML = inner;
  } catch (err) {
    var emptyEl = card.querySelector('.empty');
    if (emptyEl) emptyEl.textContent = 'ADV data unavailable.';
  }
}

// ── Brief: Financial Headlines card ─────────────────────
async function loadBriefFinNews() {
  var card = document.getElementById('briefFinNews');
  if (!card) return;
  try {
    var res = await apiFetch('/api/fin-articles?limit=5');
    var articles = await res.json();
    if (!articles || articles.length === 0) {
      card.querySelector('.empty').textContent = 'No financial news. Use the Financial News tab to crawl.';
      return;
    }
    var inner = '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDCB0 Financial Headlines</span><span class="brief-card-badge" style="background:var(--surface2);color:var(--text-muted)">' + articles.length + ' latest</span></div>';

    articles.forEach(function(a) {
      var sentColor = a.sentiment_label === 'positive' ? 'var(--positive)' : a.sentiment_label === 'negative' ? 'var(--negative)' : 'var(--text-muted)';
      var sentDot = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + sentColor + ';margin-right:6px;flex-shrink:0"></span>';
      var timeAgo = formatDateTime(a.pub_date);
      inner += '<div style="display:flex;align-items:flex-start;gap:4px;padding:5px 0;border-bottom:1px solid var(--border)">';
      inner += sentDot;
      inner += '<div style="flex:1;min-width:0">';
      inner += '<div style="font-size:12px;font-weight:500;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical"><a href="' + escHtml(a.link) + '" target="_blank" rel="noopener" style="color:var(--text-primary);text-decoration:none">' + escHtml(a.title) + '</a></div>';
      inner += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">' + escHtml(a.source_name || a.source_domain || '') + ' · ' + timeAgo + '</div>';
      inner += '</div></div>';
    });

    card.innerHTML = inner;
  } catch (err) {
    var emptyEl = card.querySelector('.empty');
    if (emptyEl) emptyEl.textContent = 'Financial news unavailable.';
  }
}

// ── Brief: Leadership Moves (async from /api/personnel) ──
async function loadBriefPersonnel() {
  var card = document.getElementById('briefLeadershipCard');
  if (!card) return;
  try {
    var res = await apiFetch('/api/personnel');
    var all = await res.json();
    if (!all || all.length === 0) {
      card.querySelector('.empty').textContent = 'No personnel changes. Use the Personnel tab to crawl.';
      return;
    }
    // Dedup by composite key: person + entity + change_type (keeps diversity)
    var seen = {};
    var unique = all.filter(function(p) {
      var key = (p.person_name || '').toLowerCase().trim() + '|' +
                (p.entity_name || '').toLowerCase().trim() + '|' +
                (p.change_type || '');
      if (!key || key === '||') return true; // empty = always include
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    // Take up to 8 most recent
    var moves = unique.slice(0, 8);
    var inner = '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDC65 Leadership Moves</span><span class="brief-card-badge" style="background:var(--surface2);color:var(--text-muted)">' + unique.length + ' changes</span></div>';
    inner += '<div class="lm-grid">';
    moves.forEach(function(p, idx) {
      var typeLabel = p.change_type === 'hire' ? 'New Hire' : p.change_type === 'departure' ? 'Departure' : p.change_type === 'promotion' ? 'Promotion' : 'Board Change';
      var typeClass = p.change_type || 'hire';
      var roleText = p.change_type === 'hire' ? (p.new_role || 'New hire') : p.change_type === 'departure' ? (p.old_role || 'Departed') : p.change_type === 'promotion' ? ((p.old_role || '') + ' \u2192 ' + (p.new_role || '')) : (p.new_role || p.old_role || 'Board change');
      var dateStr = new Date(p.date).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
      inner += '<div class="lm-card" style="animation-delay:' + (0.5 + idx * 0.06) + 's">';
      inner += '<div class="lm-type-badge ' + typeClass + '">' + escHtml(typeLabel) + '</div>';
      inner += '<div class="lm-person">' + escHtml(p.person_name || 'Unknown') + '</div>';
      inner += '<div class="lm-role">' + escHtml(roleText) + '</div>';
      inner += '<div class="lm-footer"><span class="lm-entity">' + escHtml(p.entity_name) + '</span><span class="lm-date">' + dateStr + '</span></div>';
      inner += '</div>';
    });
    inner += '</div>';
    card.innerHTML = inner;
  } catch (err) {
    var emptyEl = card.querySelector('.empty');
    if (emptyEl) emptyEl.textContent = 'Personnel data unavailable.';
  }
}

// ── Brief: Trending Topics (async from articles) ────────
var THEME_STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can','could',
  'not','no','nor','so','if','then','than','that','this','these','those','it',
  'its','he','she','they','we','you','i','me','my','our','your','his','her',
  'their','which','who','whom','what','where','when','how','all','each','every',
  'both','few','more','most','other','some','such','any','only','own','same',
  'also','very','just','about','new','says','said','year','years','one','two',
  'after','over','into','could','would','should','been','more','like','into',
  'firm','firms','company','companies','group','advisory','management',
]);

async function loadBriefTrendingTopics() {
  var card = document.getElementById('briefTrendingTopics');
  if (!card) return;
  try {
    // Fetch recent articles (competitor news)
    var res = await apiFetch('/api/articles?limit=200');
    var articles = await res.json();
    // Also include financial news
    try {
      var res2 = await apiFetch('/api/fin-articles?limit=100');
      var finArticles = await res2.json();
      if (Array.isArray(finArticles)) articles = articles.concat(finArticles);
    } catch(e) {}

    if (!articles || articles.length === 0) {
      card.querySelector('.empty').textContent = 'No articles to extract topics. Crawl news first.';
      return;
    }
    // Extract word frequency themes
    var freq = {};
    articles.forEach(function(a) {
      var text = ((a.title || '') + ' ' + (a.snippet || '')).toLowerCase().replace(/[^a-z\s]/g, '');
      var words = text.split(/\s+/);
      var seen = {};
      words.forEach(function(w) {
        if (w.length < 4 || THEME_STOP_WORDS.has(w) || seen[w]) return;
        seen[w] = true;
        freq[w] = (freq[w] || 0) + 1;
      });
    });
    var themes = Object.entries(freq)
      .filter(function(e) { return e[1] >= 2; })
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 15)
      .map(function(e) { return { theme: e[0], count: e[1] }; });

    if (themes.length === 0) {
      card.querySelector('.empty').textContent = 'No trending topics found.';
      return;
    }
    var inner = '<div class="brief-card-header"><span class="brief-card-title">\uD83D\uDD25 Trending Topics</span></div>';
    inner += '<div class="themes-grid">';
    themes.forEach(function(t, i) {
      inner += '<span class="theme-tag' + (i < 3 ? ' top' : '') + '">' + escHtml(t.theme) + ' <strong>' + t.count + '</strong></span>';
    });
    inner += '</div>';
    card.innerHTML = inner;
  } catch (err) {
    var emptyEl = card.querySelector('.empty');
    if (emptyEl) emptyEl.textContent = 'Topics unavailable.';
  }
}

// ── Competitor Discovery ────────────────────────────────
async function discoverCompetitors() {
  const btn = document.getElementById('btnDiscover');
  const container = document.getElementById('discoverySuggestions');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';
  container.innerHTML = '<div class="loading">Searching SEC EDGAR for investment advisory firms...</div>';

  try {
    const res = await apiFetch('/api/entities/discover', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Found ${data.count} suggestions`;
    setTimeout(() => { btn.textContent = 'Scan EDGAR'; btn.disabled = false; }, 3000);
    renderDiscoverySuggestions(data.suggestions || []);
  } catch (err) {
    console.error('Discovery error:', err);
    btn.textContent = 'Error';
    container.innerHTML = '<div class="empty">Failed to scan EDGAR. Try again later.</div>';
    setTimeout(() => { btn.textContent = 'Scan EDGAR'; btn.disabled = false; }, 3000);
  }
}

function renderDiscoverySuggestions(suggestions) {
  const container = document.getElementById('discoverySuggestions');
  if (!suggestions || suggestions.length === 0) {
    container.innerHTML = '<div class="empty">No new competitors found. All known firms are already tracked.</div>';
    return;
  }

  container.innerHTML = '';
  for (const s of suggestions) {
    const card = document.createElement('div');
    card.className = 'discovery-card';
    card.innerHTML = `
      <div class="discovery-card-main">
        <div class="discovery-card-info">
          <span class="discovery-name">${escHtml(s.name)}</span>
          <span class="discovery-sic">${escHtml(s.sic_description)} (SIC ${escHtml(s.sic_code)})</span>
        </div>
        <div class="discovery-card-stats">
          <span class="discovery-filings">${s.filing_count} filing${s.filing_count !== 1 ? 's' : ''}</span>
          ${s.recent_filing_types.length > 0 ? `<span class="discovery-types">${s.recent_filing_types.map(t => escHtml(t)).join(', ')}</span>` : ''}
          ${s.latest_filing_date ? `<span class="discovery-date">Latest: ${formatDateTime(s.latest_filing_date)}</span>` : ''}
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="addDiscoveredEntity('${escHtml(s.name)}', '${escHtml(s.cik)}')">Add</button>
    `;
    container.appendChild(card);
  }
}

async function addDiscoveredEntity(name, cik) {
  try {
    const res = await apiFetch('/api/entities/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, website: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}` }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to add entity');
      return;
    }
    await loadEntities();
    loadCustomEntities();
    populateAumEntitySelect();
    populateSecEntitySelect();
    // Re-run discovery to update suggestions (remove added entity)
    discoverCompetitors();
  } catch (err) {
    console.error('Failed to add discovered entity:', err);
  }
}

// ── Helpers ──────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

// ── Market Indicators ────────────────────────────────────

let _marketRefreshTimer = null;

async function loadMarketIndicators() {
  try {
    const [mktRes, sentRes] = await Promise.all([
      apiFetch('/api/market-indicators'),
      apiFetch('/api/sentiment'),
    ]);
    const mkt = await mktRes.json();
    const sent = await sentRes.json();
    renderMarketIndicators(mkt, sent);

    // Auto-crawl if data is stale (>1 hour old) or missing
    const staleMs = 60 * 60 * 1000; // 1 hour
    const isStale = !mkt.updated_at || (Date.now() - new Date(mkt.updated_at).getTime()) > staleMs;
    if (isStale) {
      console.log('[Market] Data is stale or missing — auto-refreshing...');
      const ts = document.getElementById('marketTimestamp');
      if (ts) ts.textContent = 'Auto-refreshing data...';
      try {
        await apiFetch('/api/market-indicators/crawl', { method: 'POST' });
        // Reload after crawl
        const freshRes = await apiFetch('/api/market-indicators');
        const freshMkt = await freshRes.json();
        renderMarketIndicators(freshMkt, sent);
      } catch (crawlErr) {
        console.warn('[Market] Auto-crawl failed:', crawlErr);
      }
    }

    // Set up auto-refresh every 5 minutes while on this tab
    clearInterval(_marketRefreshTimer);
    _marketRefreshTimer = setInterval(async () => {
      try {
        const [r1, r2] = await Promise.all([
          apiFetch('/api/market-indicators'),
          apiFetch('/api/sentiment'),
        ]);
        renderMarketIndicators(await r1.json(), await r2.json());
      } catch (e) { /* silent */ }
    }, 5 * 60 * 1000);
  } catch (err) {
    console.error('Failed to load market indicators:', err);
  }
}

// ── Gauge Animation Engine ──
function animateAllGauges(container, baseDelay) {
  var delay = baseDelay || 200;
  var svgs = container.querySelectorAll('.gauge-svg-animated');
  svgs.forEach(function(svg, idx) {
    var card = svg.closest('[data-gauge-delay]');
    var cardDelay = card ? parseInt(card.getAttribute('data-gauge-delay')) : (delay + idx * 120);

    // 1. Animate arc fill with spring easing
    var arcFill = svg.querySelector('.gauge-arc-fill');
    if (arcFill) {
      setTimeout(function() {
        arcFill.style.transition = 'stroke-dashoffset 1.4s cubic-bezier(0.22, 1.0, 0.36, 1)';
        arcFill.setAttribute('stroke-dashoffset', arcFill.getAttribute('data-target'));
      }, cardDelay);
    }

    // 2. Count-up the score number
    var counter = svg.querySelector('.gauge-score-counter');
    if (counter) {
      var target = parseInt(counter.getAttribute('data-target'));
      var startTime = null;
      var duration = 1200;
      setTimeout(function() {
        requestAnimationFrame(function step(ts) {
          if (!startTime) startTime = ts;
          var progress = Math.min((ts - startTime) / duration, 1);
          // Ease out cubic
          var eased = 1 - Math.pow(1 - progress, 3);
          var current = Math.round(eased * target);
          counter.textContent = current;
          if (progress < 1) requestAnimationFrame(step);
        });
      }, cardDelay + 200);
    }

    // 4. Reveal rating text (Fear & Greed only)
    var ratingText = svg.querySelector('.fg-rating-text');
    if (ratingText) {
      setTimeout(function() {
        ratingText.textContent = ratingText.getAttribute('data-rating');
        ratingText.style.transition = 'opacity 0.5s';
        ratingText.style.opacity = '1';
      }, cardDelay + 1200);
    }
  });
}

function renderMarketIndicators(mkt, sent) {
  // ── Composite Gauge Dashboard ──
  var gaugeEl = document.getElementById('marketGaugeStrip');
  if (gaugeEl && mkt.fred_series && mkt.fred_series.length > 0) {
    // Helper: find latest value by series_id
    function fredVal(id) {
      var s = mkt.fred_series.find(function(x) { return x.series_id === id; });
      return s ? s.latest_value : null;
    }
    // Helper: clamp & normalize value to 0-100
    function norm(val, lo, hi) {
      if (val === null || val === undefined) return null;
      return Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
    }
    // Helper: average non-null values
    function avg(arr) {
      var vals = arr.filter(function(v) { return v !== null; });
      if (vals.length === 0) return null;
      return vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
    }

    // ── Compute composite scores (0 = bad/risk, 100 = good/calm) ──
    var gauges = [];

    // Helper: find source_url by series_id
    function fredUrl(id) {
      var s = mkt.fred_series.find(function(x) { return x.series_id === id; });
      return s && s.source_url ? s.source_url : 'https://fred.stlouisfed.org/series/' + id;
    }

    // 1. Fear & Greed (already 0-100)
    if (mkt.fear_greed) {
      gauges.push({
        label: 'Fear & Greed',
        score: mkt.fear_greed.score,
        sub: mkt.fear_greed.rating,
        icon: '😰',
        url: 'https://edition.cnn.com/markets/fear-and-greed',
        sources: ['CNN Fear & Greed Index']
      });
    }

    // 2. Market Risk: VIX (invert: low=calm=100) + Stress Index (invert)
    var vix = fredVal('VIXCLS');
    var stress = fredVal('STLFSI4');
    var riskScore = avg([
      vix !== null ? 100 - norm(vix, 10, 45) : null,
      stress !== null ? 100 - norm(stress, -1.5, 4) : null
    ]);
    if (riskScore !== null) {
      var riskLabel = riskScore >= 70 ? 'Low Risk' : riskScore >= 40 ? 'Moderate' : 'Elevated';
      gauges.push({ label: 'Market Risk', score: Math.round(riskScore), sub: riskLabel, icon: '⚡', url: fredUrl('VIXCLS'), sources: ['CBOE VIX', 'St. Louis Financial Stress'] });
    }

    // 3. Credit Health: Invert spreads (tight=good=100)
    var hyOas = fredVal('BAMLH0A0HYM2');
    var bbb = fredVal('BAMLC0A4CBBB');
    var aaa = fredVal('BAMLC0A1CAAA');
    var creditScore = avg([
      hyOas !== null ? 100 - norm(hyOas, 2.5, 10) : null,
      bbb !== null ? 100 - norm(bbb, 0.8, 4) : null,
      aaa !== null ? 100 - norm(aaa, 0.3, 2.5) : null
    ]);
    if (creditScore !== null) {
      var crLabel = creditScore >= 70 ? 'Tight' : creditScore >= 40 ? 'Normal' : 'Widening';
      gauges.push({ label: 'Credit Health', score: Math.round(creditScore), sub: crLabel, icon: '🔗', url: fredUrl('BAMLH0A0HYM2'), sources: ['ICE BofA HY OAS', 'BBB Spread', 'AAA Spread'] });
    }

    // 4. Yield Curve: 10Y-2Y spread (positive=normal=good)
    var t10y2y = fredVal('T10Y2Y');
    if (t10y2y !== null) {
      var ycScore = Math.round(norm(t10y2y, -1.0, 2.5));
      var ycLabel = t10y2y < 0 ? 'Inverted' : t10y2y < 0.5 ? 'Flat' : 'Steep';
      gauges.push({ label: 'Yield Curve', score: ycScore, sub: (t10y2y > 0 ? '+' : '') + t10y2y.toFixed(2) + '% spread', icon: '📐', url: fredUrl('T10Y2Y'), sources: ['Treasury 10Y-2Y Spread'] });
    }

    // 5. Inflation Pulse: distance from 2% target (on target = 100)
    var be10 = fredVal('T10YIE');
    var be5 = fredVal('T5YIE');
    var inflScore = avg([
      be10 !== null ? Math.max(0, 100 - Math.abs(be10 - 2.0) * 40) : null,
      be5 !== null ? Math.max(0, 100 - Math.abs(be5 - 2.0) * 40) : null
    ]);
    if (inflScore !== null) {
      var iVal = be10 || be5;
      var iLabel = iVal > 2.8 ? 'Hot' : iVal > 2.2 ? 'Above Target' : iVal >= 1.8 ? 'On Target' : 'Below Target';
      gauges.push({ label: 'Inflation Pulse', score: Math.round(inflScore), sub: iLabel, icon: '🔥', url: fredUrl('T10YIE'), sources: ['10Y Breakeven', '5Y Breakeven'] });
    }

    // 6. Dollar Strength: USD Index (normalize around 90-120 range, mid=neutral)
    var dxy = fredVal('DTWEXBGS');
    if (dxy !== null) {
      var dolScore = Math.round(norm(dxy, 95, 135));
      var dolLabel = dolScore >= 70 ? 'Strong' : dolScore >= 40 ? 'Neutral' : 'Weak';
      gauges.push({ label: 'USD Strength', score: dolScore, sub: dxy.toFixed(1) + ' index', icon: '💵', url: fredUrl('DTWEXBGS'), sources: ['Fed Broad Dollar Index'] });
    }

    // 7. Commodities Heat: Oil + Gas + Gold momentum (rising prices = hot)
    var wti = fredVal('DCOILWTICO');
    var gas = fredVal('DHHNGSP');
    var gold = fredVal('GOLDAMGBD228NLBM');
    var cmdScore = avg([
      wti !== null ? norm(wti, 40, 120) : null,
      gas !== null ? norm(gas, 1.5, 6.0) : null,
      gold !== null ? norm(gold, 1500, 3000) : null
    ]);
    if (cmdScore !== null) {
      var cmdLabel = cmdScore >= 70 ? 'Hot' : cmdScore >= 40 ? 'Moderate' : 'Cool';
      gauges.push({ label: 'Commodities', score: Math.round(cmdScore), sub: cmdLabel, icon: '🛢️', url: fredUrl('DCOILWTICO'), sources: ['WTI Crude', 'Henry Hub Gas', 'Gold London Fix'] });
    }

    // 8. Labor Strength: low unemployment + low claims = strong (invert for score)
    var unemp = fredVal('UNRATE');
    var claims = fredVal('ICSA');
    var labScore = avg([
      unemp !== null ? 100 - norm(unemp, 3.0, 8.0) : null,
      claims !== null ? 100 - norm(claims, 180000, 400000) : null
    ]);
    if (labScore !== null) {
      var labLabel = labScore >= 70 ? 'Strong' : labScore >= 40 ? 'Softening' : 'Weak';
      gauges.push({ label: 'Labor Market', score: Math.round(labScore), sub: labLabel, icon: '👷', url: fredUrl('UNRATE'), sources: ['BLS Unemployment', 'Initial Claims'] });
    }

    // 9. Consumer Pulse: UMich sentiment (higher = better)
    var umcs = fredVal('UMCSENT');
    if (umcs !== null) {
      var conScore = Math.round(norm(umcs, 50, 100));
      var conLabel = conScore >= 70 ? 'Optimistic' : conScore >= 40 ? 'Mixed' : 'Pessimistic';
      gauges.push({ label: 'Consumer', score: conScore, sub: umcs.toFixed(1) + ' index', icon: '🛒', url: fredUrl('UMCSENT'), sources: ['U. Michigan Sentiment'] });
    }

    // ── Render gauge cards ──
    function gaugeColor(score) {
      if (score <= 25) return '#ef4444';
      if (score <= 40) return '#f97316';
      if (score <= 55) return '#eab308';
      if (score <= 75) return '#22c55e';
      return '#16a34a';
    }
    function renderArcGauge(score, color, size) {
      var r = size * 0.38;
      var arcLen = Math.PI * r;
      var cx = size / 2, cy = size * 0.55;
      var x1 = cx - r, x2 = cx + r;
      var h = Math.round(size * 0.7);
      return '<svg class="gauge-svg-animated" viewBox="0 0 ' + size + ' ' + h + '" width="' + size + '" height="' + h + '" data-score="' + score + '">' +
        '<defs><filter id="glow' + score + '"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
        '<path d="M ' + x1 + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + x2 + ' ' + cy + '" fill="none" stroke="var(--border)" stroke-width="7" stroke-linecap="round" opacity="0.5"/>' +
        '<path class="gauge-arc-fill" d="M ' + x1 + ' ' + cy + ' A ' + r + ' ' + r + ' 0 0 1 ' + x2 + ' ' + cy + '" fill="none" stroke="' + color + '" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + arcLen.toFixed(1) + '" stroke-dashoffset="' + arcLen.toFixed(1) + '" data-target="' + (arcLen - (score / 100) * arcLen).toFixed(1) + '" filter="url(#glow' + score + ')"/>' +
        '<text class="gauge-score-counter" x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" fill="' + color + '" font-size="18" font-weight="800" data-target="' + score + '">0</text>' +
        '</svg>';
    }

    var gHtml = '';
    gauges.forEach(function(g, idx) {
      var c = gaugeColor(g.score);
      var srcText = (g.sources || []).join(' · ');
      gHtml += '<a class="gauge-card" href="' + escHtml(g.url || '#') + '" target="_blank" rel="noopener" style="--gauge-accent:' + c + ';animation-delay:' + (idx * 0.08) + 's;" data-gauge-delay="' + (idx * 120 + 300) + '">';
      gHtml += renderArcGauge(g.score, c, 130);
      gHtml += '<div class="gauge-card-label">' + g.icon + ' ' + escHtml(g.label) + '</div>';
      gHtml += '<div class="gauge-card-sub">' + escHtml(g.sub) + '</div>';
      gHtml += '<div class="gauge-card-sources">' + escHtml(srcText) + ' ↗</div>';
      gHtml += '</a>';
    });
    gaugeEl.innerHTML = gHtml;
    // Animate all 9 gauges with staggered timing
    animateAllGauges(gaugeEl);
  } else if (gaugeEl) {
    gaugeEl.innerHTML = '';
  }

  // Fear & Greed gauge — animated
  const fgEl = document.getElementById('fearGreedSection');
  if (mkt.fear_greed) {
    const fg = mkt.fear_greed;
    const color = fg.score <= 25 ? '#ef4444' : fg.score <= 45 ? '#f97316' : fg.score <= 55 ? '#eab308' : fg.score <= 75 ? '#22c55e' : '#16a34a';
    const fgArcLen = 251.2;
    fgEl.innerHTML = `
      <a class="fg-card" href="https://edition.cnn.com/markets/fear-and-greed" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">
        <div class="fg-gauge">
          <svg class="gauge-svg-animated" viewBox="0 0 200 120" width="220" height="132" data-score="${fg.score}">
            <defs>
              <filter id="fgGlow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              <linearGradient id="fgGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#ef4444"/>
                <stop offset="25%" stop-color="#f97316"/>
                <stop offset="50%" stop-color="#eab308"/>
                <stop offset="75%" stop-color="#22c55e"/>
                <stop offset="100%" stop-color="#16a34a"/>
              </linearGradient>
            </defs>
            <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="var(--border)" stroke-width="10" stroke-linecap="round" opacity="0.4"/>
            <path class="gauge-arc-fill fg-arc" d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#fgGrad)" stroke-width="10" stroke-linecap="round"
              stroke-dasharray="${fgArcLen}" stroke-dashoffset="${fgArcLen}" data-target="${(fgArcLen - (fg.score / 100) * fgArcLen).toFixed(1)}" filter="url(#fgGlow)"/>
            <text class="gauge-score-counter" x="100" y="85" text-anchor="middle" fill="${color}" font-size="28" font-weight="800" data-target="${fg.score}">0</text>
            <text x="100" y="113" text-anchor="middle" fill="var(--text-muted)" font-size="10" class="fg-rating-text" data-rating="${escHtml(fg.rating)}">&nbsp;</text>
          </svg>
        </div>
        <div class="fg-meta">
          <h3>Fear &amp; Greed Index</h3>
          <div class="fg-comparisons">
            <span>Prev Close: <strong>${fg.previous_close}</strong></span>
            <span>1 Week: <strong>${fg.one_week_ago}</strong></span>
            <span>1 Month: <strong>${fg.one_month_ago}</strong></span>
            <span>1 Year: <strong>${fg.one_year_ago}</strong></span>
          </div>
          <div style="font-size:10px;color:var(--accent, #6366f1);margin-top:8px;opacity:0.7;">Source: CNN Business ↗</div>
        </div>
      </a>
      ${mkt.yield_spread !== null ? `<div class="yield-spread-card"><span class="yield-label">Yield Curve Spread (10Y-2Y)</span><span class="yield-value ${mkt.yield_spread < 0 ? 'inverted' : ''}">${mkt.yield_spread > 0 ? '+' : ''}${mkt.yield_spread}%</span></div>` : ''}
    `;
    // Animate Fear & Greed gauge
    animateAllGauges(fgEl, 400);
  } else {
    fgEl.innerHTML = '<div class="empty">No Fear &amp; Greed data yet. Click "Refresh Data" to fetch.</div>';
  }

  // FRED series cards — grouped by category
  var fredEl = document.getElementById('fredCardsGrid');
  if (mkt.fred_series && mkt.fred_series.length > 0) {
    // Group by category
    var catOrder = ['Volatility & Risk','Interest Rates','Credit Spreads','Inflation','Commodities','Currencies','Liquidity','Labor Market','Housing','Economic Activity'];
    var catIcons = {'Volatility & Risk':'⚡','Interest Rates':'📈','Credit Spreads':'🔗','Inflation':'🔥','Commodities':'🛢️','Currencies':'💱','Liquidity':'💧','Labor Market':'👷','Housing':'🏠','Economic Activity':'🏭'};
    var grouped = {};
    mkt.fred_series.forEach(function(s) {
      var cat = s.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(s);
    });
    var catHtml = '';
    catOrder.forEach(function(cat) {
      if (!grouped[cat]) return;
      var icon = catIcons[cat] || '📊';
      catHtml += '<div class="fred-category-group"><div class="fred-category-header"><span class="fred-category-icon">' + icon + '</span><span class="fred-category-title">' + escHtml(cat) + '</span></div><div class="fred-category-grid">';
      grouped[cat].forEach(function(s) {
        var pts = s.data_points || [];
        var sparkline = renderSparklineSvg(pts.map(function(p) { return p.value; }));
        var sourceUrl = s.source_url || ('https://fred.stlouisfed.org/series/' + s.series_id);
        var valStr = s.unit === '%' || s.unit === '$/bbl' || s.unit === '$/oz' || s.unit === '$/MMBtu' || s.unit === '¥/$' || s.unit === 'Rate'
          ? s.latest_value.toFixed(2) + (s.unit === '%' ? '%' : ' ' + s.unit)
          : s.unit === '$M' ? '$' + (s.latest_value / 1e6).toFixed(1) + 'T'
          : s.unit === '$B' ? '$' + s.latest_value.toFixed(0) + 'B'
          : s.unit === 'K' ? Math.round(s.latest_value / 1000) + 'K'
          : s.latest_value.toFixed(2);
        catHtml += '<a class="fred-card" href="' + escHtml(sourceUrl) + '" target="_blank" rel="noopener">';
        catHtml += '<div class="fred-header"><span class="fred-label">' + escHtml(s.label) + '</span><span class="fred-value">' + valStr + '</span></div>';
        catHtml += '<div class="fred-sparkline">' + sparkline + '</div>';
        catHtml += '<div class="fred-footer"><span class="fred-date">' + s.latest_date + '</span><span class="fred-source">FRED ↗</span></div>';
        catHtml += '</a>';
      });
      catHtml += '</div></div>';
    });
    // Any uncategorized
    Object.keys(grouped).forEach(function(cat) {
      if (catOrder.indexOf(cat) === -1) {
        catHtml += '<div class="fred-category-group"><div class="fred-category-header"><span class="fred-category-icon">📊</span><span class="fred-category-title">' + escHtml(cat) + '</span></div><div class="fred-category-grid">';
        grouped[cat].forEach(function(s) {
          var pts = s.data_points || [];
          var sparkline = renderSparklineSvg(pts.map(function(p) { return p.value; }));
          var sourceUrl = s.source_url || ('https://fred.stlouisfed.org/series/' + s.series_id);
          catHtml += '<a class="fred-card" href="' + escHtml(sourceUrl) + '" target="_blank" rel="noopener">';
          catHtml += '<div class="fred-header"><span class="fred-label">' + escHtml(s.label) + '</span><span class="fred-value">' + s.latest_value.toFixed(2) + '</span></div>';
          catHtml += '<div class="fred-sparkline">' + sparkline + '</div>';
          catHtml += '<div class="fred-footer"><span class="fred-date">' + s.latest_date + '</span><span class="fred-source">FRED ↗</span></div>';
          catHtml += '</a>';
        });
        catHtml += '</div></div>';
      }
    });
    fredEl.innerHTML = catHtml;
  } else {
    fredEl.innerHTML = '<div class="empty">No FRED data. Set FRED_API_KEY and click "Refresh Data".</div>';
  }

  // Sentiment section
  const sentEl = document.getElementById('sentimentSection');
  if (sent && sent.topics && sent.topics.length > 0) {
    const sentColor = sent.composite_score < -0.15 ? '#ef4444' : sent.composite_score > 0.15 ? '#22c55e' : '#eab308';
    sentEl.innerHTML = `
      <h3 style="margin-top:24px;">Alpha Vantage Sentiment</h3>
      <div class="sent-composite">
        <span class="sent-score" style="color:${sentColor}">${sent.composite_label}</span>
        <span class="sent-value">(${sent.composite_score.toFixed(3)})</span>
      </div>
      <div class="sent-topics">${sent.topics.map(t => `
        <div class="sent-topic-card">
          <div class="sent-topic-name">${escHtml(t.topic.replace(/_/g, ' '))}</div>
          <div class="sent-topic-score">${t.label} (${t.score.toFixed(3)})</div>
          <div class="sent-topic-count">${t.article_count} articles</div>
        </div>
      `).join('')}</div>
    `;
  } else {
    sentEl.innerHTML = '';
  }

  // Timestamp
  const ts = document.getElementById('marketTimestamp');
  if (mkt.updated_at) ts.textContent = `Updated ${formatDateTime(mkt.updated_at)}`;
}

function renderSparklineSvg(values) {
  if (!values || values.length < 2) return '';
  const w = 120, h = 32, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
    return `${x},${y}`;
  }).join(' ');
  const color = values[values.length - 1] >= values[0] ? '#22c55e' : '#ef4444';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

async function triggerMarketCrawl() {
  try {
    await apiFetch('/api/market-indicators/crawl', { method: 'POST' });
    await apiFetch('/api/sentiment/crawl', { method: 'POST' });
    loadMarketIndicators();
  } catch (err) {
    console.error('Market crawl failed:', err);
  }
}

// ── 13F Holdings ─────────────────────────────────────────

async function loadHoldingsEntities() {
  try {
    const res = await apiFetch('/api/13f');
    const data = await res.json();
    const allEntities = data.entities || [];
    window._holdingsEntities = allEntities;
    renderHoldingsGrid(allEntities);
  } catch (err) {
    console.error('Failed to load 13F entities:', err);
    document.getElementById('holdingsGrid').innerHTML = '<div class="v2-empty">Failed to load holdings data. Try "Crawl 13F Filings" first.</div>';
  }
}

function formatValue(valThousands) {
  if (!valThousands) return '$0';
  const m = valThousands / 1000; // millions
  if (m >= 1000000) {
    const t = m / 1000000;
    return '$' + t.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'T';
  }
  if (m >= 1000) return '$' + (m / 1000).toFixed(1) + 'B';
  if (m >= 1) return '$' + m.toFixed(0) + 'M';
  return '$' + valThousands.toLocaleString() + 'K';
}

function renderHoldingsGrid(allEntities) {
  const kpiEl = document.getElementById('holdingsKpi');
  const gridEl = document.getElementById('holdingsGrid');

  if (!allEntities || allEntities.length === 0) {
    kpiEl.innerHTML = '';
    gridEl.innerHTML = '<div class="v2-empty">No 13F holdings data available. Click "Crawl 13F Filings" to fetch data from SEC EDGAR.</div>';
    return;
  }

  // KPI strip
  const totalEntities = allEntities.length;
  const totalVal = allEntities.reduce((s, e) => s + (e.total_value_thousands || 0), 0);
  const totalHoldings = allEntities.reduce((s, e) => s + (e.holdings_count || 0), 0);
  kpiEl.innerHTML = `
    <div class="kpi-card"><div class="kpi-value">${totalEntities}</div><div class="kpi-label">Entities</div></div>
    <div class="kpi-card"><div class="kpi-value">${formatValue(totalVal)}</div><div class="kpi-label">Aggregate 13F Value</div></div>
    <div class="kpi-card"><div class="kpi-value">${totalHoldings.toLocaleString()}</div><div class="kpi-label">Total Positions</div></div>
  `;

  // Entity cards
  gridEl.innerHTML = allEntities.map((e, idx) => {
    const val = formatValue(e.total_value_thousands || 0);
    const topTags = (e.top_holdings || []).map(h =>
      '<span class="holdings-top-tag">' + escHtml(h.issuer) + ' (' + h.pct + '%)</span>'
    ).join('');
    return `
      <div class="holdings-entity-card" data-cik="${escHtml(e.cik)}" onclick="toggleHoldingsCard(this)" style="animation-delay:${Math.min(idx * 0.04, 0.6)}s">
        <div class="holdings-card-header">
          <span class="holdings-card-name">${escHtml(e.name)}</span>
          <span class="holdings-card-chevron">&#9660;</span>
        </div>
        <div class="holdings-card-highlights">
          <div class="holdings-highlight"><span class="holdings-highlight-val">${val}</span><span class="holdings-highlight-label">Total Value</span></div>
          <div class="holdings-highlight"><span class="holdings-highlight-val">${(e.holdings_count || 0).toLocaleString()}</span><span class="holdings-highlight-label">Holdings</span></div>
          <div class="holdings-highlight"><span class="holdings-highlight-val">${e.latest_period || '-'}</span><span class="holdings-highlight-label">Period</span></div>
        </div>
        ${topTags ? '<div class="holdings-card-top">' + topTags + '</div>' : ''}
        <div class="holdings-card-detail" style="display:none"></div>
      </div>
    `;
  }).join('');
}

async function toggleHoldingsCard(card) {
  const detailEl = card.querySelector('.holdings-card-detail');
  if (card.classList.contains('expanded')) {
    card.classList.remove('expanded');
    detailEl.style.display = 'none';
    return;
  }

  // Collapse any other expanded card
  document.querySelectorAll('.holdings-entity-card.expanded').forEach(c => {
    c.classList.remove('expanded');
    c.querySelector('.holdings-card-detail').style.display = 'none';
  });

  card.classList.add('expanded');
  detailEl.style.display = 'block';

  // If already loaded, just show
  if (detailEl.dataset.loaded) return;

  detailEl.innerHTML = '<div class="loading" style="padding:12px">Loading holdings...</div>';
  const cik = card.dataset.cik;

  try {
    const res = await apiFetch('/api/13f?cik=' + encodeURIComponent(cik));
    const data = await res.json();
    if (!data.filing || !data.filing.holdings || data.filing.holdings.length === 0) {
      detailEl.innerHTML = '<div class="v2-empty" style="margin:0">No holdings data for this entity.</div>';
      detailEl.dataset.loaded = '1';
      return;
    }

    const f = data.filing;
    // Period selector if multiple periods
    const periods = data.periods || [];
    let periodHtml = '';
    if (periods.length > 1) {
      periodHtml = '<div style="margin-bottom:12px"><select class="holdings-period-select" onchange="switchHoldingsPeriod(this, \'' + escHtml(cik) + '\')">' +
        periods.map(p => '<option value="' + p + '"' + (p === f.period ? ' selected' : '') + '>' + p + '</option>').join('') +
        '</select></div>';
    }

    const top = f.holdings.slice(0, 50);
    detailEl.innerHTML = periodHtml + `
      <div class="v2-table-card" style="margin:0">
      <table class="v2-table">
        <thead><tr><th>#</th><th>Issuer</th><th>CUSIP</th><th>Value</th><th>Shares</th><th>% Port</th></tr></thead>
        <tbody>${top.map((h, i) => {
          const pct = f.total_value_thousands > 0 ? ((h.value_thousands / f.total_value_thousands) * 100).toFixed(2) : '0.00';
          return '<tr><td>' + (i + 1) + '</td><td>' + escHtml(h.issuer) + '</td><td class="mono">' + (h.cusip || '') + '</td><td class="num">' + formatValue(h.value_thousands) + '</td><td class="num">' + (h.shares || 0).toLocaleString() + '</td><td class="num">' + pct + '%</td></tr>';
        }).join('')}</tbody>
      </table>
      </div>
      ${f.holdings.length > 50 ? '<p class="table-note" style="padding:8px 0;margin:0;font-size:11px;color:var(--text-muted)">Showing top 50 of ' + f.holdings.length + ' holdings</p>' : ''}
    `;
    detailEl.dataset.loaded = '1';
  } catch (err) {
    console.error('Failed to load holdings detail:', err);
    detailEl.innerHTML = '<div class="v2-empty" style="margin:0">Error loading holdings.</div>';
  }
}

async function switchHoldingsPeriod(select, cik) {
  const card = select.closest('.holdings-entity-card');
  const detailEl = card.querySelector('.holdings-card-detail');
  const period = select.value;

  detailEl.dataset.loaded = '';
  const selectHtml = select.parentElement.outerHTML;
  detailEl.innerHTML = selectHtml + '<div class="loading" style="padding:12px">Loading...</div>';

  try {
    const res = await apiFetch('/api/13f?cik=' + encodeURIComponent(cik) + '&period=' + encodeURIComponent(period));
    const data = await res.json();
    const f = data.filing;
    if (!f || !f.holdings || f.holdings.length === 0) {
      detailEl.innerHTML = selectHtml + '<div class="v2-empty" style="margin:0">No data for this period.</div>';
      return;
    }

    const top = f.holdings.slice(0, 50);
    detailEl.innerHTML = selectHtml + `
      <div class="v2-table-card" style="margin:0">
      <table class="v2-table">
        <thead><tr><th>#</th><th>Issuer</th><th>CUSIP</th><th>Value</th><th>Shares</th><th>% Port</th></tr></thead>
        <tbody>${top.map((h, i) => {
          const pct = f.total_value_thousands > 0 ? ((h.value_thousands / f.total_value_thousands) * 100).toFixed(2) : '0.00';
          return '<tr><td>' + (i + 1) + '</td><td>' + escHtml(h.issuer) + '</td><td class="mono">' + (h.cusip || '') + '</td><td class="num">' + formatValue(h.value_thousands) + '</td><td class="num">' + (h.shares || 0).toLocaleString() + '</td><td class="num">' + pct + '%</td></tr>';
        }).join('')}</tbody>
      </table>
      </div>
      ${f.holdings.length > 50 ? '<p class="table-note" style="padding:8px 0;margin:0;font-size:11px;color:var(--text-muted)">Showing top 50 of ' + f.holdings.length + ' holdings</p>' : ''}
    `;
    detailEl.dataset.loaded = '1';
  } catch (err) {
    console.error('Failed to switch period:', err);
  }
}

async function trigger13FCrawl() {
  const btn = event.target;
  btn.disabled = true;

  try {
    const infoRes = await apiFetch('/api/13f/crawl', { method: 'POST' });
    const info = await infoRes.json();
    const totalBatches = info.totalBatches || 1;
    let totalFilings = 0;

    for (let batch = 0; batch < totalBatches; batch++) {
      btn.textContent = `Crawling batch ${batch + 1}/${totalBatches}...`;
      try {
        const res = await apiFetch(`/api/13f/crawl?batch=${batch}`, { method: 'POST' });
        const data = await res.json();
        totalFilings += data.filings || 0;
      } catch (batchErr) {
        console.warn(`[13F] Batch ${batch} failed, continuing...`, batchErr);
      }
    }

    btn.textContent = `Done! ${totalFilings} filings saved. Reloading...`;
    await loadHoldingsEntities();
  } catch (err) {
    console.error('13F crawl failed:', err);
    btn.textContent = 'Crawl failed — try again';
  }

  btn.disabled = false;
  setTimeout(() => { btn.textContent = 'Crawl 13F Filings'; }, 3000);
}

// ── Email Digest ─────────────────────────────────────────
async function sendEmailDigest() {
  const btn = document.getElementById('btnEmailDigest');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending...';

  try {
    const res = await apiFetch('/api/email/digest', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      btn.textContent = 'Sent!';
    } else {
      btn.textContent = 'Error: ' + (data.error || 'Unknown');
    }
    setTimeout(() => { btn.textContent = 'Email Digest'; btn.disabled = false; }, 3000);
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Email Digest'; btn.disabled = false; }, 3000);
  }
}

// ── Form ADV Analysis ────────────────────────────────────
async function loadAdvAnalyses() {
  try {
    const res = await apiFetch('/api/adv');
    const analyses = await res.json();
    renderAdvAnalyses(analyses);
  } catch (err) {
    console.error('Failed to load ADV analyses:', err);
  }
}

function renderAdvAnalyses(analyses) {
  const container = document.getElementById('advGrid');
  if (!analyses || analyses.length === 0) {
    container.innerHTML = '<div class="v2-empty">No ADV data yet. Click "Scan IAPD" to fetch Form ADV registrations.</div>';
    return;
  }

  const sorted = [...analyses].sort((a, b) => (a.firm_name || '').localeCompare(b.firm_name || ''));
  const active = sorted.filter(a => a.registration_status === 'ACTIVE');
  const withDisclosures = sorted.filter(a => a.has_disclosures);
  const totalStates = new Set(sorted.flatMap(a => a.notice_states || [])).size;

  container.innerHTML = `<div class="v2-kpi-strip">
    <div class="kpi-card"><div class="kpi-value">${sorted.length}</div><div class="kpi-label">Firms Found</div></div>
    <div class="kpi-card"><div class="kpi-value">${active.length}</div><div class="kpi-label">Active RIAs</div></div>
    <div class="kpi-card"><div class="kpi-value">${withDisclosures.length}</div><div class="kpi-label">With Disclosures</div></div>
    <div class="kpi-card"><div class="kpi-value">${totalStates}</div><div class="kpi-label">States Covered</div></div>
  </div>`;

  for (let idx = 0; idx < sorted.length; idx++) {
    const a = sorted[idx];
    const card = document.createElement('div');
    card.className = 'adv-card';
    card.style.animationDelay = (idx * 0.04) + 's';
    const statusClass = a.registration_status === 'ACTIVE' ? 'adv-status-active' : 'adv-status-inactive';
    const stateCount = (a.notice_states || []).length;

    card.innerHTML = `
      <div class="adv-card-header">
        <h3>${escHtml(a.firm_name || a.entity_name || 'Unknown')}</h3>
        <span class="adv-status ${statusClass}">${escHtml(a.registration_status || 'Unknown')}</span>
      </div>
      ${a.other_names && a.other_names.length > 0 ? `<div class="adv-aka">aka ${a.other_names.map(n => escHtml(n)).join(', ')}</div>` : ''}
      <div class="adv-metrics">
        <div class="adv-metric"><span class="adv-metric-label">CRD #</span><span class="adv-metric-value">${escHtml(a.crd || 'N/A')}</span></div>
        <div class="adv-metric"><span class="adv-metric-label">SEC #</span><span class="adv-metric-value">${escHtml(a.sec_number || 'N/A')}</span></div>
        <div class="adv-metric"><span class="adv-metric-label">Branches</span><span class="adv-metric-value">${a.branches_count || 0}</span></div>
        <div class="adv-metric"><span class="adv-metric-label">Notice States</span><span class="adv-metric-value">${stateCount}</span></div>
      </div>
      ${a.office_address ? `<div class="adv-detail-row"><span class="adv-detail-label">Office:</span> ${escHtml(a.office_address)}</div>` : ''}
      ${a.has_disclosures ? '<div class="adv-detail-row adv-warning">Has regulatory disclosures</div>' : ''}
      ${a.brochure_name ? `<div class="adv-detail-row"><span class="adv-detail-label">Brochure:</span> ${escHtml(a.brochure_name)} (${escHtml(a.brochure_date || '')})</div>` : ''}
      <div class="adv-footer">
        <span class="adv-date">ADV Filed: ${escHtml(a.filing_date || 'N/A')}</span>
        <div class="adv-links">
          ${a.iapd_url ? `<a href="${escHtml(a.iapd_url)}" target="_blank" rel="noopener" class="adv-link">IAPD</a>` : ''}
          ${a.pdf_url ? `<a href="${escHtml(a.pdf_url)}" target="_blank" rel="noopener" class="adv-link">PDF</a>` : ''}
          ${a.brochure_id ? `<a href="https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=${a.brochure_id}" target="_blank" rel="noopener" class="adv-link">Brochure</a>` : ''}
        </div>
      </div>
    `;
    container.appendChild(card);
  }
}

async function triggerAdvCrawl() {
  const btn = document.getElementById('btnAdvCrawl');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning IAPD...';

  try {
    const res = await apiFetch('/api/adv/crawl', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.analyzed} found)`;
    setTimeout(() => { btn.textContent = 'Scan IAPD'; btn.disabled = false; }, 3000);
    loadAdvAnalyses();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Scan IAPD'; btn.disabled = false; }, 3000);
  }
}

// ── Trends ──────────────────────────────────────────────
function populateTrendEntitySelect() {
  const select = document.getElementById('trendEntity');
  if (!select || select.options.length > 1) return;
  for (const e of entities.all || []) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    select.appendChild(opt);
  }
}

async function loadTrends(autoCapture) {
  const metric = document.getElementById('trendMetric').value;
  const entity = document.getElementById('trendEntity').value;
  const chartEl = document.getElementById('trendsChart');

  try {
    // First check if ANY trend data exists (unfiltered)
    const checkRes = await apiFetch('/api/trends');
    const allSnapshots = await checkRes.json();

    // Auto-capture on first visit if store is completely empty
    if ((!allSnapshots || allSnapshots.length === 0) && !autoCapture) {
      chartEl.innerHTML = '<div class="v2-empty"><span class="spinner"></span> No trend data found — capturing first snapshot...</div>';
      try {
        await apiFetch('/api/trends', { method: 'POST' });
        return loadTrends(true);
      } catch (e) {
        console.error('Auto-capture failed:', e);
        chartEl.innerHTML = '<div class="v2-empty">Failed to capture initial snapshot. Try clicking "Capture Snapshot" manually.</div>';
        return;
      }
    }

    // Now fetch with user's filters
    const params = new URLSearchParams();
    if (metric) params.set('metric', metric);
    if (entity) params.set('entity', entity);
    const res = await apiFetch(`/api/trends?${params}`);
    const snapshots = await res.json();

    // If filtered results are empty but unfiltered has data, show helpful message
    if ((!snapshots || snapshots.length === 0) && allSnapshots && allSnapshots.length > 0) {
      const availableTypes = [...new Set(allSnapshots.map(function(s) { return s.metric_type; }))];
      chartEl.innerHTML = '<div class="v2-empty">No data for this metric/entity filter. Available metrics: ' + availableTypes.join(', ') + '</div>';
      document.getElementById('trendsTable').innerHTML = '';
      return;
    }

    renderTrends(snapshots, metric);
  } catch (err) {
    console.error('Failed to load trends:', err);
    chartEl.innerHTML = '<div class="v2-empty">Failed to load trend data.</div>';
  }
}

function renderTrends(snapshots, metric) {
  const chartEl = document.getElementById('trendsChart');
  const tableEl = document.getElementById('trendsTable');
  const explainerEl = document.getElementById('trendsExplainer');

  // Metric explanations
  var explanations = {
    '': '<strong>All Metrics</strong> — Showing every tracked data point across all entities. Use the filters above to narrow by metric type or entity. Each snapshot captures a point-in-time measurement that, over successive captures, reveals performance trends.',
    'aum': '<strong>Assets Under Management (AUM)</strong> — Total assets each firm manages or advises on, measured in billions of dollars. Rising AUM indicates organic growth or market appreciation; declining AUM may signal client attrition or market losses.',
    'sentiment': '<strong>Sentiment Score</strong> — Ranges from −1.0 (very negative) to +1.0 (very positive), computed from recent news article analysis. A sustained drop may indicate reputational risk or adverse press coverage for a competitor.',
    'article_count': '<strong>Article Count</strong> — Number of news articles published about each entity in the snapshot period. Spikes often correspond to major announcements, regulatory actions, or market events.',
  };
  if (explainerEl) {
    explainerEl.innerHTML = '<div class="trend-explainer-box">' + (explanations[metric || ''] || explanations['']) + ' <em>Click any bar or legend item to filter by that entity.</em></div>';
  }

  if (!snapshots || snapshots.length === 0) {
    chartEl.innerHTML = '<div class="v2-empty">No trend data yet. Click "Capture Snapshot" to start tracking.</div>';
    tableEl.innerHTML = '';
    return;
  }

  // Group by entity
  const byEntity = {};
  for (const s of snapshots) {
    const key = s.entity_name + (s.metric_type ? ' (' + s.metric_type + ')' : '');
    if (!byEntity[key]) byEntity[key] = [];
    byEntity[key].push(s);
  }

  const allDates = [...new Set(snapshots.map(s => s.date))].sort();
  const colors = ['#4a6cf7', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316'];
  const entityKeys = Object.keys(byEntity);

  if (allDates.length <= 1) {
    // ── BAR CHART for single-date snapshot ──
    const maxVal = Math.max(...snapshots.map(s => Math.abs(Number(s.value) || 0)), 0.01);
    let barsHtml = '';
    entityKeys.forEach(function(key, i) {
      const pts = byEntity[key];
      const val = Number(pts[0].value) || 0;
      const pct = Math.max((Math.abs(val) / maxVal) * 100, 3);
      const color = colors[i % colors.length];
      const entityId = pts[0].entity_id || '';
      const metricType = pts[0].metric_type || '';
      var valLabel = metricType === 'aum' ? '$' + val.toFixed(1) + 'B' : metricType === 'sentiment' ? val.toFixed(2) + ' score' : metricType === 'article_count' ? Math.round(val) + ' articles' : val.toFixed(2);
      barsHtml += '<div class="trend-bar-row trend-bar-clickable" style="animation-delay:' + (i * 0.04) + 's" onclick="filterTrendByEntity(\'' + escHtml(entityId) + '\')" title="Click to filter by this entity">';
      barsHtml += '<span class="trend-bar-label">' + escHtml(key) + '</span>';
      barsHtml += '<div class="trend-bar-track"><div class="trend-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      barsHtml += '<span class="trend-bar-value">' + valLabel + '</span>';
      barsHtml += '</div>';
    });
    chartEl.innerHTML = '<div class="brief-card" style="padding:20px;margin-bottom:14px;">' +
      '<div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Snapshot: ' + escHtml(allDates[0] || 'Today') + ' · Click a bar to filter by entity · Capture more snapshots to see trend lines</div>' +
      barsHtml + '</div>';
  } else {
    // ── LINE CHART for multi-date data ──
    const w = 800, h = 300, pad = 50;
    const allValues = snapshots.map(s => Number(s.value) || 0);
    const minV = Math.min(...allValues);
    const maxV = Math.max(...allValues);
    const range = maxV - minV || 1;

    let svgLines = '';
    let legendHtml = '';
    let colorIdx = 0;

    for (const [name, pts] of Object.entries(byEntity)) {
      const sorted = pts.sort((a, b) => a.date.localeCompare(b.date));
      const color = colors[colorIdx % colors.length];
      const entityId = sorted[0].entity_id || '';
      const coords = sorted.map(p => {
        const x = pad + (allDates.indexOf(p.date) / Math.max(allDates.length - 1, 1)) * (w - 2 * pad);
        const y = pad + (1 - ((Number(p.value) || 0) - minV) / range) * (h - 2 * pad);
        return { x: x, y: y, date: p.date, value: Number(p.value) || 0 };
      });
      if (coords.length > 1) {
        svgLines += `<polyline points="${coords.map(c => c.x + ',' + c.y).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
      }
      coords.forEach(function(c) {
        svgLines += `<circle cx="${c.x}" cy="${c.y}" r="5" fill="${color}" stroke="var(--surface)" stroke-width="2" style="cursor:pointer" onclick="filterTrendByEntity('${escHtml(entityId)}')" onmouseover="showTrendTip(evt, '${escHtml(name)}', '${c.date}', ${c.value})" onmouseout="hideTrendTip()"><title>${escHtml(name)}: ${c.value.toFixed(2)} on ${c.date}</title></circle>`;
      });
      legendHtml += `<span class="trend-legend-item trend-legend-clickable" onclick="filterTrendByEntity('${escHtml(entityId)}')" title="Click to filter by this entity"><span class="trend-legend-dot" style="background:${color}"></span>${escHtml(name)}</span>`;
      colorIdx++;
    }

    const yLabels = [minV, minV + range / 2, maxV].map(v => {
      const y = pad + (1 - (v - minV) / range) * (h - 2 * pad);
      return `<text x="${pad - 8}" y="${y + 4}" text-anchor="end" fill="var(--text-muted)" font-size="11">${v.toFixed(1)}</text>`;
    }).join('');

    const step = Math.max(1, Math.floor(allDates.length / 6));
    const xLabels = allDates.filter((_, i) => i % step === 0).map(d => {
      const x = pad + (allDates.indexOf(d) / Math.max(allDates.length - 1, 1)) * (w - 2 * pad);
      return `<text x="${x}" y="${h - 5}" text-anchor="middle" fill="var(--text-muted)" font-size="10">${d.substring(5)}</text>`;
    }).join('');

    chartEl.innerHTML = `
      <div class="brief-card" style="padding:20px; margin-bottom:14px;">
        <div class="trend-legend" style="margin-bottom:12px;">${legendHtml}</div>
        <div style="position:relative">
          <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" class="trend-svg">
            <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="var(--border)" stroke-width="1"/>
            <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border)" stroke-width="1"/>
            ${yLabels}${xLabels}${svgLines}
          </svg>
          <div id="trendTip" class="trend-tooltip" style="display:none"></div>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;text-align:center">Click a data point or legend item to filter by entity</div>
      </div>
    `;
  }

  // Table with clickable entity names
  const metricLabel = metric === 'aum' ? 'AUM ($B)' : metric === 'sentiment' ? 'Score' : metric === 'article_count' ? 'Count' : 'Value';
  const showMetricCol = !metric; // Show metric type column when "All Metrics" selected
  tableEl.innerHTML = `
    <div class="v2-table-card">
    <table class="v2-table">
      <thead><tr><th>Date</th><th>Entity</th>${showMetricCol ? '<th>Metric</th>' : ''}<th>${metricLabel}</th></tr></thead>
      <tbody>${snapshots.slice(-50).reverse().map(s => {
        var valDisplay = metric === 'aum' ? '$' + (Number(s.value) || 0).toFixed(1) + 'B' : (Number(s.value) || 0).toFixed(2);
        return `<tr><td>${s.date || ''}</td><td><a href="#" class="trend-entity-link" onclick="filterTrendByEntity('${escHtml(s.entity_id || '')}');return false">${escHtml(s.entity_name || '')}</a></td>${showMetricCol ? '<td><span class="trend-metric-tag">' + escHtml(s.metric_type || '') + '</span></td>' : ''}<td class="num">${valDisplay}</td></tr>`;
      }).join('')}</tbody>
    </table>
    </div>
  `;
}

async function triggerTrendCapture() {
  const btn = document.getElementById('btnTrendCapture');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Capturing...';

  try {
    const res = await apiFetch('/api/trends', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.snapshots || 0} snapshots)`;
    setTimeout(() => { btn.textContent = 'Capture Snapshot'; btn.disabled = false; }, 3000);
    loadTrends();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Capture Snapshot'; btn.disabled = false; }, 3000);
  }
}

// ── Trend helpers: click & tooltip ──
function filterTrendByEntity(entityId) {
  if (!entityId) return;
  var sel = document.getElementById('trendEntity');
  if (!sel) return;
  // Find the option matching this entity
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === entityId) {
      sel.value = entityId;
      loadTrends();
      return;
    }
  }
  // If entity not in dropdown, it may not be populated yet — still try
  sel.value = entityId;
  loadTrends();
}

function showTrendTip(evt, name, date, value) {
  var tip = document.getElementById('trendTip');
  if (!tip) return;
  tip.innerHTML = '<strong>' + escHtml(name) + '</strong><br>' + date + '<br>' + value.toFixed(2);
  tip.style.display = 'block';
  var rect = evt.target.closest('.brief-card').getBoundingClientRect();
  var cx = evt.clientX - rect.left;
  var cy = evt.clientY - rect.top;
  tip.style.left = (cx + 12) + 'px';
  tip.style.top = (cy - 10) + 'px';
}

function hideTrendTip() {
  var tip = document.getElementById('trendTip');
  if (tip) tip.style.display = 'none';
}

// ── Personnel ───────────────────────────────────────────
async function loadPersonnel() {
  const type = document.getElementById('filterPersonnelType').value;
  const params = new URLSearchParams();
  if (type !== 'all') params.set('type', type);

  try {
    const res = await apiFetch(`/api/personnel?${params}`);
    const changes = await res.json();
    renderPersonnel(changes);
  } catch (err) {
    console.error('Failed to load personnel:', err);
  }
}

function renderPersonnel(changes) {
  const container = document.getElementById('personnelList');
  if (!changes || changes.length === 0) {
    container.innerHTML = '<div class="v2-empty">No personnel changes found. Click "Scan for Changes" to monitor leadership moves.</div>';
    return;
  }

  // KPI strip
  const hires = changes.filter(p => (p.change_type || '') === 'hire').length;
  const departures = changes.filter(p => (p.change_type || '') === 'departure').length;
  const promotions = changes.filter(p => (p.change_type || '') === 'promotion').length;
  const board = changes.filter(p => (p.change_type || '') === 'board_change').length;
  const kpiHtml = `<div class="v2-kpi-strip">
    <div class="kpi-card"><div class="kpi-value">${changes.length}</div><div class="kpi-label">Total Changes</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--positive)">${hires}</div><div class="kpi-label">Hires</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--negative)">${departures}</div><div class="kpi-label">Departures</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--primary)">${promotions}</div><div class="kpi-label">Promotions</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:#8b5cf6">${board}</div><div class="kpi-label">Board Changes</div></div>
  </div>`;

  container.innerHTML = kpiHtml;
  for (const p of changes) {
    const card = document.createElement('div');
    const ct = p.change_type || 'unknown';
    const typeClass = ct === 'departure' ? 'negative' : ct === 'hire' ? 'positive' : 'neutral';
    card.className = `personnel-card personnel-${typeClass}`;
    card.innerHTML = `
      <div class="personnel-header">
        <span class="personnel-type type-${ct}">${ct.toUpperCase()}</span>
        <span class="personnel-date">${p.date || ''}</span>
      </div>
      <div class="personnel-name">${escHtml(p.person_name || 'Unknown')}</div>
      <div class="personnel-entity">${escHtml(p.entity_name || '')}</div>
      <div class="personnel-roles">
        ${p.old_role ? `<span class="personnel-old-role">${escHtml(p.old_role)}</span>` : ''}
        ${p.old_role && p.new_role ? ' &rarr; ' : ''}
        ${p.new_role ? `<span class="personnel-new-role">${escHtml(p.new_role)}</span>` : ''}
      </div>
      <div class="personnel-details">${escHtml(p.details || '').substring(0, 200)}</div>
      ${p.source_url ? `<a href="${escHtml(p.source_url)}" target="_blank" rel="noopener" class="read-more">Source &#8594;</a>` : ''}
    `;
    container.appendChild(card);
  }
}

async function triggerPersonnelCrawl() {
  const btn = document.getElementById('btnPersonnelCrawl');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';

  try {
    const res = await apiFetch('/api/personnel/crawl', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.found} found)`;
    setTimeout(() => { btn.textContent = 'Scan for Changes'; btn.disabled = false; }, 3000);
    loadPersonnel();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Scan for Changes'; btn.disabled = false; }, 3000);
  }
}


// ── Jobs ────────────────────────────────────────────────
var _allJobPostings = []; // stored for entity filtering
var _jobEntityFilter = ''; // current entity filter

async function loadJobs() {
  try {
    const [postsRes, trendsRes] = await Promise.all([
      apiFetch('/api/jobs'),
      apiFetch('/api/jobs?view=trends'),
    ]);
    const postings = await postsRes.json();
    const trends = await trendsRes.json();
    _allJobPostings = postings || [];
    renderJobTrends(trends);
    renderJobPostings(_allJobPostings, _jobEntityFilter);
  } catch (err) {
    console.error('Failed to load jobs:', err);
  }
}

function filterJobsByEntity(entityName) {
  _jobEntityFilter = (_jobEntityFilter === entityName) ? '' : entityName; // toggle
  renderJobPostings(_allJobPostings, _jobEntityFilter);
  // Scroll to postings table
  var el = document.getElementById('jobPostings');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Highlight active trend row
  document.querySelectorAll('.job-trend-row').forEach(function(row) {
    row.classList.remove('job-trend-active');
    if (_jobEntityFilter && row.dataset.entity === _jobEntityFilter) {
      row.classList.add('job-trend-active');
    }
  });
}

function renderJobTrends(trends) {
  const container = document.getElementById('jobTrends');
  if (!trends || trends.length === 0) {
    container.innerHTML = '';
    return;
  }

  const sorted = [...trends].sort((a, b) => (b.total_postings || 0) - (a.total_postings || 0));
  const maxPost = (sorted[0] && sorted[0].total_postings) || 1;
  const totalPostings = sorted.reduce((s, t) => s + (t.total_postings || 0), 0);

  container.innerHTML = `
    <div class="v2-kpi-strip">
      <div class="kpi-card"><div class="kpi-value">${totalPostings}</div><div class="kpi-label">Total Postings</div></div>
      <div class="kpi-card"><div class="kpi-value">${sorted.length}</div><div class="kpi-label">Entities Hiring</div></div>
      <div class="kpi-card"><div class="kpi-value">${sorted[0]?.entity_name || '-'}</div><div class="kpi-label" style="font-size:9px">Top Hirer</div></div>
    </div>
    <h3 style="margin-bottom:4px;">Hiring Trends by Entity</h3>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Click an entity to filter the postings table below</div>
    <div class="job-trends-grid">
      ${sorted.map(t => {
        const pct = Math.max((t.total_postings / maxPost) * 100, 3);
        const depts = Object.entries(t.by_department || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const isActive = _jobEntityFilter === t.entity_name;
        return `
          <div class="job-trend-row job-trend-clickable${isActive ? ' job-trend-active' : ''}" data-entity="${escHtml(t.entity_name)}" onclick="filterJobsByEntity('${escHtml(t.entity_name).replace(/'/g, "\\'")}')" title="Click to filter postings for ${escHtml(t.entity_name)}">
            <div class="job-trend-label">
              <span class="job-trend-name">${escHtml(t.entity_name)}</span>
              <span class="job-trend-count">${t.total_postings} postings</span>
            </div>
            <div class="aum-bar-track"><div class="aum-bar-fill" style="width:${pct}%"></div></div>
            <div class="job-trend-depts">${depts.map(([d, c]) => `<span class="job-dept-pill">${escHtml(d)}: ${c}</span>`).join('')}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderJobPostings(postings, entityFilter) {
  const container = document.getElementById('jobPostings');
  if (!postings || postings.length === 0) {
    container.innerHTML = '<div class="v2-empty">No job postings found. Click "Scan Job Postings" to crawl.</div>';
    return;
  }

  var filtered = entityFilter ? postings.filter(function(j) { return j.entity_name === entityFilter; }) : postings;
  var filterNote = entityFilter ? '<div class="job-filter-active">Showing <strong>' + filtered.length + '</strong> postings for <strong>' + escHtml(entityFilter) + '</strong> <a href="#" onclick="filterJobsByEntity(\'\');return false" style="color:var(--primary);margin-left:8px">× Clear filter</a></div>' : '';

  container.innerHTML = `
    <h3 style="margin:16px 0 12px;">Recent Postings</h3>
    ${filterNote}
    <div class="v2-table-card">
    <table class="v2-table">
      <thead><tr><th>Date</th><th>Entity</th><th>Title</th><th>Department</th><th>Seniority</th><th>Location</th></tr></thead>
      <tbody>${filtered.slice(0, 100).map(j => `
        <tr>
          <td>${j.posted_date || ''}</td>
          <td>${escHtml(j.entity_name || '')}</td>
          <td>${j.url ? `<a href="${escHtml(j.url)}" target="_blank" rel="noopener">${escHtml(j.title || 'Untitled')}</a>` : escHtml(j.title || 'Untitled')}</td>
          <td>${escHtml(j.department || '')}</td>
          <td><span class="seniority-badge seniority-${j.seniority || 'unknown'}">${j.seniority || '-'}</span></td>
          <td>${escHtml(j.location || '')}</td>
        </tr>
      `).join('')}</tbody>
    </table>
    </div>
  `;
}

async function triggerJobsCrawl() {
  const btn = document.getElementById('btnJobsCrawl');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';

  try {
    const res = await apiFetch('/api/jobs/crawl', { method: 'POST' });
    const data = await res.json();
    btn.textContent = `Done! (${data.found} found)`;
    setTimeout(() => { btn.textContent = 'Scan Job Postings'; btn.disabled = false; }, 3000);
    loadJobs();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Scan Job Postings'; btn.disabled = false; }, 3000);
  }
}

// ── Export ───────────────────────────────────────────────
async function downloadExport(type, format) {
  try {
    const res = await apiFetch(`/api/export?type=${type}&format=${format || 'csv'}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = format === 'json' ? 'json' : 'csv';
    a.download = `${type}-export.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed:', err);
    alert('Export failed. Please try again.');
  }
}

// ── AI Summarize ────────────────────────────────────────
async function aiSummarize(filingId, docUrl, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const res = await apiFetch('/api/ai/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filing_id: filingId, document_url: docUrl }),
    });
    const summary = await res.json();
    btn.textContent = 'View Summary';
    btn.onclick = () => showAiSummary(summary);
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'AI Summary'; btn.disabled = false; }, 3000);
  }
}

function showAiSummary(summary) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>AI Filing Summary</h3>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="ai-summary-text">${escHtml(summary.summary)}</div>
        ${summary.key_risks.length > 0 ? `
          <h4>Key Risks</h4>
          <ul>${summary.key_risks.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>
        ` : ''}
        ${summary.action_items.length > 0 ? `
          <h4>Action Items</h4>
          <ul>${summary.action_items.map(a => `<li>${escHtml(a)}</li>`).join('')}</ul>
        ` : ''}
        ${summary.cost_implications ? `<h4>Cost Implications</h4><p>${escHtml(summary.cost_implications)}</p>` : ''}
        <div class="ai-summary-meta">Generated: ${formatDateTime(summary.generated_at)}</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── FINRA Alerts ─────────────────────────────────────────

async function loadFinraAlerts() {
  try {
    const res = await apiFetch('/api/finra');
    const alerts = await res.json();
    renderFinraAlerts(alerts);
  } catch (err) {
    console.error('Failed to load FINRA alerts:', err);
  }
}

function renderFinraAlerts(alerts) {
  const el = document.getElementById('finraAlertsList');
  if (!alerts || alerts.length === 0) {
    el.innerHTML = '<div class="v2-empty">No FINRA alerts found. Click "Scan FINRA" to check.</div>';
    return;
  }

  // KPI strip
  const critical = alerts.filter(a => a.severity === 'critical').length;
  const high = alerts.filter(a => a.severity === 'high').length;
  const medium = alerts.filter(a => a.severity === 'medium' || a.severity === 'low').length;
  el.innerHTML = `<div class="v2-kpi-strip">
    <div class="kpi-card"><div class="kpi-value">${alerts.length}</div><div class="kpi-label">Total Alerts</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--negative)">${critical}</div><div class="kpi-label">Critical</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--gold)">${high}</div><div class="kpi-label">High</div></div>
    <div class="kpi-card"><div class="kpi-value" style="color:var(--text-muted)">${medium}</div><div class="kpi-label">Medium/Low</div></div>
  </div>` + alerts.slice(0, 50).map(a => `
    <div class="finra-alert finra-${a.severity}">
      <div class="finra-alert-header">
        <span class="finra-badge badge-${a.severity}">${a.severity.toUpperCase()}</span>
        <span class="finra-firm">${escHtml(a.firm_name)}</span>
        <span class="finra-date">${a.date}</span>
      </div>
      <div class="finra-type">${escHtml(a.action_type)}</div>
      <div class="finra-summary">${escHtml(a.summary).substring(0, 200)}${a.summary.length > 200 ? '...' : ''}</div>
      <a href="${a.source_url}" target="_blank" class="finra-link">View on BrokerCheck</a>
    </div>
  `).join('');
}

async function triggerFinraCrawl() {
  try {
    await apiFetch('/api/finra/crawl', { method: 'POST' });
    loadFinraAlerts();
  } catch (err) {
    console.error('FINRA crawl failed:', err);
  }
}

// ── Social Media Feed ──────────────────────────────────
let socialOffset = 0;
const SOCIAL_LIMIT = 50;
let socialSearchTimer = null;

function debounceSocialSearch() {
  clearTimeout(socialSearchTimer);
  socialSearchTimer = setTimeout(() => { socialOffset = 0; loadSocialFeed(); }, 400);
}

async function loadSocialFeed() {
  const entityFilter = document.getElementById('filterSocialEntity').value;
  const platform = document.getElementById('filterSocialPlatform').value;
  const sentiment = document.getElementById('filterSocialSentiment').value;
  const search = document.getElementById('filterSocialSearch').value;

  try {
    const params = new URLSearchParams({
      entity: entityFilter,
      platform: platform,
      sentiment: sentiment,
      search: search,
      limit: SOCIAL_LIMIT.toString(),
      offset: socialOffset.toString(),
    });
    const res = await apiFetch('/api/social?' + params);
    const data = await res.json();

    // Populate entity filter if not done yet
    var select = document.getElementById('filterSocialEntity');
    if (select.options.length <= 1) {
      entities.all.forEach(function(e) {
        var opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        select.appendChild(opt);
      });
    }

    renderSocialBuzzStrip(data.buzz_summary || []);
    renderSocialPosts(data.posts || [], data.total || 0);

    if (data.updated_at) {
      document.getElementById('socialTimestamp').textContent = 'Updated: ' + new Date(data.updated_at).toLocaleString();
    }
  } catch (err) {
    console.error('Failed to load social feed:', err);
  }
}

function renderSocialBuzzStrip(buzz) {
  var strip = document.getElementById('socialBuzzStrip');
  if (!buzz || buzz.length === 0) {
    strip.innerHTML = '';
    return;
  }

  // Show top entities with mentions
  strip.innerHTML = buzz.slice(0, 12).map(function(b, i) {
    var sentColor = b.sentiment_label === 'positive' ? 'var(--positive)' :
                    b.sentiment_label === 'negative' ? 'var(--negative)' : 'var(--text-muted)';
    var sentIcon = b.sentiment_label === 'positive' ? '&#9650;' :
                   b.sentiment_label === 'negative' ? '&#9660;' : '&#9644;';
    var redditBadge = b.platforms.reddit > 0 ? '<span class="social-platform-badge reddit-badge" title="Reddit mentions">\u{1F4AC} ' + b.platforms.reddit + '</span>' : '';
    var stwBadge = b.platforms.stocktwits > 0 ? '<span class="social-platform-badge stw-badge" title="StockTwits mentions">\u{1F4CA} ' + b.platforms.stocktwits + '</span>' : '';

    return '<div class="social-buzz-card" style="animation-delay:' + (i * 60) + 'ms">' +
      '<div class="social-buzz-name">' + escHtml(b.entity_name) + '</div>' +
      '<div class="social-buzz-count">' + b.mention_count + ' <span class="social-buzz-label">mentions</span></div>' +
      '<div class="social-buzz-sentiment" style="color:' + sentColor + '">' + sentIcon + ' ' + b.sentiment_label + '</div>' +
      '<div class="social-buzz-platforms">' + redditBadge + stwBadge + '</div>' +
    '</div>';
  }).join('');
}

function renderSocialPosts(posts, total) {
  var list = document.getElementById('socialPostsList');
  var btnMore = document.getElementById('btnSocialLoadMore');

  if (!posts || posts.length === 0) {
    list.innerHTML = '<div class="empty">No social media posts found. Click "Scan Social Media" to search Reddit &amp; StockTwits.</div>';
    btnMore.style.display = 'none';
    return;
  }

  var html = posts.map(function(p, i) {
    var sentClass = 'sentiment-' + p.sentiment_label;
    var platformIcon = p.platform === 'reddit' ? '\u{1F4AC}' : '\u{1F4CA}';
    var platformLabel = p.platform === 'reddit' ? 'r/' + (p.subreddit || 'reddit') : 'StockTwits';
    var scoreLabel = p.platform === 'reddit' ? '\u2B06 ' + p.score : '\u2665 ' + p.score;
    var timeAgo = formatTimeAgo(p.posted_at);
    var title = p.title ? '<div class="social-post-title">' + escHtml(p.title) + '</div>' : '';
    var content = p.content ? '<div class="social-post-content">' + escHtml(p.content).substring(0, 300) + (p.content.length > 300 ? '...' : '') + '</div>' : '';

    return '<a href="' + p.url + '" target="_blank" class="social-post-card ' + sentClass + '" style="animation-delay:' + (i * 40) + 'ms">' +
      '<div class="social-post-header">' +
        '<span class="social-post-platform">' + platformIcon + ' ' + platformLabel + '</span>' +
        '<span class="social-post-entity">' + escHtml(p.entity_name) + '</span>' +
        '<span class="social-post-time">' + timeAgo + '</span>' +
      '</div>' +
      title +
      content +
      '<div class="social-post-footer">' +
        '<span class="social-post-author">u/' + escHtml(p.author) + '</span>' +
        '<span class="social-post-score">' + scoreLabel + '</span>' +
        '<span class="social-post-comments">\u{1F4AC} ' + p.comments + '</span>' +
        '<span class="social-post-sentiment ' + sentClass + '">' + p.sentiment_label + '</span>' +
      '</div>' +
    '</a>';
  }).join('');

  if (socialOffset === 0) {
    list.innerHTML = html;
  } else {
    list.innerHTML += html;
  }

  btnMore.style.display = (socialOffset + SOCIAL_LIMIT < total) ? 'inline-block' : 'none';
}

function loadMoreSocial() {
  socialOffset += SOCIAL_LIMIT;
  loadSocialFeed();
}

function formatTimeAgo(dateStr) {
  var now = new Date();
  var d = new Date(dateStr);
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString();
}

async function triggerSocialCrawl() {
  var btn = document.getElementById('btnSocialCrawl');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';

  try {
    var res = await apiFetch('/api/social/crawl', { method: 'POST' });
    var data = await res.json();
    btn.textContent = 'Done! (' + (data.posts_found || 0) + ' posts)';
    setTimeout(function() { btn.textContent = 'Scan Social Media'; btn.disabled = false; }, 3000);
    loadSocialFeed();
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(function() { btn.textContent = 'Scan Social Media'; btn.disabled = false; }, 3000);
  }
}
