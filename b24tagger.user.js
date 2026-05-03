// ==UserScript==
// @name         B24 Tagger BETA
// @namespace    https://brand24.com
// @version      0.23.80
// @description  Wtyczka do ułatwiania pracy w panelu Brand24
// @author       B24 Tagger
// @match        https://app.brand24.com/*
// @match        https://panel.brand24.pl/*
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js
// @downloadURL  https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect       hooks.slack.com
// @connect       raw.githubusercontent.com
// @connect       cdn.jsdelivr.net
// @connect       *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ── NEWS DATE RELAY: gdy skrypt odpala się na stronie artykułu (nie Brand24) ──
  // Czyta datę z DOM i odsyła przez postMessage do Brand24 (window.opener)
  var _isB24 = /brand24\.com|panel\.brand24\.pl/.test(location.hostname);
  if (!_isB24 && window.name === '_b24tnews' && window.opener) {
    (function() {
      function _extractDate() {
        var patterns = [
          // JSON-LD datePublished / dateCreated
          function() {
            var scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (var i = 0; i < scripts.length; i++) {
              try {
                var data = JSON.parse(scripts[i].textContent);
                var graphs = data['@graph'] || [data];
                for (var j = 0; j < graphs.length; j++) {
                  var d = graphs[j].datePublished || graphs[j].dateCreated;
                  if (d) return d.substring(0, 10);
                }
              } catch(e) {}
            }
            return null;
          },
          // meta article:published_time
          function() {
            var el = document.querySelector('meta[property="article:published_time"]');
            return el ? (el.getAttribute('content') || '').substring(0, 10) : null;
          },
          // meta name=date lub name=pubdate
          function() {
            var el = document.querySelector('meta[name="date"], meta[name="pubdate"], meta[name="publication_date"]');
            return el ? (el.getAttribute('content') || '').substring(0, 10) : null;
          },
          // itemprop=datePublished
          function() {
            var el = document.querySelector('[itemprop="datePublished"]');
            if (!el) return null;
            return (el.getAttribute('datetime') || el.getAttribute('content') || el.textContent || '').substring(0, 10);
          },
          // <time datetime=...>
          function() {
            var el = document.querySelector('time[datetime]');
            return el ? (el.getAttribute('datetime') || '').substring(0, 10) : null;
          },
          // data-date attributes
          function() {
            var el = document.querySelector('[data-publish-date],[data-pub-date],[data-created-date],[data-article-date],[data-date]');
            if (!el) return null;
            var attrs = ['data-publish-date','data-pub-date','data-created-date','data-article-date','data-date'];
            for (var i = 0; i < attrs.length; i++) {
              var v = el.getAttribute(attrs[i]);
              if (v) return v.substring(0, 10);
            }
            return null;
          },
        ];
        for (var i = 0; i < patterns.length; i++) {
          try {
            var result = patterns[i]();
            if (result && /^\d{4}-\d{2}-\d{2}$/.test(result) && result > '2000-01-01') return result;
          } catch(e) {}
        }
        return null;
      }

      function _trySend() {
        var date = _extractDate();
        if (date) {
          try { window.opener.postMessage({ type: 'b24t_news_date', date: date, url: location.href }, '*'); } catch(e) {}
          return true;
        }
        return false;
      }

      // Spróbuj natychmiast (DOM może być już gotowy)
      if (!_trySend()) {
        // Poczekaj na DOMContentLoaded
        document.addEventListener('DOMContentLoaded', function() {
          if (!_trySend()) {
            // Ostatnia próba po pełnym load (lazy-loaded schema scripts)
            window.addEventListener('load', function() { _trySend(); });
          }
        });
      }
    })();
    return; // Nie inicjalizuj reszty wtyczki na zewnętrznych stronach
  }


  // ───────────────────────────────────────────
  // CONSTANTS & CONFIG
  // ───────────────────────────────────────────

  const VERSION = '0.23.80';
  const LS = {
    SETUP_DONE:  'b24tagger_setup_done',
    PROJECTS:    'b24tagger_projects',
    SCHEMAS:     'b24tagger_schemas',
    JOBS:        'b24tagger_jobs',
    CRASHLOG:    'b24tagger_crashlog',
    FEATURES:    'b24tagger_features',
    UI_POS:      'b24tagger_ui_pos',
    UI_COLLAPSED:'b24tagger_ui_collapsed',
    PANEL_CORNER:     'b24tagger_panel_corner',
    DELETE_CONFIRMED: 'b24tagger_delete_confirmed',
    DELETE_AUTO:      'b24tagger_delete_auto',
    HISTORY:          'b24tagger_history',
    THEME:            'b24tagger_theme',
    UI_SIZE:          'b24tagger_ui_size',
    UI_ANN_SIZE:      'b24tagger_ann_size',
    GROUPS:           'b24tagger_groups',
    STATS_CFG:        'b24tagger_stats_config',
    PROJECT_NAMES:    'b24tagger_project_names',
    NEWS_KEYWORDS:    'b24tagger_news_keywords',
    NEWS_SESSION_URLS:'b24tagger_news_session_urls',
    NEWS_LANG_MAP:    'b24tagger_news_lang_map',
    NEWS_WIN_SIZE:    'b24tagger_news_win_size',
    WELCOME_SHOWN:    'b24tagger_welcome_shown_v0210',
    UPDATE_CHANNEL:   'b24tagger_update_channel',
    MONTH_CLOSE_DONE: 'b24tagger_month_close_done',
    DEL_BATCH:        'b24tagger_del_batch',
    DEL_BATCH_WARNED: 'b24tagger_del_batch_warned',
    AI_SETTINGS:      'b24t_ai_settings',
    NA_SESSION_STATS:   'b24t_na_session_stats',
    NA_PENDING:         'b24t_na_pending',
    NA_CONSENT:         'b24t_na_consent',
    NA_SETTINGS:        'b24t_na_settings',
  };
  const MAX_BATCH_SIZE = 50;
  const DEL_BATCH_DEFAULT = 25; // domyślny batch równoległych deletów (edytowalny w UI)
  const BASE_PANEL_W = 440; // bazowa szerokość głównego panelu — punkt odniesienia dla zoomu
  let MAP_FETCH_CONCURRENCY = 8; // równoległość pobierania stron w buildUrlMap (fallback: 3)
  const STATS_FETCH_CONCURRENCY = 10; // równoległość pobierania projektów w _fetchOverallStats
  const BG_CONCURRENCY  = 5; // równoległość prefetchu danych annotatorskich w tle
  const QT_CONCURRENCY  = 2; // równoległość batchów w Quick Tag / Quick Untag
  const TAG_CONCURRENCY = 4; // równoległość batchów bulkTag w runTagging
  const HEALTH_CHECK_INTERVAL = 30000;
  const ACTION_TIMEOUT_WARN = 10000;
  const RETRY_DELAYS = [2000, 4000, 8000, 12000, 20000]; // 5 prób — Brand24 API czasem losowo failuje

  // ───────────────────────────────────────────
  // STATE
  // ───────────────────────────────────────────

  const state = {
    status: 'idle',          // idle | running | paused | error | done
    lastMentionsVars: null,  // last organic getMentions variables from Brand24
    matchPreview: null,      // match preview result
    soundEnabled: false,     // play sound on done
    tokenHeaders: null,
    tknB24: null,             // CSRF token for legacy Django endpoints
    projectId: null,
    projectName: null,
    tags: {},                // tagName → tagId
    untaggedId: 1,
    file: null,              // parsed file data
    mapping: {},             // labelName → {tagId, tagName, type}
    urlMap: {},              // normalizedUrl → {id, existingTags}
    partitions: [],
    currentPartitionIdx: 0,
    currentPage: 0,
    totalPages: 0,
    pageSize: 60,
    stats: { tagged: 0, skipped: 0, noMatch: 0, conflicts: 0 },
    failedMentions: [],   // wzmianki które nie mogły być otagowane przez fallback
    skippedRows: [],      // wiersze z pliku pominięte (NO_MATCH, TRUNCATED_URL, NO_MAPPING, NO_ASSESSMENT)
    logs: [],
    sessionStart: null,
    lastActionTime: null,
    testRunMode: false,
    mapMode: 'untagged',     // untagged | full
    conflictMode: 'ignore',  // ask | ignore | overwrite | multitag
    switchViewOnDone: false,
    switchViewTagId: null,
    autoPartition: false,
    partitionLimit: 1000,
    _sniffUiTag: false,
    _netMonitor: null,
  };

  // Batch size dla masowego usuwania — domyślnie DEL_BATCH_DEFAULT, edytowalny przez UI
  let _deleteBatch = DEL_BATCH_DEFAULT;

  // ───────────────────────────────────────────
  // LOCAL STORAGE HELPERS
  // ───────────────────────────────────────────

  const lsGet = (key, fallback = null) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };
  const lsSet = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  };

  // ── AI SETTINGS HELPERS ────────────────────────────────────────────────────

  var _aiEditingPromptId = null;

  function _aiDefaultSettings() {
    return {
      apiKey: '', prompts: [],
      tagging: { model: 'claude-haiku-4-5-20251001', activePromptId: null, batchSize: 10, firstUseWarningShown: false },
      news: { model: 'claude-haiku-4-5-20251001', enabled: false }
    };
  }
  function _aiGetSettings() {
    var s = lsGet(LS.AI_SETTINGS, _aiDefaultSettings());
    if (!s.news) s.news = {};
    if (!s.tagging) s.tagging = {};
    if (!s.news.model) s.news.model = s.model || 'claude-haiku-4-5-20251001';
    if (!s.tagging.model) s.tagging.model = s.model || 'claude-haiku-4-5-20251001';
    if (!s.prompts) s.prompts = [];
    return s;
  }
  function _aiSaveSettings(s) { lsSet(LS.AI_SETTINGS, s); }
  function _aiUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function _aiRenderPromptList() {
    var list = document.getElementById('b24t-ai-prompt-list');
    if (!list) return;
    var s = _aiGetSettings();
    if (!s.prompts.length) {
      list.innerHTML = '<div style="font-size:10px;color:#999;padding:4px 0;">Brak promptów — dodaj pierwszy.</div>';
      return;
    }
    function esc(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    list.innerHTML = s.prompts.map(function(p) {
      var isActive = s.tagging.activePromptId === p.id;
      return '<div style="display:flex;align-items:center;gap:4px;padding:5px 8px;background:#f5f5f5;border:1px solid #e0e0e0;border-radius:7px;">' +
        '<span style="flex:1;font-size:12px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
        '<button data-ai-set="' + esc(p.id) + '" style="font-size:10px;padding:2px 7px;background:transparent;border:1px solid #ccc;border-radius:5px;cursor:pointer;' + (isActive ? 'color:#6366f1;font-weight:700;border-color:#6366f1;' : 'color:#666;') + '">' + (isActive ? '● Aktywny' : 'Ustaw') + '</button>' +
        '<button data-ai-edit="' + esc(p.id) + '" style="font-size:11px;padding:2px 7px;background:transparent;border:1px solid #ccc;color:#555;border-radius:5px;cursor:pointer;">✎</button>' +
        '<button data-ai-del="' + esc(p.id) + '" style="font-size:11px;padding:2px 7px;background:transparent;border:1px solid #fca5a5;color:#ef4444;border-radius:5px;cursor:pointer;">✕</button>' +
        '</div>';
    }).join('');
  }

  function _showPromptLibraryModal() {
    if (document.getElementById('b24t-prompt-lib-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'b24t-prompt-lib-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;backdrop-filter:blur(4px);animation:b24t-fadein 0.2s ease;';
    modal.innerHTML =
      '<div style="background:#fff;border:1px solid #e0e0e0;border-radius:16px;width:480px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,0.22);animation:b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:14px 20px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:16px 16px 0 0;display:flex;align-items:center;gap:10px;flex-shrink:0;">' +
          '<span style="font-size:18px;">📚</span>' +
          '<div style="flex:1;">' +
            '<div style="font-size:13px;font-weight:700;color:#fff;">Biblioteka promptów</div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.7);margin-top:2px;">Zarządzaj promptami systemowymi dla AI</div>' +
          '</div>' +
          '<button id="b24t-prompt-lib-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:2px 8px;border-radius:5px;">✕</button>' +
        '</div>' +
        '<div style="overflow-y:auto;flex:1;padding:16px 20px;">' +
          '<div id="b24t-ai-prompt-list" style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px;"></div>' +
          '<button id="b24t-ai-add-prompt" style="width:100%;font-size:12px;padding:7px 0;background:transparent;border:1px dashed #bbb;color:#666;border-radius:8px;cursor:pointer;font-family:inherit;">+ Dodaj nowy prompt</button>' +
          '<div id="b24t-ai-prompt-editor" style="display:none;margin-top:12px;padding:12px;background:#f7f7f7;border:1px solid #e0e0e0;border-radius:10px;">' +
            '<input type="text" id="b24t-ai-prompt-name" placeholder="Nazwa (np. InditexGroup TR)" style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#333;font-size:12px;margin-bottom:7px;">' +
            '<textarea id="b24t-ai-prompt-body" rows="5" placeholder="Treść system promptu..." style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#333;font-size:11px;resize:vertical;font-family:monospace;"></textarea>' +
            '<div style="display:flex;gap:6px;margin-top:8px;">' +
              '<button id="b24t-ai-prompt-save" style="flex:1;font-size:12px;padding:6px 0;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:7px;cursor:pointer;font-family:inherit;font-weight:600;">Zapisz</button>' +
              '<button id="b24t-ai-prompt-cancel" style="flex:1;font-size:12px;padding:6px 0;background:transparent;border:1px solid #ddd;color:#666;border-radius:7px;cursor:pointer;font-family:inherit;">Anuluj</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    _aiRenderPromptList();

    function closeLib() { modal.remove(); }
    document.getElementById('b24t-prompt-lib-close').addEventListener('click', closeLib);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeLib(); });

    var promptEditor = document.getElementById('b24t-ai-prompt-editor');
    var promptNameInput = document.getElementById('b24t-ai-prompt-name');
    var promptBodyInput = document.getElementById('b24t-ai-prompt-body');

    function openEditor(id) {
      _aiEditingPromptId = id || null;
      if (id) {
        var cfg = _aiGetSettings();
        var p = cfg.prompts.find(function(x) { return x.id === id; });
        if (p) {
          if (promptNameInput) promptNameInput.value = p.name;
          if (promptBodyInput) promptBodyInput.value = p.system;
        }
      } else {
        if (promptNameInput) promptNameInput.value = '';
        if (promptBodyInput) promptBodyInput.value = '';
      }
      if (promptEditor) promptEditor.style.display = '';
    }

    document.getElementById('b24t-ai-add-prompt').addEventListener('click', function() { openEditor(null); });

    document.getElementById('b24t-ai-prompt-save').addEventListener('click', function() {
      var name = (promptNameInput && promptNameInput.value.trim()) || '';
      var system = (promptBodyInput && promptBodyInput.value.trim()) || '';
      if (!name || !system) return;
      var cfg = _aiGetSettings();
      if (_aiEditingPromptId) {
        var p = cfg.prompts.find(function(x) { return x.id === _aiEditingPromptId; });
        if (p) { p.name = name; p.system = system; }
      } else {
        cfg.prompts.push({ id: _aiUuid(), name: name, system: system, createdAt: new Date().toISOString(), knownAssessments: [], tagMap: {} });
      }
      _aiSaveSettings(cfg);
      _aiEditingPromptId = null;
      if (promptEditor) promptEditor.style.display = 'none';
      _aiRenderPromptList();
    });

    document.getElementById('b24t-ai-prompt-cancel').addEventListener('click', function() {
      _aiEditingPromptId = null;
      if (promptEditor) promptEditor.style.display = 'none';
    });

    document.getElementById('b24t-ai-prompt-list').addEventListener('click', function(e) {
      var setBtn = e.target.closest('[data-ai-set]');
      var editBtn = e.target.closest('[data-ai-edit]');
      var delBtn = e.target.closest('[data-ai-del]');
      var cfg = _aiGetSettings();
      if (setBtn) {
        if (!cfg.tagging) cfg.tagging = {};
        cfg.tagging.activePromptId = setBtn.dataset.aiSet;
        _aiSaveSettings(cfg); _aiRenderPromptList();
      } else if (editBtn) {
        openEditor(editBtn.dataset.aiEdit);
      } else if (delBtn) {
        cfg.prompts = cfg.prompts.filter(function(p) { return p.id !== delBtn.dataset.aiDel; });
        if (cfg.tagging && cfg.tagging.activePromptId === delBtn.dataset.aiDel) cfg.tagging.activePromptId = null;
        _aiSaveSettings(cfg); _aiRenderPromptList();
      }
    });
  }

  // ── PROJECT NAME RESOLVER ──────────────────────────────────────────────────
  // Trwały słownik {projectId: "Nazwa"} niezależny od struktury LS.PROJECTS.
  // Zapisywany TYLKO gdy mamy pewną nazwę (nie fallback "Project XXXXXXX").
  // Priorytet przy odczycie nazwy: PROJECT_NAMES > LS.PROJECTS.name > state > fallback

  function _pnGet(projectId) {
    var names = lsGet(LS.PROJECT_NAMES, {});
    return names[String(projectId)] || null;
  }

  function _pnSet(projectId, name) {
    if (!projectId || !name) return;
    // Nie zapisuj fallbackowych nazw
    var isFallback = !name || name === 'Brand24' || name === 'Panel Brand24' ||
                     /^Project\s+\d+$/.test(name) || /^Projekt\s+\d+$/.test(name) ||
                     name.length < 3;
    if (isFallback) return;
    var names = lsGet(LS.PROJECT_NAMES, {});
    if (names[String(projectId)] === name) return; // bez zmian
    names[String(projectId)] = name;
    lsSet(LS.PROJECT_NAMES, names);
  }

  function _pnResolve(projectId) {
    // 1. Trwały cache nazw
    var cached = _pnGet(projectId);
    if (cached) return cached;
    // 2. Aktualny state (jeśli to bieżący projekt)
    if (state.projectId === parseInt(projectId) && state.projectName &&
        !/^Project\s+\d+$/.test(state.projectName) && !/^Projekt\s+\d+$/.test(state.projectName)) {
      return state.projectName;
    }
    // 3. LS.PROJECTS.name
    var projects = lsGet(LS.PROJECTS, {});
    var pData = projects[String(projectId)];
    var lsName = pData && typeof pData === 'object' ? pData.name : null;
    if (lsName && lsName !== 'Brand24' && lsName !== 'Panel Brand24' &&
        !/^Project\s+\d+$/.test(lsName) && lsName.length >= 3) {
      // Okazja żeby zapisać do PROJECT_NAMES
      _pnSet(projectId, lsName);
      return lsName;
    }
    // 4. Fallback — ID projektu (przynajmniej wiadomo co to)
    return 'Projekt ' + projectId;
  }

  // ───────────────────────────────────────────
  // URL NORMALIZATION
  // ───────────────────────────────────────────

  // Pre-compiled regexes for normalizeUrl (perf: called thousands of times per session)
  const _RX_PROTO  = /^https?:\/\/(www\.)?/;
  const _RX_TWIT   = /twitter\.com/;
  const _RX_STATUS = /\/status\//;
  const _RX_TRAIL  = /\/$/;
  // Brand24 zapisuje wszystkie Instagram URL-e jako /p/<shortcode> — reels, guides itp.
  // np. instagram.com/reel/ABC → instagram.com/p/ABC
  //     instagram.com/username/reel/ABC → instagram.com/p/ABC  (z nazwą użytkownika)
  const _RX_IG_REEL_USER = /instagram\.com\/[^/]+\/(reel|tv|guide)\/([^/?#]+)/;
  const _RX_IG_REEL      = /instagram\.com\/(reel|tv|guide)\/([^/?#]+)/;
  // Brand24 usuwa też query string z Instagram URL-i (igsh=, img_index= itp.)
  const _RX_IG_QUERY = /(instagram\.com\/[^?#]+)\?.*/;

  function normalizeUrl(url) {
    if (!url) return '';
    let u = url
      .replace(_RX_PROTO,  '')
      .replace(_RX_TWIT,   'x.com')
      .replace(_RX_STATUS, '/statuses/')
      .replace(_RX_TRAIL,  '')
      .toLowerCase()
      .trim();
    // Instagram: usuń query string (igsh=, img_index= itp.) — przed trim trailing slash
    u = u.replace(_RX_IG_QUERY, '$1');
    // Trailing slash może zostać po usunięciu query — usuń ponownie
    u = u.replace(_RX_TRAIL, '');
    // Instagram: /username/reel/CODE → /p/CODE
    u = u.replace(_RX_IG_REEL_USER, (_, __, code) => `instagram.com/p/${code}`);
    // Instagram: /reel/CODE → /p/CODE  (bez nazwy użytkownika)
    u = u.replace(_RX_IG_REEL, (_, __, code) => `instagram.com/p/${code}`);
    return u;
  }

  // Porównaj dwa znormalizowane URL z tolerancją na obcięte ID
  // TikTok/Twitter video ID mają 19 cyfr — Excel/XLSX może obciąć ostatnie cyfry
  function urlsMatch(urlA, urlB) {
    if (!urlA || !urlB) return false;
    if (urlA === urlB) return true;
    // Jeśli jeden jest prefiksem drugiego (obcięte ID) — uznaj za match
    // Wymaga min 15 znaków wspólnych żeby uniknąć false positives
    const shorter = urlA.length < urlB.length ? urlA : urlB;
    const longer  = urlA.length < urlB.length ? urlB : urlA;
    if (shorter.length >= 15 && longer.startsWith(shorter)) return true;
    return false;
  }

  // Wykrywa czy URL z pliku jest obciętą wersją URL z mapy Brand24.
  // Zwraca { candidate, missingChars } lub null.
  // NIE jest używane do matchowania — tylko do diagnostyki w logu.
  // Warunki:
  //   • urlFromFile jest prefiksem candidateFromMap (lub odwrotnie — mapy też mogą mieć krótsze URL)
  //   • wspólny prefiks ma min MIN_COMMON znaków (unika losowych pokryć krótkich URL)
  //   • różnica długości max MAX_DIFF znaków (bardzo duże obcięcia = prawdopodobnie inny artykuł)
  function detectTruncatedUrl(normalizedFileUrl, mapKeys) {
    if (!normalizedFileUrl || normalizedFileUrl.length < 20) return null;
    const MIN_COMMON = 20;
    const MAX_DIFF   = 30;
    for (let i = 0; i < mapKeys.length; i++) {
      const k = mapKeys[i];
      if (!k) continue;
      const shorter = normalizedFileUrl.length <= k.length ? normalizedFileUrl : k;
      const longer  = normalizedFileUrl.length <= k.length ? k : normalizedFileUrl;
      const diff = longer.length - shorter.length;
      if (diff === 0) continue; // identyczne — to nie truncation, to normalny match miss
      if (diff > MAX_DIFF) continue;
      if (shorter.length < MIN_COMMON) continue;
      if (longer.startsWith(shorter)) {
        return { candidate: k, missingChars: diff, fileIsShorter: normalizedFileUrl.length < k.length };
      }
    }
    return null;
  }

  // ───────────────────────────────────────────
  // TOKEN CAPTURE
  // ───────────────────────────────────────────

  // Use unsafeWindow to access the real page fetch (not TM sandbox copy)
  const _win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const origFetch = _win.fetch;
  _win.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const opts = args[1] || {};
    const bodyStr = typeof opts.body === 'string' ? opts.body : '';
    if (url.includes('graphql') && opts.headers && !state.tokenHeaders) {
      state.tokenHeaders = { ...opts.headers };
      updateTokenUI(true);
    }
    // Capture last organic getMentions variables for Quick Tag filter mirroring
    if (url.includes('graphql') && bodyStr.includes('getMentions') && bodyStr.includes('"filters"')) {
      try {
        const parsed = JSON.parse(bodyStr);
        if (parsed.variables?.filters && parsed.variables?.dateRange) {
          state.lastMentionsVars = parsed.variables;
        }
      } catch(e) {}
    }
    // [DEV TOOL] UI TAG SNIFF: przechwytuje mutacje tagowania UI Brand24
    // Aktywuj z konsoli: B24Tagger.debug.sniffUiTag() — loguje jeden request i wyłącza się
    if (state._sniffUiTag && url.includes('graphql') && bodyStr.includes('mutation') &&
        (bodyStr.toLowerCase().includes('tag') || bodyStr.toLowerCase().includes('label'))) {
      try {
        const parsed = JSON.parse(bodyStr);
        addLog(
          `[SNIFF/UI_TAG] Operacja UI: ${parsed.operationName || '?'}\n` +
          `  variables: ${JSON.stringify(parsed.variables || {}).substring(0, 300)}\n` +
          `  query snippet: ${(parsed.query || '').substring(0, 200)}`,
          'info'
        );
        state._sniffUiTag = false; // loguj tylko raz
      } catch(e) {}
    }
    const res = await origFetch.apply(this, args);

    // [DEV TOOL] NET_MONITOR: monitoruje odpowiedzi getMentions
    // Aktywuj z konsoli: b24tagger.netMonitor(shortcodes)
    if (state._netMonitor && url.includes('graphql') && bodyStr.includes('getMentions')) {
      try {
        const clone = res.clone();
        clone.json().then(data => {
          const results = data?.data?.getMentions?.results || [];
          const target = state._netMonitor.targetShortcodes;
          results.forEach(m => {
            const u = m.url || m.openUrl || '';
            const hit = target.find(t => u.toLowerCase().includes(t.toLowerCase()));
            if (hit) {
              addLog(
                `[NET_MONITOR] Znaleziono "${hit}" w odpowiedzi Brand24:
` +
                `  url: "${m.url || ''}"
` +
                `  openUrl: "${(m.openUrl || '').substring(0, 60)}"
` +
                `  id: ${m.id} | date: ${m.createdDate}`,
                'info'
              );
              state._netMonitor.found.add(hit);
            }
          });
        }).catch(() => {});
      } catch(e) {}
    }

    return res;
  };

  // ───────────────────────────────────────────
  // GRAPHQL HELPERS
  // ───────────────────────────────────────────

  // Kategoryzuje błąd i zwraca { src, hint } — używane w logach i raporcie końcowym
  // src: 'BRAND24' | 'SIEĆ' | 'AUTORYZACJA' | 'PLIK' | 'PLUGIN'
  function _errContext(msg) {
    const m = String(msg || '');
    const ml = m.toLowerCase();
    if (m === 'TOKEN_NOT_READY')
      return { src: 'AUTORYZACJA', hint: 'Token autoryzacji nie jest gotowy — odśwież stronę Brand24 i poczekaj na załadowanie, potem wznów.' };
    if (m === 'GRAPHQL_AUTH_ERROR' || m.includes('GRAPHQL_HTTP_ERROR_401'))
      return { src: 'AUTORYZACJA', hint: 'Sesja Brand24 wygasła — zaloguj się ponownie i kliknij Wznów.' };
    if (m === 'GRAPHQL_PERMISSION_DENIED' || m.includes('GRAPHQL_HTTP_ERROR_403'))
      return { src: 'AUTORYZACJA', hint: 'Brak uprawnień do tagowania w tym projekcie — sprawdź rolę konta w Brand24.' };
    if (m.includes('GRAPHQL_HTTP_ERROR_400'))
      return { src: 'PLUGIN', hint: 'Brand24 odrzucił zapytanie jako nieprawidłowe (400) — prawdopodobny błąd formatu. Wyślij Bug Report przez Feedback.' };
    if (m.includes('GRAPHQL_HTTP_ERROR_404'))
      return { src: 'BRAND24', hint: 'Endpoint API nie istnieje (404) — Brand24 mógł zmienić API. Sprawdź aktualizacje wtyczki.' };
    if (m.includes('GRAPHQL_HTTP_ERROR_429'))
      return { src: 'BRAND24', hint: 'Zbyt wiele zapytań — Brand24 zablokował ruch (rate limit). Poczekaj ok. minutę i wznów.' };
    if (m.includes('GRAPHQL_HTTP_ERROR_500'))
      return { src: 'BRAND24', hint: 'Wewnętrzny błąd serwera Brand24 (500) — spróbuj ponownie za chwilę.' };
    if (m.includes('GRAPHQL_HTTP_ERROR_502') || m.includes('GRAPHQL_HTTP_ERROR_503') || m.includes('GRAPHQL_HTTP_ERROR_504'))
      return { src: 'BRAND24', hint: 'Brand24 tymczasowo niedostępny — spróbuj za kilka minut.' };
    if (m.includes('GRAPHQL_HTTP_ERROR_'))
      return { src: 'BRAND24', hint: `Nieoczekiwany błąd HTTP Brand24 (${m}) — sprawdź logi powyżej.` };
    if (m === 'GRAPHQL_ERROR')
      return { src: 'BRAND24', hint: 'Brand24 API zwróciło błąd GQL — sprawdź logi [BRAND24/GQL] powyżej.' };
    if (ml.includes('failed to fetch') || ml.includes('networkerror') || ml.includes('network error') || ml.includes('net::'))
      return { src: 'SIEĆ', hint: 'Brak połączenia z Brand24 — sprawdź internet i wznów sesję.' };
    if (ml.includes('timeout') || ml.includes('timed out'))
      return { src: 'SIEĆ', hint: 'Zapytanie przekroczyło limit czasu — sprawdź połączenie i wznów.' };
    // UserError messages z Brand24 bulkTagMentions / bulkUntagMentions
    if (ml.includes('not found') || ml.includes('nie znalezion') || ml.includes('does not exist'))
      return { src: 'BRAND24', hint: 'Wzmianka nie istnieje lub została usunięta z Brand24. Możliwe że pochodzi z innego projektu lub okresu.' };
    if ((ml.includes('invalid') || ml.includes('nieprawidłow')) && (ml.includes('id') || ml.includes('mention')))
      return { src: 'PLIK', hint: 'ID wzmianki jest nieprawidłowe — sprawdź czy plik pochodzi z tego samego projektu Brand24.' };
    if (ml.includes('tag') && (ml.includes('not found') || ml.includes('invalid') || ml.includes('nie znalezion')))
      return { src: 'BRAND24', hint: 'Tag nie istnieje lub został usunięty w Brand24 — sprawdź mapowanie tagów.' };
    if (ml.includes('permission') || ml.includes('access denied') || ml.includes('forbidden') || ml.includes('unauthorized'))
      return { src: 'AUTORYZACJA', hint: 'Brak uprawnień do tej wzmianki lub projektu — sprawdź rolę konta.' };
    if (ml.includes('quota') || ml.includes('limit exceeded') || ml.includes('too many'))
      return { src: 'BRAND24', hint: 'Przekroczono limit Brand24 — poczekaj chwilę i wznów.' };
    return { src: 'BRAND24', hint: 'Nieoczekiwana odpowiedź Brand24 — możliwy tymczasowy błąd lub zmiana API. Spróbuj ponownie.' };
  }

  async function gql(operationName, variables, query, opts) {
    if (!state.tokenHeaders) {
      addLog(`✕ [AUTORYZACJA] ${operationName} — token autoryzacji nie gotowy. Odśwież stronę Brand24.`, 'error');
      throw new Error('TOKEN_NOT_READY');
    }
    const res = await origFetch('/api/graphql', {
      method: 'POST',
      credentials: 'same-origin',
      headers: state.tokenHeaders,
      body: JSON.stringify({ operationName, variables, query }),
    });
    if (res.status === 401) {
      addLog(`✕ [AUTORYZACJA] ${operationName} — sesja wygasła (HTTP 401). Zaloguj się ponownie i kliknij Wznów.`, 'error');
      throw new Error('GRAPHQL_AUTH_ERROR');
    }
    if (!res.ok) {
      let rawBody = '';
      try { rawBody = await res.text(); } catch(e) {}
      const bodySnippet = rawBody.substring(0, 200).replace(/\n/g, ' ');
      const _statusLabels = {
        400: '[PLUGIN] Brand24 odrzucił zapytanie jako nieprawidłowe (400) — prawdopodobny błąd formatu. Wyślij Bug Report.',
        403: '[AUTORYZACJA] Brand24 odmawia dostępu (403) — sprawdź uprawnienia konta do projektu.',
        404: '[BRAND24] Endpoint API nie istnieje (404) — Brand24 mógł zmienić API. Sprawdź aktualizacje wtyczki.',
        429: '[BRAND24] Zbyt wiele zapytań (429) — Brand24 zablokował ruch. Poczekaj ok. minutę i wznów.',
        500: '[BRAND24] Wewnętrzny błąd serwera Brand24 (500) — spróbuj ponownie za chwilę.',
        502: '[BRAND24] Brand24 niedostępny (502) — spróbuj za kilka minut.',
        503: '[BRAND24] Brand24 tymczasowo niedostępny (503) — spróbuj za kilka minut.',
        504: '[BRAND24] Brand24 timeout (504) — spróbuj ponownie.',
      };
      const desc = _statusLabels[res.status] || `[BRAND24] Nieoczekiwany błąd HTTP ${res.status}`;
      addLog(`✕ ${desc}\n  Operacja: ${operationName} | Odpowiedź: "${bodySnippet}"`, 'error');
      throw new Error(`GRAPHQL_HTTP_ERROR_${res.status}`);
    }
    const data = await res.json();
    if (data.errors) {
      const _errCode = data.errors[0]?.extensions?.code;
      const _errMsg = data.errors[0]?.message || 'GRAPHQL_ERROR';
      if (_errCode === 'PERMISSION_DENIED') {
        if (!opts?.silent) addLog(`✕ [AUTORYZACJA] ${operationName} — brak uprawnień (PERMISSION_DENIED). Sprawdź rolę konta w Brand24.`, 'error');
        throw new Error('GRAPHQL_PERMISSION_DENIED');
      }
      if (_errCode === 'UNAUTHENTICATED' || _errMsg.toLowerCase().includes('unauthenticated')) {
        addLog(`✕ [AUTORYZACJA] ${operationName} — token nieważny (${_errCode || _errMsg}). Zaloguj się ponownie.`, 'error');
        throw new Error('GRAPHQL_AUTH_ERROR');
      }
      addLog(`✕ [BRAND24/GQL] ${operationName} — błąd API: "${_errMsg}" (code: ${_errCode || 'brak'})`, 'error');
      throw new Error(_errMsg || 'GRAPHQL_ERROR');
    }
    return data.data;
  }

  async function gqlRetry(operationName, variables, query, retries = 3, opts) {
    for (let i = 0; i < retries; i++) {
      try {
        return await gql(operationName, variables, query, opts);
      } catch (e) {
        if (e.message === 'GRAPHQL_AUTH_ERROR' || e.message === 'GRAPHQL_PERMISSION_DENIED' || e.message === 'TOKEN_NOT_READY') throw e;
        if (i < retries - 1) {
          const ctx = _errContext(e.message);
          addLog(`⚠ [${ctx.src}] Retry ${i + 1}/${retries - 1} dla ${operationName}: ${e.message}`, 'warn');
          await sleep(RETRY_DELAYS[i]);
        } else {
          const ctx = _errContext(e.message);
          addLog(`✕ [${ctx.src}] ${operationName} — wszystkie retries wyczerpane (${retries}×): ${e.message}\n  → ${ctx.hint}`, 'error');
          throw e;
        }
      }
    }
  }

  // ───────────────────────────────────────────
  // API OPERATIONS
  // ───────────────────────────────────────────

  async function getTags() {
    const data = await gqlRetry('getTags', {}, `query getTags {
      getTags { id title isProtected }
    }`);
    return data.getTags;
  }

  async function createTag(title) {
    const data = await gqlRetry('createTag', { title }, `mutation createTag($title: String!) {
      createTag(title: $title) {
        ... on CreateTagSuccess { id title isProtected }
      }
    }`);
    return data.createTag;
  }

  async function getMentions(projectId, dateFrom, dateTo, gr, page, opts) {
    const variables = {
      projectId,
      dateRange: { from: dateFrom, to: dateTo },
      filters: {
        va: 1, rt: [], se: [], vi: null,
        gr: gr || [],
        sq: '', do: '', au: '', lem: false,
        ctr: [], nctr: false, is: [0, 10],
        tp: null, lang: [], nlang: false,
      },
      page: page || 1,
      order: 0,
    };
    const data = await gqlRetry('getMentions', variables, `query getMentions(
      $projectId: Int!, $dateRange: DateRangeInput!,
      $filters: MentionFilterInput, $page: Int, $order: Int
    ) {
      getMentions(projectId: $projectId, dateRange: $dateRange,
                  filters: $filters, page: $page, order: $order) {
        count
        results {
          id openUrl url createdDate
          host { name }
          author { name }
          tags { id title }
        }
      }
    }`, 3, opts);
    return data.getMentions;
  }

  async function bulkTagMentions(mentionsIds, tagId) {
    if (state.testRunMode) {
      addLog(`[TEST] bulkTag: ${mentionsIds.length} IDs → tagId ${tagId}`, 'info');
      return { success: true, testRun: true };
    }

    const data = await gqlRetry('bulkTagMentions', { mentionsIds, tagId }, `mutation bulkTagMentions(
      $mentionsIds: [IntString!]!, $tagId: Int!
    ) {
      bulkTagMentions(mentionsIds: $mentionsIds, tagId: $tagId) {
        ... on UserError { message }
      }
    }`, 5); // 5 retry — Brand24 Internal server error jest losowy
    if (data.bulkTagMentions?.message) {
      const brandMsg = data.bulkTagMentions.message;
      const ctx = _errContext(brandMsg);
      addLog(`✕ [${ctx.src}] bulkTagMentions UserError (${mentionsIds.length} IDs, tagId=${tagId}): "${brandMsg}"\n  → ${ctx.hint}`, 'error');
      throw new Error(brandMsg);
    }
    return { success: true };
  }

  async function bulkUntagMentions(mentionsIds, tagId) {
    if (state.testRunMode) {
      addLog(`[TEST] bulkUntag: ${mentionsIds.length} IDs ← tagId ${tagId}`, 'info');
      return { success: true, testRun: true };
    }
    const data = await gqlRetry('bulkUntagMentions', { mentionsIds, tagId }, `mutation bulkUntagMentions(
      $mentionsIds: [IntString!]!, $tagId: Int!
    ) {
      bulkUntagMentions(mentionsIds: $mentionsIds, tagId: $tagId) {
        ... on UserError { message }
      }
    }`);
    if (data.bulkUntagMentions?.message) {
      const brandMsg = data.bulkUntagMentions.message;
      const ctx = _errContext(brandMsg);
      addLog(`✕ [${ctx.src}] bulkUntagMentions UserError (${mentionsIds.length} IDs, tagId=${tagId}): "${brandMsg}"\n  → ${ctx.hint}`, 'error');
      throw new Error(brandMsg);
    }
    return { success: true };
  }

  async function getNotifications() {
    return gql('getNotifications', {}, `query getNotifications {
      getNotifications { notifications { variant message } }
    }`);
  }

  // getMentions with full filters object (for Quick Tag - mirrors exact Brand24 view)
  async function getMentionsWithFilters(projectId, dateFrom, dateTo, filters, page) {
    const variables = {
      projectId,
      dateRange: { from: dateFrom, to: dateTo },
      filters: filters || {},
      page: page || 1,
      order: 0,
    };
    const data = await gqlRetry('getMentions', variables, `query getMentions(
      $projectId: Int!, $dateRange: DateRangeInput!,
      $filters: MentionFilterInput, $page: Int, $order: Int
    ) {
      getMentions(projectId: $projectId, dateRange: $dateRange,
                  filters: $filters, page: $page, order: $order) {
        count
        results {
          id openUrl url createdDate
          host { name }
          author { name }
          tags { id title }
        }
      }
    }`);
    return data.getMentions;
  }

  // ───────────────────────────────────────────
  // FILE PARSING
  // ───────────────────────────────────────────

  function parseCSV(text) {
    const str = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!str) return [];
    // Auto-detect separator
    const firstLine = str.split('\n')[0];
    const sep = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

    // Parser state-machine — obsługuje "" (escaped quote) wewnątrz pól
    function parseRow(pos) {
      const row = [];
      while (pos <= str.length) {
        if (str[pos] === '"') {
          pos++;
          let val = '';
          while (pos < str.length) {
            if (str[pos] === '"') {
              if (str[pos + 1] === '"') { val += '"'; pos += 2; }
              else { pos++; break; }
            } else { val += str[pos++]; }
          }
          row.push(val);
        } else {
          let val = '';
          while (pos < str.length && str[pos] !== sep && str[pos] !== '\n') val += str[pos++];
          row.push(val.trim());
        }
        if (pos < str.length && str[pos] === sep) pos++;
        else break;
      }
      return { row, pos };
    }

    let pos = 0, headers = null;
    const rows = [];
    while (pos < str.length) {
      const { row, pos: next } = parseRow(pos);
      pos = next;
      if (pos < str.length && str[pos] === '\n') pos++;
      if (!headers) { headers = row; }
      else if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
        rows.push(obj);
      }
    }
    return rows;
  }

  function parseJSON(text) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }

  // Post-processing po parsowaniu — tylko loguje podejrzane wartości, nie modyfikuje
  function sanitizeInputRows(rows) {
    const SCI_RE = /^-?\d+\.?\d*[eE][+\-]\d+$/;
    const warnings = [];

    rows.forEach((row, i) => {
      Object.keys(row).forEach(col => {
        const val = row[col];
        if (!val) return;
        if (SCI_RE.test(String(val).trim())) {
          warnings.push(`Wiersz ${i + 2}, kolumna "${col}": wartość wygląda jak sci notation: "${val}"`);
        }
      });
    });

    if (warnings.length) {
      addLog(`[INTEGRITY] ${warnings.length} podejrzanych wartości w pliku wejściowym:`, 'warn');
      warnings.slice(0, 10).forEach(w => addLog('  ' + w, 'warn'));
      if (warnings.length > 10) addLog(`  ...i ${warnings.length - 10} więcej`, 'warn');
    }

    return rows;
  }

  function autoDetectColumns(rows) {
    if (!rows.length) return {};
    const headers = Object.keys(rows[0]);
    const detected = {};

    // Assessment column FIRST - detect before date to avoid false matches
    // Krok 1: szukaj po dokładnej nazwie kolumny (najwyższy priorytet)
    const ASSESSMENT_NAMES = ['assessment', 'label', 'ocena', 'flag', 'classification', 'klasa', 'class',
      'verdict', 'relevance', 'decision', 'annotation', 'etykieta'];
    // Kolumny które NIE są assessment — wyklucz je z heurystyki
    const SOURCE_NAMES = ['source', 'platform', 'channel', 'medium', 'site', 'domain', 'network',
      'source_type', 'mention_source', 'type', 'media_type', 'content_type'];

    let assessmentCol = headers.find(h => ASSESSMENT_NAMES.includes(h.toLowerCase()));

    // Krok 2: jeśli nie znaleziono po nazwie — użyj heurystyki (małe unikalne wartości)
    if (!assessmentCol) {
      assessmentCol = headers.find(h => {
        const hl = h.toLowerCase();
        // Wyklucz kolumny o znanych nazwach które nie są assessment
        if (SOURCE_NAMES.some(s => hl.includes(s))) return false;
        if (['url', 'link', 'id', 'date', 'text', 'content', 'author', 'title'].some(s => hl.includes(s))) return false;

        const vals = new Set(rows.map(r => (r[h] || '').toString().trim()).filter(Boolean));
        const isLikelyLabel = vals.size >= 2 && vals.size <= 10 && rows.length > vals.size * 5;
        const sampleVal = [...vals][0] || '';
        const looksLikeDate = /\d{4}-\d{2}-\d{2}/.test(sampleVal);
        const looksLikeId = /^[a-f0-9]{20,}$/.test(sampleVal) || /^\d{15,}$/.test(sampleVal);
        const looksLikeUrl = /^https?:\/\//.test(sampleVal);
        // Wartości assessment: uppercase (RELEVANT) lub lowercase słowa (relevant) — nie cyfry/URL/daty
        const looksLikeAssessment = [...vals].some(v => /^[A-Z_]{3,}$/.test(v) || /^[a-z_]{3,}$/.test(v));
        return isLikelyLabel && !looksLikeDate && !looksLikeId && !looksLikeUrl && looksLikeAssessment;
      });
    }
    if (assessmentCol) detected.assessment = assessmentCol;

    // ID column
    const idCol = headers.find(h =>
      ['id', 'mention_id', 'mentionid'].includes(h.toLowerCase()) ||
      rows.slice(0, 5).every(r => /^[a-f0-9]{24}$/.test(r[h] || ''))
    );
    if (idCol) detected.id = idCol;

    // Date column - exclude assessment column
    const dateCol = headers.find(h => {
      if (h === assessmentCol) return false;
      if (['created_date', 'date', 'createddate', 'crawled_date', 'creation_date',
           'published_at', 'timestamp', 'datetime', 'published_date'].includes(h.toLowerCase())) return true;
      return rows.slice(0, 5).some(r => /\d{4}-\d{2}-\d{2}/.test(String(r[h] || '')));
    });
    if (dateCol) detected.date = dateCol;

    // URL column - exclude already detected columns
    const urlCol = headers.find(h => {
      if (h === assessmentCol || h === dateCol) return false;
      if (['url', 'link', 'source_url', 'permalink', 'post_url', 'mention_url', 'href', 'uri'].includes(h.toLowerCase())) return true;
      return rows.slice(0, 5).some(r => /^https?:\/\//.test(r[h] || ''));
    });
    if (urlCol) detected.url = urlCol;

    // Text column: longest average values, exclude already detected
    const usedCols = new Set([detected.id, detected.date, detected.url, detected.assessment].filter(Boolean));
    let maxAvg = 0, textCol = null;
    headers.forEach(h => {
      if (usedCols.has(h)) return;
      const avg = rows.slice(0, 10).reduce((s, r) => s + (r[h] || '').length, 0) / 10;
      if (avg > maxAvg) { maxAvg = avg; textCol = h; }
    });
    if (textCol) detected.text = textCol;

    // Project ID column for multi-project tagging
    const projectIdCol = headers.find(h => /^proje[ck]t[_\s-]?id$/i.test(h.trim()));
    if (projectIdCol) detected.projectId = projectIdCol;

    return detected;
  }

  function processFileData(rows, colMap) {
    const assessments = {};
    let noAssessment = 0;
    let minDate = null, maxDate = null;

    rows.forEach(row => {
      const assessmentRaw = colMap.assessment ? (row[colMap.assessment] || '').trim() : '';
      if (!assessmentRaw) { noAssessment++; return; }
      // Multi-assessment: split po "|", każda część liczy się osobno
      const assessmentParts = assessmentRaw.split('|').map(a => a.trim()).filter(Boolean);
      if (!assessmentParts.length) { noAssessment++; return; }
      assessmentParts.forEach(a => {
        assessments[a] = (assessments[a] || 0) + 1;
      });

      const dateStr = colMap.date ? row[colMap.date] : null;
      if (dateStr) {
        const d = dateStr.substring(0, 10);
        if (!minDate || d < minDate) minDate = d;
        if (!maxDate || d > maxDate) maxDate = d;
      }
    });

    return { assessments, noAssessment, minDate, maxDate, totalRows: rows.length };
  }

  // ───────────────────────────────────────────
  // URL MAP BUILDING
  // ───────────────────────────────────────────

  async function buildUrlMap(dateFrom, dateTo, untaggedOnly) {
    const gr = untaggedOnly ? [state.untaggedId] : [];
    const map = {};
    const diag = {
      step: 'init',
      dateFrom, dateTo, untaggedOnly,
      untaggedId: state.untaggedId,
      projectId: state.projectId,
      pageSize: null, totalPages: null, totalCount: null,
      fetchedPages: 0, mentionsInMap: 0,
      urlFieldEmpty: 0, urlFieldPresent: 0,
      dupeKeys: 0,
      errors: [],
    };

    // ── KROK 1: walidacja dat ───────────────────────────────────────────
    diag.step = 'date_validation';
    const isInvalidDate = function(d) { return !d || d === '9999' || d === '0000' || !/^\d{4}-\d{2}-\d{2}$/.test(d); };
    if (isInvalidDate(dateFrom) || isInvalidDate(dateTo)) {
      const fallback = getAnnotatorDates();
      addLog(`⚠ [DIAG/DATY] Brak dat w pliku — używam fallback: ${fallback.dateFrom} → ${fallback.dateTo}`, 'warn');
      dateFrom = fallback.dateFrom;
      dateTo   = fallback.dateTo;
      diag.dateFrom = dateFrom; diag.dateTo = dateTo;
    }
    if (new Date(dateFrom) > new Date(dateTo)) {
      addLog(`✕ [DIAG/DATY] dateFrom (${dateFrom}) > dateTo (${dateTo}) — zakres odwrócony! Sprawdź plik.`, 'error');
    }

    // ── KROK 2: walidacja untaggedId ────────────────────────────────────
    diag.step = 'untagged_id';
    if (untaggedOnly) {
      if (!state.untaggedId) {
        addLog(`⚠ [DIAG/UNTAGGED] untaggedId=${state.untaggedId} — wartość domyślna, możliwe że tag "Untagged" nie został poprawnie wykryty.`, 'warn');
      } else {
        addLog(`ℹ [DIAG/UNTAGGED] Filtr Untagged aktywny, gr=[${state.untaggedId}]`, 'info');
      }
    }

    updateProgress('map', 0, '?');
    addLog(`→ Budowanie mapy URL (${untaggedOnly ? 'Untagged' : 'pełny zakres'}) | projekt=${state.projectId} | ${dateFrom}→${dateTo}`, 'info');

    // ── KROK 3: pierwsza strona — sprawdź count i pageSize ───────────────
    diag.step = 'page1_fetch';
    let first;
    try {
      first = await getMentions(state.projectId, dateFrom, dateTo, gr, 1);
    } catch(e) {
      addLog(`✕ [DIAG/API] getMentions strona 1 FAILED: ${e.message}`, 'error');
      return map;
    }

    if (!first || !first.results) {
      addLog(`✕ [DIAG/API] getMentions strona 1 zwróciła null/undefined — problem z API Brand24`, 'error');
      return map;
    }

    diag.totalCount = first.count;
    diag.pageSize   = first.results.length;
    if (!state.pageSize && first.results.length > 0) state.pageSize = first.results.length;
    const pageSize  = state.pageSize || 60;
    const totalPages = Math.ceil(first.count / pageSize);
    diag.totalPages = totalPages;

    addLog(`ℹ [DIAG/API] Strona 1: count=${first.count}, wyniki=${first.results.length}, pageSize=${pageSize}, totalPages=${totalPages}`, 'info');

    if (first.count === 0) {
      addLog(`⚠ [DIAG/API] count=0 — Brand24 nie zwraca żadnych wzmianek dla tego zakresu/filtrów.
  Możliwe przyczyny: zły zakres dat, nieistniejący projekt, filtr Untagged pusty.`, 'warn');
      return map;
    }

    // ── KROK 4: analiza pola url vs openUrl na stronie 1 ─────────────────
    diag.step = 'url_field_analysis';
    let urlEmpty = 0, urlPresent = 0, openUrlOnly = 0, bothEmpty = 0;
    first.results.forEach(m => {
      if (m.url) { urlPresent++; }
      else if (m.openUrl) { openUrlOnly++; }
      else { bothEmpty++; }
    });
    if (openUrlOnly > 0 || bothEmpty > 0) {
      addLog(`⚠ [DIAG/URL_FIELD] Strona 1: url=${urlPresent} present, openUrl-only=${openUrlOnly}, oba puste=${bothEmpty}
  Jeśli openUrl-only > 0, Brand24 zmienił format — używamy openUrl jako fallback.`, 'warn');
    }

    // ── KROK 5: buduj mapę ze strony 1 ───────────────────────────────────
    diag.step = 'build_map_p1';
    const keysBefore = Object.keys(map).length;
    first.results.forEach(m => {
      const matchUrl = m.url || m.openUrl;
      if (matchUrl) {
        const key = normalizeUrl(matchUrl);
        if (map[key]) diag.dupeKeys++;
        map[key] = { id: String(m.id), existingTags: m.tags || [] };
      } else {
        diag.urlFieldEmpty++;
      }
    });
    diag.fetchedPages = 1;
    updateProgress('map', 1, totalPages);

    if (totalPages <= 1) {
      addLog(`✓ Mapa zbudowana: ${Object.keys(map).length} wzmianek (1 strona)`, 'success');
      return map;
    }

    // ── KROK 6: pozostałe strony — sliding window pool (MAP_FETCH_CONCURRENCY workerów) ──
    // Każdy worker od razu bierze kolejną stronę po zakończeniu — nie ma "najwolniejszego
    // w batchu" który blokuje całą rundę. Deduplication przez mentionIdsSeen.
    diag.step = 'build_map_pages';
    let fetched = 1;
    let pageErrors = 0;
    let allDupeIds = 0;
    const mentionIdsSeen = new Set();
    first.results.forEach(m => { if (m.id) mentionIdsSeen.add(String(m.id)); });

    const _mapTStart = Date.now();
    let _poolNextPage = 2; // shared counter — atomowy w JS (single-threaded)

    const _mapWorker = async () => {
      while (true) {
        if (state.status !== 'running') break;
        const p = _poolNextPage;
        if (p > totalPages) break;
        _poolNextPage++;
        const result = await getMentions(state.projectId, dateFrom, dateTo, gr, p)
          .catch(e => ({ _err: e.message, _page: p }));
        if (result && result._err !== undefined) {
          pageErrors++;
          addLog(`⚠ [DIAG/API] Błąd strony ${p}: ${result._err}`, 'warn');
          continue;
        }
        if (!result || !result.results) {
          pageErrors++;
          addLog(`⚠ [DIAG/API] Strona ${p}: null response`, 'warn');
          continue;
        }
        let pageDupeIds = 0;
        result.results.forEach(m => {
          const matchUrl = m.url || m.openUrl;
          const idStr = String(m.id);
          if (mentionIdsSeen.has(idStr)) { pageDupeIds++; diag.dupeKeys++; allDupeIds++; return; }
          mentionIdsSeen.add(idStr);
          if (matchUrl) {
            const key = normalizeUrl(matchUrl);
            if (map[key]) diag.dupeKeys++;
            map[key] = { id: String(m.id), existingTags: m.tags || [] };
          } else {
            diag.urlFieldEmpty++;
          }
        });
        if (pageDupeIds > 0) {
          addLog(`⚠ [DIAG/PAGINATION] Strona ${p}: ${pageDupeIds} duplikatów ID — Brand24 niestabilna paginacja`, 'warn');
        }
        fetched++;
        diag.fetchedPages = fetched;
        updateProgress('map', fetched, totalPages);
        if (fetched % 10 === 0 || fetched >= totalPages) {
          addLog(`→ Mapa: ${fetched}/${totalPages} stron (${Object.keys(map).length} wzmianek)`, 'info');
        }
        await sleep(0); // yield do UI między stronami
      }
    };
    await Promise.all(Array.from({ length: MAP_FETCH_CONCURRENCY }, _mapWorker));

    const _mapElapsed = Date.now() - _mapTStart;
    addLog(`ℹ [DIAG/PERF] Mapa ${totalPages} stron: ${_mapElapsed}ms | concurrency=${MAP_FETCH_CONCURRENCY} | dupeId=${allDupeIds} (${first.count > 0 ? (allDupeIds / first.count * 100).toFixed(1) : 0}%)`, 'info');
    diag.mentionsInMap = Object.keys(map).length;

    // ── KROK 7: weryfikacja kompletności ─────────────────────────────────
    diag.step = 'completeness_check';
    const expectedMin = Math.floor(first.count * 0.95); // tolerancja 5% na duplikaty/race
    if (diag.mentionsInMap < expectedMin) {
      addLog(
        `⚠ [DIAG/COMPLETENESS] Mapa niekompletna!
` +
        `  count z API: ${first.count} | w mapie: ${diag.mentionsInMap} | oczekiwano min: ${expectedMin}
` +
        `  Możliwe: Brand24 zwraca niestabilny count, duplikaty URL-i (${diag.dupeKeys}), błędy stron (${pageErrors})`,
        'warn'
      );
    }
    if (diag.dupeKeys > 0) {
      addLog(`ℹ [DIAG/DUPES] ${diag.dupeKeys} duplikatów URL w mapie (nadpisane) — Brand24 może zwracać tę samą wzmiankę na wielu stronach`, 'info');
    }
    if (pageErrors > 0) {
      addLog(`⚠ [DIAG/API] ${pageErrors} stron z błędem — mapa może być niekompletna!`, 'warn');
    }
    if (diag.urlFieldEmpty > 0) {
      addLog(`⚠ [DIAG/URL_FIELD] ${diag.urlFieldEmpty} wzmianek bez url i openUrl — pominięte w mapie. Brand24 może mieć wzmianki bez URL.`, 'warn');
    }

    addLog(`✓ Mapa zbudowana: ${diag.mentionsInMap} wzmianek w ${totalPages} stronach`, 'success');

    // ── KROK 8: próbkowanie mapy — pokaż sample kluczy ───────────────────
    const mapSample = Object.keys(map).slice(0, 3);
    addLog(`ℹ [DIAG/MAP_SAMPLE] Przykłady kluczy w mapie: ${mapSample.map(k => '"'+k+'"').join(' | ')}`, 'info');

    return map;
  }


  // ───────────────────────────────────────────
  // MAIN TAGGING FLOW
  // ───────────────────────────────────────────

  async function runMultiProjectTagging(partition) {
    var colMap = state.file.colMap;
    var savedProjectId = state.projectId;
    var savedTags = state.tags;
    var savedMapping = state.mapping;
    var savedUntaggedId = state.untaggedId;

    // Group rows by projectId
    var projectGroups = {};
    partition.rows.forEach(function(row) {
      var pid = (row[colMap.projectId] || '').toString().trim();
      if (!pid) return;
      if (!projectGroups[pid]) projectGroups[pid] = [];
      projectGroups[pid].push(row);
    });

    var projectIds = Object.keys(projectGroups);
    addLog('ℹ Multi-projekt: ' + projectIds.length + ' projektów w pliku — przetwarzam sekwencyjnie', 'info');

    var overallStats = {};
    var savedProjects = lsGet(LS.PROJECTS, {});

    for (var _pIdx = 0; _pIdx < projectIds.length; _pIdx++) {
      var projectId = projectIds[_pIdx];
      var projectData = savedProjects[projectId];
      if (!projectData) {
        addLog('⚠ Projekt ' + projectId + ' nieznany lokalnie — pomijam. Odwiedź projekt w Brand24 i spróbuj ponownie.', 'warn');
        continue;
      }

      var projectName = _pnResolve(projectId);
      var projectRows = projectGroups[projectId];
      addLog('\n══ Projekt: ' + projectName + ' (' + projectId + ') — ' + projectRows.length + ' wierszy ══', 'info');

      // Resolve mapping for this project by tag name
      var projectTags = projectData.tagIds || {};
      var projectMapping = {};
      Object.entries(savedMapping).forEach(function(_entry) {
        var label = _entry[0], m = _entry[1];
        var tagId = projectTags[m.tagName];
        if (tagId) {
          projectMapping[label] = { tagId: tagId, tagName: m.tagName, type: m.type };
        } else {
          addLog('⚠ Tag "' + m.tagName + '" nieznany w projekcie ' + projectName + ' — ocena "' + label + '" zostanie pominięta', 'warn');
        }
      });

      // Swap state for this project
      state.projectId = parseInt(projectId);
      state.tags = projectTags;
      state.mapping = projectMapping;
      state.untaggedId = projectData.untaggedId || savedUntaggedId;

      var statsBefore = { tagged: state.stats.tagged, skipped: state.stats.skipped };
      try {
        await runTagging({ dateFrom: partition.dateFrom, dateTo: partition.dateTo, rows: projectRows }, true);
      } catch (e) {
        addLog('✕ Błąd tagowania projektu ' + projectName + ': ' + e.message, 'error');
      }
      overallStats[projectId] = {
        name: projectName,
        tagged: state.stats.tagged - statsBefore.tagged,
        skipped: state.stats.skipped - statsBefore.skipped,
      };
    }

    // Restore original state
    state.projectId = savedProjectId;
    state.tags = savedTags;
    state.mapping = savedMapping;
    state.untaggedId = savedUntaggedId;

    // Overall report
    var lines = ['\n═══ RAPORT MULTI-PROJEKT ═══'];
    Object.entries(overallStats).forEach(function(_e) {
      var pid = _e[0], s = _e[1];
      lines.push((s.tagged > 0 ? '✓' : '○') + ' ' + s.name + ' (' + pid + '): ' + s.tagged + ' otagowano, ' + s.skipped + ' pominięto');
    });
    lines.push('════════════════════════════');
    addLog(lines.join('\n'), 'info');
  }

  function validateInputSchema(rows, colMap) {
    const issues = [];

    if (!colMap.url) issues.push('BRAK kolumny URL — matching niemożliwy');
    if (!colMap.assessment) issues.push('BRAK kolumny assessment — tagowanie niemożliwe');

    if (issues.length) {
      issues.forEach(i => addLog('[SCHEMA ERROR] ' + i, 'error'));
      return false;
    }

    const SCI_RE = /^-?\d+\.?\d*[eE][+\-]\d+$/;
    let emptyUrls = 0, sciUrls = 0, dupUrls = 0;
    const urlsSeen = new Set();
    const urlCol = colMap.url;

    rows.forEach(row => {
      const url = (row[urlCol] || '').trim();
      if (!url) { emptyUrls++; return; }
      if (SCI_RE.test(url)) { sciUrls++; return; }
      if (urlsSeen.has(url)) { dupUrls++; } else { urlsSeen.add(url); }
    });

    if (emptyUrls) addLog(`[SCHEMA WARN] ${emptyUrls} pustych URL-i w pliku`, 'warn');
    if (sciUrls) addLog(`[SCHEMA ERROR] ${sciUrls} URL-i wygląda jak sci notation — prawdopodobnie uszkodzone ID!`, 'error');
    if (dupUrls) addLog(`[SCHEMA WARN] ${dupUrls} zduplikowanych URL-i w pliku (możliwe duplikaty wzmianek)`, 'warn');

    addLog(`[SCHEMA OK] ${rows.length} rekordów, ${urlsSeen.size} unikalnych URL-i`, 'info');
    return sciUrls === 0;
  }

  async function runTagging(partition, _isSubCall) {
    if (!_isSubCall && state.file && state.file.colMap && state.file.colMap.projectId) {
      return runMultiProjectTagging(partition);
    }

    const { dateFrom, dateTo, rows } = partition;

    // Build URL map
    state.urlMap = await buildUrlMap(dateFrom, dateTo, state.mapMode === 'untagged');

    // Walidacja schematu pliku — blokuje tagowanie przy sci notation URL
    const schemaOk = validateInputSchema(rows, state.file.colMap);
    if (!schemaOk) {
      addLog('[TAGGING ABORTED] Schemat pliku wejściowego nie przeszedł walidacji. Napraw plik i spróbuj ponownie.', 'error');
      return;
    }

    // Build batches
    const batches = {};          // tagId → [snowflakeIds]
    const overwriteBatches = {}; // {oldTagId_newTagId} → {oldIds, newIds}
    const skipped = [];
    const conflicts = [];

    // ── DIAG: analiza pliku przed matchowaniem ─────────────────────────
    const matchDiag = {
      total: rows.length, noAssessment: 0, noMapping: 0,
      noMatch: 0, truncated: 0, alreadyTagged: 0, conflict: 0, willTag: 0,
      exactMatch: 0, fuzzyShort: 0,
      mapSize: Object.keys(state.urlMap).length,
      // próbki URL-i z pliku vs z mapy (pierwsze 2 każdej domeny)
      fileSamplesByDomain: {},
      mapSamplesByDomain: {},
    };
    // Zbierz próbki domen z mapy (wszystkie klucze — potrzebne do diagnozy NO_MATCH)
    Object.keys(state.urlMap).forEach(k => {
      const dom = k.split('/')[0];
      if (!matchDiag.mapSamplesByDomain[dom]) matchDiag.mapSamplesByDomain[dom] = [];
      if (matchDiag.mapSamplesByDomain[dom].length < 2) matchDiag.mapSamplesByDomain[dom].push(k);
    });

    const _mapKeys = Object.keys(state.urlMap); // cached once — fuzzy match uses this
    rows.forEach(row => {
      const urlRaw = row[state.file.colMap.url] || '';
      const assessmentRaw = (row[state.file.colMap.assessment] || '').trim().toUpperCase();
      // Multi-assessment: wartości rozdzielone "|", np. "POSITIVE|RELEVANT"
      const assessments = assessmentRaw ? assessmentRaw.split('|').map(a => a.trim()).filter(Boolean) : [];
      const normalizedUrl = normalizeUrl(urlRaw);

      // Zbierz próbki domen z pliku
      const dom = normalizedUrl.split('/')[0];
      if (dom && !matchDiag.fileSamplesByDomain[dom]) matchDiag.fileSamplesByDomain[dom] = [];
      if (dom && matchDiag.fileSamplesByDomain[dom] && matchDiag.fileSamplesByDomain[dom].length < 2) {
        matchDiag.fileSamplesByDomain[dom].push(normalizedUrl);
      }

      // Szukaj w mapie: 1) exact, 2) fuzzy bezpieczny (diff ≤5), 3) długi fuzzy → skip
      let entry = null;
      let matchConfidence = 'NO_MATCH';

      if (state.urlMap[normalizedUrl]) {
        entry = state.urlMap[normalizedUrl];
        matchConfidence = 'EXACT';
      }

      if (!entry) {
        const fuzzyKey = _mapKeys.find(k => {
          if (!urlsMatch(normalizedUrl, k)) return false;
          return Math.abs(normalizedUrl.length - k.length) <= 5;
        });
        if (fuzzyKey) {
          entry = state.urlMap[fuzzyKey];
          matchConfidence = 'FUZZY_SHORT';
        }
      }

      if (!entry) {
        const longFuzzyKey = _mapKeys.find(k => urlsMatch(normalizedUrl, k));
        if (longFuzzyKey) {
          addLog(`[MATCH WARN] Długi fuzzy match (>5 znaków diff) — pomijam tagowanie. URL z pliku: "${normalizedUrl.substring(0, 70)}" → mapa: "${longFuzzyKey.substring(0, 70)}"`, 'warn');
          skipped.push({ row, reason: 'FUZZY_LONG_SKIPPED', url: urlRaw, candidate: longFuzzyKey });
          matchDiag.noMatch++;
          state.stats.noMatch++;
          return;
        }
      }

      if (matchConfidence === 'EXACT') matchDiag.exactMatch++;
      else if (matchConfidence === 'FUZZY_SHORT') matchDiag.fuzzyShort++;

      if (!assessments.length) {
        skipped.push({ row, reason: 'NO_ASSESSMENT' });
        matchDiag.noAssessment++;
        return;
      }

      if (!entry) {
        const truncInfo = detectTruncatedUrl(normalizedUrl, _mapKeys);
        if (truncInfo) {
          const truncHint = `URL obcięty o ${truncInfo.missingChars} znaków w pliku — Brand24 ma: "${truncInfo.candidate.substring(0, 80)}"`;
          skipped.push({ row, reason: 'TRUNCATED_URL', url: urlRaw, normUrl: normalizedUrl, truncInfo, hint: truncHint });
          matchDiag.truncated++;
        } else {
          const _nmDom = normalizedUrl.split('/')[0];
          const _nmSample = matchDiag.mapSamplesByDomain[_nmDom];
          let _nmHint;
          if (!_nmSample || !_nmSample.length) {
            // Sprawdź alias twitter↔x
            const _altDom = _nmDom === 'twitter.com' ? 'x.com' : _nmDom === 'x.com' ? 'twitter.com' : null;
            if (_altDom && matchDiag.mapSamplesByDomain[_altDom]) {
              _nmHint = `Domena ${_nmDom} znormalizowana do x.com — Brand24 nie ma tej konkretnej wzmianki w projekcie`;
            } else {
              _nmHint = `Domena "${_nmDom}" nieobecna w mapie Brand24 — nie monitorowana w tym projekcie lub zakresie dat`;
            }
          } else {
            const _nmSmp = _nmSample[0];
            const _untaggedNote = state.mapMode === 'untagged'
              ? ' — lub jest już otagowana (mapa Untagged nie zawiera wzmianek z istniejącym tagiem)'
              : '';
            // Wykryj specyficzne wzorce
            if (_nmDom === 'instagram.com') {
              _nmHint = `Instagram: konkretny post/reel nie znaleziony w Brand24${_untaggedNote}. Mapa ma np.: "${_nmSmp}"`;
            } else if (_nmDom === 'facebook.com') {
              _nmHint = `Facebook: konkretna wzmianka nie znaleziona w Brand24${_untaggedNote}. Mapa ma np.: "${_nmSmp}"`;
            } else if (_nmDom === 'x.com' || _nmDom === 'twitter.com') {
              _nmHint = `Twitter/X: konkretny tweet nie znaleziony w Brand24${_untaggedNote}. Mapa ma np.: "${_nmSmp}"`;
            } else {
              _nmHint = `URL nie zgadza się z Brand24${_untaggedNote}. Domena obecna, mapa ma np.: "${_nmSmp}"`;
            }
          }
          skipped.push({ row, reason: 'NO_MATCH', url: urlRaw, normUrl: normalizedUrl, hint: _nmHint });
          matchDiag.noMatch++;
        }
        state.stats.noMatch++;
        return;
      }

      // Przetwórz każdy assessment z wiersza (obsługa multi-assessment przez separator "|")
      const existingTagIds = entry.existingTags.map(t => t.id);
      assessments.forEach(assessment => {
        const mapping = state.mapping[assessment];
        if (!mapping) {
          skipped.push({ row, reason: 'NO_MAPPING', assessment });
          matchDiag.noMapping++;
          return;
        }

        const alreadyTagged = existingTagIds.includes(mapping.tagId);
        if (alreadyTagged) {
          skipped.push({ row, reason: 'ALREADY_TAGGED', tagId: mapping.tagId });
          return;
        }

        const hasConflict = existingTagIds.length > 0 && !existingTagIds.includes(mapping.tagId);

        if (state.conflictMode === 'multitag') {
          // Multitag: dodaj tag obok istniejących — brak konfliktu
          if (!batches[mapping.tagId]) batches[mapping.tagId] = [];
          batches[mapping.tagId].push(entry.id);
        } else if (hasConflict) {
          if (state.conflictMode === 'ignore') {
            skipped.push({ row, reason: 'CONFLICT_IGNORED', existingTags: entry.existingTags });
            state.stats.conflicts++;
          } else if (state.conflictMode === 'overwrite') {
            const oldTagId = existingTagIds[0];
            const key = `${oldTagId}_${mapping.tagId}`;
            if (!overwriteBatches[key]) overwriteBatches[key] = { oldTagId, newTagId: mapping.tagId, ids: [] };
            overwriteBatches[key].ids.push(entry.id);
          } else {
            // 'ask' mode
            conflicts.push({ row, entry, mapping });
          }
        } else {
          if (!batches[mapping.tagId]) batches[mapping.tagId] = [];
          batches[mapping.tagId].push(entry.id);
        }
      });
    });

    // ── DIAG: raport matchowania ────────────────────────────────────────
    matchDiag.willTag    = Object.values(batches).reduce((s, ids) => s + ids.length, 0);
    matchDiag.alreadyTagged = skipped.filter(s => s.reason === 'ALREADY_TAGGED').length;
    matchDiag.conflict   = skipped.filter(s => s.reason === 'CONFLICT_IGNORED').length;

    addLog(
      `ℹ Wyniki matchowania ${matchDiag.total} wierszy vs ${matchDiag.mapSize} wzmianek w mapie:
` +
      `  ✓ do otagowania: ${matchDiag.willTag}
` +
      `  ✗ NO_MATCH: ${matchDiag.noMatch}
` +
      `  ✗ TRUNCATED_URL: ${matchDiag.truncated}
` +
      `  ↷ już otagowane: ${matchDiag.alreadyTagged}
` +
      `  ↷ konflikt (ignorowany): ${matchDiag.conflict}
` +
      `  ↷ brak assessment: ${matchDiag.noAssessment}
` +
      `  ↷ brak mappingu: ${matchDiag.noMapping}`,
      'info'
    );

    // Porównaj domeny pliku vs mapy — wykryj rozbieżności
    const fileDoms  = Object.keys(matchDiag.fileSamplesByDomain);
    const mapDoms   = Object.keys(matchDiag.mapSamplesByDomain);
    const missingInMap  = fileDoms.filter(d => !mapDoms.includes(d));
    const missingInFile = mapDoms.filter(d => !fileDoms.includes(d));

    if (missingInMap.length > 0) {
      addLog(
        `⚠ Domeny z pliku nieobecne w mapie: ${missingInMap.join(', ')}
` +
        `  → Brand24 API nie zwraca wzmianek z tych domen dla tego projektu/zakresu`,
        'warn'
      );
    }

    // Pokaż przykłady URL plik vs mapa dla każdej domeny z missem
    if (matchDiag.noMatch > 0) {
      const noMatchSamples = skipped.filter(s => s.reason === 'NO_MATCH').slice(0, 3);
      noMatchSamples.forEach(s => {
        const normVal = s.normUrl || normalizeUrl(s.url || '');
        const dom = normVal.split('/')[0];
        const mapSample = matchDiag.mapSamplesByDomain[dom];
        addLog(
          `⚠ Brak dopasowania:
` +
          `  plik: "${normVal}"
` +
          `  mapa (${dom}): ${mapSample ? '"' + mapSample[0] + '"' : 'BRAK TEJ DOMENY W MAPIE'}`,
          'warn'
        );
      });
    }

    // Handle 'ask' conflicts
    for (const conflict of conflicts) {
      const decision = await showConflictDialog(conflict);
      if (decision === 'tag') {
        if (!batches[conflict.mapping.tagId]) batches[conflict.mapping.tagId] = [];
        batches[conflict.mapping.tagId].push(conflict.entry.id);
      } else if (decision === 'overwrite') {
        const oldTagId = conflict.entry.existingTags[0]?.id;
        if (oldTagId) await bulkUntagMentions([String(conflict.entry.id)], oldTagId);
        if (!batches[conflict.mapping.tagId]) batches[conflict.mapping.tagId] = [];
        batches[conflict.mapping.tagId].push(conflict.entry.id);
      }
      // 'skip' - do nothing
    }

    // Log skipped
    let truncatedCount = 0;
    let noMatchCount   = 0;
    skipped.forEach(s => {
      if (s.reason === 'TRUNCATED_URL') {
        truncatedCount++;
        if (truncatedCount <= 5) {
          addLog(
            `⚠ [TRUNCATED_URL] URL obcięty o ${s.truncInfo.missingChars} zn. (${s.truncInfo.fileIsShorter ? 'plik krótszy' : 'mapa krótsza'})\n` +
            `  plik: "${(s.url || '').substring(0, 70)}"\n` +
            `  mapa: "${s.truncInfo.candidate.substring(0, 70)}"\n` +
            `  → Pomiń i sprawdź plik źródłowy`,
            'warn'
          );
        }
      } else if (s.reason === 'NO_MATCH') {
        noMatchCount++;
        if (noMatchCount <= 5) {
          const urlVal = s.url || '';
          const normVal = s.normUrl || normalizeUrl(urlVal);
          addLog(`⚠ Brak matcha: url="${urlVal.substring(0, 60)}" | norm="${normVal.substring(0, 50)}"`, 'warn');
        }
      }
    });
    if (truncatedCount > 5) {
      addLog(`⚠ [TRUNCATED_URL] Łącznie ${truncatedCount} obciętych URL — sprawdź plik źródłowy.`, 'warn');
    }
    if (truncatedCount > 0 && noMatchCount === 0) {
      addLog(`ℹ Wszystkie niezmatchowane URL wyglądają na obcięte. Problem w pliku źródłowym.`, 'info');
    }
    if (noMatchCount > 5) {
      addLog(`⚠ Brak matcha: ${noMatchCount} URL-i (pokazano 5). Sprawdź zakres dat i projekt.`, 'warn');
    }

    // Execute overwrite batches
    for (const [, batch] of Object.entries(overwriteBatches)) {
      for (let i = 0; i < batch.ids.length; i += MAX_BATCH_SIZE) {
        const slice = batch.ids.slice(i, i + MAX_BATCH_SIZE);
        addLog(`→ Odtagowuję ${slice.length} wzmianek (tag ${batch.oldTagId})`, 'info');
        try {
          await bulkUntagMentions(slice.map(String), batch.oldTagId);
          if (!batches[batch.newTagId]) batches[batch.newTagId] = [];
          batches[batch.newTagId].push(...slice);
        } catch (untagErr) {
          addLog(`⚠ [FALLBACK] bulkUntag batch FAILED (${slice.length} IDs, tag ${batch.oldTagId}): ${untagErr.message} — pomijam batch, wzmianki nie zostaną przepisane`, 'error');
        }
        await sleep(200);
      }
    }

    // Execute tag batches — TAG_CONCURRENCY batchów równolegle per tagId
    const tagIds = Object.keys(batches);
    let batchNum = 0;
    let totalTagFailed = 0;
    for (const tagId of tagIds) {
      const ids = batches[tagId];
      const tagName = Object.entries(state.tags).find(([, id]) => id === parseInt(tagId))?.[0] || tagId;
      const slices = [];
      for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) slices.push(ids.slice(i, i + MAX_BATCH_SIZE));
      for (let i = 0; i < slices.length; i += TAG_CONCURRENCY) {
        const concSlices = slices.slice(i, i + TAG_CONCURRENCY);
        batchNum += concSlices.length;
        updateProgress('tag', batchNum, tagIds.length);
        addLog(`→ bulkTag: ${concSlices.reduce((s, sl) => s + sl.length, 0)} → ${tagName} (${concSlices.length}× równolegle)`, 'info');
        const results = await Promise.allSettled(concSlices.map(slice => bulkTagMentions(slice.map(String), parseInt(tagId))));
        let batchSuccessCount = 0;
        for (let j = 0; j < results.length; j++) {
          if (results[j].status === 'fulfilled') {
            batchSuccessCount += concSlices[j].length;
          } else {
            // Fallback: taguj po 1 ID żeby wyizolować wadliwy rekord
            const errMsg = results[j].reason?.message || 'unknown';
            addLog(
              `⚠ [FALLBACK] Batch ${j + 1} FAILED (${concSlices[j].length} IDs → "${tagName}"): ${errMsg}\n` +
              `  → Próba fallback: tagowanie po 1 ID aby znaleźć wadliwą wzmiankę...`,
              'warn'
            );
            for (const singleId of concSlices[j]) {
              try {
                await bulkTagMentions([singleId], parseInt(tagId));
                batchSuccessCount++;
              } catch (singleErr) {
                totalTagFailed++;
                const ctx = _errContext(singleErr.message);
                addLog(
                  `✕ [FALLBACK/${ctx.src}] ID ${singleId} → "${tagName}": ${singleErr.message}\n  → ${ctx.hint}`,
                  'error'
                );
                state.failedMentions.push({
                  id: singleId,
                  tagId: parseInt(tagId),
                  tagName,
                  error: singleErr.message,
                  src: ctx.src,
                  hint: ctx.hint,
                });
              }
            }
          }
        }
        state.stats.tagged += batchSuccessCount;
        updateStatsUI();
        await sleep(200);
      }
    }
    if (totalTagFailed > 0) {
      addLog(
        `⚠ [PODSUMOWANIE] ${totalTagFailed} wzmianek nie mogło być otagowanych — wadliwe IDs lub błąd Brand24 API.\n` +
        `  → Sprawdź logi [FALLBACK] wyżej aby zobaczyć które IDs są problematyczne.`,
        'warn'
      );
    }

    // Persystuj pominięte wiersze do state (NO_MATCH, TRUNCATED_URL, NO_MAPPING, NO_ASSESSMENT)
    const _exportableReasons = new Set(['NO_MATCH', 'TRUNCATED_URL', 'NO_MAPPING', 'NO_ASSESSMENT', 'FUZZY_LONG_SKIPPED']);
    state.skippedRows.push(...skipped.filter(s => _exportableReasons.has(s.reason)));

    state.stats.skipped += skipped.length + totalTagFailed;

    const _fuzzyLongSkipped = skipped.filter(s => s.reason === 'FUZZY_LONG_SKIPPED').length;
    const _report = [
      `═══ RAPORT TAGOWANIA ═══`,
      `Rekordy wejściowe:  ${rows.length}`,
      `Exact match:        ${matchDiag.exactMatch}`,
      `Fuzzy match (safe): ${matchDiag.fuzzyShort}`,
      `Długi fuzzy (skip): ${_fuzzyLongSkipped}`,
      `Brak assessment:    ${matchDiag.noAssessment}`,
      `Brak mappingu:      ${matchDiag.noMapping}`,
      `Brak match:         ${matchDiag.noMatch - _fuzzyLongSkipped}`,
      `Obcięte URL:        ${matchDiag.truncated}`,
      `Konflikty:          ${matchDiag.conflict}`,
      `Już otagowane:      ${matchDiag.alreadyTagged}`,
      `WYKONANO tagowań:   ${matchDiag.willTag}`,
      `════════════════════════`,
    ].join('\n');
    addLog(_report, 'info');

    addLog(`✓ Partycja zakończona: ${state.stats.tagged} otagowane, ${state.stats.skipped} pominięte${totalTagFailed > 0 ? `, ${totalTagFailed} błędy fallback` : ''}`, 'success');
  }

  // ───────────────────────────────────────────
  // PARTITION MANAGEMENT
  // ───────────────────────────────────────────

  function buildPartitions(rows, colMap, partitionLimit) {
    if (rows.length <= partitionLimit) {
      return [{
        id: 1,
        dateFrom: rows.reduce((m, r) => {
          const d = (r[colMap.date] || '').substring(0, 10);
          return d && d < m ? d : m;
        }, '9999'),
        dateTo: rows.reduce((m, r) => {
          const d = (r[colMap.date] || '').substring(0, 10);
          return d > m ? d : m;
        }, '0000'),
        rows,
        status: 'pending',
      }];
    }

    // Sort by date and split
    const sorted = [...rows].sort((a, b) => {
      const da = (a[colMap.date] || '').substring(0, 10);
      const db = (b[colMap.date] || '').substring(0, 10);
      return da.localeCompare(db);
    });

    const partitions = [];
    let i = 0, partId = 1;
    while (i < sorted.length) {
      const chunk = sorted.slice(i, i + partitionLimit);
      const dates = chunk.map(r => (r[colMap.date] || '').substring(0, 10)).filter(Boolean);
      partitions.push({
        id: partId++,
        dateFrom: dates.length ? dates.reduce((m, d) => d < m ? d : m) : '',
        dateTo: dates.length ? dates.reduce((m, d) => d > m ? d : m) : '',
        rows: chunk,
        status: 'pending',
      });
      i += partitionLimit;
    }
    return partitions;
  }

  // ───────────────────────────────────────────
  // MAIN RUN LOOP
  // ───────────────────────────────────────────

  async function startRun() {
    if (!state.file || !Object.keys(state.mapping).length) {
      showError('Wgraj plik i skonfiguruj mapowanie przed startem.');
      return;
    }

    state.status = 'running';
    state.sessionStart = Date.now();
    state.stats = { tagged: 0, skipped: 0, noMatch: 0, conflicts: 0 };
    state.failedMentions = [];
    state.skippedRows = [];
    updateStatusUI();
    startSessionTimer();
    startHealthCheck();

    // Set Brand24 date filter
    const dateFrom = state.file.meta.minDate;
    const dateTo = state.file.meta.maxDate;
    if (dateFrom && dateTo) {
      const currentUrl = window.location.href;
      if (!currentUrl.includes(`d1=${dateFrom}`) || !currentUrl.includes(`d2=${dateTo}`)) {
        addLog(`→ Ustawiam zakres dat: ${dateFrom} → ${dateTo}`, 'info');
        navigateToDateRange(dateFrom, dateTo);
        // Polling zamiast hardkodowanego sleep — czekaj max 4s na zmianę URL
        for (let _w = 0; _w < 8; _w++) {
          await sleep(500);
          if (window.location.href.includes(`d1=${dateFrom}`)) break;
        }
      }
    }

    // Activate Untagged filter
    addLog('→ Aktywuję filtr Untagged', 'info');
    activateUntaggedFilter();
    await sleep(500);

    // Process partitions
    for (let idx = state.currentPartitionIdx; idx < state.partitions.length; idx++) {
      if (state.status !== 'running') break;

      state.currentPartitionIdx = idx;
      const partition = state.partitions[idx];
      partition.status = 'running';
      saveCheckpoint();
      updatePartitionUI(idx);

      addLog(`→ Partycja ${idx + 1}/${state.partitions.length}: ${partition.dateFrom} → ${partition.dateTo}`, 'info');

      try {
        await runTagging(partition);
        partition.status = 'done';
        saveCheckpoint();
      } catch (e) {
        handleError(e, `partycja ${idx + 1}`);
        return;
      }

      // Between partitions
      if (idx < state.partitions.length - 1) {
        if (state.autoPartition) {
          addLog(`⏱ Przerwa 30s przed następną partycją...`, 'info');
          await sleep(30000);
        } else {
          state.status = 'paused';
          updateStatusUI();
          addLog(`⏸ Partycja ${idx + 1} zakończona. Kliknij Start aby kontynuować.`, 'info');
          return;
        }
      }
    }

    // Done
    if (state.status === 'running') {
      state.status = 'done';
      updateStatusUI();
      addLog(`✅ Wszystkie partycje zakończone! ${state.stats.tagged} otagowane.`, 'success');
      showToast(`✅ ${state.stats.tagged} wzmianek otagowanych!`, 'success', 5000);

      // Switch view if configured
      if (state.switchViewOnDone && state.switchViewTagId) {
        addLog(`→ Przełączam widok na tag ${state.switchViewTagId}`, 'info');
        await sleep(500);
        navigateToTag(state.switchViewTagId);
      }

      // Auto-Delete after tagging if enabled
      if (state.autoDeleteEnabled && state.autoDeleteTagId) {
        const autoTagName = Object.entries(state.tags).find(([, id]) => id === state.autoDeleteTagId)?.[0] || String(state.autoDeleteTagId);
        const dateFrom = state.file?.meta?.minDate;
        const dateTo = state.file?.meta?.maxDate;
        if (dateFrom && dateTo) {
          addLog(`→ Auto-Delete: uruchamiam dla tagu "${autoTagName}"`, 'warn');
          await runAutoDeleteAfterTagging(state.autoDeleteTagId, autoTagName, dateFrom, dateTo);
        }
      }

      stopHealthCheck();
      stopSessionTimer();
      saveSessionToHistory();
      if (state.soundEnabled) playDoneSound();
      showFinalReport();
      clearCheckpoint();
    }
  }

  // ───────────────────────────────────────────
  // NAVIGATION HELPERS
  // ───────────────────────────────────────────

  function getProjectId() {
    const match = window.location.pathname.match(/\/panel\/results\/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  function navigateToDateRange(dateFrom, dateTo) {
    const url = new URL(window.location.href);
    url.searchParams.set('d1', dateFrom);
    url.searchParams.set('d2', dateTo);
    url.searchParams.set('p', '1');
    url.searchParams.set('cdt', 'days');
    url.searchParams.delete('dr');
    history.pushState({}, '', url.toString());
  }

  function navigateToTag(tagId) {
    const url = new URL(window.location.href);
    url.searchParams.set('gr', tagId);
    url.searchParams.set('p', '1');
    history.pushState({}, '', url.toString());
  }

  function activateUntaggedFilter() {
    const chips = Array.from(document.querySelectorAll('.MuiChip-root.MuiChip-clickable'));
    const untaggedChip = chips.find(c => c.textContent.trim() === 'Untagged' && !c.classList.contains('Mui-active'));
    if (untaggedChip) {
      untaggedChip.click();
    } else {
      addLog('⚠ Nie znaleziono chipa Untagged — filtr nie aktywowany. Sprawdź czy Brand24 nie zmienił interfejsu.', 'warn');
    }
  }

  // ───────────────────────────────────────────
  // CHECKPOINT & CRASH LOG
  // ───────────────────────────────────────────

  function saveCheckpoint() {
    const jobs = lsGet(LS.JOBS, {});
    if (!state.projectId) return;
    jobs[state.projectId] = {
      partitions: state.partitions,
      currentPartitionIdx: state.currentPartitionIdx,
      mapping: state.mapping,
      stats: state.stats,
      mapMode: state.mapMode,
      file: { meta: state.file?.meta, colMap: state.file?.colMap },
      savedAt: new Date().toISOString(),
    };
    lsSet(LS.JOBS, jobs);
  }

  function clearCheckpoint() {
    const jobs = lsGet(LS.JOBS, {});
    if (state.projectId) delete jobs[state.projectId];
    lsSet(LS.JOBS, jobs);
  }

  function saveCrashLog(error, lastAction) {
    const ctx = _errContext(error.message);
    const userMsg = ctx.hint + (ctx.src === 'PLUGIN' ? ' Wyślij Bug Report przez Feedback.' : '');

    // Snapshot logu sesji z momentu crashu (ostatnie 50 wpisów)
    const logSnapshot = (state.logs || []).slice(-50).map(function(l) {
      return '[' + l.time + '] [' + l.type.toUpperCase() + '] ' + l.message;
    });

    // Ostatni URL który był matchowany (z logu)
    const lastMatchLog = (state.logs || []).slice().reverse().find(function(l) {
      return l.message.includes('Brak matcha') || l.message.includes('bulkTag') || l.message.includes('Mapa');
    });

    const crashLog = {
      // Identyfikacja
      version: VERSION,
      timestamp: new Date().toISOString(),
      localTime: new Date().toLocaleString('pl-PL'),

      // Błąd
      errorType: error.message,
      stack: error.stack ? error.stack.substring(0, 1000) : '',

      // Kontekst akcji
      lastAction,
      url: window.location.href,

      // Stan sesji w momencie crashu
      session: {
        status: state.status,
        projectId: state.projectId,
        projectName: state.projectName,
        testRunMode: state.testRunMode,
        mapMode: state.mapMode,
        hasToken: !!state.tokenHeaders,
        currentPartitionIdx: state.currentPartitionIdx,
        totalPartitions: state.partitions ? state.partitions.length : null,
        currentPartitionRange: state.partitions && state.partitions[state.currentPartitionIdx]
          ? state.partitions[state.currentPartitionIdx].dateFrom + ' → ' + state.partitions[state.currentPartitionIdx].dateTo
          : null,
      },

      // Statystyki
      stats: state.stats ? {
        tagged: state.stats.tagged,
        skipped: state.stats.skipped,
        noMatch: state.stats.noMatch,
        conflicts: state.stats.conflicts,
        deleted: state.stats.deleted || 0,
      } : null,

      // Plik
      file: state.file ? {
        name: state.file.name,
        rows: state.file.rows ? state.file.rows.length : null,
        colMap: state.file.colMap,
      } : null,

      // Mapa URL
      urlMapSize: Object.keys(state.urlMap || {}).length,
      lastMatchLogEntry: lastMatchLog ? lastMatchLog.message : null,

      // Log sesji (snapshot z momentu crashu)
      logSnapshot,

      // Metadata
      recoverable: error.message !== 'TOKEN_NOT_READY',
      userMessage: userMsg,
      browser: navigator.userAgent.substring(0, 150),
    };

    lsSet(LS.CRASHLOG, crashLog);
    return crashLog;
  }

  function handleError(error, context) {
    const crash = saveCrashLog(error, context);
    const ctx = _errContext(error.message);
    stopHealthCheck();
    stopSessionTimer();
    state.status = 'error';
    updateStatusUI();
    addLog(`✕ [${ctx.src}] Błąd w: ${context} — ${error.message}\n  → ${ctx.hint}`, 'error');
    showCrashBanner(crash);
  }

  // ───────────────────────────────────────────
  // HEALTH CHECK
  // ───────────────────────────────────────────

  let healthCheckTimer = null;

  function startHealthCheck() {
    healthCheckTimer = setInterval(async () => {
      if (state.status !== 'running') return;
      try {
        await getNotifications();
      } catch {
        if (state.status === 'running') {
          handleError(new Error('HEALTH_CHECK_FAILED'), 'health check');
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  function stopHealthCheck() {
    if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  }

  // ───────────────────────────────────────────
  // SESSION TIMER
  // ───────────────────────────────────────────

  let sessionTimerInterval = null;

  function startSessionTimer() {
    sessionTimerInterval = setInterval(() => {
      const el = document.getElementById('b24t-session-timer');
      const subEl = document.getElementById('b24t-session-timer-sub');
      if ((!el && !subEl) || !state.sessionStart) return;
      const elapsed = Math.floor((Date.now() - state.sessionStart) / 1000);
      const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      const timeStr = `${h}:${m}:${s}`;
      if (el) el.textContent = timeStr;
      if (subEl) subEl.textContent = timeStr;

      // Check last action time
      if (state.lastActionTime && state.status === 'running') {
        const sinceLastAction = Date.now() - state.lastActionTime;
        if (sinceLastAction > ACTION_TIMEOUT_WARN) {
          const lastLog = document.querySelector('#b24t-log .b24t-log-entry:last-child');
          if (lastLog && !lastLog.dataset.warned) {
            lastLog.dataset.warned = '1';
            const timeEl = lastLog.querySelector('.b24t-log-elapsed');
            if (timeEl) timeEl.textContent = `(+${Math.floor(sinceLastAction / 1000)}s)`;
          }
        }
      }
    }, 1000);
  }

  function stopSessionTimer() {
    if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
  }

  // ───────────────────────────────────────────
  // LOGGING
  // ───────────────────────────────────────────

  function addLog(message, type = 'info', extra = null) {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const entry = { time, message, type, timestamp: Date.now(), extra };
    state.logs.push(entry);
    if (state.logs.length > 500) state.logs.shift(); // keep last 500 in memory
    state.lastActionTime = Date.now();

    const log = document.getElementById('b24t-log');
    if (!log) return;

    const div = document.createElement('div');
    div.className = `b24t-log-entry b24t-log-${type}`;
    div.innerHTML = `<span class="b24t-log-time">${time}</span><span class="b24t-log-msg">${message}</span><span class="b24t-log-elapsed"></span>`;
    log.appendChild(div);
    requestAnimationFrame(function() { log.scrollTop = log.scrollHeight; });

    // Keep max 200 entries in DOM
    while (log.children.length > 200) log.removeChild(log.firstChild);

    // Live-update log panel jeśli otwarty
    _syncLogPanel(entry);
  }

  // Build comprehensive bug report data
  function buildBugReportData() {
    const now = new Date();
    const recentLogs = state.logs.slice(-30).map(function(l) {
      return '[' + l.time + '] [' + l.type.toUpperCase() + '] ' + l.message;
    });
    const crashLog = lsGet(LS.CRASHLOG, null);
    return {
      version: VERSION,
      timestamp: now.toISOString(),
      localTime: now.toLocaleString('pl-PL'),
      url: window.location.href,
      projectId: state.projectId || null,
      projectName: state.projectName || null,
      sessionStatus: state.status,
      hasToken: !!state.tokenHeaders,
      testRunMode: state.testRunMode,
      mapMode: state.mapMode,
      stats: state.stats ? JSON.parse(JSON.stringify(state.stats)) : null,
      fileName: state.file ? state.file.name : null,
      fileRows: state.file ? state.file.rows.length : null,
      urlMapSize: Object.keys(state.urlMap || {}).length,
      partitions: state.partitions ? state.partitions.length : null,
      sessionStart: state.sessionStart ? new Date(state.sessionStart).toISOString() : null,
      recentLogs: recentLogs,
      crashLog: crashLog ? {
        version:    crashLog.version,
        errorType:  crashLog.errorType,
        localTime:  crashLog.localTime || crashLog.timestamp,
        lastAction: crashLog.lastAction,
        session:    crashLog.session || crashLog.state,
        stats:      crashLog.stats,
        file:       crashLog.file ? crashLog.file.name : null,
        urlMapSize: crashLog.urlMapSize,
        stack:      (crashLog.stack || crashLog.stackTrace || '').substring(0, 800),
        logSnapshot: crashLog.logSnapshot ? crashLog.logSnapshot.slice(-20) : null,
      } : null,
      browser: navigator.userAgent.substring(0, 120),
      screen: window.innerWidth + 'x' + window.innerHeight,
    };
  }

  // ───────────────────────────────────────────
  // UI HELPERS
  // ───────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 3500;
    var container = document.getElementById('b24t-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'b24t-toast-container';
      document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    toast.className = 'b24t-toast b24t-toast-' + type;
    toast.textContent = message;
    var existingCount = container.querySelectorAll('.b24t-toast').length;
    if (existingCount > 0) toast.style.animationDelay = (existingCount * 40) + 'ms';
    container.appendChild(toast);
    setTimeout(function() {
      toast.classList.add('b24t-toast-out');
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 160);
    }, duration);
  }

  // Simple session timer for Quick Tag / Quick Delete tabs
  function makeTabTimer(displayId) {
    let startTime = null;
    let interval = null;
    return {
      start() {
        startTime = Date.now();
        const el = document.getElementById(displayId);
        if (!el) return;
        interval = setInterval(() => {
          if (!startTime) return;
          const s = Math.floor((Date.now() - startTime) / 1000);
          const mm = String(Math.floor(s / 60)).padStart(2, '0');
          const ss = String(s % 60).padStart(2, '0');
          el.textContent = `${mm}:${ss}`;
        }, 1000);
      },
      stop() { clearInterval(interval); interval = null; },
      reset() {
        clearInterval(interval); interval = null; startTime = null;
        const el = document.getElementById(displayId);
        if (el) el.textContent = '00:00';
      }
    };
  }



  function updateTokenUI(found) {
    const el = document.getElementById('b24t-token-status');
    if (el) {
      el.className = found ? 'b24t-token-ok' : 'b24t-token-pending';
      el.textContent = found ? '● Token' : '● Token';
    }
  }

  function updateStatusUI() {
    const el = document.getElementById('b24t-status-badge');
    if (!el) return;
    const map = {
      idle: ['Idle', 'badge-idle'],
      running: ['⟳ Running', 'badge-running'],
      paused: ['Paused', 'badge-paused'],
      error: ['⚠ Error', 'badge-error'],
      done: ['✓ Done', 'badge-done'],
    };
    const [text, cls] = map[state.status] || ['Idle', 'badge-idle'];
    el.textContent = text;
    el.className = `b24t-badge ${cls}`;

    const bar = document.getElementById('b24t-progress-bar');
    if (bar) bar.classList.toggle('b24t-running', state.status === 'running');

    const lbl = document.getElementById('b24t-progress-label');
    if (lbl) {
      if (state.status === 'idle')    { lbl.textContent = 'Gotowy do startu'; lbl.style.color = 'var(--b24t-text-faint)'; }
      if (state.status === 'done')    { lbl.textContent = '✓ Zakończono';     lbl.style.color = 'var(--b24t-ok)'; }
      if (state.status === 'error')   {                                         lbl.style.color = 'var(--b24t-err)'; }
      if (state.status === 'paused')  {                                         lbl.style.color = 'var(--b24t-warn)'; }
      if (state.status === 'running') {                                         lbl.style.color = 'var(--b24t-text)'; }
    }

    const startBtn = document.getElementById('b24t-btn-start');
    const pauseBtn = document.getElementById('b24t-btn-pause');
    if (startBtn) startBtn.textContent = state.status === 'paused' ? 'Wznów' : 'Start';
    if (pauseBtn) pauseBtn.disabled = state.status !== 'running';
  }

  function updateStatsUI() {
    const els = {
      tagged: document.getElementById('b24t-stat-tagged'),
      skipped: document.getElementById('b24t-stat-skipped'),
      remaining: document.getElementById('b24t-stat-remaining'),
    };
    function _pop(el) {
      if (!el) return;
      el.classList.remove('b24t-stat-pop');
      void el.offsetHeight;
      el.classList.add('b24t-stat-pop');
      setTimeout(function() { el.classList.remove('b24t-stat-pop'); }, 350);
    }
    const prevTagged  = els.tagged  ? (parseInt(els.tagged.textContent)  || 0) : 0;
    const prevSkipped = els.skipped ? (parseInt(els.skipped.textContent) || 0) : 0;

    if (els.tagged)  els.tagged.textContent  = state.stats.tagged;
    if (els.skipped) els.skipped.textContent = state.stats.skipped + state.stats.noMatch;

    if (state.stats.tagged > prevTagged)                                   _pop(els.tagged);
    if ((state.stats.skipped + state.stats.noMatch) > prevSkipped)         _pop(els.skipped);

    // Remaining = total file rows - tagged - skipped
    const total = state.file?.rows?.length || 0;
    const done = state.stats.tagged + state.stats.skipped + state.stats.noMatch;
    if (els.remaining) els.remaining.textContent = Math.max(0, total - done);
  }

  function _makeBarSmoother(getId, lerpFactor) {
    lerpFactor = lerpFactor || 0.12;
    var cur = 0, tgt = 0, raf = null;
    function _apply() {
      var el = getId();
      if (el) el.style.width = cur.toFixed(2) + '%';
    }
    function tick() {
      var diff = tgt - cur;
      if (Math.abs(diff) < 0.15) { cur = tgt; _apply(); raf = null; return; }
      cur += diff * lerpFactor;
      _apply();
      raf = requestAnimationFrame(tick);
    }
    return {
      set: function(pct) {
        tgt = Math.min(100, Math.max(0, pct));
        if (!raf) raf = requestAnimationFrame(tick);
      },
      reset: function() {
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        cur = 0; tgt = 0; _apply();
      }
    };
  }

  var _barMain, _barNews, _barDel, _barDelView, _barQt;
  function _getBarMain()    { return _barMain    || (_barMain    = _makeBarSmoother(function() { return document.getElementById('b24t-progress-bar'); })); }
  function _getBarNews()    { return _barNews    || (_barNews    = _makeBarSmoother(function() { return document.getElementById('b24t-news-progress-bar'); })); }
  function _getBarDel()     { return _barDel     || (_barDel     = _makeBarSmoother(function() { return document.getElementById('b24t-del-progress'); })); }
  function _getBarDelView() { return _barDelView || (_barDelView = _makeBarSmoother(function() { return document.getElementById('b24t-delview-progress'); })); }
  function _getBarQt()      { return _barQt      || (_barQt      = _makeBarSmoother(function() { return document.getElementById('b24t-qt-progress'); })); }

  function updateProgress(phase, current, total) {
    const label = document.getElementById('b24t-progress-label');
    if (!label) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    label.textContent = phase === 'map'
      ? `Budowanie mapy: ${current}/${total}`
      : `Tagowanie: batch ${current}/${total}`;
    if (current === 0) _getBarMain().reset(); else _getBarMain().set(pct);
  }

  function updatePartitionUI(idx) {
    const el = document.getElementById('b24t-partition-info');
    if (!el) return;
    const p = state.partitions[idx];
    if (!p) return;
    el.textContent = `Partycja ${idx + 1}/${state.partitions.length} · ${p.rows.length} wzmianek`;
  }

  function showError(msg) {
    addLog(`✕ ${msg}`, 'error');
    alert(`B24 Tagger BETA: ${msg}`);
  }

  function showCrashBanner(crash) {
    const banner = document.getElementById('b24t-crash-banner');
    if (!banner) return;
    banner.style.display = 'block';

    const msg = banner.querySelector('.b24t-crash-msg');
    if (msg) {
      msg.innerHTML =
        '<strong style="color:#f87171;">' + (crash.errorType || 'Błąd') + '</strong> ' +
        '· ' + (crash.localTime || crash.timestamp || '') + '<br>' +
        '<span style="color:#9090bb;">' + (crash.userMessage || '') + '</span>';
    }

    // Szczegoly techniczne - czytelny format
    const detail = banner.querySelector('.b24t-crash-detail');
    if (detail) {
      const session = crash.session || crash.state || {};
      const stats = crash.stats || {};
      const lines = [
        '=== CRASH REPORT v' + (crash.version || '?') + ' ===',
        'Czas:       ' + (crash.localTime || crash.timestamp || '?'),
        'Błąd:       ' + (crash.errorType || '?'),
        'Akcja:      ' + (crash.lastAction || '?'),
        'URL:        ' + (crash.url || window.location.href),
        '',
        '=== SESJA ===',
        'Projekt:    ' + (session.projectName || '?') + ' (' + (session.projectId || '?') + ')',
        'Status:     ' + (session.status || '?') + (session.testRunMode ? ' [TEST]' : ''),
        'Token:      ' + (session.hasToken ? 'aktywny' : 'BRAK'),
        'Partycja:   ' + (session.currentPartitionIdx !== undefined ? (session.currentPartitionIdx + 1) + '/' + (session.totalPartitions || '?') : '?'),
        'Zakres:     ' + (session.currentPartitionRange || '?'),
        'Mapa URL:   ' + (crash.urlMapSize || 0) + ' wzmianek',
        '',
        '=== STATYSTYKI ===',
        'Otagowano:  ' + (stats.tagged || 0),
        'Pominięto:  ' + (stats.skipped || 0),
        'Brak matcha:' + (stats.noMatch || 0),
        '',
        '=== PLIK ===',
        crash.file ? (crash.file.name + ' (' + crash.file.rows + ' wierszy)') : '—',
        '',
        '=== STACK TRACE ===',
        (crash.stack || crash.stackTrace || '—').substring(0, 800),
        '',
        '=== OSTATNIE LOGI ===',
        (crash.logSnapshot || []).slice(-15).join('\n') || '—',
      ];
      detail.textContent = lines.join('\n');
    }

    // Dodaj przycisk "Wyślij Bug Report" do bannera jeśli nie ma
    const actions = banner.querySelector('.b24t-crash-actions');
    if (actions && !actions.querySelector('#b24t-crash-bugreport')) {
      const btn = document.createElement('button');
      btn.id = 'b24t-crash-bugreport';
      btn.className = 'b24t-btn-secondary';
      btn.style.cssText = 'font-size:10px;padding:4px 8px;color:#f87171;border-color:#f87171;';
      btn.textContent = '🐛 Wyślij Bug Report';
      btn.addEventListener('click', function() {
        sendBugReport('Auto-report z crash bannera: ' + (crash.errorType || '?'), function() {
          btn.textContent = '✓ Wysłano';
          btn.disabled = true;
        });
      });
      actions.appendChild(btn);
    }
  }

  function showFinalReport() {
    const modal = document.getElementById('b24t-report-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    const content = modal.querySelector('.b24t-report-content');
    if (!content) return;
    const elapsed = state.sessionStart ? Math.floor((Date.now() - state.sessionStart) / 1000) : 0;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const failed = state.failedMentions || [];
    const skippedRows = state.skippedRows || [];

    // Sekcja pominiętych wierszy z pliku
    let skippedHtml = '';
    if (skippedRows.length > 0) {
      const byReason = {};
      skippedRows.forEach(s => { byReason[s.reason] = (byReason[s.reason] || 0) + 1; });
      const reasonLabels = {
        'NO_MATCH':      'Brak URL w Brand24',
        'TRUNCATED_URL': 'URL obcięty',
        'NO_MAPPING':    'Brak mapowania oceny',
        'NO_ASSESSMENT': 'Brak oceny',
      };
      const reasonRows = Object.entries(byReason).map(([r, n]) =>
        `<span style="margin-right:10px"><strong style="color:#f1f5f9">${n}×</strong> <span style="color:#94a3b8">${reasonLabels[r] || r}</span></span>`
      ).join('');
      skippedHtml = `
        <div style="margin-top:10px;border:1px solid rgba(99,102,241,0.35);border-radius:6px;overflow:hidden">
          <div style="background:rgba(99,102,241,0.1);padding:7px 10px;display:flex;align-items:center;justify-content:space-between">
            <div style="font-size:13px">${reasonRows}</div>
            <button onclick="window.B24Tagger.exportSkippedMentions()" style="background:rgba(99,102,241,0.2);color:#818cf8;border:1px solid rgba(99,102,241,0.4);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer">Pobierz CSV z powodami</button>
          </div>
          <div style="padding:6px 10px;font-size:11px;color:#64748b">
            Plik CSV zawiera oryginalne wiersze z pliku + kolumny: <em>powód_pominięcia</em>, <em>szczegóły</em>, <em>url_znormalizowany</em>
          </div>
        </div>`;
    }

    let failedHtml = '';
    if (failed.length > 0) {
      const srcColors = { BRAND24: '#f59e0b', SIEĆ: '#6366f1', AUTORYZACJA: '#ef4444', PLIK: '#3b82f6', PLUGIN: '#ec4899' };
      const rows = failed.map(f => {
        const color = srcColors[f.src] || '#888';
        return `<tr style="border-bottom:1px solid rgba(128,128,128,0.15)">
          <td style="padding:4px 6px;font-family:monospace;font-size:11px;color:#94a3b8">${f.id}</td>
          <td style="padding:4px 6px;font-size:12px">${f.tagName}</td>
          <td style="padding:4px 6px"><span style="background:${color};color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:600">${f.src}</span></td>
          <td style="padding:4px 6px;font-size:11px;color:#94a3b8;max-width:200px;word-break:break-word">${f.error}</td>
          <td style="padding:4px 6px;font-size:11px;color:#cbd5e1;max-width:220px">${f.hint}</td>
        </tr>`;
      }).join('');
      failedHtml = `
        <div style="margin-top:12px;border:1px solid rgba(239,68,68,0.35);border-radius:6px;overflow:hidden">
          <div style="background:rgba(239,68,68,0.12);padding:7px 10px;display:flex;align-items:center;justify-content:space-between">
            <strong style="color:#ef4444;font-size:13px">⚠ ${failed.length} wzmianki nie mogły być otagowane</strong>
            <button onclick="window.B24Tagger.exportFailedMentions()" style="background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid rgba(239,68,68,0.4);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer">Eksportuj CSV</button>
          </div>
          <div style="overflow-x:auto;max-height:220px;overflow-y:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:rgba(0,0,0,0.15);text-align:left">
                <th style="padding:5px 6px;font-size:10px;color:#94a3b8">ID wzmianki</th>
                <th style="padding:5px 6px;font-size:10px;color:#94a3b8">Tag</th>
                <th style="padding:5px 6px;font-size:10px;color:#94a3b8">Źródło błędu</th>
                <th style="padding:5px 6px;font-size:10px;color:#94a3b8">Komunikat Brand24</th>
                <th style="padding:5px 6px;font-size:10px;color:#94a3b8">Co zrobić</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }

    content.innerHTML = `
      <h3>Raport sesji</h3>
      <div class="b24t-report-row"><span>Otagowano:</span><strong>${state.stats.tagged}</strong></div>
      <div class="b24t-report-row"><span>Pominięto:</span><strong>${state.stats.skipped}</strong></div>
      <div class="b24t-report-row"><span>Brak matcha:</span><strong>${state.stats.noMatch}</strong></div>
      <div class="b24t-report-row"><span>Konflikty:</span><strong>${state.stats.conflicts}</strong></div>
      ${failed.length > 0 ? `<div class="b24t-report-row"><span>Błędy fallback:</span><strong style="color:#ef4444">${failed.length}</strong></div>` : ''}
      ${skippedRows.length > 0 ? `<div class="b24t-report-row"><span>Pominięte wiersze:</span><strong style="color:#818cf8">${skippedRows.length}</strong></div>` : ''}
      <div class="b24t-report-row"><span>Czas sesji:</span><strong>${mins}m ${secs}s</strong></div>
      ${skippedHtml}
      ${failedHtml}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button onclick="window.B24Tagger.exportReport()" class="b24t-btn-secondary" style="flex:1">Eksportuj logi CSV</button>
        <button onclick="document.getElementById('b24t-report-modal').style.display='none'" class="b24t-btn-primary" style="flex:1">Zamknij</button>
      </div>
    `;
  }

  async function showConflictDialog(conflict) {
    return new Promise(resolve => {
      const existingTagName = conflict.entry.existingTags.map(t => t.title).join(', ');
      const newTagName = conflict.mapping.tagName;
      const text = (conflict.row[state.file.colMap.text] || '').substring(0, 60);

      const modal = document.createElement('div');
      modal.className = 'b24t-modal-overlay';
      modal.innerHTML = `
        <div class="b24t-modal">
          <div class="b24t-modal-title">⚠ Konflikt tagu</div>
          <div class="b24t-modal-text">
            <strong>Wzmianka:</strong> "${text}..."<br>
            <strong>Obecny tag:</strong> ${existingTagName}<br>
            <strong>Nowy tag:</strong> ${newTagName}
          </div>
          <div class="b24t-modal-actions">
            <button data-action="skip" class="b24t-btn-secondary">Zachowaj ${existingTagName}</button>
            <button data-action="overwrite" class="b24t-btn-warn">Zamień na ${newTagName}</button>
            <button data-action="tag" class="b24t-btn-primary">Dodaj ${newTagName}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          document.body.removeChild(modal);
          resolve(btn.dataset.action);
        });
      });
    });
  }

  // ───────────────────────────────────────────
  // EXPORT
  // ───────────────────────────────────────────

  function exportReport() {
    const rows = [['czas', 'typ', 'wiadomość']];
    state.logs.forEach(l => rows.push([l.time, l.type, l.message]));
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `b24tagger_report_${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  function exportFailedMentions() {
    const failed = state.failedMentions || [];
    if (!failed.length) { addLog('ℹ Brak wadliwych wzmianek do eksportu.', 'info'); return; }
    const rows = [['id_wzmianki', 'tag', 'tagId', 'zrodlo_bledu', 'komunikat', 'co_zrobic']];
    failed.forEach(f => rows.push([f.id, f.tagName, f.tagId, f.src, f.error, f.hint]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `b24tagger_failed_${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
    addLog(`✓ Eksport: ${failed.length} wadliwych wzmianek → b24tagger_failed_*.csv`, 'success');
  }

  function exportSkippedMentions() {
    const skipped = state.skippedRows || [];
    if (!skipped.length) { addLog('ℹ Brak pominiętych wierszy do eksportu.', 'info'); return; }

    // Zbierz wszystkie kolumny z oryginalnych wierszy pliku
    const allCols = new Set();
    skipped.forEach(s => { if (s.row) Object.keys(s.row).forEach(k => allCols.add(k)); });
    const origCols = [...allCols];

    const reasonLabels = {
      'NO_MATCH':      'Brak dopasowania URL w Brand24',
      'TRUNCATED_URL': 'URL obcięty (Excel/XLSX)',
      'NO_MAPPING':    'Ocena bez przypisanego tagu',
      'NO_ASSESSMENT': 'Brak oceny w wierszu',
    };

    const headers = [...origCols, 'powód_pominięcia', 'szczegóły', 'url_znormalizowany'];
    const rows = skipped.map(s => {
      const rowData = origCols.map(c => s.row ? (s.row[c] != null ? s.row[c] : '') : '');
      const reason = reasonLabels[s.reason] || s.reason;
      let detail = s.hint || '';
      if (!detail) {
        if (s.reason === 'NO_MAPPING')    detail = `Ocena "${s.assessment}" nie ma przypisanego tagu — sprawdź mapowanie w wtyczce`;
        if (s.reason === 'NO_ASSESSMENT') detail = 'Wiersz nie ma wartości w kolumnie oceny — uzupełnij lub usuń wiersz';
      }
      const normUrl = s.normUrl || (s.url ? normalizeUrl(s.url) : '');
      return [...rowData, reason, detail, normUrl];
    });

    const csv = [headers, ...rows].map(r =>
      r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `b24tagger_skipped_${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
    addLog(`✓ Eksport: ${skipped.length} pominiętych wierszy → b24tagger_skipped_*.csv`, 'success');
  }

  function exportPartitions() {
    if (!state.partitions.length) return;
    const rows = [['partycja', 'dateFrom', 'dateTo', 'wzmianek', 'status']];
    state.partitions.forEach(p => rows.push([p.id, p.dateFrom, p.dateTo, p.rows.length, p.status]));
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `b24tagger_partitions_${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // ───────────────────────────────────────────
  // DEBUG BRIDGE
  // ───────────────────────────────────────────

  _win.B24Tagger = window.B24Tagger = {
    state,
    version: VERSION,
    exportFailedMentions,
    exportSkippedMentions,
    debug: {
      getState: () => JSON.parse(JSON.stringify({ ...state, urlMap: `[${Object.keys(state.urlMap).length} entries]`, logs: `[${state.logs.length} entries]` })),
      sniffUiTag: () => { state._sniffUiTag = true; addLog('[SNIFF] Aktywny — otaguj teraz wzmiankę ręcznie w UI Brand24', 'info'); },
      getLogs: () => state.logs,
      getCrashLog: () => lsGet(LS.CRASHLOG),
      getUrlMap: () => ({ size: Object.keys(state.urlMap).length, sample: Object.entries(state.urlMap).slice(0, 3) }),
      testGraphQL: async () => { try { await getNotifications(); return 'OK'; } catch (e) { return `FAIL: ${e.message}`; } },
      retryLastAction: () => { if (state.status === 'paused' || state.status === 'error') { state.status = 'running'; updateStatusUI(); startRun(); } },
      forceStop: () => { state.status = 'idle'; updateStatusUI(); stopHealthCheck(); addLog('⏹ Awaryjne zatrzymanie.', 'warn'); },
      clearCheckpoint: () => { clearCheckpoint(); addLog('🗑 Checkpoint wyczyszczony.', 'info'); },
      getToken: () => state.tokenHeaders,
      checkForUpdate: (manual) => checkForUpdate(manual),
      stressTestBulk: async function(tagId, dateFrom, dateTo) {
        // Stress test batch size: [300, 500, 1000, 1500, 2000] z sleep=500ms między parami tag/untag
        if (!tagId) { addLog('[STRESS/BULK] Użycie: stressTestBulk(tagId, dateFrom?, dateTo?)', 'warn'); return; }
        const dFrom = dateFrom || getAnnotatorDates().dateFrom;
        const dTo   = dateTo   || getAnnotatorDates().dateTo;
        const batchSizes = [300, 500, 1000, 1500, 2000];
        const results = [];
        addLog(`[STRESS/BULK] Zbieram ID z projektu ${state.projectId} (${dFrom}→${dTo})...`, 'info');
        state.status = 'running';
        const map = await buildUrlMap(dFrom, dTo, false);
        state.status = 'idle';
        const allIds = Object.values(map).map(function(v) { return String(v.id); });
        addLog(`[STRESS/BULK] Zebrano ${allIds.length} ID. Testuję batch sizes: ${batchSizes.join(', ')}`, 'info');
        for (const bs of batchSizes) {
          const testIds = allIds.slice(0, Math.min(bs, allIds.length));
          addLog(`[STRESS/BULK] batch=${testIds.length} — tagowanie...`, 'info');
          const tTag = Date.now();
          try {
            await bulkTagMentions(testIds, tagId);
            const tagMs = Date.now() - tTag;
            addLog(`[STRESS/BULK] batch=${testIds.length}: TAG OK ${tagMs}ms`, 'info');
            await sleep(500);
            const tUntag = Date.now();
            await bulkUntagMentions(testIds, tagId);
            const untagMs = Date.now() - tUntag;
            addLog(`[STRESS/BULK] batch=${testIds.length}: UNTAG OK ${untagMs}ms`, 'info');
            results.push({ bs: testIds.length, tagMs, untagMs, ok: true });
          } catch(e) {
            addLog(`[STRESS/BULK] batch=${testIds.length}: FAIL — ${e.message}`, 'warn');
            results.push({ bs: testIds.length, ok: false, error: e.message });
            try { await bulkUntagMentions(testIds, tagId); } catch(_) {}
          }
          if (bs !== batchSizes[batchSizes.length - 1]) await sleep(2000);
        }
        addLog('[STRESS/BULK] ═══ WYNIKI BATCH SIZE ═══', 'info');
        results.forEach(function(r) {
          if (r.ok) addLog(`  batch=${r.bs}: tag=${r.tagMs}ms | untag=${r.untagMs}ms`, 'info');
          else addLog(`  batch=${r.bs}: FAIL — ${r.error}`, 'warn');
        });
        return results;
      },
      stressTestBulkSleep: async function(tagId, batchSize, dateFrom, dateTo) {
        // Stress test sleep: jak długo trzeba czekać między requestami bulk?
        // Uruchamia pary tag→untag z różnymi sleep między nimi: 0, 100, 200, 500ms
        if (!tagId) { addLog('[STRESS/SLEEP] Użycie: stressTestBulkSleep(tagId, batchSize?, dateFrom?, dateTo?)', 'warn'); return; }
        const bs = batchSize || 200;
        const dFrom = dateFrom || getAnnotatorDates().dateFrom;
        const dTo   = dateTo   || getAnnotatorDates().dateTo;
        const sleepValues = [0, 100, 200, 500];
        const results = [];
        addLog(`[STRESS/SLEEP] Zbieram ID z projektu ${state.projectId}...`, 'info');
        state.status = 'running';
        const map = await buildUrlMap(dFrom, dTo, false);
        state.status = 'idle';
        const allIds = Object.values(map).map(function(v) { return String(v.id); }).slice(0, bs);
        addLog(`[STRESS/SLEEP] Testuję sleep: ${sleepValues.join(', ')}ms | batch=${allIds.length}`, 'info');
        for (const sleepMs of sleepValues) {
          addLog(`[STRESS/SLEEP] sleep=${sleepMs}ms — tag...`, 'info');
          try {
            const t0 = Date.now();
            await bulkTagMentions(allIds, tagId);
            const tagMs = Date.now() - t0;
            await sleep(sleepMs);
            const t1 = Date.now();
            await bulkUntagMentions(allIds, tagId);
            const untagMs = Date.now() - t1;
            addLog(`[STRESS/SLEEP] sleep=${sleepMs}ms: TAG ${tagMs}ms | UNTAG ${untagMs}ms — OK`, 'info');
            results.push({ sleepMs, tagMs, untagMs, ok: true });
          } catch(e) {
            addLog(`[STRESS/SLEEP] sleep=${sleepMs}ms: FAIL — ${e.message}`, 'warn');
            results.push({ sleepMs, ok: false, error: e.message });
            try { await bulkUntagMentions(allIds, tagId); } catch(_) {}
          }
          if (sleepMs !== sleepValues[sleepValues.length - 1]) await sleep(3000);
        }
        addLog('[STRESS/SLEEP] ═══ WYNIKI SLEEP TEST ═══', 'info');
        results.forEach(function(r) {
          if (r.ok) addLog(`  sleep=${r.sleepMs}ms: tag=${r.tagMs}ms | untag=${r.untagMs}ms`, 'info');
          else addLog(`  sleep=${r.sleepMs}ms: FAIL — ${r.error}`, 'warn');
        });
        return results;
      },
      stressTestBuildUrlMap: async function(dateFrom, dateTo) {
        const levels = [1, 2, 3, 5];
        const results = [];
        addLog('[STRESS] Rozpoczynam stress test buildUrlMap — concurrency: ' + levels.join('→'), 'info');
        const prevStatus = state.status;
        for (const c of levels) {
          MAP_FETCH_CONCURRENCY = c;
          state.status = 'running';
          const dates = (dateFrom && dateTo) ? { dateFrom, dateTo } : getAnnotatorDates();
          addLog(`[STRESS] concurrency=${c} — start (${dates.dateFrom} → ${dates.dateTo})`, 'info');
          const t0 = Date.now();
          let mapResult = {};
          try { mapResult = await buildUrlMap(dates.dateFrom, dates.dateTo, false); } catch(e) { addLog(`[STRESS] concurrency=${c} BŁĄD: ${e.message}`, 'warn'); }
          state.status = 'idle';
          const elapsed = Date.now() - t0;
          const size = Object.keys(mapResult).length;
          results.push({ concurrency: c, elapsed, size });
          addLog(`[STRESS] concurrency=${c}: ${elapsed}ms | wzmianek=${size}`, 'info');
          if (c !== levels[levels.length - 1]) await sleep(3000);
        }
        MAP_FETCH_CONCURRENCY = 3;
        state.status = prevStatus;
        addLog('[STRESS] ═══ WYNIKI STRESS TEST buildUrlMap ═══', 'info');
        results.forEach(r => addLog(`  concurrency=${r.concurrency}: ${r.elapsed}ms | ${r.size} wzmianek`, 'info'));
        return results;
      },
      netMonitor: function(shortcodes) {
        const sc = Array.isArray(shortcodes) ? shortcodes : [shortcodes];
        state._netMonitor = { targetShortcodes: sc, found: new Set() };
        addLog('[NET_MONITOR] Aktywny — monitoruję: ' + sc.join(', '), 'info');
      },
      netMonitorStop: function() {
        state._netMonitor = null;
        addLog('[NET_MONITOR] Wyłączony.', 'info');
      },
      // Skanuje URL tak samo jak News moduł — zwraca status, score, matched chips i snippet
      testUrlScan: function(url, chips) {
        var kw = chips || [];
        if (typeof kw === 'string') kw = [kw];
        if (!kw.length) {
          console.warn('[B24T] testUrlScan: podaj chips, np. B24Tagger.debug.testUrlScan("https://...", ["słowo"])');
          return Promise.resolve(null);
        }
        console.log('[B24T] Skanuję URL:', url);
        console.log('[B24T] Szukane chipy:', kw);
        return _newsContentScan(url, kw).then(function(r) {
          console.log('[B24T] STATUS:', r.status, '| SCORE:', r.score);
          console.log('[B24T] Typ strony:', r.pageType, '| Sygnały:', (r.pageTypeSignals || []).join(', ') || '(brak)');
          console.log('[B24T] Znalezione chipy:', r.matchedChips.length ? r.matchedChips.join(', ') : '(brak)');
          console.log('[B24T] Tytuł:', r.title || '(brak)');
          console.log('[B24T] Snippet:', r.snippet || '(brak)');
          return r;
        });
      },
      // Pobiera surowy HTML i pokazuje co plugin faktycznie widzi (przed parsowaniem)
      testUrlRaw: function(url) {
        console.log('[B24T] Pobieram surowy HTML:', url);
        return new Promise(function(resolve) {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
            timeout: 15000,
            onload: function(resp) {
              var info = { httpStatus: resp.status, htmlLength: (resp.responseText || '').length };
              try {
                var doc = (new DOMParser()).parseFromString(resp.responseText, 'text/html');
                info.title    = ((doc.querySelector('title') || {}).textContent || '').trim();
                info.h1       = ((doc.querySelector('h1') || {}).textContent || '').trim();
                info.hasArticle = !!doc.querySelector('article');
                info.hasMain    = !!doc.querySelector('main');
                info.cookieEls  = doc.querySelectorAll('[class*="cookie"],[class*="consent"],[id*="cookie"],[id*="consent"]').length;
                info.pCount     = doc.querySelectorAll('p').length;
                var bodyEl = doc.querySelector('article') || doc.querySelector('main') || doc.body;
                info.bodyStart  = bodyEl ? bodyEl.textContent.trim().slice(0, 400) : '';
              } catch(e) { info.parseError = e.message; }
              console.log('[B24T] HTTP status:', info.httpStatus, '| Długość HTML:', info.htmlLength, 'znaków');
              console.log('[B24T] <title>:', info.title);
              console.log('[B24T] <h1>:', info.h1);
              console.log('[B24T] <article>:', info.hasArticle, '| <main>:', info.hasMain);
              console.log('[B24T] <p> na stronie:', info.pCount, '| elementy cookie/consent:', info.cookieEls);
              console.log('[B24T] Tekst body (pierwsze 400 znaków):', info.bodyStart);
              resolve(info);
            },
            onerror: function() { console.log('[B24T] Raw fetch: BŁĄD SIECI'); resolve({ error: 'network error' }); },
            ontimeout: function() { console.log('[B24T] Raw fetch: TIMEOUT'); resolve({ error: 'timeout' }); },
          });
        });
      },
      naDebug: function() {
        var stats = lsGet(LS.NA_SESSION_STATS, []);
        var agg = newsState.sessionId ? _naAggSession() : null;
        console.log('[B24T_NA] Session:', newsState.sessionId || 'brak', '| Sesje w LS:', stats.length);
        if (agg) console.log('[B24T_NA] Bieżąca sesja (live):', agg);
        if (console.table && stats.length) console.table(stats);
        return { savedSessions: stats, currentSession: agg };
      },
      naCompute: function(filters) {
        var result = _naCompute(filters);
        console.log('[B24T_NA] _naCompute result:', result);
        return result;
      },
    },
    exportReport,
    exportPartitions,
    exportAuditReport: () => {
      const r = window.B24Tagger._lastAuditResult;
      if (!r) { addLog('Brak wyników Audit Mode.', 'warn'); return; }
      const rows = [['status','url','expected','actual']];
      r.alreadyTagged.forEach(u => rows.push(['OK', u, '', '']));
      r.untagged.forEach(e => rows.push(['UNTAGGED', e.url || e, e.expected || '', '']));
      r.taggedWrong.forEach(e => rows.push(['WRONG_TAG', e.url, e.expected, e.actual]));
      r.notFound.forEach(u => rows.push(['NOT_FOUND', u, '', '']));
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'b24tagger_audit_' + Date.now() + '.csv';
      a.click(); URL.revokeObjectURL(url);
    },
  };
  _win.b24tagger = _win.B24Tagger; // lowercase alias dla wygody konsoli

  // ───────────────────────────────────────────
  // UI - STYLES
  // ───────────────────────────────────────────

  function injectStyles() {
    // Wczytaj Geist z Google Fonts (jeśli jeszcze nie ma)
    if (!document.getElementById('b24t-geist-font')) {
      const link = document.createElement('link');
      link.id = 'b24t-geist-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&display=swap';
      document.head.appendChild(link);
    }
    const style = document.createElement('style');
    style.textContent = `
      /* =====================================================================
         B24 TAGGER — DESIGN SYSTEM v0.7.0
         Light mode: Brand24 white+grey+green, full panel gradient feel
         Dark mode:  rich indigo/violet, multi-gradient sections
         ===================================================================== */

      /* ── LIGHT MODE (default) — WYSOKI KONTRAST v0.8 ── */
      :root, [data-b24t-theme="light"] {
        --b24t-bg:          #ffffff;
        --b24t-bg-deep:     #f2f4f8;
        --b24t-bg-elevated: #f8f9fc;
        --b24t-bg-input:    #eaecf4;
        --b24t-bg-section-a: #ffffff;
        --b24t-bg-section-b: #f6f7fb;
        --b24t-bg-section-c: #eef0f8;
        --b24t-border:      #c8cde0;
        --b24t-border-sub:  #dde0ef;
        --b24t-border-strong: #9098c8;

        /* Atramentowy tekst — wyraźny kontrast na białym */
        --b24t-text:        #111827;
        --b24t-text-muted:  #374151;
        --b24t-text-faint:  #6b7280;
        --b24t-text-label:  #1e40af;
        --b24t-text-meta:   #4b5563;

        /* Brand24-blue primary — czytelny na białym tle, wyraźny */
        --b24t-primary:     #2563eb;
        --b24t-primary-h:   #1d4ed8;
        --b24t-primary-glow: rgba(37,99,235,0.20);
        --b24t-primary-bg:  rgba(37,99,235,0.07);

        /* Gradient: Brand24 niebieski → Brand24 zielony */
        --b24t-accent-grad: linear-gradient(135deg, #1d6fe8 0%, #0ea875 50%, #16a34a 100%);
        --b24t-panel-grad:  linear-gradient(180deg, #f0f7ff 0%, #f0fdf6 60%, #ecfdf5 100%);
        --b24t-section-grad-a: #ffffff;
        --b24t-section-grad-b: #f6faf8;
        --b24t-section-grad-c: #eef7f2;
        --b24t-section-grad-d: #f0f9ff;

        --b24t-ok:          #166534;
        --b24t-ok-bg:       #dcfce7;
        --b24t-ok-text:     #14532d;
        --b24t-warn:        #92400e;
        --b24t-warn-bg:     #fef3c7;
        --b24t-warn-text:   #78350f;
        --b24t-err:         #991b1b;
        --b24t-err-bg:      #fee2e2;
        --b24t-err-text:    #7f1d1d;
        --b24t-info:        #1e40af;
        --b24t-info-bg:     #dbeafe;
        --b24t-info-text:   #1e3a8a;

        --b24t-shadow:      0 4px 16px rgba(22,163,74,0.10), 0 1px 4px rgba(37,99,235,0.08);
        --b24t-shadow-h:    0 8px 28px rgba(22,163,74,0.14), 0 2px 8px rgba(37,99,235,0.10);
        --b24t-shadow-drag: 0 16px 48px rgba(14,168,117,0.18);

        --b24t-scrollbar:   #c4cae8;
        --b24t-badge-idle-bg:  #e8eaf6; --b24t-badge-idle-fg: #374151;
        --b24t-badge-run-bg:   #dcfce7; --b24t-badge-run-fg:  #14532d;
        --b24t-badge-pause-bg: #fef3c7; --b24t-badge-pause-fg:#78350f;
        --b24t-badge-err-bg:   #fee2e2; --b24t-badge-err-fg:  #7f1d1d;
        --b24t-badge-done-bg:  #dbeafe; --b24t-badge-done-fg: #1e3a8a;
      }

      /* ── DARK MODE ── */
      [data-b24t-theme="dark"] {
        --b24t-bg:          #0d0d14;
        --b24t-bg-deep:     #0a0a10;
        --b24t-bg-elevated: #131320;
        --b24t-bg-input:    #191926;
        --b24t-bg-section-a: #0d0d14;
        --b24t-bg-section-b: #101018;
        --b24t-bg-section-c: #13131e;
        --b24t-border:      #282840;
        --b24t-border-sub:  #1c1c2e;
        --b24t-border-strong: #3a3a5a;

        --b24t-text:        #e8e8f4;
        --b24t-text-muted:  #c0c0e0;
        --b24t-text-faint:  #7070a8;
        --b24t-text-label:  #a0a8f0;
        --b24t-text-meta:   #8888c0;

        --b24t-primary:     oklch(65% 0.12 200);
        --b24t-primary-h:   oklch(72% 0.12 200);
        --b24t-primary-glow: oklch(65% 0.12 200 / 0.28);
        --b24t-primary-bg:  oklch(65% 0.12 200 / 0.12);

        --b24t-accent-grad: linear-gradient(135deg, #1a7a8a 0%, #0ea895 50%, #0d9488 100%);
        --b24t-panel-grad:  linear-gradient(180deg, #0d0d14 0%, #0f0f1a 50%, #111120 100%);
        --b24t-section-grad-a: linear-gradient(135deg, #0d0d14 0%, #0f0f1c 100%);
        --b24t-section-grad-b: linear-gradient(135deg, #101018 0%, #141428 100%);
        --b24t-section-grad-c: linear-gradient(135deg, #12121e 0%, #181830 100%);
        --b24t-section-grad-d: linear-gradient(135deg, #0e0e1c 0%, #131328 100%);

        --b24t-ok:          #4ade80;
        --b24t-ok-bg:       linear-gradient(135deg, #0d3320, #0a2518);
        --b24t-ok-text:     #86efac;
        --b24t-warn:        #fbbf24;
        --b24t-warn-bg:     linear-gradient(135deg, #2a2500, #1e1a00);
        --b24t-warn-text:   #fde68a;
        --b24t-err:         #f87171;
        --b24t-err-bg:      linear-gradient(135deg, #2d1010, #200808);
        --b24t-err-text:    #fca5a5;
        --b24t-info:        #60a5fa;
        --b24t-info-bg:     linear-gradient(135deg, #0d2240, #091830);
        --b24t-info-text:   #93c5fd;

        --b24t-shadow:      0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04);
        --b24t-shadow-h:    0 12px 40px rgba(0,0,0,0.8), 0 0 20px rgba(13,148,136,0.10), 0 0 0 1px rgba(255,255,255,0.06);
        --b24t-shadow-drag: 0 20px 60px rgba(0,0,0,0.9), 0 0 30px rgba(13,148,136,0.14);

        --b24t-scrollbar:   #282840;
        --b24t-badge-idle-bg:  #1a1a2e; --b24t-badge-idle-fg: #c0c0e0;
        --b24t-badge-run-bg:   #0d3320; --b24t-badge-run-fg:  #4ade80;
        --b24t-badge-pause-bg: #2a2500; --b24t-badge-pause-fg:#fbbf24;
        --b24t-badge-err-bg:   #2d1010; --b24t-badge-err-fg:  #f87171;
        --b24t-badge-done-bg:  #0d2240; --b24t-badge-done-fg: #60a5fa;
      }

      /* ── ANIMATIONS ── */
      @keyframes b24t-slidein {
        from { opacity: 0; transform: translateY(10px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0)   scale(1); }
      }
      @keyframes b24t-fadein {
        from { opacity: 0; } to { opacity: 1; }
      }
      @keyframes b24t-section-reveal {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes b24t-pulse-ring {
        0%   { box-shadow: 0 0 0 0 var(--b24t-primary-glow); }
        70%  { box-shadow: 0 0 0 6px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      @keyframes b24t-shimmer {
        0%   { background-position: -200% 0; }
        100% { background-position:  200% 0; }
      }
      @keyframes b24t-spin {
        from { transform: rotate(0deg); } to { transform: rotate(360deg); }
      }

      /* LAYOUT CONTRACT: Only #b24t-log has flex-grow inside the panel tree.
         Do not add flex-grow to any other child of #b24t-panel-inner.
         Do not set fixed heights (height/min-height) on #b24t-log or #b24t-log-section.
         Panel overflow is hidden — #b24t-log scrolls internally via overflow-y: auto.
         Resize JS sets height on #b24t-panel only — nothing else should have explicit height. */

      /* ── MAIN PANEL ── */
      #b24t-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 440px;
        background: var(--b24t-panel-grad);
        border: 1px solid var(--b24t-border);
        border-radius: 14px;
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 13px;
        color: var(--b24t-text);
        z-index: 2147483647;
        box-shadow: var(--b24t-shadow);
        user-select: none;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: box-shadow 0.25s ease, background 0.3s ease, border-color 0.3s ease;
        /* animation removed — was causing glitch on Plik tab */
      }
      #b24t-panel:hover { box-shadow: var(--b24t-shadow-h); }
      #b24t-panel-inner {
        width: 440px; /* musi być zgodne z BASE_PANEL_W w JS; nadpisywane przez JS gdy panel >= 440px */
        display: flex;
        flex-direction: column;
        transform-origin: top left;
        flex: 1 1 auto; /* rozciąga się do pełnej wysokości #b24t-panel po resize */
        min-height: 0; /* required: allows flex shrink to work inside #b24t-panel overflow:hidden */
      }
      #b24t-panel.b24t-resizing { opacity: 0.97; box-shadow: var(--b24t-shadow-drag); transition: none !important; }
      #b24t-panel.b24t-resizing * { pointer-events: none !important; user-select: none !important; }
      #b24t-panel.dragging { opacity: 0.94; box-shadow: var(--b24t-shadow-drag); cursor: grabbing; }

      /* ── OVERFLOW GUARD — elementy flex/grid nie wychodzą poza panel ── */
      #b24t-body > * { min-width: 0; }
      .b24t-section { min-width: 0; }
      .b24t-map-row > * { min-width: 0; overflow: hidden; }
      #b24t-body { width: 100%; box-sizing: border-box; }
      #b24t-annotator-panel > * { min-width: 0; }
      .b24t-ann-content { min-width: 0; width: 100%; box-sizing: border-box; overflow-x: hidden; }
      .b24t-ann-content > * { max-width: 100%; box-sizing: border-box; }
      [data-news-panel] > * { min-width: 0; }

      /* ── COMPACT MODE (panel width < 400px lub mały ekran) ── */
      #b24t-panel.b24t-compact { font-size: 11.5px; }
      #b24t-panel.b24t-compact #b24t-topbar { padding: 8px 10px; }
      #b24t-panel.b24t-compact #b24t-meta-bar { padding: 4px 10px; font-size: 10px; }
      #b24t-panel.b24t-compact .b24t-section { padding: 9px 10px; }
      #b24t-panel.b24t-compact .b24t-section-label { font-size: 9px; margin-bottom: 7px; }
      #b24t-panel.b24t-compact .b24t-project-name { font-size: 13px; }
      #b24t-panel.b24t-compact .b24t-project-meta { font-size: 11px; }
      #b24t-panel.b24t-compact .b24t-map-row { grid-template-columns: 1fr 80px; }
      #b24t-panel.b24t-compact .b24t-map-count { display: none; }
      #b24t-panel.b24t-compact .b24t-toggle-label { font-size: 11.5px; }
      #b24t-panel.b24t-compact .b24t-radio span { font-size: 11.5px; }
      #b24t-panel.b24t-compact .b24t-checkbox-row label { font-size: 11.5px; }

      /* ── COMPACT MODE — annotator panel ── */
      #b24t-annotator-panel.b24t-compact { font-size: 12px !important; }
      #b24t-annotator-panel.b24t-compact #b24t-ann-header { padding: 8px 12px !important; }
      #b24t-annotator-panel.b24t-compact .b24t-ann-content { font-size: 12px !important; }
      #b24t-annotator-panel.b24t-compact .b24t-tab { font-size: 11px !important; padding: 4px 7px !important; }

      /* ── COMPACT MODE — news panels ── */
      [data-news-panel].b24t-compact { font-size: 11.5px !important; }

      /* ── TOPBAR ── */
      #b24t-topbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        padding: 11px 14px;
        background: var(--b24t-accent-grad);
        border-bottom: none;
        cursor: grab;
        gap: 8px;
        position: relative;
        overflow: hidden;
      }
      #b24t-topbar::before {
        content: '';
        position: absolute; inset: 0;
        background: radial-gradient(ellipse at 80% 50%, rgba(255,255,255,0.12) 0%, transparent 60%);
        pointer-events: none;
      }
      #b24t-topbar::after {
        content: '';
        position: absolute; inset: 0;
        background: linear-gradient(90deg, rgba(0,0,0,0.08) 0%, transparent 40%);
        pointer-events: none;
      }
      #b24t-topbar:active { cursor: grabbing; }
      .b24t-logo {
        font-size: 13px;
        font-weight: 700;
        color: #ffffff;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        flex-shrink: 1;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0;
        text-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      .b24t-logo-name { display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .b24t-version { font-size: 9px; font-weight: 500; color: rgba(255,255,255,0.6); cursor: pointer; letter-spacing: 0.03em; text-transform: none; white-space: nowrap; transition: color 0.15s; line-height: 1.4; text-shadow: none; }
      .b24t-version:hover { color: rgba(255,255,255,0.9); text-decoration: underline; text-decoration-style: dotted; }
      #b24t-topbar-right { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; }

      /* ── DARK MODE TOGGLE SLIDER ── */
      #b24t-theme-toggle {
        display: flex; align-items: center; gap: 5px;
      }
      #b24t-theme-toggle .b24t-toggle-icon {
        font-size: 11px; line-height: 1; transition: opacity 0.2s;
        user-select: none;
      }
      .b24t-slider-track {
        position: relative; width: 34px; height: 18px;
        background: rgba(0,0,0,0.25);
        border-radius: 99px; cursor: pointer;
        border: 1px solid rgba(255,255,255,0.25);
        transition: background 0.25s;
        flex-shrink: 0;
      }
      .b24t-slider-track.is-dark { background: rgba(255,255,255,0.15); }
      .b24t-slider-knob {
        position: absolute; top: 2px; left: 2px;
        width: 12px; height: 12px;
        background: #ffffff;
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1);
      }
      .b24t-slider-track.is-dark .b24t-slider-knob { transform: translateX(16px); }

      /* ── BADGES ── */
      .b24t-badge {
        font-size: 10px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 99px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .badge-idle    { background: var(--b24t-badge-idle-bg);  color: var(--b24t-badge-idle-fg); }
      .badge-running { background: var(--b24t-badge-run-bg);   color: var(--b24t-badge-run-fg); animation: b24t-pulse-ring 1.5s infinite; border-color: var(--b24t-badge-run-fg); }
      .badge-paused  { background: var(--b24t-badge-pause-bg); color: var(--b24t-badge-pause-fg); }
      .badge-error   { background: var(--b24t-badge-err-bg);   color: var(--b24t-badge-err-fg); border-color: var(--b24t-badge-err-fg); animation: b24t-badge-flash 1.1s ease-in-out infinite; }
      .badge-done    { background: var(--b24t-badge-done-bg);  color: var(--b24t-badge-done-fg); }

      /* ── ICON BUTTONS (in topbar) ── */
      .b24t-icon-btn {
        background: rgba(255,255,255,0.28); border: 1px solid rgba(255,255,255,0.5);
        color: #fff;
        cursor: pointer; padding: 3px 6px; border-radius: 5px;
        font-size: 13px; line-height: 1;
        transition: background 0.15s, color 0.15s, transform 0.08s ease-out;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      }
      .b24t-icon-btn:hover { background: rgba(255,255,255,0.4); color: #fff; transform: scale(1.03); }
      .b24t-icon-btn:active { transform: scale(0.93); }

      /* ── TOKEN STATUS BAR ── */
      #b24t-meta-bar {
        flex: 0 0 auto;
        display: flex; align-items: center; justify-content: space-between;
        padding: 5px 14px;
        background: var(--b24t-bg-deep);
        border-bottom: 2px solid var(--b24t-border);
        font-size: 11px;
        transition: background 0.3s, border-color 0.3s;
      }
      .b24t-token-ok      { color: var(--b24t-ok); font-weight: 700; font-size: 12px; }
      .b24t-token-pending { color: var(--b24t-warn); font-weight: 700; font-size: 12px; animation: b24t-dot-pulse 1.4s ease-in-out infinite; }
      .b24t-token-error   { color: var(--b24t-err); font-weight: 700; font-size: 12px; }
      .b24t-cms-checking  { animation: b24t-dot-pulse 1.4s ease-in-out infinite; }
      #b24t-session-timer { color: var(--b24t-text-meta); font-size: 11px; font-weight: 500; }
      .b24t-meta-btn-wrap { position: relative; display: inline-flex; }
      .b24t-meta-tooltip {
        position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
        background: var(--b24t-bg-elevated); border: 1px solid var(--b24t-border);
        color: var(--b24t-text-muted); font-size: 10px; font-weight: 500;
        padding: 3px 8px; border-radius: 5px; white-space: nowrap;
        opacity: 0; pointer-events: none;
        transition: opacity 0.15s 0.4s;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        z-index: 10;
      }
      .b24t-meta-btn-wrap:hover .b24t-meta-tooltip { opacity: 1; }

      /* ── SUBBAR ── */
      #b24t-subbar {
        flex: 0 0 auto;
        background: var(--b24t-bg-deep) !important;
        border-bottom: 1px solid var(--b24t-border-sub) !important;
        transition: background 0.3s, border-color 0.3s;
      }
      #b24t-subbar .b24t-icon-btn {
        background: var(--b24t-primary-bg) !important;
        border: 1px solid color-mix(in srgb, var(--b24t-primary) 30%, transparent) !important;
        color: var(--b24t-primary) !important;
        box-shadow: none !important;
      }
      #b24t-subbar .b24t-icon-btn:hover { background: var(--b24t-primary-bg) !important; filter: brightness(1.2); }
      /* Fix hardcoded dark colors on subbar buttons */
      #b24t-btn-changelog { color: var(--b24t-primary) !important; border-color: color-mix(in srgb, var(--b24t-primary) 25%, transparent) !important; }
      #b24t-btn-check-update { color: var(--b24t-text-faint) !important; border-color: var(--b24t-border) !important; }
      #b24t-session-timer-sub { color: var(--b24t-text-faint) !important; }

      /* ── FLEX CONTRACT (panel vertical layout) ───────────────────────────
         #b24t-panel          flex col, explicit height (set by resize JS)
           └─ #b24t-panel-inner  flex: 1 1 auto  ← fills panel
                ├─ #b24t-topbar      flex: 0 0 auto  (fixed)
                ├─ #b24t-meta-bar    flex: 0 0 auto  (fixed)
                ├─ #b24t-tabs        flex: 0 0 auto  (fixed)
                ├─ #b24t-body        flex: 1 1 auto  ← ONLY stretchy child of inner
                │    └─ #b24t-main-tab   flex: 1 1 auto  ← fills body
                │         ├─ .b24t-section  flex: 0 0 auto  (Projekt, Plik, Postęp, Stats…)
                │         └─ #b24t-log-section  flex: 1 1 auto  ← ONLY stretchy section
                │              ├─ .b24t-section-label  flex: 0 0 auto
                │              └─ #b24t-log  flex: 1, overflow-y: auto  ← scrolls here
                └─ #b24t-actions     flex: 0 0 auto  (footer, always pinned bottom)
         RULE: exactly ONE element with flex-grow > 0 per flex column level.
         RULE: no height: fixed values on #b24t-log or #b24t-log-section.
         RULE: no position:absolute hacks on footer.
      ── */
      /* ── BODY ── */
      #b24t-body { display: flex; flex-direction: column; overflow: hidden; flex: 1 1 auto; min-height: 0; background: var(--b24t-panel-grad); transition: background 0.3s; }
      #b24t-body::-webkit-scrollbar { width: 3px; }
      #b24t-body::-webkit-scrollbar-track { background: transparent; }
      #b24t-body::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); border-radius: 99px; }
      /* main-tab fills body; other tabs are display:none so don't participate in flex */
      #b24t-main-tab { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overflow-x: hidden; }
      #b24t-main-tab::-webkit-scrollbar { width: 3px; }
      #b24t-main-tab::-webkit-scrollbar-track { background: transparent; }
      #b24t-main-tab::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); border-radius: 99px; }
      /* LOG section — the ONLY flex-grow element inside main-tab */
      #b24t-log-section { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; border-bottom: none; }
      #b24t-log-section .b24t-section-label { flex: 0 0 auto; }

      /* ── SECTIONS ── */
      .b24t-section {
        padding: 12px 14px;
        border-bottom: 2px solid var(--b24t-border);
        transition: border-color 0.3s, background 0.3s;
        position: relative;
      }
      /* Alternating section backgrounds for visual rhythm */
      .b24t-section:nth-child(odd)  { background: var(--b24t-section-grad-a); }
      .b24t-section:nth-child(even) { background: var(--b24t-section-grad-b); }

      .b24t-section-label {
        font-size: 10px; font-weight: 700; color: var(--b24t-text-label);
        text-transform: uppercase; letter-spacing: 0.14em;
        margin-bottom: 10px;
      }
      .b24t-section-label.primary { font-size: 10px; color: var(--b24t-text-meta); letter-spacing: 0.08em; }
      .b24t-section-label.tertiary { font-size: 8px; opacity: 0.7; }
      .b24t-project-name { font-size: 15px; font-weight: 700; color: var(--b24t-text); }
      .b24t-project-meta { font-size: 12px; color: var(--b24t-text-meta); margin-top: 3px; }

      /* ── FILE ZONE ── */
      .b24t-file-zone {
        border: 2px dashed var(--b24t-border); border-radius: 8px;
        padding: 10px 12px; cursor: pointer;
        display: flex; align-items: center; gap: 8px;
        background: var(--b24t-section-grad-d);
        transition: border-color 0.2s, background 0.2s, transform 0.15s;
      }
      .b24t-file-zone:hover { border-color: var(--b24t-primary); background: var(--b24t-primary-bg); transform: translateY(-1px); box-shadow: 0 4px 12px var(--b24t-primary-glow); }
      .b24t-file-zone.b24t-dragover { border-color: var(--b24t-primary); border-style: solid; background: var(--b24t-primary-bg); transform: scale(1.015); box-shadow: 0 0 0 3px var(--b24t-primary-glow); }
      .b24t-file-icon { font-size: 18px; flex-shrink: 0; }
      .b24t-file-name { font-size: 13px; color: var(--b24t-text); font-weight: 600; }
      .b24t-file-meta { font-size: 12px; color: var(--b24t-text-meta); }
      .b24t-date-range {
        display: flex; align-items: center; gap: 6px;
        margin-top: 8px; font-size: 10px; color: var(--b24t-text-meta);
      }
      .b24t-date-chip {
        background: var(--b24t-section-grad-c); border: 1px solid var(--b24t-border-strong);
        border-radius: 99px; padding: 2px 10px;
        color: var(--b24t-text-label); font-size: 11px; font-weight: 600;
        transition: background 0.3s, border-color 0.3s;
      }

      /* ── MAPPING ── */
      .b24t-map-row {
        display: grid; grid-template-columns: 1fr 1fr 80px;
        gap: 4px; margin-bottom: 4px; align-items: center;
      }
      .b24t-map-label { font-size: 13px; color: var(--b24t-text); font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .b24t-map-count { font-size: 12px; color: var(--b24t-text-meta); }
      .b24t-select {
        background: var(--b24t-bg-input); border: 1px solid var(--b24t-border);
        color: var(--b24t-text); border-radius: 5px; font-size: 12px;
        padding: 3px 4px; width: 100%; cursor: pointer; font-family: inherit;
        transition: border-color 0.15s, background 0.3s;
      }
      .b24t-select:focus { outline: none; border-color: var(--b24t-primary); }
      .b24t-add-tag-btn {
        font-size: 11px; color: var(--b24t-primary); background: none; border: none;
        cursor: pointer; padding: 2px 0; text-align: left; margin-top: 4px;
        font-weight: 600; transition: opacity 0.15s;
      }
      .b24t-add-tag-btn:hover { opacity: 0.75; }

      /* ── TOGGLE ROWS ── */
      .b24t-toggle-row {
        display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;
      }
      .b24t-toggle-label { font-size: 13px; color: var(--b24t-text); font-weight: 500; }
      .b24t-radio-group { display: flex; gap: 12px; }
      .b24t-radio { display: flex; align-items: center; gap: 4px; cursor: pointer; }
      .b24t-radio input { accent-color: var(--b24t-primary); cursor: pointer; }
      .b24t-radio span { font-size: 13px; color: var(--b24t-text-muted); }
      .b24t-checkbox-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .b24t-checkbox-row input { accent-color: var(--b24t-primary); cursor: pointer; }
      .b24t-checkbox-row label { font-size: 13px; color: var(--b24t-text-muted); cursor: pointer; }
      .b24t-select-inline {
        background: var(--b24t-bg-input); border: 1px solid var(--b24t-border);
        color: var(--b24t-text); border-radius: 4px; font-size: 10px;
        padding: 2px 4px; cursor: pointer; font-family: inherit; margin-left: 4px;
        transition: background 0.3s, border-color 0.3s;
      }

      /* ── PROGRESS ── */
      .b24t-progress-bar-track {
        height: 6px; background: var(--b24t-bg-input); border-radius: 99px;
        overflow: hidden; margin: 8px 0 4px;
        transition: background 0.3s;
        border: 1px solid var(--b24t-border-sub);
      }
      #b24t-progress-bar {
        height: 100%;
        background: var(--b24t-accent-grad);
        border-radius: 99px; width: 0%;
      }
      #b24t-progress-label { font-size: 12px; color: var(--b24t-text); font-weight: 500; }
      #b24t-progress-action { font-size: 11px; color: var(--b24t-text-meta); margin-top: 2px; }

      /* ── STATS ── */
      .b24t-stats-row-list { display: flex; flex-direction: column; gap: 3px; }
      .b24t-stat-row {
        display: flex; align-items: baseline; justify-content: space-between;
        padding: 4px 0; border-bottom: 1px solid var(--b24t-border-sub);
      }
      .b24t-stat-row:last-child { border-bottom: none; }
      .b24t-stat-row-label { font-size: 12px; color: var(--b24t-text-faint); font-weight: 400; }
      .b24t-stat-row-value { font-size: 14px; font-weight: 600; color: var(--b24t-text); font-variant-numeric: tabular-nums; }
      .b24t-stat-row-value.ok   { color: var(--b24t-ok); }
      .b24t-stat-row-value.warn { color: var(--b24t-warn); }
      .b24t-stat-row-value.err  { color: var(--b24t-err); }

      /* ── LOG ── */
      #b24t-log {
        flex: 1 1 auto; min-height: 80px; overflow-y: auto;
        font-size: 12px; line-height: 1.6;
        background: var(--b24t-bg-section-c);
        transition: background 0.3s;
        border-radius: 6px;
      }
      #b24t-log::-webkit-scrollbar { width: 3px; }
      #b24t-log::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); border-radius: 99px; }
      .b24t-log-entry { display: flex; gap: 6px; padding: 2px 8px; animation: b24t-fadein 0.08s ease; }
      .b24t-log-time    { color: var(--b24t-text-faint); flex-shrink: 0; }
      .b24t-log-msg     { color: var(--b24t-text-muted); flex: 1; }
      .b24t-log-elapsed { color: var(--b24t-text-faint); font-size: 10px; flex-shrink: 0; }
      .b24t-log-success { background: var(--b24t-ok-bg); border-radius: 3px; }
      .b24t-log-error   { background: var(--b24t-err-bg); border-radius: 3px; }
      .b24t-log-warn    { background: var(--b24t-warn-bg); border-radius: 3px; }
      .b24t-log-success .b24t-log-msg { color: var(--b24t-ok); font-weight: 500; }
      .b24t-log-error   .b24t-log-msg { color: var(--b24t-err); font-weight: 500; }
      .b24t-log-warn    .b24t-log-msg { color: var(--b24t-warn); }
      .b24t-log-info    .b24t-log-msg { color: var(--b24t-text-muted); }
      .b24t-log-diag    .b24t-log-msg { color: var(--b24t-err); }
      .b24t-log-diag    .b24t-log-diag-prefix { color: #f87171; font-weight: 700; }
      .b24t-log-clear { font-size: 9px; color: var(--b24t-text-faint); background: none; border: none; cursor: pointer; float: right; transition: color 0.15s; }
      .b24t-log-clear:hover { color: var(--b24t-primary); }
      .b24t-log-expand { font-size: 9px; color: var(--b24t-text-faint); background: none; border: none; cursor: pointer; float: right; margin-right: 4px; transition: color 0.15s; }
      .b24t-log-expand:hover { color: var(--b24t-primary); }

      /* ── ACTION BAR ── */
      #b24t-actions {
        flex: 0 0 auto;
        display: flex; gap: 6px; padding: 10px 14px;
        background: var(--b24t-section-grad-c);
        border-top: 2px solid var(--b24t-border);
        transition: background 0.3s, border-color 0.3s;
      }
      .b24t-btn-primary {
        flex: 1; background: var(--b24t-primary); color: #fff;
        border: none; border-radius: 7px; padding: 9px 0;
        font-size: 12px; font-weight: 700; cursor: pointer;
        font-family: inherit;
        transition: opacity 0.15s, transform 0.08s ease-out, box-shadow 0.15s;
        box-shadow: 0 2px 8px var(--b24t-primary-glow);
        letter-spacing: 0.02em;
      }
      .b24t-btn-primary:hover { opacity: 0.88; box-shadow: 0 6px 20px var(--b24t-primary-glow); transform: translateY(-1px); }
      .b24t-btn-primary:active { transform: scale(0.97); }
      .b24t-btn-primary:disabled { background: var(--b24t-bg-input); color: var(--b24t-text-faint); box-shadow: none; cursor: not-allowed; }
      .b24t-btn-secondary {
        flex: 1; background: var(--b24t-section-grad-d); color: var(--b24t-text);
        border: 1px solid var(--b24t-border); border-radius: 7px; padding: 9px 0;
        font-size: 12px; cursor: pointer; font-family: inherit; font-weight: 500;
        transition: background 0.15s, transform 0.08s ease-out, border-color 0.15s;
      }
      .b24t-btn-secondary:hover { background: var(--b24t-section-grad-c); border-color: var(--b24t-border-strong); transform: translateY(-1px); }
      .b24t-btn-secondary:active { transform: scale(0.97); }
      .b24t-btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
      .b24t-btn-danger {
        flex: 1; background: var(--b24t-err-bg); color: var(--b24t-err-text);
        border: 1px solid color-mix(in srgb, var(--b24t-err) 30%, transparent); border-radius: 7px; padding: 9px 0;
        font-size: 12px; cursor: pointer; font-family: inherit; font-weight: 600;
        transition: background 0.15s, transform 0.1s;
      }
      .b24t-btn-danger:hover { filter: brightness(0.9); transform: translateY(-1px); }
      .b24t-btn-tool {
        font-size: 10px !important; padding: 5px 8px !important;
        color: var(--b24t-text-faint) !important;
        background: transparent !important;
        border-color: var(--b24t-border) !important;
      }
      .b24t-btn-tool:hover {
        color: var(--b24t-text) !important;
        background: var(--b24t-bg-elevated) !important;
      }
      .b24t-btn-warn {
        background: var(--b24t-warn-bg); color: var(--b24t-warn-text);
        border: 1px solid color-mix(in srgb, var(--b24t-warn) 30%, transparent); border-radius: 7px; padding: 6px 12px;
        font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600;
        transition: filter 0.15s;
      }
      .b24t-btn-warn:hover { filter: brightness(0.9); }

      /* ── FOCUS VISIBLE ── */
      .b24t-btn-primary:focus-visible,
      .b24t-btn-secondary:focus-visible,
      .b24t-btn-danger:focus-visible,
      .b24t-btn-warn:focus-visible,
      .b24t-tab:focus-visible,
      .b24t-icon-btn:focus-visible {
        outline: 2px solid var(--b24t-primary);
        outline-offset: 2px;
      }

      /* ── CRASH BANNER ── */
      #b24t-crash-banner {
        display: none; margin: 8px 14px;
        background: var(--b24t-err-bg); border: 1px solid color-mix(in srgb, var(--b24t-err) 40%, transparent);
        border-radius: 8px; padding: 8px 10px;
        font-size: 10px; color: var(--b24t-err);
        animation: b24t-fadein 0.2s ease;
      }
      .b24t-crash-actions { display: flex; gap: 6px; margin-top: 6px; }
      .b24t-crash-detail-toggle { font-size: 9px; color: var(--b24t-text-faint); background: none; border: none; cursor: pointer; padding: 0; }
      .b24t-crash-detail {
        display: none; font-size: 9px; color: var(--b24t-text-faint);
        background: var(--b24t-bg-deep); border-radius: 4px; padding: 6px;
        margin-top: 6px; white-space: pre-wrap; max-height: 80px; overflow-y: auto;
      }

      /* ── TABS — liquid glass pill style ── */
      #b24t-tabs {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 6px 10px;
        background: var(--b24t-bg-deep);
        border-bottom: 1px solid var(--b24t-border-sub);
        transition: background 0.3s, border-color 0.3s;
      }
      .b24t-tab {
        flex: 1;
        position: relative;
        background: transparent;
        border: 1px solid transparent;
        color: var(--b24t-text-faint);
        font-size: 12px;
        font-weight: 500;
        padding: 6px 4px;
        border-radius: 20px;
        cursor: pointer;
        font-family: inherit;
        letter-spacing: 0.01em;
        transition: color 0.18s, background 0.18s, border-color 0.18s,
                    box-shadow 0.18s, transform 0.12s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .b24t-tab:hover {
        color: var(--b24t-text-muted);
        background: color-mix(in srgb, var(--b24t-primary) 8%, transparent);
        border-color: color-mix(in srgb, var(--b24t-primary) 20%, transparent);
      }
      .b24t-tab:active { transform: scale(0.97); }

      /* Light mode aktywna zakładka */
      .b24t-tab.b24t-tab-active {
        color: var(--b24t-primary);
        font-weight: 700;
        background:
          linear-gradient(180deg,
            color-mix(in srgb, var(--b24t-primary) 14%, var(--b24t-bg)) 0%,
            color-mix(in srgb, var(--b24t-primary) 6%,  var(--b24t-bg)) 100%);
        border-color: color-mix(in srgb, var(--b24t-primary) 35%, transparent);
        box-shadow:
          0 1px 6px color-mix(in srgb, var(--b24t-primary) 20%, transparent),
          inset 0 1px 0 color-mix(in srgb, white 40%, transparent),
          inset 0 -1px 0 color-mix(in srgb, var(--b24t-primary) 15%, transparent);
      }
      /* Dark mode aktywna zakładka — mocniejszy kontrast */
      [data-b24t-theme="dark"] .b24t-tab.b24t-tab-active {
        background:
          linear-gradient(180deg,
            rgba(108,108,255,0.22) 0%,
            rgba(108,108,255,0.10) 100%);
        border-color: rgba(108,108,255,0.45);
        box-shadow:
          0 2px 10px rgba(108,108,255,0.25),
          inset 0 1px 0 rgba(255,255,255,0.12),
          inset 0 -1px 0 rgba(108,108,255,0.15);
      }

      /* Collapsed */
      #b24t-panel.collapsed { overflow: hidden; }
      #b24t-panel.collapsed #b24t-tabs { display: none; }
      #b24t-panel.collapsed #b24t-body,
      #b24t-panel.collapsed #b24t-actions,
      #b24t-panel.collapsed #b24t-meta-bar { display: none !important; }
      #b24t-panel.collapsed { height: auto !important; max-height: none !important; min-height: 0 !important; }

      /* ── MODALS ── */
      .b24t-modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647;
        animation: b24t-fadein 0.2s ease;
        backdrop-filter: blur(4px);
      }
      .b24t-modal {
        background: var(--b24t-bg); border: 1px solid var(--b24t-border);
        border-radius: 14px; padding: 20px; width: 320px;
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        box-shadow: var(--b24t-shadow-h);
        animation: b24t-slidein 0.22s cubic-bezier(0.34,1.56,0.64,1);
        transition: background 0.3s, border-color 0.3s;
      }
      .b24t-modal-title { font-size: 13px; font-weight: 700; color: var(--b24t-warn); margin-bottom: 12px; }
      .b24t-modal-text { font-size: 11px; color: var(--b24t-text-muted); line-height: 1.6; margin-bottom: 16px; }
      .b24t-modal-text strong { color: var(--b24t-text); }
      .b24t-modal-actions { display: flex; gap: 6px; flex-wrap: wrap; }

      /* Report modal */
      #b24t-report-modal {
        display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
        align-items: center; justify-content: center;
        z-index: 2147483647;
      }
      .b24t-report-content {
        background: var(--b24t-bg); border: 1px solid var(--b24t-border);
        border-radius: 14px; padding: 24px; width: 280px;
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        box-shadow: var(--b24t-shadow-h);
        animation: b24t-slidein 0.22s cubic-bezier(0.34,1.56,0.64,1);
      }
      .b24t-report-content h3 { font-size: 14px; color: var(--b24t-primary); margin-bottom: 16px; }
      .b24t-report-row {
        display: flex; justify-content: space-between;
        padding: 6px 0; border-bottom: 1px solid var(--b24t-border-sub);
        font-size: 11px; color: var(--b24t-text-muted);
      }
      .b24t-report-row strong { color: var(--b24t-text); }
      .b24t-report-content button { margin-top: 12px; width: 100%; }

      /* ── INPUT ── */
      .b24t-input {
        background: var(--b24t-bg-input); border: 1px solid var(--b24t-border);
        color: var(--b24t-text); border-radius: 5px; font-size: 12px;
        padding: 5px 8px; width: 100%; font-family: inherit;
        box-sizing: border-box;
        transition: border-color 0.15s, background 0.3s;
      }
      .b24t-input:focus { outline: none; border-color: var(--b24t-primary); }

      /* ── SETUP WIZARD ── */
      #b24t-setup {
        position: fixed; inset: 0; background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647; font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        backdrop-filter: blur(6px);
      }
      .b24t-setup-card {
        background: var(--b24t-bg); border: 1px solid var(--b24t-border);
        border-radius: 18px; width: 480px; max-height: 90vh;
        overflow-y: auto; padding: 28px;
        box-shadow: var(--b24t-shadow-h);
        animation: b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);
      }
      .b24t-setup-card::-webkit-scrollbar { width: 3px; }
      .b24t-setup-card::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); }
      .b24t-setup-header { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
      .b24t-setup-logo { font-size: 14px; font-weight: 700; color: var(--b24t-primary); letter-spacing: 0.1em; }
      .b24t-setup-step { font-size: 11px; color: var(--b24t-text-faint); margin-left: auto; }
      .b24t-progress-dots { display: flex; gap: 4px; margin-bottom: 24px; }
      .b24t-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--b24t-bg-input); }
      .b24t-dot.active { background: var(--b24t-primary); }
      .b24t-dot.done { background: var(--b24t-ok); }
      .b24t-setup-title { font-size: 16px; color: var(--b24t-text); margin-bottom: 6px; }
      .b24t-setup-desc { font-size: 11px; color: var(--b24t-text-faint); margin-bottom: 20px; line-height: 1.6; }
      .b24t-check-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 11px; }
      .b24t-check-icon { flex-shrink: 0; }
      .b24t-check-label { color: var(--b24t-text-muted); }
      .b24t-check-ok   { color: var(--b24t-ok); }
      .b24t-check-fail { color: var(--b24t-err); }
      .b24t-check-wait { color: var(--b24t-warn); }
      .b24t-setup-nav { display: flex; justify-content: space-between; margin-top: 24px; gap: 8px; }

      /* ── SIDE TAB PULSE ANIMATION ── */
      @keyframes b24t-tab-pulse {
        0%   { box-shadow: 3px 0 14px rgba(99,102,241,0.7); }
        25%  { box-shadow: 3px 0 20px rgba(139,92,246,0.85); }
        50%  { box-shadow: 3px 0 20px rgba(236,72,153,0.85); }
        75%  { box-shadow: 3px 0 20px rgba(139,92,246,0.85); }
        100% { box-shadow: 3px 0 14px rgba(99,102,241,0.7); }
      }
      /* ── MAIN PANEL SIDE TAB ── */
      #b24t-panel-side-tab {
        position: fixed; left: 0; top: 36%; transform: translateY(-50%);
        z-index: 2147483645; border-radius: 0 10px 10px 0; border: none;
        padding: 18px 11px; cursor: pointer; display: none;
        flex-direction: column; align-items: center; gap: 7px;
        font-family: 'Geist','Segoe UI',system-ui,-apple-system,sans-serif;
        font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
        color: #fff; user-select: none; background: #6366f1;
        animation: b24t-tab-pulse 2.5s ease-in-out infinite;
        transition: transform 0.15s;
      }
      #b24t-panel-side-tab:hover { transform: translateY(-50%) scale(1.08) !important; animation-play-state: paused; background: #7c3aed !important; }
      /* ── NEWS SIDE TAB ── */
      #b24t-news-side-tab {
        position: fixed; right: 0; top: calc(50% + 90px); transform: translateY(0);
        z-index: 2147483639; border-radius: 10px 0 0 10px; border: 1px solid var(--b24t-border); border-right: none;
        padding: 14px 10px; cursor: pointer; display: none;
        flex-direction: column; align-items: center; gap: 5px;
        font-family: 'Geist','Segoe UI',system-ui,-apple-system,sans-serif;
        font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
        color: var(--b24t-primary); user-select: none;
        background: var(--b24t-bg-elevated); box-shadow: var(--b24t-shadow);
        transition: transform 0.15s, background 0.15s, border-color 0.3s;
      }
      #b24t-news-side-tab:hover { background: var(--b24t-bg-section-c); transform: scale(1.06); }
      #b24t-news-side-tab.active { background: #6366f1; color: #fff; border-color: #4f46e5; }
      #b24t-news-side-tab.active:hover { background: #4f46e5; }
      /* ── ANNOTATOR FLOATING PANEL ── */
      #b24t-annotator-tab {
        transition: opacity 0.2s, transform 0.2s;
      }
      #b24t-annotator-tab:hover { transform: translateY(-50%) scale(1.05) !important; }

      #b24t-annotator-panel {
        transition: background 0.3s, border-color 0.3s, box-shadow 0.3s;
      }

      /* ── CROSS-PROJECT DELETE PANEL ── */
      #b24t-xproject-panel {
        position: fixed;
        top: 0; bottom: 0;
        width: 0;
        overflow: hidden;
        background: var(--b24t-bg);
        border-left: 1px solid var(--b24t-border);
        box-shadow: -4px 0 24px rgba(0,0,0,0.18);
        z-index: 2147483645;
        display: flex;
        flex-direction: column;
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        transition: width 0.32s cubic-bezier(0.4,0,0.2,1), right 0.32s cubic-bezier(0.4,0,0.2,1);
      }
      #b24t-xproject-panel.open { width: 320px; }
      #b24t-xproject-header {
        padding: 12px 14px;
        background: var(--b24t-err-bg);
        border-bottom: 1px solid color-mix(in srgb, var(--b24t-err) 25%, transparent);
        flex-shrink: 0;
        display: flex; align-items: center; gap: 8px;
      }
      #b24t-xproject-header .xp-title {
        font-size: 13px; font-weight: 700;
        color: var(--b24t-err); flex: 1;
      }
      #b24t-xproject-close {
        background: none; border: none;
        color: var(--b24t-err); font-size: 18px;
        cursor: pointer; line-height: 1; padding: 2px 6px;
        border-radius: 4px; transition: background 0.15s;
      }
      #b24t-xproject-close:hover { background: var(--b24t-err-bg); }
      #b24t-xproject-body {
        flex: 1; overflow-y: auto; padding: 12px 14px;
      }
      #b24t-xproject-body::-webkit-scrollbar { width: 3px; }
      #b24t-xproject-body::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); border-radius: 99px; }
      .xp-project-row {
        display: flex; align-items: center;
        gap: 8px; padding: 7px 0;
        border-bottom: 1px solid var(--b24t-border-sub);
        font-size: 12px; color: var(--b24t-text-muted);
      }
      .xp-project-row .xp-name { flex: 1; font-weight: 500; }
      .xp-project-row .xp-count {
        font-size: 11px; font-weight: 700;
        color: var(--b24t-err); min-width: 28px; text-align: right;
      }
      .xp-project-row .xp-status {
        font-size: 10px; color: var(--b24t-text-faint);
      }
      #b24t-xproject-footer {
        padding: 10px 14px;
        border-top: 1px solid var(--b24t-border-sub);
        flex-shrink: 0;
      }
      #b24t-xproject-run {
        width: 100%;
        background: var(--b24t-err);
        color: #fff; border: none;
        border-radius: 8px; padding: 9px;
        font-size: 13px; font-weight: 700;
        font-family: inherit; cursor: pointer;
        transition: opacity 0.15s, transform 0.1s;
      }
      #b24t-xproject-run:hover { opacity: 0.88; }
      #b24t-xproject-run:disabled { opacity: 0.4; cursor: not-allowed; }

      /* ── SHIMMER LOADING ── */
      .b24t-shimmer {
        background: linear-gradient(90deg,
          var(--b24t-bg-input) 25%,
          var(--b24t-bg-elevated) 50%,
          var(--b24t-bg-input) 75%);
        background-size: 200% 100%;
        animation: b24t-shimmer 1.5s infinite;
        border-radius: 4px;
      }

      /* ── HELP MODE ── */
      #b24t-panel.b24t-help-mode {
        outline: 2px solid rgba(108,108,255,0.4);
        outline-offset: 2px;
      }
      .b24t-help-zone {
        position: fixed;
        cursor: help;
        border-radius: 7px;
        z-index: 2147483520;
        border: 2px solid rgba(108,108,255,0.55);
        background: rgba(108,108,255,0.06);
        transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
        box-sizing: border-box;
        animation: b24t-help-pulse 2.5s ease-in-out infinite;
      }
      @keyframes b24t-help-pulse {
        0%, 100% { border-color: rgba(108,108,255,0.45); box-shadow: 0 0 0 0 rgba(108,108,255,0.15); }
        50%       { border-color: rgba(108,108,255,0.80); box-shadow: 0 0 0 3px rgba(108,108,255,0.08); }
      }
      .b24t-help-zone:hover {
        background: rgba(108,108,255,0.16) !important;
        border-color: rgba(108,108,255,0.90) !important;
        box-shadow: 0 0 0 4px rgba(108,108,255,0.12) !important;
        animation: none !important;
      }
      .b24t-help-tip {
        position: fixed;
        z-index: 2147483540;
        max-width: 280px;
        background: var(--b24t-bg-elevated);
        border: 1px solid color-mix(in srgb, var(--b24t-primary) 40%, transparent);
        border-radius: 10px;
        padding: 10px 14px;
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 11px;
        color: var(--b24t-text-muted);
        line-height: 1.6;
        box-shadow: var(--b24t-shadow-h);
        pointer-events: none;
        transform-origin: bottom center;
        animation: b24t-slidein 0.2s cubic-bezier(0.34,1.56,0.64,1);
      }
      .b24t-help-tip strong { color: var(--b24t-text); display: block; margin-bottom: 4px; font-size: 12px; }
      #b24t-help-panel-overlay {
        position: fixed;
        border-radius: 14px;
        z-index: 2147483510;
        pointer-events: none;
        background: rgba(0,0,0,0.30);
        animation: b24t-fadein 0.25s ease;
      }
      #b24t-help-close {
        position: fixed;
        background: rgba(15,15,25,0.96);
        border: 1px solid rgba(108,108,255,0.45);
        border-radius: 10px;
        padding: 9px 18px;
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 11px; color: #9090ff;
        cursor: pointer;
        z-index: 2147483530;
        pointer-events: all;
        white-space: nowrap;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        transition: background 0.15s, border-color 0.15s;
        letter-spacing: 0.02em;
      }
      #b24t-help-close:hover { background: rgba(25,25,50,0.98); border-color: rgba(108,108,255,0.75); }

      /* ── TAB ENTER ── */
      @keyframes b24t-tab-enter {
        from { opacity: 0; transform: translateX(7px); }
        to   { opacity: 1; transform: translateX(0); }
      }

      /* ── STAT POP ── */
      @keyframes b24t-stat-pop {
        0%   { transform: scale(1); }
        45%  { transform: scale(1.22); }
        100% { transform: scale(1); }
      }
      .b24t-stat-pop { animation: b24t-stat-pop 0.22s cubic-bezier(0.34,1.56,0.64,1) !important; }

      /* ── PROGRESS BAR PULSE WHEN RUNNING ── */
      @keyframes b24t-bar-pulse {
        0%, 100% { filter: brightness(1); }
        50%       { filter: brightness(1.3); }
      }
      #b24t-progress-bar.b24t-running,
      .b24t-bar-active {
        animation: b24t-bar-pulse 1.1s ease-in-out infinite;
      }

      /* ── BADGE ERROR FLASH ── */
      @keyframes b24t-badge-flash {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.45; }
      }

      /* ── TOKEN DOT PULSE ── */
      @keyframes b24t-dot-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.2; }
      }

      /* ── TOAST NOTIFICATIONS ── */
      #b24t-toast-container {
        position: fixed; bottom: 24px; right: 24px;
        display: flex; flex-direction: column; gap: 8px;
        z-index: 2147483647; pointer-events: none;
      }
      .b24t-toast {
        font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 13px; padding: 10px 16px;
        border-radius: 8px; border: 1px solid; border-top: 2px solid;
        box-shadow: 0 4px 20px rgba(0,0,0,0.45);
        animation: b24t-toast-in 0.22s cubic-bezier(0.34,1.56,0.64,1) forwards;
        pointer-events: all; max-width: 320px; line-height: 1.4;
      }
      .b24t-toast.b24t-toast-out { animation: b24t-toast-out 0.15s cubic-bezier(0.4,0,1,1) forwards; }
      .b24t-toast-success { background: rgba(10,22,15,0.97); border-color: #4ade80; color: #d1fae5; }
      .b24t-toast-error   { background: rgba(25,8,8,0.97);   border-color: #f87171; color: #fee2e2; }
      .b24t-toast-info    { background: rgba(5,18,20,0.97); border-color: #0d9488; color: #ccfaf5; }
      .b24t-toast-warn    { background: rgba(24,18,4,0.97);  border-color: #facc15; color: #fef9c3; }
      @keyframes b24t-toast-in {
        from { opacity: 0; transform: translateX(28px) scale(0.93); }
        to   { opacity: 1; transform: translateX(0)    scale(1); }
      }
      @keyframes b24t-toast-out {
        from { opacity: 1; transform: translateX(0)    scale(1); }
        to   { opacity: 0; transform: translateX(28px) scale(0.93); }
      }
    `;
    document.head.appendChild(style);
  }

  // ───────────────────────────────────────────
  // UI - HTML
  // ───────────────────────────────────────────

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'b24t-panel';

    panel.innerHTML = `<div id="b24t-panel-inner">
      <!-- TOPBAR -->
      <div id="b24t-topbar">
        <span class="b24t-logo"><span class="b24t-logo-name">B24 TAGGER<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;background:rgba(255,255,255,0.18);color:#fff;border:1px solid rgba(255,255,255,0.35);border-radius:4px;padding:1px 5px;vertical-align:middle;margin-left:4px;">BETA</span></span><span id="b24t-version" class="b24t-version" title="Kliknij aby sprawdzić aktualizacje">v${VERSION}</span></span>
        <div id="b24t-topbar-right">
          <span id="b24t-status-badge" class="b24t-badge badge-idle">Idle</span>
          <button class="b24t-icon-btn" id="b24t-btn-features" title="Dodatkowe funkcje" style="font-size:14px;">⚙</button>
          <button class="b24t-icon-btn" id="b24t-btn-help" title="Pomoc">?</button>
          <button class="b24t-icon-btn" id="b24t-btn-collapse" title="Zwiń/Rozwiń">▼</button><button class="b24t-icon-btn" id="b24t-btn-hide-panel" title="Schowaj panel do boku" style="font-size:13px;">‹</button>
        </div>
      </div>

      <!-- META BAR -->
      <div id="b24t-meta-bar">
        <div style="display:flex;align-items:center;gap:6px;">
          <span id="b24t-token-status" class="b24t-token-pending" title="Status tokenu API">●</span>
          <div class="b24t-meta-btn-wrap">
            <button class="b24t-icon-btn" id="b24t-btn-changelog" style="font-size:13px;padding:2px 6px;">📋</button>
            <span class="b24t-meta-tooltip">Changelog</span>
          </div>
          <div class="b24t-meta-btn-wrap">
            <button class="b24t-icon-btn" id="b24t-btn-feedback" style="font-size:13px;padding:2px 6px;">💬</button>
            <span class="b24t-meta-tooltip">Feedback</span>
          </div>
        </div>
        <span id="b24t-session-timer">00:00:00</span>
      </div>

      <div id="b24t-tabs">
        <button class="b24t-tab b24t-tab-active" data-tab="main">📄 Plik</button>
        <button class="b24t-tab" data-tab="quicktag">⚡ Quick Tag</button>
        <button class="b24t-tab" data-tab="delete">🗑 Quick Delete</button>
        <button class="b24t-tab" data-tab="history">📋 Historia</button>
        <!-- Annotator Tools uses floating panel, no tab here -->
      </div>

      <!-- BODY -->
      <div id="b24t-body">
      <div id="b24t-main-tab">

        <!-- CRASH BANNER -->
        <div id="b24t-crash-banner">
          <div class="b24t-crash-msg"></div>
          <div class="b24t-crash-actions">
            <button class="b24t-btn-secondary" id="b24t-crash-resume" style="font-size:10px;padding:4px 8px;">Wznów</button>
            <button class="b24t-btn-danger" id="b24t-crash-reset" style="font-size:10px;padding:4px 8px;">Od nowa</button>
            <button class="b24t-crash-detail-toggle" id="b24t-crash-detail-toggle">Szczegóły ▾</button>
          </div>
          <pre class="b24t-crash-detail" id="b24t-crash-detail"></pre>
        </div>

        <!-- PROJEKT -->
        <div class="b24t-section">
          <div class="b24t-section-label">Projekt</div>
          <div class="b24t-project-name" id="b24t-project-name">—</div>
          <div class="b24t-project-meta" id="b24t-project-meta">Przejdź do zakładki Mentions</div>
        </div>

        <!-- PLIK -->
        <div class="b24t-section">
          <div class="b24t-section-label">Plik źródłowy</div>
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="b24t-file-zone" id="b24t-file-zone" style="flex:1;">
              <span class="b24t-file-icon">📄</span>
              <div>
                <div class="b24t-file-name" id="b24t-file-name">Kliknij aby wgrać plik...</div>
                <div class="b24t-file-meta" id="b24t-file-meta">CSV, JSON lub XLSX</div>
              </div>
            </div>
            <button id="b24t-btn-clear-file" title="Usuń plik" style="display:none;background:var(--b24t-err-bg);border:1px solid color-mix(in srgb,var(--b24t-err) 35%,transparent);color:var(--b24t-err-text);border-radius:7px;padding:7px 10px;font-size:13px;cursor:pointer;flex-shrink:0;transition:background 0.15s,border-color 0.15s;">✕</button>
          </div>
          <input type="file" id="b24t-file-input" accept=".csv,.json,.xlsx" style="display:none">
          <div class="b24t-date-range" id="b24t-date-range" style="display:none">
            <span>Zakres dat:</span>
            <span class="b24t-date-chip" id="b24t-date-from">—</span>
            <span>→</span>
            <span class="b24t-date-chip" id="b24t-date-to">—</span>
          </div>
        </div>


        <!-- FILE VALIDATION -->
        <div id="b24t-file-validation" style="display:none;margin-top:8px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:8px 10px;"></div>

        <!-- MULTI-PROJEKT -->
        <div id="b24t-multiproject-section" style="display:none;margin-top:8px;"></div>

        <!-- COLUMN OVERRIDE -->
        <div id="b24t-column-override-section" style="display:none;margin-top:6px;">
          <button id="b24t-col-override-toggle" style="font-size:10px;color:var(--b24t-text-faint);background:none;border:none;cursor:pointer;padding:2px 0;">⚙ Zmień wykryte kolumny ▾</button>
          <div id="b24t-column-override" style="display:none;margin-top:6px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:8px 10px;"></div>
        </div>

        <!-- MATCH PREVIEW -->
        <div id="b24t-match-preview" style="display:none;margin-top:8px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:10px;"></div>

        <!-- PARTYCJE -->
        <div class="b24t-section" id="b24t-partition-section" style="display:none">
          <div class="b24t-section-label">Partycje</div>
          <div id="b24t-partition-info" style="font-size:11px;color:var(--b24t-text-meta);margin-bottom:6px;"></div>
          <div class="b24t-toggle-row" style="margin-bottom:6px;">
            <span class="b24t-toggle-label">Po zakończeniu partycji:</span>
          </div>
          <div class="b24t-radio-group">
            <label class="b24t-radio"><input type="radio" name="b24t-partition-mode" value="pause" checked> <span>Pauza</span></label>
            <label class="b24t-radio"><input type="radio" name="b24t-partition-mode" value="auto"> <span>Auto (30s)</span></label>
          </div>
          <button class="b24t-add-tag-btn" id="b24t-export-partitions" style="margin-top:6px;">↓ Eksportuj partie jako CSV</button>
        </div>

        <!-- MAPOWANIE -->
        <div class="b24t-section" id="b24t-mapping-section" style="display:none">
          <div class="b24t-section-label">Mapowanie labelek</div>
          <div id="b24t-assessment-col-bar" style="display:none;margin-bottom:8px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:6px 8px;">
            <div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:4px;">Kolumna z ocenami:</div>
            <div id="b24t-assessment-col-active" style="display:flex;align-items:center;gap:6px;">
              <span id="b24t-assessment-col-name" style="font-size:11px;color:var(--b24t-text);background:var(--b24t-bg-input);border:1px solid var(--b24t-border);border-radius:4px;padding:2px 7px;font-family:monospace;"></span>
              <button id="b24t-assessment-col-clear" title="Zmień kolumnę" style="font-size:10px;background:none;border:none;color:var(--b24t-text-faint);cursor:pointer;padding:0 2px;">✕ zmień</button>
            </div>
            <div id="b24t-assessment-col-picker" style="display:none;margin-top:4px;">
              <select id="b24t-assessment-col-sel" class="b24t-select" style="width:100%;">
                <option value="">— wybierz kolumnę z ocenami —</option>
              </select>
            </div>
          </div>
          <div id="b24t-mapping-rows"></div>
          <button class="b24t-add-tag-btn" id="b24t-create-tag-btn">+ Utwórz nowy tag w Brand24</button>
        </div>

        <!-- USTAWIENIA -->
        <div class="b24t-section" id="b24t-settings-section" style="display:none">
          <div class="b24t-section-label tertiary" id="b24t-settings-toggle" style="cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between;">
            <span>Ustawienia</span>
            <span id="b24t-settings-arrow" style="transition:transform 0.18s;">▸</span>
          </div>

          <div id="b24t-settings-content">
            <div class="b24t-toggle-row">
              <span class="b24t-toggle-label">Tryb:</span>
              <div class="b24t-radio-group">
                <label class="b24t-radio"><input type="radio" name="b24t-run-mode" value="real" checked> <span>Właściwy</span></label>
                <label class="b24t-radio"><input type="radio" name="b24t-run-mode" value="test"> <span>Test Run</span></label>
              </div>
            </div>

            <div class="b24t-toggle-row" style="margin-top:6px;">
              <span class="b24t-toggle-label">Mapa wzmianek:</span>
              <div class="b24t-radio-group">
                <label class="b24t-radio"><input type="radio" name="b24t-map-mode" value="untagged" checked> <span>Untagged</span></label>
                <label class="b24t-radio"><input type="radio" name="b24t-map-mode" value="full"> <span>Pełna</span></label>
              </div>
            </div>

            <!-- Konflikty — tylko w trybie pełnym -->
            <div id="b24t-conflict-section" style="display:none;margin-top:8px;">
              <div class="b24t-section-label" style="margin-bottom:4px;">Konflikty tagów</div>
              <div class="b24t-radio-group" style="flex-direction:column;gap:4px;">
                <label class="b24t-radio"><input type="radio" name="b24t-conflict" value="ignore" checked> <span>Ignoruj — zachowaj istniejący tag</span></label>
                <label class="b24t-radio"><input type="radio" name="b24t-conflict" value="ask"> <span>Zatrzymaj i zapytaj</span></label>
                <label class="b24t-radio"><input type="radio" name="b24t-conflict" value="overwrite"> <span>Nadpisz — zamień tag</span></label>
                <label class="b24t-radio"><input type="radio" name="b24t-conflict" value="multitag"> <span>Multitag — dodaj obok istniejących tagów</span></label>
              </div>
            </div>

            <!-- Po zakończeniu — tylko gdy jest label "Inny" -->
            <div id="b24t-switchview-section" style="display:none;margin-top:8px;">
              <div class="b24t-checkbox-row">
                <input type="checkbox" id="b24t-switch-view">
                <label for="b24t-switch-view">Po zakończeniu przełącz widok na:</label>
              </div>
              <select class="b24t-select" id="b24t-switch-view-tag" style="margin-top:4px;"></select>
            </div>

            <!-- AUTO DELETE — injected by JS -->
            <div id="b24t-auto-delete-placeholder"></div>

            <div style="height:1px;background:var(--b24t-border);margin:8px 0;"></div>
            <div class="b24t-checkbox-row">
              <input type="checkbox" id="b24t-sound-cb">
              <label for="b24t-sound-cb">Dźwięk po zakończeniu sesji</label>
            </div>
          </div>

        </div>

        <!-- POSTĘP -->
        <div class="b24t-section" id="b24t-progress-section">
          <div class="b24t-section-label primary">Postęp</div>
          <div id="b24t-progress-label" style="font-size:12px;color:var(--b24t-text-meta);">Gotowy do startu</div>
          <div class="b24t-progress-bar-track"><div id="b24t-progress-bar"></div></div>
          <div id="b24t-progress-action" style="font-size:10px;color:var(--b24t-text-faint);"></div>
        </div>

        <!-- STATYSTYKI -->
        <div class="b24t-section">
          <div class="b24t-section-label">Statystyki sesji</div>
          <div class="b24t-stats-row-list">
            <div class="b24t-stat-row">
              <span class="b24t-stat-row-label">Otagowano</span>
              <span class="b24t-stat-row-value ok" id="b24t-stat-tagged">0</span>
            </div>
            <div class="b24t-stat-row">
              <span class="b24t-stat-row-label">Pominięto</span>
              <span class="b24t-stat-row-value warn" id="b24t-stat-skipped" style="cursor:pointer" title="Kliknij aby zobaczyć listę">0</span>
            </div>
            <div class="b24t-stat-row">
              <span class="b24t-stat-row-label">Pozostało</span>
              <span class="b24t-stat-row-value" id="b24t-stat-remaining">0</span>
            </div>
          </div>
        </div>

        <!-- LOG -->
        <div class="b24t-section" id="b24t-log-section">
          <div class="b24t-section-label tertiary">
            Log
            <button class="b24t-log-clear" id="b24t-log-clear">wyczyść</button>
            <button class="b24t-log-expand" id="b24t-log-expand" title="Pełny widok loga">↗</button>
          </div>
          <div id="b24t-log"></div>
        </div>

      </div><!-- /b24t-main-tab -->

      <!-- DELETE TAB (injected by JS) -->
      <div id="b24t-delete-tab-placeholder"></div>

      <!-- QUICK TAG TAB (injected by JS) -->
      <div id="b24t-quicktag-tab-placeholder"></div>

      <!-- HISTORY TAB (injected by JS) -->\n      <div id=\"b24t-history-tab-placeholder\"></div>\n\n      <!-- NEWS TAB (injected by JS) -->\n      <div id="b24t-news-tab-placeholder"></div>

      <!-- Annotator Tools: floating panel, no inline tabs -->
      <!-- Annotator Tools: moved to floating panel -->

      </div><!-- /body -->

      <!-- ACTION BAR -->
      <div id="b24t-actions" style="flex-direction:column;gap:6px;">
        <button class="b24t-btn-primary" id="b24t-btn-start" style="width:100%;">▶ Start</button>
        <div id="b24t-run-controls" style="display:flex;gap:6px;width:100%;">
          <button class="b24t-btn-secondary" id="b24t-btn-pause" disabled style="flex:1;font-size:11px;">⏸ Pauza</button>
          <button class="b24t-btn-danger" id="b24t-btn-stop" style="flex:1;font-size:11px;">⏹ Stop</button>
        </div>
        <div id="b24t-diag-controls" style="display:flex;gap:6px;width:100%;">
          <button class="b24t-btn-secondary b24t-btn-tool" id="b24t-btn-preview" title="Match Preview — sprawdź dopasowanie bez tagowania" style="flex:1;">Match</button>
          <button class="b24t-btn-secondary b24t-btn-tool" id="b24t-btn-audit" title="Audit Mode — porównaj bez tagowania" style="flex:1;">Audit</button>
          <button class="b24t-btn-secondary b24t-btn-tool" id="b24t-btn-export" title="Eksport raportu CSV" style="flex:0 0 34px;">↓</button>
        </div>
      </div>

      <!-- REPORT MODAL -->
      <div id="b24t-report-modal">
        <div class="b24t-report-content"></div>
      </div>
    </div>`;

    return panel;
  }

  // ───────────────────────────────────────────
  // UI - DRAGGING & COLLAPSING
  // ───────────────────────────────────────────


  // ───────────────────────────────────────────
  // RESIZE — Windows-style resize dla obu paneli
  // ───────────────────────────────────────────

  const RESIZE_HANDLE_SIZE = 8; // px strefa klikania krawędzi

  // Zwraca 'compact' jeśli ekran jest mały (laptop z małą przekątną)
  function _getScreenProfile() {
    return (window.innerWidth < 1366 || window.innerHeight < 800) ? 'compact' : 'normal';
  }

  // Skaluje zawartość głównego panelu proporcjonalnie do jego szerokości
  function _applyPanelZoom(panel) {
    var inner = document.getElementById('b24t-panel-inner');
    if (!inner || !panel) return;
    var w = panel.offsetWidth;
    if (!w) return;

    var newScale = (w >= BASE_PANEL_W) ? 1 : Math.max(0.5, w / BASE_PANEL_W);

    var panelH = panel.offsetHeight;
    inner.style.zoom = newScale;
    inner.style.width = (newScale < 1) ? BASE_PANEL_W + 'px' : '100%';
    // min-height kompensuje zoom: po przeskalowaniu inner wizualnie wypełnia cały panel
    inner.style.minHeight = (newScale < 1 && panelH) ? Math.ceil(panelH / newScale) + 'px' : '';
  }

  // Dodaje/usuwa klasę b24t-compact na panelu w zależności od jego szerokości
  // Dla głównego panelu (#b24t-panel) używa zoom zamiast compact class
  function _updatePanelClass(panel) {
    if (panel && panel.id === 'b24t-panel') {
      _applyPanelZoom(panel);
      return;
    }
    var w = panel.offsetWidth;
    if (w > 0 && w < 400) {
      panel.classList.add('b24t-compact');
    } else {
      panel.classList.remove('b24t-compact');
    }
  }

  function setupResize(panel, lsKey, opts) {
    opts = opts || {};
    var minW = opts.minW || 300;
    var maxW = opts.maxW || Math.min(720, Math.round(window.innerWidth * 0.85));
    var minH = opts.minH || 300;
    var maxH = opts.maxH || Math.round(window.innerHeight * 0.92);

    // Przywróć zapisany rozmiar
    var saved = lsGet(lsKey);
    if (saved) {
      if (saved.width)  panel.style.width  = Math.min(maxW, Math.max(minW, saved.width))  + 'px';
      if (saved.height) {
        var h = Math.min(maxH, Math.max(minH, saved.height));
        panel.style.height = h + 'px';
        panel.style.maxHeight = h + 'px';
      }
    }
    _updatePanelClass(panel);

    // Dodaj CSS cursor na krawędziach przez mousemove
    var isResizing = false;
    var resizeDir = '';
    var startX, startY, startW, startH, startLeft, startTop;

    function getDir(e) {
      var r = panel.getBoundingClientRect();
      var x = e.clientX, y = e.clientY;
      var hs = RESIZE_HANDLE_SIZE;
      var onL = x < r.left   + hs;
      var onR = x > r.right  - hs;
      var onT = y < r.top    + hs;
      var onB = y > r.bottom - hs;
      if (onT && onL) return 'nw';
      if (onT && onR) return 'ne';
      if (onB && onL) return 'sw';
      if (onB && onR) return 'se';
      if (onL) return 'w';
      if (onR) return 'e';
      if (onT) return 'n';
      if (onB) return 's';
      return '';
    }

    var cursorMap = { n:'n-resize', s:'s-resize', e:'e-resize', w:'w-resize',
                      ne:'ne-resize', nw:'nw-resize', se:'se-resize', sw:'sw-resize' };

    panel.addEventListener('mousemove', function(e) {
      if (isResizing) return;
      // Nie zmieniaj kursora gdy mousemove pochodzi od wewnętrznego elementu który sam ma kursor
      if (e.target !== panel && !e.target.classList.contains('b24t-resize-handle')) {
        var dir = getDir(e);
        panel.style.cursor = dir ? cursorMap[dir] : '';
        return;
      }
      var dir = getDir(e);
      panel.style.cursor = dir ? cursorMap[dir] : '';
    });

    panel.addEventListener('mouseleave', function() {
      if (!isResizing) panel.style.cursor = '';
    });

    panel.addEventListener('mousedown', function(e) {
    if (panel.getAttribute('data-ob-locked')) return; // onboarding aktywny
      // Ignoruj kliknięcia na przyciski/inputy
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' ||
          e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      var dir = getDir(e);
      if (!dir) return;

      isResizing = true;
      resizeDir = dir;
      var r = panel.getBoundingClientRect();
      startX    = e.clientX;
      startY    = e.clientY;
      startW    = r.width;
      startH    = r.height;
      startLeft = r.left;
      startTop  = r.top;

      panel.classList.add('b24t-resizing');
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isResizing) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

      if (resizeDir.includes('e')) newW = startW + dx;
      if (resizeDir.includes('w')) { newW = startW - dx; newLeft = startLeft + dx; }
      if (resizeDir.includes('s')) newH = startH + dy;
      if (resizeDir.includes('n')) { newH = startH - dy; newTop  = startTop  + dy; }

      newW = Math.min(maxW, Math.max(minW, newW));
      newH = Math.min(maxH, Math.max(minH, newH));

      // Clamp pozycję żeby nie wyszła poza ekran
      newLeft = Math.max(0, Math.min(window.innerWidth  - newW, newLeft));
      newTop  = Math.max(0, Math.min(window.innerHeight - 60,   newTop));

      panel.style.width = newW + 'px';
      panel.style.left  = newLeft + 'px';
      panel.style.top   = newTop  + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';

      // Dla main panelu: panel ma display:flex flex-direction:column, body ma flex:1 min-height:0
      // Wystarczy ustawić height na panel — flex rozkłada przestrzeń automatycznie
      if (opts.useMaxHeight) {
        panel.style.height = newH + 'px';
        panel.style.maxHeight = newH + 'px';
      } else {
        panel.style.height = newH + 'px';
      }
      _updatePanelClass(panel);
    });

    document.addEventListener('mouseup', function() {
      if (!isResizing) return;
      isResizing = false;
      resizeDir = '';
      panel.classList.remove('b24t-resizing');
      document.body.style.userSelect = '';
      panel.style.cursor = '';

      // Zapisz rozmiar
      var r = panel.getBoundingClientRect();
      lsSet(lsKey, { width: Math.round(r.width), height: Math.round(r.height) });

      // Też zapisz pozycję (bo mogła się zmienić przy resize od lewej/góry)
      lsSet(LS.UI_POS, { left: panel.style.left, top: panel.style.top });
      _updatePanelClass(panel);
    });

    // ResizeObserver jako fallback — łapie zmiany rozmiaru z każdego źródła
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function() { _updatePanelClass(panel); });
      ro.observe(panel);
    }
  }

  var _zTop = 2147483630;
  function _bringToFront(panel) {
    _zTop = Math.min(_zTop + 1, 2147483646);
    panel.style.zIndex = _zTop;
  }

  function setupDragging(panel) {
    const topbar = panel.querySelector('#b24t-topbar');
    let isDragging = false, startX, startY, startLeft, startTop;

    // Restore position - validate it's within current viewport
    const pos = lsGet(LS.UI_POS);
    if (pos) {
      const left = parseInt(pos.left);
      const top = parseInt(pos.top);
      const inBounds = left >= 0 && left < window.innerWidth - 100 &&
                       top >= 0 && top < window.innerHeight - 50;
      if (inBounds) {
        panel.style.left = pos.left;
        panel.style.top = pos.top;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      } else {
        // Out of bounds - reset to default bottom-right corner
        lsSet(LS.UI_POS, null);
      }
    }

    topbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      if (panel.getAttribute('data-ob-locked')) return; // onboarding aktywny
      isDragging = true;
      _bringToFront(panel);
      panel.classList.add('dragging');
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + dy));
      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      panel.classList.remove('dragging');
      lsSet(LS.UI_POS, { left: panel.style.left, top: panel.style.top });
    });

    // Clampuj pozycję panelu przy zmianie rozmiaru okna
    window.addEventListener('resize', () => {
      if (!panel.style.left && !panel.style.top) return;
      var l = parseInt(panel.style.left) || 0;
      var tp = parseInt(panel.style.top)  || 0;
      var nl = Math.max(0, Math.min(window.innerWidth  - (panel.offsetWidth  || 300), l));
      var nt = Math.max(0, Math.min(window.innerHeight - 60, tp));
      if (nl !== l || nt !== tp) {
        panel.style.left   = nl + 'px';
        panel.style.top    = nt + 'px';
        panel.style.right  = 'auto';
        panel.style.bottom = 'auto';
        lsSet(LS.UI_POS, { left: panel.style.left, top: panel.style.top });
      }
    });
  }

  function setupCollapse(panel) {
    const btn = panel.querySelector('#b24t-btn-collapse');
    const collapsed = lsGet(LS.UI_COLLAPSED, false);
    if (collapsed) {
      panel.classList.add('collapsed');
      panel.style.height = '';
      panel.style.maxHeight = '';
    }
    btn.textContent = collapsed ? '▲' : '▼';

    btn.addEventListener('click', () => {
      const isCollapsed = panel.classList.toggle('collapsed');
      btn.textContent = isCollapsed ? '▲' : '▼';
      lsSet(LS.UI_COLLAPSED, isCollapsed);
      if (isCollapsed) {
        panel.style.height = '';
        panel.style.maxHeight = '';
      }
    });

    // Hide-to-side button (in collapsed header)
    var hideBtn = panel.querySelector('#b24t-btn-hide-panel');
    if (hideBtn) {
      hideBtn.addEventListener('click', function() {
        panel.style.display = 'none';
        var mainTab = document.getElementById('b24t-panel-side-tab');
        if (mainTab) {
          mainTab.style.display = 'flex';
          mainTab.style.cssText += ';display:flex!important;';
        }
        lsSet('b24tagger_panel_hidden', true);
      });
    }
  }

  // ───────────────────────────────────────────
  // UI - EVENT WIRING
  // ───────────────────────────────────────────

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-b24t-theme', theme);
    const track = document.getElementById('b24t-theme-track');
    if (track) {
      if (theme === 'dark') track.classList.add('is-dark');
      else track.classList.remove('is-dark');
    }
    lsSet(LS.THEME, theme);
    const ap = document.getElementById('b24t-annotator-panel');
    const at = document.getElementById('b24t-annotator-tab');
    if (ap) ap.setAttribute('data-b24t-theme', theme);
    if (at) at.setAttribute('data-b24t-theme', theme);
  }

  function wireEvents(panel) {
    // File upload
    const fileZone = panel.querySelector('#b24t-file-zone');
    const fileInput = panel.querySelector('#b24t-file-input');
    fileZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFileUpload(e.target.files[0]));

    // Clear file button
    const clearFileBtn = panel.querySelector('#b24t-btn-clear-file');
    if (clearFileBtn) {
      clearFileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearFile();
      });
    }

    // Drag & drop on file zone
    fileZone.addEventListener('dragover', (e) => { e.preventDefault(); fileZone.classList.add('b24t-dragover'); });
    fileZone.addEventListener('dragleave', () => { fileZone.classList.remove('b24t-dragover'); });
    fileZone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileZone.classList.remove('b24t-dragover');
      if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
    });

    // Start / Resume
    panel.querySelector('#b24t-btn-start').addEventListener('click', () => {
      if (state.status === 'idle' || state.status === 'done') {
        initRun();
      } else if (state.status === 'paused') {
        state.currentPartitionIdx++;
        state.status = 'running';
        updateStatusUI();
        startRun();
      }
    });

    // Pause
    panel.querySelector('#b24t-btn-pause').addEventListener('click', () => {
      if (state.status === 'running') {
        state.status = 'paused';
        updateStatusUI();
        addLog('⏸ Pauzowanie — czekam na zakończenie bieżącej akcji...', 'warn');
      }
    });

    // Stop
    panel.querySelector('#b24t-btn-stop').addEventListener('click', () => {
      if (confirm('Zatrzymać wtyczkę? Postęp zostanie zapisany.')) {
        state.status = 'idle';
        stopHealthCheck();
        updateStatusUI();
        addLog('⏹ Zatrzymano przez użytkownika.', 'warn');
        saveCheckpoint();
      }
    });

    // Export
    panel.querySelector('#b24t-btn-export').addEventListener('click', exportReport);

    // Match Preview
    panel.querySelector('#b24t-btn-preview')?.addEventListener('click', async () => {
      if (!state.file) { addLog('Wgraj plik przed Match Preview.', 'warn'); return; }
      if (!state.tokenHeaders) { addLog('Token nie gotowy — poczekaj chwile.', 'warn'); return; }
      const preview = await runMatchPreview();
      if (preview) renderMatchPreview(preview);
    });

    // Audit Mode
    panel.querySelector('#b24t-btn-audit')?.addEventListener('click', async () => {
      if (!state.file) { addLog('Wgraj plik przed Audit Mode.', 'warn'); return; }
      if (!Object.keys(state.mapping).length) { addLog('Skonfiguruj mapowanie przed Audit Mode.', 'warn'); return; }
      if (state.status === 'running') { addLog('Sesja jest juz uruchomiona.', 'warn'); return; }
      await runAuditMode();
    });

    // Column override toggle
    panel.querySelector('#b24t-col-override-toggle')?.addEventListener('click', () => {
      const box = document.getElementById('b24t-column-override');
      const btn = document.getElementById('b24t-col-override-toggle');
      if (!box) return;
      const show = box.style.display === 'none';
      box.style.display = show ? 'block' : 'none';
      btn.textContent = (show ? '\u2699 Zmień wykryte kolumny \u25b4' : '\u2699 Zmień wykryte kolumny \u25be');
      if (show && state.file && state.file.rows) buildColumnOverrideUI(state.file.rows);
    });

    // Sound checkbox
    panel.querySelector('#b24t-sound-cb')?.addEventListener('change', (e) => {
      state.soundEnabled = e.target.checked;
    });

    // Settings collapse toggle
    (function() {
      var settingsToggle = document.getElementById('b24t-settings-toggle');
      var settingsContent = document.getElementById('b24t-settings-content');
      var settingsArrow = document.getElementById('b24t-settings-arrow');
      if (!settingsToggle || !settingsContent) return;
      var collapsed = localStorage.getItem('b24tagger_settings_collapsed') === '1';
      function applyCollapsed(c) {
        settingsContent.style.display = c ? 'none' : '';
        if (settingsArrow) settingsArrow.style.transform = c ? 'rotate(0deg)' : 'rotate(90deg)';
        localStorage.setItem('b24tagger_settings_collapsed', c ? '1' : '0');
      }
      applyCollapsed(collapsed);
      settingsToggle.addEventListener('click', function() {
        collapsed = !collapsed;
        applyCollapsed(collapsed);
      });
    })();

    // Log clear
    panel.querySelector('#b24t-log-clear').addEventListener('click', () => {
      document.getElementById('b24t-log').innerHTML = '';
      state.logs = [];
    });

    // Log expand — pełnoekranowy panel loga
    panel.querySelector('#b24t-log-expand').addEventListener('click', () => {
      openLogPanel();
    });

    // Help
    panel.querySelector('#b24t-btn-help').addEventListener('click', toggleHelpMode);

    // Changelog
    panel.querySelector('#b24t-btn-changelog')?.addEventListener('click', () => showWhatsNewExtended(true));

    // Feedback
    panel.querySelector('#b24t-btn-feedback')?.addEventListener('click', () => showFeedbackModal());

    // Dodatkowe funkcje
    panel.querySelector('#b24t-btn-features')?.addEventListener('click', () => showFeaturesModal());

    // ── APPLY SAVED THEME ON INIT ──
    applyTheme(lsGet(LS.THEME, 'light'));

    // Annotator Tools: wired in buildAnnotatorPanel()

    // Version click — sprawdź aktualizacje
    const versionEl = document.getElementById('b24t-version');
    if (versionEl) {
      versionEl.addEventListener('mousedown', function(e) { e.stopPropagation(); });
      versionEl.addEventListener('click', function() {
        versionEl.style.opacity = '0.5';
        checkForUpdate(true);
        setTimeout(function() { versionEl.style.opacity = ''; }, 3000);
      });
    }

    // Crash banner
    panel.querySelector('#b24t-crash-resume').addEventListener('click', () => {
      document.getElementById('b24t-crash-banner').style.display = 'none';
      state.status = 'running';
      updateStatusUI();
      startRun();
    });
    panel.querySelector('#b24t-crash-reset').addEventListener('click', () => {
      if (confirm('Zacząć od nowa? Postęp zostanie utracony.')) {
        clearCheckpoint();
        lsSet(LS.CRASHLOG, null);
        document.getElementById('b24t-crash-banner').style.display = 'none';
        state.status = 'idle';
        state.currentPartitionIdx = 0;
        state.stats = { tagged: 0, skipped: 0, noMatch: 0, conflicts: 0 };
        updateStatusUI();
        updateStatsUI();
      }
    });
    panel.querySelector('#b24t-crash-detail-toggle').addEventListener('click', () => {
      const detail = document.getElementById('b24t-crash-detail');
      const isVisible = detail.style.display === 'block';
      detail.style.display = isVisible ? 'none' : 'block';
      document.getElementById('b24t-crash-detail-toggle').textContent = isVisible ? 'Szczegóły ▾' : 'Szczegóły ▴';
    });

    // Run mode toggle
    panel.querySelectorAll('input[name="b24t-run-mode"]').forEach(r => {
      r.addEventListener('change', (e) => { state.testRunMode = e.target.value === 'test'; });
    });

    // Map mode toggle
    panel.querySelectorAll('input[name="b24t-map-mode"]').forEach(r => {
      r.addEventListener('change', (e) => {
        state.mapMode = e.target.value;
        document.getElementById('b24t-conflict-section').style.display =
          state.mapMode === 'full' ? 'block' : 'none';
      });
    });

    // Conflict mode
    panel.querySelectorAll('input[name="b24t-conflict"]').forEach(r => {
      r.addEventListener('change', (e) => { state.conflictMode = e.target.value; });
    });

    // Switch view
    panel.querySelector('#b24t-switch-view').addEventListener('change', (e) => {
      state.switchViewOnDone = e.target.checked;
    });
    panel.querySelector('#b24t-switch-view-tag').addEventListener('change', (e) => {
      state.switchViewTagId = parseInt(e.target.value);
    });

    // Partition mode
    panel.querySelectorAll('input[name="b24t-partition-mode"]').forEach(r => {
      r.addEventListener('change', (e) => { state.autoPartition = e.target.value === 'auto'; });
    });

    // Export partitions
    panel.querySelector('#b24t-export-partitions').addEventListener('click', exportPartitions);

    // Create tag
    panel.querySelector('#b24t-create-tag-btn').addEventListener('click', async () => {
      const title = prompt('Nazwa nowego tagu:');
      if (!title) return;
      try {
        const tag = await createTag(title);
        if (tag?.id) {
          state.tags[tag.title] = tag.id;
          renderMappingRows();
          addLog(`✓ Utworzono tag: ${tag.title} (ID: ${tag.id})`, 'success');
        }
      } catch (e) {
        showError(`Nie udało się utworzyć tagu: ${e.message}`);
      }
    });

    // Skipped stat - show list
    panel.querySelector('#b24t-stat-skipped').addEventListener('click', () => {
      const noMatchLogs = state.logs.filter(l => l.message.includes('Brak matcha'));
      if (!noMatchLogs.length) return alert('Brak wzmianek bez matcha.');
      alert(`Wzmianki bez matcha (${noMatchLogs.length}):\n\n` +
        noMatchLogs.map(l => l.message.replace('⚠ ', '')).join('\n'));
    });

  }

  // ───────────────────────────────────────────
  // FILE HANDLING
  // ───────────────────────────────────────────

  async function handleFileUpload(file) {
    if (!file) return;
    addLog(`→ Wczytuję plik: ${file.name}`, 'info');

    try {
      let rows;
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'csv') {
        const text = await file.text();
        rows = parseCSV(text);
      } else if (ext === 'json') {
        const text = await file.text();
        rows = parseJSON(text);
      } else if (ext === 'xlsx') {
        rows = await parseXLSXFile(file);
      } else {
        throw new Error('Nieobsługiwany format pliku. Użyj CSV, JSON lub XLSX.');
      }

      if (!rows || !rows.length) throw new Error('Plik jest pusty lub nieprawidłowy.');

      rows = sanitizeInputRows(rows);

      const colMap = autoDetectColumns(rows);
      const meta = processFileData(rows, colMap);

      // Fallback: if url not detected, try every column for http pattern
    if (!colMap.url) {
      const firstRow = rows[0] || {};
      const urlFallback = Object.keys(firstRow).find(k =>
        rows.slice(0, 10).some(r => /^https?:\/\//.test(String(r[k] || '')))
      );
      if (urlFallback) {
        colMap.url = urlFallback;
        addLog(`→ Kolumna URL wykryta jako fallback: "${urlFallback}"`, 'warn');
      }
    }

    state.file = { name: file.name, rows, colMap, meta };

      // Update UI
      document.getElementById('b24t-file-name').textContent = file.name;
      document.getElementById('b24t-file-meta').textContent =
        `${meta.totalRows} wierszy · ${Object.keys(meta.assessments).map(k => `${meta.assessments[k]} ${k.toLowerCase()}`).join(' · ')}` +
        (meta.noAssessment > 0 ? ` · ${meta.noAssessment} bez oceny ℹ` : '');
      const clearBtnEl = document.getElementById('b24t-btn-clear-file');
      if (clearBtnEl) clearBtnEl.style.display = 'block';

      if (meta.minDate && meta.maxDate) {
        document.getElementById('b24t-date-from').textContent = meta.minDate;
        document.getElementById('b24t-date-to').textContent = meta.maxDate;
        document.getElementById('b24t-date-range').style.display = 'flex';
      }

      // Partitioning
      const partitions = buildPartitions(rows, colMap, state.partitionLimit);
      state.partitions = partitions;
      state.currentPartitionIdx = 0;

      if (partitions.length > 1) {
        const ps = document.getElementById('b24t-partition-section');
        ps.style.display = 'block';
        ps.style.animation = 'none'; void ps.offsetHeight; ps.style.animation = 'b24t-section-reveal 0.18s ease-out';
        document.getElementById('b24t-partition-info').textContent =
          `${partitions.length} partycji · max ${state.partitionLimit} wzmianek/partycja`;
      }

      // Show mapping section
      ['b24t-mapping-section', 'b24t-settings-section'].forEach(function(id, i) {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = 'block';
        el.style.animation = 'none'; void el.offsetHeight;
        el.style.animation = 'b24t-section-reveal 0.18s ease-out';
      });

      // Check for saved schema
      const savedSchema = findMatchingSchema(Object.keys(meta.assessments));
      if (savedSchema) {
        addLog(`💡 Znaleziono pasujący schemat z ${savedSchema.usedAt}. Sprawdź mapowanie!`, 'warn');
      }

      renderMappingRows(meta.assessments, savedSchema);
      renderAssessmentColBar(rows, colMap);
      updateStatsUI();
      addLog(`✓ Plik załadowany: ${meta.totalRows} wierszy, ${Object.keys(meta.assessments).length} typów labelek`, 'success');
      addLog(`→ Wykryte kolumny: url="${colMap.url || 'BRAK!'}" | assessment="${colMap.assessment || 'BRAK!'}" | date="${colMap.date || 'BRAK!'}"`+ (colMap.projectId ? ` | project_id="${colMap.projectId}"` : ''), 'info');
      showToast(`✓ Plik załadowany: ${meta.totalRows} wierszy`, 'success');

      if (colMap.projectId) {
        addLog(`→ Multi-projekt: wykryto kolumnę projektów "${colMap.projectId}"`, 'info');
        renderMultiProjectWidget(rows, colMap);
      } else {
        const mpEl = document.getElementById('b24t-multiproject-section');
        if (mpEl) { mpEl.style.display = 'none'; delete mpEl.dataset.blocked; }
      }

      // Walidacja krytyczna — blokuje Start jeśli brak URL/dat
      const fileWarnings = validateFile(rows, colMap);
      renderFileValidation(fileWarnings);
      if (fileWarnings.some(w => w.type === 'error')) {
        addLog('⛔ Plik ma błędy krytyczne — Start zablokowany. Sprawdź ostrzeżenia nad mapowaniem.', 'error');
      }

    } catch (e) {
      addLog(`✕ Błąd pliku: ${e.message}`, 'error');
      alert(`Błąd wczytywania pliku: ${e.message}`);
    }
  }

  function clearFile() {
    if (state.status === 'running' || state.status === 'paused') {
      addLog('⚠ Nie można usunąć pliku podczas aktywnej sesji.', 'warn');
      return;
    }
    // Reset state
    state.file = null;
    state.mapping = {};
    state.partitions = [];
    state.currentPartitionIdx = 0;
    state.urlMap = {};
    state.matchPreview = null;
    state.stats = { tagged: 0, skipped: 0, noMatch: 0, conflicts: 0 };

    // Reset file UI
    const fileNameEl = document.getElementById('b24t-file-name');
    const fileMetaEl = document.getElementById('b24t-file-meta');
    const dateRangeEl = document.getElementById('b24t-date-range');
    const fileInput = document.getElementById('b24t-file-input');
    const clearBtn = document.getElementById('b24t-btn-clear-file');
    if (fileNameEl) fileNameEl.textContent = 'Kliknij aby wgrać plik...';
    if (fileMetaEl) fileMetaEl.textContent = 'CSV, JSON lub XLSX';
    if (dateRangeEl) dateRangeEl.style.display = 'none';
    if (fileInput) fileInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';

    // Hide dependent sections
    const sectionsToHide = ['b24t-file-validation','b24t-multiproject-section','b24t-mapping-section','b24t-settings-section',
                            'b24t-partition-section','b24t-match-preview','b24t-column-override-section'];
    sectionsToHide.forEach(function(id) {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; if (el.dataset) { el.dataset.hasErrors = ''; el.dataset.blocked = ''; } }
    });

    // Reset validation block and re-enable start buttons
    _updateStartBtnBlock();

    // Clear mapping rows
    const mappingRows = document.getElementById('b24t-mapping-rows');
    if (mappingRows) mappingRows.innerHTML = '';

    updateStatsUI();
    addLog('🗑 Plik usunięty. Wgraj nowy plik.', 'info');
  }

  function renderMultiProjectWidget(rows, colMap) {
    var el = document.getElementById('b24t-multiproject-section');
    if (!el) return;
    var savedProjects = lsGet(LS.PROJECTS, {});
    var projectCounts = {};
    rows.forEach(function(row) {
      var pid = (row[colMap.projectId] || '').toString().trim();
      if (!pid) return;
      projectCounts[pid] = (projectCounts[pid] || 0) + 1;
    });
    var projectIds = Object.keys(projectCounts);
    var hasUnknown = projectIds.some(function(pid) { return !savedProjects[pid]; });
    el.style.display = 'block';
    el.dataset.blocked = hasUnknown ? '1' : '';
    var borderColor = hasUnknown ? '#f87171' : 'var(--b24t-border)';
    var rows_html = projectIds.map(function(pid) {
      var known = !!savedProjects[pid];
      var name = known ? _pnResolve(pid) : null;
      var count = projectCounts[pid];
      var icon = known ? '✓' : '✕';
      var iconColor = known ? '#4ade80' : '#f87171';
      return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;">' +
        '<span style="color:' + iconColor + ';flex-shrink:0;">' + icon + '</span>' +
        '<span style="color:var(--b24t-text);font-family:monospace;font-size:10px;">' + pid + '</span>' +
        (name ? '<span style="color:var(--b24t-text-meta);">' + name + '</span>' : '') +
        '<span style="color:var(--b24t-text-faint);margin-left:auto;">' + count + ' wierszy</span>' +
        (!known ? '<span style="color:#f87171;font-size:10px;">— odwiedź projekt w Brand24 najpierw</span>' : '') +
        '</div>';
    }).join('');
    el.innerHTML = '<div style="background:var(--b24t-bg-elevated);border:1px solid ' + borderColor + ';border-radius:6px;padding:8px 10px;">' +
      '<div style="font-size:10px;font-weight:600;color:var(--b24t-text-faint);margin-bottom:6px;letter-spacing:.04em;">WYKRYTE PROJEKTY (' + projectIds.length + ')</div>' +
      rows_html +
      (hasUnknown ? '<div style="margin-top:6px;font-size:10px;color:#f87171;font-weight:600;">⛔ Start zablokowany — odwiedź nieznane projekty w Brand24 aby załadować ich tagi.</div>' : '') +
      '</div>';
    _updateStartBtnBlock();
  }

  async function parseXLSXFile(file) {
    // Jeśli SheetJS jest już załadowany — użyj od razu
    // Sprawdź unsafeWindow.XLSX (prawdziwy window strony, nie sandbox TM)
    const _win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    if (_win.XLSX && typeof _win.XLSX.read === 'function') {
      return new Promise((resolve, reject) => readWithSheetJS(file, resolve, reject));
    }

    // Załaduj SheetJS przez GM_xmlhttpRequest (omija CSP Brand24)
    // a następnie eval w unsafeWindow scope
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'undefined') {
        // Fallback: dynamiczny script tag (może być zablokowany przez CSP)
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        script.onload = function() {
          if (window.XLSX) readWithSheetJS(file, resolve, reject);
          else reject(new Error('SheetJS załadowany ale XLSX undefined — odśwież stronę'));
        };
        script.onerror = function() { reject(new Error('Nie można załadować parsera XLSX. Sprawdź połączenie.')); };
        document.head.appendChild(script);
        return;
      }

      // GM_xmlhttpRequest pobiera skrypt poza CSP
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
        onload: function(r) {
          if (r.status !== 200) {
            reject(new Error('Błąd pobierania SheetJS: ' + r.status));
            return;
          }
          try {
            // Uruchom kod SheetJS w kontekście unsafeWindow
            const _win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            const fn = new Function('window', r.responseText + '; return window.XLSX;');
            const XLSX = fn(_win);
            if (!_win.XLSX && XLSX) _win.XLSX = XLSX;
            if (!_win.XLSX) throw new Error('XLSX nie zostało zdefiniowane po eval');
            readWithSheetJS(file, resolve, reject);
          } catch(e) {
            reject(new Error('Błąd inicjalizacji SheetJS: ' + e.message));
          }
        },
        onerror: function() { reject(new Error('Nie można pobrać parsera XLSX. Sprawdź połączenie.')); }
      });
    });
  }

  function readWithSheetJS(file, resolve, reject) {
    // Użyj unsafeWindow.XLSX jeśli dostępne — Tampermonkey sandbox ma oddzielne window
    const _XLSX = (typeof unsafeWindow !== 'undefined' && unsafeWindow.XLSX)
      ? unsafeWindow.XLSX
      : window.XLSX;
    if (!_XLSX || typeof _XLSX.read !== 'function') {
      reject(new Error('SheetJS (XLSX) nie jest załadowany. Odśwież stronę i spróbuj ponownie.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = _XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // rawNumbers:false + raw:false zapobiega obcinaniu dużych ID przez Number precision
        const rows = _XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        // Normalize date fields i duże ID numeryczne (TikTok/Twitter mają 19 cyfr > MAX_SAFE_INTEGER)
        rows.forEach(row => {
          Object.keys(row).forEach(k => {
            const v = row[k];
            if (v instanceof Date) {
              row[k] = v.toISOString().substring(0, 10);
            } else if (typeof v === 'number' && !Number.isSafeInteger(v)) {
              // Duża liczba — zostaw jako string żeby nie stracić cyfr
              row[k] = String(v);
            }
          });
        });
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  }

  // ───────────────────────────────────────────
  // SCHEMA MANAGEMENT
  // ───────────────────────────────────────────

  function findMatchingSchema(labels) {
    const schemas = lsGet(LS.SCHEMAS, {});
    const projectSchemas = schemas[state.projectId] || [];
    const labelSet = labels.map(l => l.toUpperCase()).sort().join(',');
    return projectSchemas.find(s => s.labels.map(l => l.toUpperCase()).sort().join(',') === labelSet) || null;
  }

  function saveSchema() {
    if (!state.projectId || !state.file || !Object.keys(state.mapping).length) return;
    const schemas = lsGet(LS.SCHEMAS, {});
    if (!schemas[state.projectId]) schemas[state.projectId] = [];
    const labels = Object.keys(state.file.meta.assessments);
    const existing = schemas[state.projectId].findIndex(s =>
      s.labels.sort().join(',') === labels.sort().join(',')
    );
    const schema = { labels, mapping: state.mapping, usedAt: new Date().toISOString().substring(0, 10) };
    if (existing >= 0) schemas[state.projectId][existing] = schema;
    else schemas[state.projectId].unshift(schema);
    lsSet(LS.SCHEMAS, schemas);
  }

  // ───────────────────────────────────────────
  // MAPPING UI
  // ───────────────────────────────────────────

  function renderMappingRows(assessments, savedSchema) {
    const container = document.getElementById('b24t-mapping-rows');
    if (!container) return;
    const meta = state.file?.meta;
    if (!meta) return;

    const source = assessments || meta.assessments;
    container.innerHTML = '';

    Object.entries(source).forEach(([label, count]) => {
      const row = document.createElement('div');
      row.className = 'b24t-map-row';
      row.style.marginBottom = '6px';

      // Tag select
      const tagOptions = Object.entries(state.tags)
        .map(([name, id]) => `<option value="${id}" ${savedSchema?.mapping?.[label]?.tagId === id ? 'selected' : ''}>${name}</option>`)
        .join('');

      // Type select
      const types = ['relevant', 'irrelevant', 'other'];
      const savedType = savedSchema?.mapping?.[label]?.type || 'other';
      const typeOptions = types.map(t =>
        `<option value="${t}" ${savedType === t ? 'selected' : ''}>${t}</option>`
      ).join('');

      row.innerHTML = `
        <div>
          <div class="b24t-map-label" title="${label}">${label}</div>
          <div class="b24t-map-count">(${count})</div>
        </div>
        <select class="b24t-select b24t-tag-select" data-label="${label}">
          <option value="">— wybierz tag —</option>
          ${tagOptions}
        </select>
        <select class="b24t-select b24t-type-select" data-label="${label}">
          ${typeOptions}
        </select>
      `;
      container.appendChild(row);
    });

    // No assessment row
    if (meta.noAssessment > 0) {
      const row = document.createElement('div');
      row.className = 'b24t-map-row';
      row.innerHTML = `
        <div>
          <div class="b24t-map-label">(bez oceny)</div>
          <div class="b24t-map-count">(${meta.noAssessment})</div>
        </div>
        <div style="font-size:10px;color:var(--b24t-text-faint);grid-column:span 2;">Pomiń ℹ</div>
      `;
      container.appendChild(row);
    }

    // Wire mapping selects
    container.querySelectorAll('.b24t-tag-select, .b24t-type-select').forEach(sel => {
      sel.addEventListener('change', () => updateMappingState(container));
    });

    updateMappingState(container);

    // Multi-project note
    var existingNote = document.getElementById('b24t-multiproject-mapping-note');
    if (existingNote) existingNote.remove();
    if (state.file && state.file.colMap && state.file.colMap.projectId) {
      var mpNote = document.createElement('div');
      mpNote.id = 'b24t-multiproject-mapping-note';
      mpNote.style.cssText = 'margin-top:8px;font-size:10px;color:var(--b24t-text-faint);padding:6px 8px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:5px;';
      mpNote.textContent = 'ℹ Tryb multi-projekt: mapowanie działa po nazwie tagu — nazwa musi być identyczna we wszystkich projektach.';
      container.parentNode.insertBefore(mpNote, container.nextSibling);
    }
  }

  function updateMappingState(container) {
    state.mapping = {};
    container.querySelectorAll('.b24t-tag-select').forEach(tagSel => {
      const label = tagSel.dataset.label;
      const tagId = parseInt(tagSel.value);
      if (!tagId) return;
      const typeSel = container.querySelector(`.b24t-type-select[data-label="${label}"]`);
      const type = typeSel?.value || 'other';
      const tagName = Object.entries(state.tags).find(([, id]) => id === tagId)?.[0] || '';
      state.mapping[label.toUpperCase()] = { tagId, tagName, type };
    });

    // Show/hide switch view section based on 'other' type labels
    const hasOther = Object.values(state.mapping).some(m => m.type === 'other');
    document.getElementById('b24t-switchview-section').style.display = hasOther ? 'block' : 'none';

    // Populate switch view dropdown
    if (hasOther) {
      const sel = document.getElementById('b24t-switch-view-tag');
      sel.innerHTML = Object.entries(state.mapping)
        .filter(([, m]) => m.type === 'other')
        .map(([label, m]) => `<option value="${m.tagId}">${m.tagName} (${label})</option>`)
        .join('');
      state.switchViewTagId = parseInt(sel.value) || null;
    }
    // F11: tag counts
    updateTagCountsInMapping();
    updateAutoDeleteSection();
  }

  // ───────────────────────────────────────────
  // ASSESSMENT COLUMN PICKER
  // ───────────────────────────────────────────

  function renderAssessmentColBar(rows, colMap) {
    const bar = document.getElementById('b24t-assessment-col-bar');
    const nameEl = document.getElementById('b24t-assessment-col-name');
    const clearBtn = document.getElementById('b24t-assessment-col-clear');
    const picker = document.getElementById('b24t-assessment-col-picker');
    const sel = document.getElementById('b24t-assessment-col-sel');
    if (!bar || !nameEl || !clearBtn || !picker || !sel) return;

    const headers = rows.length ? Object.keys(rows[0]) : [];

    function refreshBar() {
      const col = state.file && state.file.colMap && state.file.colMap.assessment;
      nameEl.textContent = col || '(brak)';
      nameEl.style.color = col ? 'var(--b24t-text)' : '#f87171';
      document.getElementById('b24t-assessment-col-active').style.display = 'flex';
      picker.style.display = 'none';
    }

    function populatePicker() {
      sel.innerHTML = '<option value="">— wybierz kolumnę z ocenami —</option>';
      headers.forEach(function(h) {
        const opt = document.createElement('option');
        opt.value = h;
        // Show unique values count as hint
        const uniq = new Set(rows.map(function(r){ return (r[h] || '').toString().trim(); }).filter(Boolean));
        opt.textContent = h + '  (' + uniq.size + ' unik. wartości: ' + [...uniq].slice(0,4).join(', ') + (uniq.size > 4 ? '…' : '') + ')';
        if (state.file && state.file.colMap && state.file.colMap.assessment === h) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    clearBtn.onclick = function() {
      populatePicker();
      document.getElementById('b24t-assessment-col-active').style.display = 'none';
      picker.style.display = 'block';
      sel.focus();
    };

    sel.onchange = function() {
      const chosen = sel.value;
      if (!chosen) return;
      // Apply new assessment column
      state.file.colMap.assessment = chosen;
      state.file.meta = processFileData(rows, state.file.colMap);
      // Re-render mapping with new labels
      renderMappingRows(state.file.meta.assessments, null);
      // Update file meta display
      const metaEl = document.getElementById('b24t-file-meta');
      if (metaEl) {
        const m = state.file.meta;
        metaEl.textContent = `${m.totalRows} wierszy · ` +
          Object.keys(m.assessments).map(function(k){ return m.assessments[k] + ' ' + k.toLowerCase(); }).join(' · ') +
          (m.noAssessment > 0 ? ` · ${m.noAssessment} bez oceny ℹ` : '');
      }
      // Revalidate
      const fileWarnings = validateFile(rows, state.file.colMap);
      renderFileValidation(fileWarnings);
      // Update column override UI if visible
      if (document.getElementById('b24t-column-override') && document.getElementById('b24t-column-override').style.display !== 'none') {
        buildColumnOverrideUI(rows);
      }
      addLog(`→ Kolumna labelek zmieniona na: "${chosen}" (${Object.keys(state.file.meta.assessments).length} typów)`, 'info');
      refreshBar();
    };

    bar.style.display = 'block';
    refreshBar();
  }

  // ───────────────────────────────────────────
  // INIT RUN
  // ───────────────────────────────────────────

  async function initRun() {
    if (!state.file) { showError('Najpierw wgraj plik z wzmiankami.'); return; }
    if (!Object.keys(state.mapping).length) { showError('Skonfiguruj mapowanie labelek.'); return; }
    if (!state.projectId) { showError('Przejdź do zakładki Mentions projektu Brand24.'); return; }
    // Guard: blokada przy błędach krytycznych pliku (brak URL / brak dat)
    const valEl = document.getElementById('b24t-file-validation');
    if (valEl && valEl.dataset.hasErrors === '1') {
      showError('Plik ma błędy krytyczne — sprawdź ostrzeżenia w sekcji "Plik źródłowy".');
      return;
    }

    // Potwierdzenie przy dużej liczbie wzmianek (200+) — tylko w trybie właściwym
    if (!state.testRunMode && state.file && state.file.rows && state.file.rows.length >= 200) {
      const count = state.file.rows.length;
      const projectName = state.projectName || state.projectId;
      const confirmed = window.confirm(
        `⚠ Duża operacja — potwierdzenie wymagane\n\n` +
        `Zamierzasz otagować ${count} wzmianek\n` +
        `w projekcie: ${projectName}\n\n` +
        `Ta operacja wykona realne zmiany w Brand24.\n` +
        `Czy na pewno chcesz kontynuować?`
      );
      if (!confirmed) {
        addLog('⏹ Sesja anulowana przez użytkownika.', 'info');
        return;
      }
    }
    if (!state.tokenHeaders) { showError('Token nie jest gotowy. Poczekaj chwilę aż strona się załaduje.'); return; }

    saveSchema();
    state.status = 'running';
    state.sessionStart = Date.now();
    state.stats = { tagged: 0, skipped: 0, noMatch: 0, conflicts: 0 };
    state.currentPartitionIdx = 0;
    updateStatusUI();

    addLog(`▶ Start ${state.testRunMode ? '[TEST RUN]' : '[WŁAŚCIWY]'} — projekt ${state.projectName}`, 'success');

    try {
      await startRun();
    } catch (e) {
      handleError(e, 'initRun');
    }
  }

  // ───────────────────────────────────────────
  // PROJECT DETECTION
  // ───────────────────────────────────────────

  async function detectProject() {
    const projectId = getProjectId();
    if (!projectId) return;

    state.projectId = projectId;

    // Capture tknB24 CSRF token — try immediately, then watch DOM for React injection
    (function captureTkn() {
      var el = document.querySelector('[name="tknB24"]');
      if (el && el.value) { state.tknB24 = el.value; return; }
      // Token not yet in DOM (SPA still rendering) — observe for up to 10s
      var obs = new MutationObserver(function() {
        var found = document.querySelector('[name="tknB24"]');
        if (found && found.value) { state.tknB24 = found.value; obs.disconnect(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() { obs.disconnect(); }, 10000);
    })();

    // Próbuj wyciągnąć nazwę z tytułu strony — ale sprawdź czy nie jest to generyczny tytuł Brand24
    const rawTitle = document.title.split(' - ')[0].trim();
    const isFallbackTitle = !rawTitle || rawTitle === 'Brand24' || rawTitle === 'Panel Brand24' || rawTitle.length < 3;
    state.projectName = isFallbackTitle ? `Project ${projectId}` : rawTitle;

    // Jeśli tytuł był fallbackiem — obserwuj zmiany tytułu przez MutationObserver
    if (isFallbackTitle) {
      let retryCount = 0;
      const updateName = function() {
        const t = document.title.split(' - ')[0].trim();
        if (t && t !== 'Brand24' && t !== 'Panel Brand24' && t.length >= 3) {
          state.projectName = t;
          _pnSet(projectId, t); // zapisz trwale do PROJECT_NAMES
          const el = document.getElementById('b24t-project-name');
          if (el) el.textContent = state.projectName;
          return true;
        }
        return false;
      };
      // Próbuj co 500ms przez max 10s
      const retryInterval = setInterval(function() {
        retryCount++;
        if (updateName() || retryCount >= 20) clearInterval(retryInterval);
      }, 500);
    }

    document.getElementById('b24t-project-name').textContent = state.projectName;
    document.getElementById('b24t-project-meta').textContent = `ID: ${projectId}`;

    // Load tags
    try {
      const tags = await getTags();
      state.tags = {};
      tags.forEach(t => {
        if (!t.isProtected) state.tags[t.title] = t.id;
      });
      state.untaggedId = tags.find(t => t.isProtected && t.title === 'Untagged')?.id || 1;

      // Save project config
      const projects = lsGet(LS.PROJECTS, {});
      projects[projectId] = {
        name: state.projectName,
        tagIds: state.tags,
        untaggedId: state.untaggedId,
        updatedAt: new Date().toISOString(),
      };
      lsSet(LS.PROJECTS, projects);
      // Zapisz nazwę do trwałego resolvera — _pnSet ignoruje fallbacki
      _pnSet(projectId, state.projectName);

      addLog(`✓ Projekt załadowany: ${state.projectName} (${Object.keys(state.tags).length} tagów)`, 'success');

      // Update mapping if file already loaded
      if (state.file) renderMappingRows();

      // Jeśli News panele są już otwarte (np. na polskim panelu) — odśwież CMS dot
      if (document.getElementById('b24t-news-tag-list')) _newsRefillTags();

    } catch (e) {
      addLog(`⚠ Nie udało się załadować tagów: ${e.message}`, 'warn');
    }

    // Check for checkpoint
    const jobs = lsGet(LS.JOBS, {});
    if (jobs[projectId]) {
      const job = jobs[projectId];
      addLog(`💾 Znaleziono zapisaną sesję z ${new Date(job.savedAt).toLocaleString('pl-PL')}`, 'warn');
      // Restore state
      state.partitions = job.partitions;
      state.currentPartitionIdx = job.currentPartitionIdx;
      state.mapping = job.mapping;
      state.stats = job.stats;
      state.mapMode = job.mapMode || 'untagged';
    }

    // Check for crash log
    const crashLog = lsGet(LS.CRASHLOG);
    if (crashLog && crashLog.recoverable) {
      showCrashBanner(crashLog);
    }
  }

  // ───────────────────────────────────────────
  // HELP / TUTORIAL
  // ───────────────────────────────────────────

  let helpModeActive = false;
  let helpZoneElements = [];
  let helpTipElement = null;
  let helpStickyTip = false;

  function toggleHelpMode() {
    if (helpModeActive) {
      exitHelpMode();
    } else {
      enterHelpMode();
    }
  }

  function enterHelpMode() {
    const panel = document.getElementById('b24t-panel');
    if (!panel) return;

    helpModeActive = true;

    // Wykryj aktywną zakładkę
    const activeTabBtn = panel.querySelector('.b24t-tab.b24t-tab-active');
    const activeTab = activeTabBtn ? (activeTabBtn.dataset.tab || 'main') : 'main';

    // Sprawdź czy Annotators Tab jest włączony i otwórz go
    const features = loadFeatures ? loadFeatures() : {};
    const annotatorsEnabled = features.annotator_tools;
    let annotatorWasHidden = false;
    if (annotatorsEnabled) {
      const annPanel = document.getElementById('b24t-annotator-panel');
      if (annPanel && annPanel.style.display === 'none') {
        annotatorWasHidden = true;
        openAnnotatorPanel();
      }
    }

    // Obniż z-index głównego panelu
    panel.dataset.prevZIndex = panel.style.zIndex || '';
    panel.dataset.helpAnnotatorOpened = annotatorWasHidden ? '1' : '0';
    panel.style.zIndex = '2147483500';

    // Obniż też z-index Annotators Panel jeśli otwarty
    const annPanel = document.getElementById('b24t-annotator-panel');
    if (annPanel && annPanel.style.display !== 'none') {
      annPanel.dataset.prevZIndex = annPanel.style.zIndex || '';
      annPanel.style.zIndex = '2147483501';
    }

    const panelRect = panel.getBoundingClientRect();

    // Overlay na główny panel
    const overlay = document.createElement('div');
    overlay.id = 'b24t-help-panel-overlay';
    overlay.style.top    = panelRect.top + 'px';
    overlay.style.left   = panelRect.left + 'px';
    overlay.style.width  = panelRect.width + 'px';
    overlay.style.height = panelRect.height + 'px';
    overlay.style.zIndex = '2147483510';
    document.body.appendChild(overlay);

    // Overlay na Annotators Panel jeśli widoczny
    if (annPanel && annPanel.style.display !== 'none') {
      const annRect = annPanel.getBoundingClientRect();
      const annOverlay = document.createElement('div');
      annOverlay.id = 'b24t-help-ann-overlay';
      annOverlay.style.cssText = [
        'position:fixed',
        'border-radius:14px',
        'z-index:2147483510',
        'pointer-events:none',
        'background:rgba(0,0,0,0.30)',
        'animation:b24t-fadein 0.25s ease',
        'top:'    + annRect.top    + 'px',
        'left:'   + annRect.left   + 'px',
        'width:'  + annRect.width  + 'px',
        'height:' + annRect.height + 'px',
      ].join(';');
      document.body.appendChild(annOverlay);
    }

    // Przycisk "Wyjdź"
    const closeBtn = document.createElement('button');
    closeBtn.id = 'b24t-help-close';
    closeBtn.innerHTML = '🔍 Tryb pomocy — kliknij element aby poznać jego funkcję &nbsp; <span style="opacity:0.55;font-size:9px;">[ kliknij tutaj aby wyjść ]</span>';
    closeBtn.style.top  = (panelRect.bottom - 44) + 'px';
    closeBtn.style.left = (panelRect.left + panelRect.width / 2) + 'px';
    closeBtn.style.transform = 'translateX(-50%)';
    closeBtn.style.zIndex = '2147483530';
    document.body.appendChild(closeBtn);
    closeBtn.addEventListener('click', exitHelpMode);

    // Strefy — kontekstowo dla aktywnej zakładki + Annotators jeśli otwarty
    const includeAnnotators = !!(annPanel && annPanel.style.display !== 'none');
    const zones = getHelpZones(activeTab, includeAnnotators);

    zones.forEach(function(z) {
      const targetEl = document.querySelector(z.selector);
      if (!targetEl) return;
      const r = targetEl.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;

      const zone = document.createElement('div');
      zone.className = 'b24t-help-zone';
      zone.style.top    = r.top + 'px';
      zone.style.left   = r.left + 'px';
      zone.style.width  = r.width + 'px';
      zone.style.height = r.height + 'px';
      zone.style.zIndex = '2147483520';

      zone.addEventListener('mouseenter', function(e) { showHelpTip(e, z); });
      zone.addEventListener('mouseleave', function() { if (!helpStickyTip) hideHelpTip(); });
      zone.addEventListener('click', function(e) {
        e.stopPropagation();
        helpStickyTip = true;
        showHelpTip(e, z, true);
      });

      document.body.appendChild(zone);
      helpZoneElements.push(zone);
    });
  }

  function exitHelpMode() {
    helpModeActive = false;
    helpStickyTip = false;
    hideHelpTip();

    // Przywróć z-index głównego panelu
    const panel = document.getElementById('b24t-panel');
    if (panel) panel.style.zIndex = panel.dataset.prevZIndex || '2147483647';

    // Przywróć z-index Annotators Panel
    const annPanel = document.getElementById('b24t-annotator-panel');
    if (annPanel && annPanel.dataset.prevZIndex !== undefined) {
      annPanel.style.zIndex = annPanel.dataset.prevZIndex || '2147483641';
      delete annPanel.dataset.prevZIndex;
    }

    // Jeśli Annotators Tab był auto-otwarty przez help mode — zamknij go
    if (panel && panel.dataset.helpAnnotatorOpened === '1') {
      if (annPanel) annPanel.style.display = 'none';
      const annTab = document.getElementById('b24t-annotator-tab');
      if (annTab) annTab.style.display = 'flex';
      delete panel.dataset.helpAnnotatorOpened;
    }

    var overlay    = document.getElementById('b24t-help-panel-overlay');
    var annOverlay = document.getElementById('b24t-help-ann-overlay');
    var closeBtn   = document.getElementById('b24t-help-close');
    if (overlay)    overlay.remove();
    if (annOverlay) annOverlay.remove();
    if (closeBtn)   closeBtn.remove();

    helpZoneElements.forEach(function(z) { z.remove(); });
    helpZoneElements = [];
  }

  function showHelpTip(e, zone, sticky) {
    sticky = sticky || false;
    hideHelpTip();

    var tip = document.createElement('div');
    tip.className = 'b24t-help-tip';
    tip.id = 'b24t-help-tip-el';
    tip.innerHTML = '<strong>' + zone.title + '</strong>' + zone.desc;
    if (sticky) {
      tip.style.pointerEvents = 'all';
      var closeX = document.createElement('button');
      closeX.style.cssText = 'position:absolute;top:5px;right:8px;background:none;border:none;color:var(--b24t-text-faint);cursor:pointer;font-size:14px;line-height:1;padding:0;';
      closeX.textContent = '×';
      closeX.addEventListener('click', function() { helpStickyTip = false; hideHelpTip(); });
      tip.appendChild(closeX);
    }
    document.body.appendChild(tip);
    helpTipElement = tip;

    // Pozycjonuj inteligentnie
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var tipW = 280;
    var tipH = tip.offsetHeight || 110;
    var cx = e.clientX, cy = e.clientY;

    var left = cx + 16;
    var top  = cy + 16;
    if (left + tipW > vw - 12) left = cx - tipW - 16;
    if (top + tipH > vh - 12)  top  = cy - tipH - 16;
    tip.style.left = Math.max(10, left) + 'px';
    tip.style.top  = Math.max(10, top)  + 'px';
  }

  function hideHelpTip() {
    helpStickyTip = false;
    if (helpTipElement) { helpTipElement.remove(); helpTipElement = null; }
    var old = document.getElementById('b24t-help-tip-el');
    if (old) old.remove();
  }

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING v2 — Dynamiczny tour z dymkami
// ─────────────────────────────────────────────────────────────────────────────

function injectOnboardingStyles() {
  const s = document.createElement('style');
  s.id = 'b24t-onboarding-styles';
  s.textContent = `
    /* ── ONBOARDING OVERLAY ── */
    #b24t-ob-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0);
      /* MUSI być wyższy niż panel (2147483647) żeby nakrywać */
      z-index: 2147483640;
      pointer-events: none;
      transition: background 0.4s ease;
    }
    #b24t-ob-overlay.ob-active {
      background: rgba(0,0,0,0.65);
      pointer-events: all;
    }
    /* Spotlight — jeszcze wyżej, wycina "dziurę" przez box-shadow */
    #b24t-ob-spotlight {
      position: fixed;
      border-radius: 10px;
      z-index: 2147483644;
      pointer-events: none;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.65);
      transition: top 0.32s cubic-bezier(0.4,0,0.2,1),
                  left 0.32s cubic-bezier(0.4,0,0.2,1),
                  width 0.32s cubic-bezier(0.4,0,0.2,1),
                  height 0.32s cubic-bezier(0.4,0,0.2,1);
      outline: 2px solid rgba(108,108,255,0.8);
      outline-offset: 2px;
    }
    #b24t-ob-spotlight.ob-hidden {
      box-shadow: none; outline: none;
      width: 0 !important; height: 0 !important;
      opacity: 0;
    }

    /* ── BUBBLE — najwyższy z-index ── */
    #b24t-ob-bubble {
      position: fixed;
      z-index: 2147483647;
      max-width: 320px;
      min-width: 240px;
      font-family: 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: var(--b24t-bg);
      border: 1px solid rgba(108,108,255,0.4);
      border-radius: 16px;
      padding: 18px 20px 14px;
      box-shadow: 0 16px 56px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.06);
      pointer-events: all;
      transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
    }
    #b24t-ob-bubble.ob-entering {
      opacity: 0; transform: translateY(10px) scale(0.97);
    }
    #b24t-ob-bubble.ob-visible {
      opacity: 1; transform: translateY(0) scale(1);
    }
    #b24t-ob-bubble.ob-exiting {
      opacity: 0; transform: translateY(-6px) scale(0.97);
    }

    /* Tail — strzałka wskazująca na podświetlony element */
    #b24t-ob-bubble::before {
      content: '';
      position: absolute;
      width: 11px; height: 11px;
      background: var(--b24t-bg);
      border: 1px solid rgba(108,108,255,0.4);
      transform: rotate(45deg);
      z-index: -1;
    }
    #b24t-ob-bubble[data-tail="bottom"]::before {
      bottom: -6px; left: 50%; margin-left: -5px;
      border-top: none; border-left: none;
    }
    #b24t-ob-bubble[data-tail="top"]::before {
      top: -6px; left: 50%; margin-left: -5px;
      border-bottom: none; border-right: none;
    }
    #b24t-ob-bubble[data-tail="right"]::before {
      right: -6px; top: 40%; margin-top: -5px;
      border-bottom: none; border-left: none;
    }
    #b24t-ob-bubble[data-tail="left"]::before {
      left: -6px; top: 40%; margin-top: -5px;
      border-top: none; border-right: none;
    }
    #b24t-ob-bubble[data-tail="none"]::before { display: none; }

    /* Bubble content */
    .ob-bubble-step {
      font-size: 10px; font-weight: 600;
      color: rgba(108,108,255,0.8);
      letter-spacing: 0.12em; text-transform: uppercase;
      margin-bottom: 5px;
    }
    .ob-bubble-title {
      font-size: 14px; font-weight: 700;
      color: var(--b24t-text);
      margin-bottom: 8px; line-height: 1.3;
    }
    .ob-bubble-body {
      font-size: 12px; color: var(--b24t-text-muted);
      line-height: 1.7; margin-bottom: 14px;
    }
    .ob-bubble-body strong { color: var(--b24t-text); }
    .ob-bubble-body .ob-tag {
      display: inline-block;
      background: rgba(108,108,255,0.14);
      border: 1px solid rgba(108,108,255,0.28);
      border-radius: 4px; padding: 1px 6px;
      font-size: 11px; color: #9090ff; margin: 1px 2px;
    }

    /* Progress dots */
    .ob-dots { display: flex; gap: 5px; margin-bottom: 12px; }
    .ob-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: rgba(255,255,255,0.1);
      transition: background 0.2s, transform 0.2s;
    }
    .ob-dot.ob-dot-done { background: rgba(74,222,128,0.45); }
    .ob-dot.ob-dot-active { background: #6c6cff; transform: scale(1.5); }

    /* Nav */
    .ob-nav {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .ob-btn-next {
      background: linear-gradient(135deg, #6c6cff, #9b59ff);
      color: #fff; border: none; border-radius: 8px;
      padding: 8px 18px; font-size: 12px; font-weight: 700;
      font-family: inherit; cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
      box-shadow: 0 2px 12px rgba(108,108,255,0.4);
    }
    .ob-btn-next:hover { opacity: 0.88; }
    .ob-btn-next:active { transform: scale(0.95); }
    .ob-btn-back {
      background: rgba(255,255,255,0.05); color: var(--b24t-text-faint);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
      padding: 8px 14px; font-size: 12px;
      font-family: inherit; cursor: pointer;
      transition: background 0.15s;
    }
    .ob-btn-back:hover { background: rgba(255,255,255,0.1); }
    .ob-step-counter { font-size: 10px; color: var(--b24t-text-faint); letter-spacing: 0.05em; }

    @keyframes ob-pulse {
      0%, 100% { outline-color: rgba(108,108,255,0.7); }
      50%       { outline-color: rgba(160,140,255,1.0); }
    }
    #b24t-ob-spotlight.ob-pulse { animation: ob-pulse 1.6s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

// ── ONBOARDING STEPS ──
function getOnboardingSteps() {
  return [
    // 0 — Powitanie (centrum ekranu, bez spotlightu)
    {
      target: null,
      title: '👋 Cześć! Witaj w B24 Tagger!',
      body: `Zanim zaczniesz — pozwól, że w kilku krokach oprowadzę Cię po wtyczce. <strong>Zajmie to dosłownie chwilę.</strong><br><br>Ten onboarding pojawi się tylko raz i <strong>nie można go pominąć</strong> 😄 — chcemy mieć pewność, że wiesz jak korzystać z narzędzia!`,
      tail: 'none',
      emoji: true,
    },
    // 1 — O projekcie (centrum ekranu)
    {
      target: null,
      title: '🛠️ Czym jest B24 Tagger?',
      body: `To <strong>autorski projekt członka Insights24</strong>, stworzony od zera, żeby przyspieszyć i ułatwić pracę annotatorską w Brand24.<br><br>Wtyczka cały czas się <strong>rozwija</strong> — nowe funkcje, poprawki i ulepszenia pojawiają się regularnie. Jesteś jednym z pierwszych użytkowników! 🚀`,
      tail: 'none',
    },
    // 2 — Header / topbar
    {
      target: '#b24t-topbar',
      title: '🏠 Header wtyczki',
      body: `Na samej górze znajdziesz:<br>
        <span class="ob-tag">B24 Tagger BETA</span> — nazwa i wersja<br>
        <span class="ob-tag">Status badge</span> — aktualny stan (Idle / Running / Done)<br>
        <span class="ob-tag">☀️🌙 Toggle</span> — przełącz jasny/ciemny motyw<br>
        <span class="ob-tag">⚙</span> — funkcje opcjonalne (więcej za chwilę)<br>
        <span class="ob-tag">?</span> — tryb pomocy<br>
        <span class="ob-tag">▼</span> — zwiń/rozwiń panel<br><br>
        Panel możesz <strong>przeciągać</strong> łapiąc za nagłówek! 🖱️`,
      tail: 'bottom',
    },
    // 3 — Meta bar (token)
    {
      target: '#b24t-meta-bar',
      title: '🔑 Pasek statusu',
      body: `Tu widzisz dwie ważne informacje:<br><br>
        <strong>● Token API</strong> — zielony = wtyczka jest połączona z Brand24 i gotowa do pracy. Żółty = czeka na inicjalizację (otwórz widok Mentions).<br><br>
        <strong>Timer sesji</strong> — mierzy czas trwania aktualnej operacji tagowania.`,
      tail: 'bottom',
    },
    // 4 — Subbar (changelog + update)
    {
      target: '#b24t-subbar',
      title: '📋 Pasek narzędzi',
      body: `Dwa przyciski QoL:<br><br>
        <strong>📋 Changelog & Feedback</strong> — lista zmian w każdej wersji, planowane funkcje i możliwość wysłania feedbacku bezpośrednio na Slack.<br><br>
        <strong>↑ Sprawdź aktualizacje</strong> — ręczne sprawdzenie nowej wersji. Btw — wtyczka <strong>aktualizuje się automatycznie</strong> przez Tampermonkey! 🎉`,
      tail: 'bottom',
    },
    // 5 — Zakładki
    {
      target: '#b24t-tabs',
      title: '📑 Zakładki — tryby pracy',
      body: `Cztery tryby pracy:<br><br>
        <span class="ob-tag">📄 Plik</span> — główny tryb: wgraj plik CSV/JSON z ocenami i otaguj setki wzmianek automatycznie<br>
        <span class="ob-tag">⚡ Quick Tag</span> — błyskawiczne tagowanie bez pliku, na podstawie aktualnego widoku Brand24<br>
        <span class="ob-tag">🗑 Quick Delete</span> — masowe usuwanie wzmianek po tagu lub aktualnym widoku<br>
        <span class="ob-tag">📋 Historia</span> — ostatnie 20 sesji ze statystykami`,
      tail: 'bottom',
    },
    // 6 — Zakładka Plik — sekcja projekt
    {
      target: '#b24t-main-tab .b24t-section:first-child',
      title: '🗂️ Sekcja: Projekt',
      body: `Tutaj wyświetla się <strong>aktualnie wykryty projekt Brand24</strong> — nazwa i ID.<br><br>
        Wtyczka wykrywa projekt automatycznie na podstawie URL. Przejdź do widoku <strong>Mentions</strong> konkretnego projektu, żeby projekt się tu pojawił.`,
      tail: 'bottom',
    },
    // 7 — Plik źródłowy
    {
      target: '#b24t-file-zone',
      title: '📂 Wgrywanie pliku',
      body: `Kliknij lub przeciągnij plik z ocenami wzmianek.<br><br>
        Obsługiwane formaty: <strong>JSON</strong> (zalecany!), CSV, XLSX<br><br>
        <strong>⚠️ Ważne:</strong> używaj formatu JSON — XLSX może obcinać długie ID z TikToka i Twittera (19 cyfr)!<br><br>
        Wymagane kolumny: <span class="ob-tag">url</span> <span class="ob-tag">assessment</span><br>
        Opcjonalne: <span class="ob-tag">created_date</span> <span class="ob-tag">text</span>`,
      tail: 'top',
    },
    // 8 — Quick Tag
    {
      target: '[data-tab="quicktag"]',
      title: '⚡ Quick Tag',
      body: `Zakładka do tagowania <strong>bez pliku</strong> — działa na aktualnym widoku Brand24.<br><br>
        Ustaw filtry w Brand24 (zakres dat, tagi, frazy) → przejdź do Quick Tag → wybierz tag → kliknij <strong>Taguj widok</strong>.<br><br>
        Wtyczka pobiera wzmianki z aktualnie otwartego widoku i taguje je wszystkie naraz. Przydatne do szybkich operacji! ⚡`,
      tail: 'bottom',
    },
    // 9 — Quick Delete
    {
      target: '[data-tab="delete"]',
      title: '🗑️ Quick Delete',
      body: `Masowe usuwanie wzmianek — dwa tryby:<br><br>
        <strong>Po tagu</strong> — usuwa wszystkie wzmianki oznaczone wybranym tagiem w zakresie dat<br><br>
        <strong>Aktualny widok</strong> — usuwa wzmianki dokładnie z widoku który masz otwarty<br><br>
        Każda operacja wymaga <strong>potwierdzenia</strong> — nie ma przypadkowych kasowań! 🛡️`,
      tail: 'bottom',
    },
    // 10 — Historia
    {
      target: '[data-tab="history"]',
      title: '📋 Historia sesji',
      body: `Pełna historia ostatnich <strong>20 sesji</strong> tagowania.<br><br>
        Dla każdej sesji widzisz: projekt, datę, czas trwania, liczbę otagowanych/pominiętych wzmianek i inne statystyki.<br><br>
        Przydatne do audytu i sprawdzenia co dokładnie było tagowane poprzednim razem. 🕐`,
      tail: 'bottom',
    },
    // 11 — Akcje (Start / Pause / Stop)
    {
      target: '#b24t-actions',
      title: '▶️ Przyciski akcji',
      body: `Na dole panelu (w zakładce Plik) znajdziesz główne przyciski operacji:<br><br>
        <strong>Start</strong> — uruchamia tagowanie lub wznawia po pauzie<br>
        <strong>Pause</strong> — bezpieczne zatrzymanie po aktualnej stronie<br>
        <strong>Test Run</strong> — symulacja bez zapisu — sprawdź dopasowanie przed właściwym tagowaniem!<br><br>
        Zawsze zacznij od <strong>Test Run</strong> przy nowym pliku! ✅`,
      tail: 'top',
    },
    // 12 — Funkcje opcjonalne (⚙)
    {
      target: '#b24t-btn-features',
      title: '⚙️ Funkcje opcjonalne',
      body: `Przycisk ⚙ otwiera panel z funkcjami, które możesz włączyć w razie potrzeby.<br><br>
        Każda z nich ma <strong>krótki przewodnik</strong>, który pojawi się automatycznie przy pierwszym włączeniu — nie musisz nic konfigurować z góry! 🎯<br><br>
        Odkrywaj funkcje w swoim tempie.`,
      tail: 'bottom',
    },
    // 13 — Tryb pomocy (?)
    {
      target: '#b24t-btn-help',
      title: '❓ Tryb pomocy',
      body: `Ten przycisk uruchamia <strong>interaktywny tryb pomocy</strong>.<br><br>
        Panel zostanie <strong>przyciemniony</strong>, a Ty możesz klikać na dowolne elementy interfejsu, żeby dowiedzieć się co robią — każdy ma swój opis.<br><br>
        Wróć tu kiedy zapomnisz do czego służy jakiś przycisk! 🔍`,
      tail: 'bottom',
    },
    // 14 — Changelog: Co nowego & Planowane
    {
      target: '#b24t-btn-changelog',
      title: '📰 Co nowego & Planowane',
      body: `Przycisk <strong>📋 Changelog & Feedback</strong> otwiera okno z trzema zakładkami:<br><br>
        <span class="ob-tag">📰 Co nowego</span> — pełna lista zmian per wersja<br>
        <span class="ob-tag">🗓 Planowane</span> — co będzie w następnych wersjach<br>
        <span class="ob-tag">💬 Feedback</span> — błędy i pomysły bezpośrednio do autora<br><br>
        Wtyczka <strong>aktualizuje się automatycznie</strong> przez Tampermonkey — sprawdzaj tu co zostało zmienione!`,
      tail: 'bottom',
    },
    // 15 — Bug Report — co jest wysyłane
    {
      target: '#b24t-btn-changelog',
      title: '🐛 Bug Report — co jest wysyłane?',
      body: `W zakładce <strong>Feedback</strong> możesz zgłosić problem lub zaproponować funkcję.<br><br>
        Do Bug Reportu <strong>automatycznie dołączane</strong> są dane techniczne:<br>
        <span class="ob-tag">wersja</span> <span class="ob-tag">ID projektu</span> <span class="ob-tag">status sesji</span> <span class="ob-tag">ostatnie 30 wpisów logu</span> <span class="ob-tag">crash log</span><br><br>
        <strong>Nie są wysyłane</strong> treści wzmianek ani zawartość wgranych plików. Raport trafia bezpośrednio do autora na Slack. 🔒`,
      tail: 'bottom',
    },
    // 16 — Resize panelu
    {
      target: '#b24t-panel',
      title: '↔️ Zmiana rozmiaru panelu',
      body: `Panel możesz <strong>dowolnie rozciągać</strong> — chwyć za <strong>dowolną krawędź lub róg</strong> i przeciągnij.<br><br>
        Min: 360×380px &nbsp;|&nbsp; Max: 720px szerokości<br><br>
        Wybrany rozmiar jest <strong>zapamiętywany</strong> między sesjami — panel zawsze otworzy się z Twoimi ustawieniami. 📐`,
      tail: 'left',
    },
    // 17 — Drag
    {
      target: '#b24t-topbar',
      title: '🖱️ Przeciąganie panelu',
      body: `Panel możesz <strong>swobodnie przesuwać</strong> po ekranie — chwyć za <strong>pasek tytułowy</strong> (ten fioletowy na górze) i przeciągnij gdzie chcesz.<br><br>
        Pozycja jest zapamiętywana między sesjami — panel wróci dokładnie tam gdzie go zostawisz. 📌`,
      tail: 'bottom',
    },
    // 18 — Finał
    {
      target: null,
      title: '🎉 Gotowy do pracy!',
      body: `To tyle! Teraz wiesz jak działa B24 Tagger.<br><br>
        <strong>Szybki start:</strong><br>
        1️⃣ Przejdź do widoku Mentions w Brand24<br>
        2️⃣ Wgraj plik JSON z ocenami<br>
        3️⃣ Zrób <strong>Test Run</strong> żeby sprawdzić dopasowanie<br>
        4️⃣ Kliknij <strong>Start</strong> i obserwuj progress!<br><br>
        Pytania? Kliknij <span class="ob-tag">📋 Changelog & Feedback</span> → zakładka Feedback 💬`,
      tail: 'none',
    },
  ];
}

// ── GŁÓWNA FUNKCJA ONBOARDINGU ──
function showOnboarding(onComplete) {
  if (document.getElementById('b24t-ob-overlay')) return; // guard

  injectOnboardingStyles();

  const steps = getOnboardingSteps();
  let currentStep = 0;
  let animating = false;

  // ── Zablokuj pozycję panelu na czas onboardingu ──
  // Snap do prawego-dolnego rogu (safe zone dla wszystkich rozmiarów ekranu)
  const panel = document.getElementById('b24t-panel');
  let panelPosBackup = null;
  if (panel) {
    panelPosBackup = {
      left: panel.style.left, top: panel.style.top,
      right: panel.style.right, bottom: panel.style.bottom,
      width: panel.style.width,
      zIndex: panel.style.zIndex,
    };
    // Ustaw stałą pozycję: prawy-dolny róg z marginesem
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = Math.min(440, vw - 24);
    const ph = panel.offsetHeight || 480;
    // Centrum ekranu — bubble ma zawsze miejsce po bokach i górze
    panel.style.width  = pw + 'px';
    panel.style.left   = Math.round((vw - pw) / 2) + 'px';
    panel.style.top    = Math.max(12, Math.round((vh - ph) / 2)) + 'px';
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    // Obniż z-index panelu — overlay/spotlight/bubble muszą być nad nim
    panel.style.zIndex = '100';
    panel.setAttribute('data-ob-locked', '1');
  }

  // Obniż też Annotators Panel jeśli otwarty
  const annPanel = document.getElementById('b24t-annotator-panel');
  if (annPanel && annPanel.style.display !== 'none') {
    panelPosBackup.annZIndex = annPanel.style.zIndex;
    annPanel.style.zIndex = '99';
  }

  // Tworzę overlay + spotlight + bubble — wszystkie na body, nad panelem
  const overlay = document.createElement('div');
  overlay.id = 'b24t-ob-overlay';
  document.body.appendChild(overlay);

  const spotlight = document.createElement('div');
  spotlight.id = 'b24t-ob-spotlight';
  spotlight.classList.add('ob-hidden');
  document.body.appendChild(spotlight);

  const bubble = document.createElement('div');
  bubble.id = 'b24t-ob-bubble';
  bubble.classList.add('ob-entering');
  document.body.appendChild(bubble);

  requestAnimationFrame(() => { overlay.classList.add('ob-active'); });

  function getTargetRect(selector) {
    if (!selector) return null;
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null; // element ukryty
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function positionSpotlight(rect) {
    if (!rect) {
      spotlight.classList.add('ob-hidden');
      return;
    }
    const pad = 6;
    spotlight.classList.remove('ob-hidden');
    spotlight.classList.add('ob-pulse');
    spotlight.style.top    = (rect.top  - pad) + 'px';
    spotlight.style.left   = (rect.left - pad) + 'px';
    spotlight.style.width  = (rect.width  + pad * 2) + 'px';
    spotlight.style.height = (rect.height + pad * 2) + 'px';
  }

  function positionBubble(rect, tailHint) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = Math.min(320, vw - 32); // responsive szerokość
    const bh = bubble.offsetHeight || 240;
    const margin = 12;
    const gap = 14; // odległość od elementu

    // Bez targetu — centrum ekranu
    if (!rect) {
      bubble.style.width = bw + 'px';
      bubble.style.left  = Math.max(margin, (vw - bw) / 2) + 'px';
      bubble.style.top   = Math.max(margin, (vh - bh) / 2) + 'px';
      bubble.setAttribute('data-tail', 'none');
      return;
    }

    bubble.style.width = bw + 'px';

    // Sprawdź dostępne miejsce po każdej stronie
    const spaceAbove = rect.top - margin;
    const spaceBelow = vh - (rect.top + rect.height) - margin;
    const spaceLeft  = rect.left - margin;
    const spaceRight = vw - (rect.left + rect.width) - margin;

    let tail, top, left;

    // Priorytet pozycji: tailHint → dostępne miejsce
    // tailHint="bottom" = bubble NAD elementem (ogon wskazuje w dół)
    // tailHint="top"    = bubble POD elementem (ogon wskazuje w górę)

    if (tailHint === 'bottom' && spaceAbove >= bh + gap) {
      // Nad elementem
      top  = rect.top - bh - gap;
      tail = 'bottom';
    } else if (tailHint === 'top' && spaceBelow >= bh + gap) {
      // Pod elementem
      top  = rect.top + rect.height + gap;
      tail = 'top';
    } else if (spaceAbove >= bh + gap) {
      // Fallback: nad
      top  = rect.top - bh - gap;
      tail = 'bottom';
    } else if (spaceBelow >= bh + gap) {
      // Fallback: pod
      top  = rect.top + rect.height + gap;
      tail = 'top';
    } else if (spaceLeft >= bw + gap) {
      // Po lewej
      top  = Math.max(margin, rect.top + rect.height / 2 - bh / 2);
      top  = Math.min(top, vh - bh - margin);
      left = rect.left - bw - gap;
      bubble.style.left = left + 'px';
      bubble.style.top  = top  + 'px';
      bubble.setAttribute('data-tail', 'right');
      return;
    } else if (spaceRight >= bw + gap) {
      // Po prawej
      top  = Math.max(margin, rect.top + rect.height / 2 - bh / 2);
      top  = Math.min(top, vh - bh - margin);
      left = rect.left + rect.width + gap;
      bubble.style.left = left + 'px';
      bubble.style.top  = top  + 'px';
      bubble.setAttribute('data-tail', 'left');
      return;
    } else {
      // Ostateczność: wyśrodkuj ekran i ukryj ogon
      bubble.style.left = Math.max(margin, (vw - bw) / 2) + 'px';
      bubble.style.top  = Math.max(margin, (vh - bh) / 2) + 'px';
      bubble.setAttribute('data-tail', 'none');
      return;
    }

    // Poziomo: wyśrodkuj względem elementu, nie wychodź poza ekran
    left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(margin, Math.min(left, vw - bw - margin));

    bubble.style.left = left + 'px';
    bubble.style.top  = Math.max(margin, Math.min(top, vh - bh - margin)) + 'px';
    bubble.setAttribute('data-tail', tail);
  }

  function renderStep(idx) {
    if (animating) return;
    animating = true;

    const step = steps[idx];
    const dots = steps.map((_, i) => {
      let cls = i < idx ? 'ob-dot-done' : i === idx ? 'ob-dot-active' : '';
      return `<div class="ob-dot ${cls}"></div>`;
    }).join('');

    bubble.classList.remove('ob-visible');
    bubble.classList.add('ob-exiting');

    setTimeout(() => {
      const rect = getTargetRect(step.target);
      positionSpotlight(rect);

      bubble.innerHTML = `
        <div class="ob-dots">${dots}</div>
        <div class="ob-bubble-step">Krok ${idx + 1} z ${steps.length}</div>
        <div class="ob-bubble-title">${step.title}</div>
        <div class="ob-bubble-body">${step.body}</div>
        <div class="ob-nav">
          ${idx > 0
            ? `<button class="ob-btn-back" id="ob-btn-back">← Wstecz</button>`
            : `<span class="ob-step-counter">${idx + 1} / ${steps.length}</span>`}
          <button class="ob-btn-next" id="ob-btn-next">
            ${idx < steps.length - 1 ? 'Dalej →' : '🎉 Zaczynamy!'}
          </button>
        </div>
      `;

      bubble.classList.remove('ob-exiting');
      bubble.classList.add('ob-entering');

      // Dwa RAF żeby browser zdążył obliczyć offsetHeight bubble
      requestAnimationFrame(() => requestAnimationFrame(() => {
        positionBubble(rect, step.tail);
        bubble.classList.remove('ob-entering');
        bubble.classList.add('ob-visible');
        animating = false;
      }));

      document.getElementById('ob-btn-next').addEventListener('click', () => {
        if (idx < steps.length - 1) { currentStep++; renderStep(currentStep); }
        else finishOnboarding();
      });
      const backBtn = document.getElementById('ob-btn-back');
      if (backBtn) backBtn.addEventListener('click', () => { currentStep--; renderStep(currentStep); });

    }, 200);
  }

  function finishOnboarding() {
    overlay.style.background = 'rgba(0,0,0,0)';
    bubble.style.opacity = '0';
    bubble.style.transform = 'scale(0.92) translateY(-8px)';
    spotlight.style.opacity = '0';

    setTimeout(() => {
      overlay.remove();
      spotlight.remove();
      bubble.remove();
      // Przywróć pozycję i rozmiar panelu
      if (panel && panelPosBackup) {
        panel.style.left   = panelPosBackup.left;
        panel.style.top    = panelPosBackup.top;
        panel.style.right  = panelPosBackup.right;
        panel.style.bottom = panelPosBackup.bottom;
        panel.style.width  = panelPosBackup.width;
        panel.style.zIndex = panelPosBackup.zIndex;
        panel.removeAttribute('data-ob-locked');
      }
      const annPanel = document.getElementById('b24t-annotator-panel');
      if (annPanel && panelPosBackup.annZIndex !== undefined) {
        annPanel.style.zIndex = panelPosBackup.annZIndex;
      }
      lsSet(LS.SETUP_DONE, true);
      if (onComplete) onComplete();
    }, 350);
  }

  // Resize handler
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!panel) return;
      // Re-centruj panel po resize okna
      const vw2 = window.innerWidth;
      const vh2 = window.innerHeight;
      const pw2 = Math.min(440, vw2 - 24);
      const ph2 = panel.offsetHeight || 480;
      panel.style.width = pw2 + 'px';
      panel.style.left  = Math.round((vw2 - pw2) / 2) + 'px';
      panel.style.top   = Math.max(12, Math.round((vh2 - ph2) / 2)) + 'px';
      // Reposition spotlight + bubble
      const step = steps[currentStep];
      const rect = getTargetRect(step.target);
      positionSpotlight(rect);
      positionBubble(rect, step.tail);
    }, 120);
  });

  renderStep(0);
}


// ─────────────────────────────────────────────────────────────────────────────
// HELP MODE — Tryb pomocy (przycisk ?)
// ─────────────────────────────────────────────────────────────────────────────

// Definicje stref klikania w trybie pomocy
  // Zwraca strefy help dla danej zakładki i opcjonalnie dla Annotators Tab
  function getHelpZones(activeTab, includeAnnotators) {
    // Wspólne — zawsze widoczne niezależnie od zakładki
    const common = [
      {
        selector: '#b24t-topbar',
        title: 'Header — pasek tytułowy',
        desc: 'Możesz przeciągać panel trzymając za ten obszar. Zawiera: status sesji, zmianę motywu, przyciski funkcji dodatkowych, pomocy i zwijania.',
      },
      {
        selector: '#b24t-theme-toggle',
        title: '☀️🌙 Przełącznik motywu',
        desc: 'Przełącza między jasnym (Brand24) a ciemnym (fioletowy gradient) motywem. Ustawienie jest zapamiętywane.',
      },
      {
        selector: '#b24t-status-badge',
        title: 'Status badge',
        desc: 'Aktualny stan wtyczki: Idle (gotowa), Running (taguje), Paused (wstrzymana), Done (zakończone), Error (błąd).',
      },
      {
        selector: '#b24t-btn-features',
        title: '⚙ Funkcje opcjonalne',
        desc: 'Otwiera panel z dodatkowymi funkcjami do włączenia — np. panel Annotatora. Każda ma krótki przewodnik przy pierwszym uruchomieniu.',
      },
      {
        selector: '#b24t-btn-help',
        title: '? Tryb pomocy',
        desc: 'Ten tryb! Klikaj na elementy panelu żeby poznać ich funkcję.',
      },
      {
        selector: '#b24t-btn-collapse',
        title: '▼ Zwiń / Rozwiń',
        desc: 'Zwija panel do samego headera — przydatne gdy chcesz mieć panel pod ręką ale nie zajmował miejsca.',
      },
      {
        selector: '#b24t-meta-bar',
        title: 'Pasek statusu API',
        desc: 'Zielona kropka = token API aktywny, wtyczka połączona z Brand24. Żółta = oczekuje. Timer pokazuje czas bieżącej sesji tagowania.',
      },
      {
        selector: '#b24t-subbar',
        title: 'Pasek narzędzi',
        desc: '"Changelog & Feedback" otwiera dziennik zmian i zakładkę opinii. "Sprawdź aktualizacje" ręcznie sprawdza czy jest nowa wersja.',
      },
      {
        selector: '#b24t-tabs',
        title: 'Zakładki trybów pracy',
        desc: 'Cztery tryby: Plik (główny, praca z CSV/JSON), Quick Tag (bez pliku), Quick Delete (masowe usuwanie), Historia (ostatnie sesje).',
      },
    ];

    // Strefy per zakładka
    const byTab = {
      main: [
        {
          selector: '#b24t-file-zone',
          title: 'Strefa wgrywania pliku',
          desc: 'Kliknij lub przeciągnij plik CSV/JSON/XLSX z ocenami wzmianek. Zalecany format: JSON (XLSX może obcinać 19-cyfrowe ID TikTok/Twitter).',
        },
        {
          selector: '#b24t-project-name',
          title: 'Wykryty projekt',
          desc: 'Automatycznie wykryty projekt Brand24. Przejdź do widoku Mentions konkretnego projektu żeby tu pojawił się jego nazwa i ID.',
        },
        {
          selector: '#b24t-actions',
          title: 'Przyciski akcji',
          desc: 'Start — uruchamia/wznawia tagowanie. Pause — bezpieczna pauza. Test Run — symulacja bez zapisu (zawsze sprawdź najpierw!). Match Preview — sprawdza % dopasowania URL.',
        },
        {
          selector: '.b24t-stats-row-list',
          title: 'Statystyki sesji',
          desc: 'Otagowano — liczba wzmianek którym nadano tag. Pominięto — wzmianki bez dopasowania URL lub bez oceny. Brak matcha — URL z pliku nieznaleziony w Brand24.',
        },
        {
          selector: '#b24t-progress-bar',
          title: 'Pasek postępu',
          desc: 'Wizualizacja postępu bieżącej sesji tagowania. Wypełnia się proporcjonalnie do otagowanych vs całkowitych wzmianek.',
        },
        {
          selector: '#b24t-log',
          title: 'Log zdarzeń',
          desc: 'Chronologiczny dziennik operacji: sukcesy (zielone), ostrzeżenia (żółte), błędy (czerwone). Kliknij "Wyczyść" żeby wyczyścić.',
        },
        {
          selector: '.b24t-section-label',
          title: 'Nagłówek sekcji',
          desc: 'Kolorowe nagłówki oznaczają poszczególne sekcje panelu: Projekt, Plik źródłowy, Mapowanie, Opcje, Progress, Statystyki i Log.',
        },
      ],
      quicktag: [
        {
          selector: '#b24t-qt-view-info',
          title: 'Info o bieżącym widoku',
          desc: 'Pokazuje aktywny projekt, zakres dat i liczbę wzmianek widocznych w Brand24. Odświeża się automatycznie.',
        },
        {
          selector: '#b24t-qt-tag',
          title: 'Wybór tagu',
          desc: 'Tag który zostanie nadany wzmiankom. Lista pochodzi z bieżącego projektu Brand24.',
        },
        {
          selector: 'input[name="b24t-qt-scope"]',
          title: 'Zakres tagowania',
          desc: 'Bieżąca strona — tylko wzmianki z aktualnej strony. Wszystkie strony — przetwarza cały widok po kolei (może potrwać dłużej).',
        },
        {
          selector: '#b24t-qt-run',
          title: '▶ Taguj teraz',
          desc: 'Uruchamia Quick Tag dla wybranego tagu i zakresu. Nie wymaga pliku CSV — taguje to co widać w Brand24.',
        },
        {
          selector: '#b24t-qt-untag',
          title: 'Usuń tag z widocznych',
          desc: 'Odwrotność Quick Tag — usuwa wybrany tag ze wszystkich widocznych wzmianek. Przydatne do korekty błędnych tagowań.',
        },
      ],
      delete: [
        {
          selector: '#b24t-del-tag',
          title: 'Tag do usunięcia',
          desc: 'Wybierz tag którego wzmianki mają zostać usunięte. Operacja trwała — nie można cofnąć.',
        },
        {
          selector: '#b24t-del-dateinfo',
          title: 'Zakres dat',
          desc: 'Pokazuje aktywny zakres dat z URL Brand24. Możesz przełączyć na własny zakres lub operację na wszystkich projektach.',
        },
        {
          selector: 'input[name="b24t-del-scope"]',
          title: 'Zakres operacji',
          desc: 'Aktualny widok — daty z URL Brand24. Własny zakres — ręczne daty. 🌐 Wszystkie projekty — usuwa tag ze wszystkich znanych projektów (wymaga panelu Annotatora).',
        },
        {
          selector: '#b24t-del-run',
          title: '🗑 Usuń wzmianki z tagiem',
          desc: 'Uruchamia masowe usuwanie. Przy pierwszym użyciu pojawi się ostrzeżenie. Tego nie można cofnąć.',
        },
        {
          selector: '#b24t-delview-info',
          title: 'Usuń wyświetlane wzmianki',
          desc: 'Usuwa wzmianki aktualnie widoczne w panelu Brand24 — niezależnie od tagu. Działa z aktywnymi filtrami i zakresem dat.',
        },
        {
          selector: '#b24t-delview-run',
          title: '🗑 Usuń wyświetlane wzmianki',
          desc: 'Usuwa wszystkie wzmianki widoczne w aktualnym widoku Brand24. Tego nie można cofnąć.',
        },
      ],
      history: [
        {
          selector: '#b24t-history-list',
          title: 'Historia sesji',
          desc: 'Lista ostatnich sesji tagowania z danego projektu: liczba otagowanych, pominiętych, czas trwania i nazwa pliku.',
        },
        {
          selector: '#b24t-history-clear',
          title: 'Wyczyść historię',
          desc: 'Usuwa całą historię sesji z pamięci przeglądarki (localStorage). Nie wpływa na dane w Brand24.',
        },
      ],
    };

    // Strefy Annotators Tab (dodawane jeśli panel jest otwarty)
    const annotators = includeAnnotators ? [
      {
        selector: '#b24t-ann-header',
        title: '🛠 Annotators Tab — header',
        desc: 'Nagłówek panelu annotatorów. Możesz go przeciągać trzymając za ten obszar.',
        panel: 'annotator',
      },
      {
        selector: '.b24t-ann-tab[data-ann-tab="project"]',
        title: '📊 Zakładka Projekt',
        desc: 'Statystyki bieżącego projektu: liczba wzmianek, otagowane, nieprzetworzone. Dane z aktualnego projektu Brand24.',
        panel: 'annotator',
      },
      {
        selector: '.b24t-ann-tab[data-ann-tab="tagstats"]',
        title: '🏷 Zakładka Tagi',
        desc: 'Przegląd wszystkich projektów — ile wzmianek ma tagi do weryfikacji (REQ) i do usunięcia (DEL). Ładuje się w tle.',
        panel: 'annotator',
      },
      {
        selector: '#b24t-ann-project-content',
        title: 'Dashboard projektu',
        desc: 'Statystyki aktualnego projektu: otagowane vs pozostałe. Odśwież żeby pobrać aktualne dane.',
        panel: 'annotator',
      },
      {
        selector: '#b24t-ann-tagstats-content',
        title: 'Tabela tagów wszystkich projektów',
        desc: 'REQ = wzmianki do weryfikacji, DEL = wzmianki do usunięcia. Pokazuje tylko projekty, w których coś zostało do zrobienia.',
        panel: 'annotator',
      },
    ] : [];

    const tabZones = byTab[activeTab] || byTab.main;
    return [...common, ...tabZones, ...annotators];
  }

  // ───────────────────────────────────────────
  // F1 - MATCH PREVIEW

  function renderMatchPreview(preview) {
    const el = document.getElementById('b24t-match-preview');
    if (!el) return;
    const color = preview.pct >= 80 ? '#4ade80' : preview.pct >= 50 ? '#facc15' : '#f87171';
    el.style.display = 'block';
    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<span style="font-size:11px;color:var(--b24t-text);font-weight:600;">Match Preview</span>' +
        '<span style="font-size:14px;font-weight:700;color:' + color + ';">' + preview.pct + '%</span>' +
      '</div>' +
      '<div style="display:flex;gap:10px;font-size:10px;margin-bottom:6px;">' +
        '<span style="color:#4ade80;">✓ ' + preview.matched + ' dopasowane</span>' +
        '<span style="color:#f87171;">✗ ' + preview.unmatched + ' brak</span>' +
        (preview.noAssessment ? '<span style="color:var(--b24t-text-faint);">~ ' + preview.noAssessment + ' bez oceny</span>' : '') +
      '</div>' +
      '<div style="height:4px;background:var(--b24t-bg-input);border-radius:99px;overflow:hidden;margin-bottom:6px;">' +
        '<div style="height:100%;width:' + preview.pct + '%;background:' + color + ';border-radius:99px;transition:width 0.4s;"></div>' +
      '</div>' +
      (preview.unmatched > 0
        ? '<button id="b24t-preview-btn" style="font-size:10px;color:var(--b24t-text-faint);background:none;border:none;cursor:pointer;padding:0;">Pokaż niedopasowane (' + Math.min(preview.unmatched, 50) + ') \u25be</button>' +
          '<div id="b24t-preview-list" style="display:none;max-height:80px;overflow-y:auto;margin-top:4px;font-size:9px;color:var(--b24t-text-faint);line-height:1.6;">' +
          preview.unmatchedList.map(function(u){ return '<div>' + u.substring(0,60) + '</div>'; }).join('') +
          (preview.unmatched > 50 ? '<div>...i ' + (preview.unmatched-50) + ' więcej</div>' : '') +
          '</div>'
        : '');
    var btn = document.getElementById('b24t-preview-btn');
    if (btn) btn.addEventListener('click', function() {
      var list = document.getElementById('b24t-preview-list');
      var show = list.style.display === 'none';
      list.style.display = show ? 'block' : 'none';
      btn.textContent = 'Pokaż niedopasowane (' + Math.min(preview.unmatched, 50) + ') ' + (show ? '\u25b4' : '\u25be');
    });
  }

  // ───────────────────────────────────────────
  // F2 - MANUAL COLUMN MAPPING
  // ───────────────────────────────────────────

  function buildColumnOverrideUI(rows) {
    if (!rows || !rows.length) return;
    const headers = Object.keys(rows[0]);
    const el = document.getElementById('b24t-column-override');
    if (!el) return;
    const roles = [
      { key: 'url',        label: 'URL' },
      { key: 'assessment', label: 'Labelka (assessment)' },
      { key: 'date',       label: 'Data' },
      { key: 'text',       label: 'Treść (opcjonalnie)' },
    ];
    const detected = state.file && state.file.colMap ? state.file.colMap : {};
    let html = '<div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:6px;">Kolumny wykryte automatycznie. Zmień jeśli coś się nie zgadza:</div>';
    roles.forEach(function(r) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
      html += '<span style="font-size:10px;color:var(--b24t-text);width:140px;flex-shrink:0;">' + r.label + ':</span>';
      html += '<select class="b24t-select b24t-col-sel" data-role="' + r.key + '" style="flex:1;"><option value="">— brak —</option>';
      headers.forEach(function(h) {
        html += '<option value="' + h + '"' + (detected[r.key] === h ? ' selected' : '') + '>' + h + '</option>';
      });
      html += '</select></div>';
    });
    html += '<div id="b24t-col-preview" style="font-size:10px;color:var(--b24t-text-faint);margin-top:4px;"></div>';
    el.innerHTML = html;
    el.querySelectorAll('.b24t-col-sel').forEach(function(sel) {
      sel.addEventListener('change', function() { applyColumnOverride(el, rows); });
    });
    applyColumnOverride(el, rows);
  }

  function applyColumnOverride(el, rows) {
    const newMap = {};
    el.querySelectorAll('.b24t-col-sel').forEach(function(sel) {
      if (sel.value) newMap[sel.dataset.role] = sel.value;
    });
    if (state.file) {
      state.file.colMap = Object.assign({}, state.file.colMap, newMap);
      state.file.meta = processFileData(rows, state.file.colMap);
    }
    const preview = el.querySelector('#b24t-col-preview');
    if (preview && rows[0]) {
      const sample = rows[0];
      const parts = [];
      if (newMap.url)        parts.push('URL: "' + (sample[newMap.url] || '').substring(0,40) + '"');
      if (newMap.assessment) parts.push('Label: "' + (sample[newMap.assessment] || '') + '"');
      if (newMap.date)       parts.push('Data: "' + (sample[newMap.date] || '') + '"');
      preview.textContent = parts.join(' | ');
    }
    state.matchPreview = null;
    const prevEl = document.getElementById('b24t-match-preview');
    if (prevEl) prevEl.style.display = 'none';
  }

  // ───────────────────────────────────────────
  // F4 - SESSION HISTORY
  // ───────────────────────────────────────────

  function saveSessionToHistory() {
    if (!state.projectId || !state.stats) return;
    const history = lsGet(LS.HISTORY, []);
    history.unshift({
      date: new Date().toLocaleString('pl-PL'),
      projectName: state.projectName || String(state.projectId),
      projectId: state.projectId,
      tagged: state.stats.tagged,
      skipped: state.stats.skipped,
      noMatch: state.stats.noMatch,
      deleted: state.stats.deleted || 0,
      fileName: state.file ? state.file.name : '—',
      durationSec: state.sessionStart ? Math.floor((Date.now() - state.sessionStart) / 1000) : 0,
      mode: state.testRunMode ? 'Test Run' : 'Właściwy',
    });
    lsSet(LS.HISTORY, history.slice(0, 20));
  }

  function buildHistoryTab() {
    const div = document.createElement('div');
    div.id = 'b24t-history-tab';
    div.style.display = 'none';
    div.innerHTML =
      '<div class="b24t-section">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
          '<div class="b24t-section-label">Historia sesji</div>' +
          '<button id="b24t-history-clear" style="font-size:9px;color:var(--b24t-text-faint);background:none;border:none;cursor:pointer;">wyczyść</button>' +
        '</div>' +
        '<div id="b24t-history-list"></div>' +
      '</div>';
    return div;
  }

  function renderHistoryTab() {
    const list = document.getElementById('b24t-history-list');
    if (!list) return;
    const history = lsGet(LS.HISTORY, []);
    if (!history.length) {
      list.innerHTML = '<div style="font-size:11px;color:var(--b24t-text-faint);text-align:center;padding:16px 0;">Brak historii sesji</div>';
      return;
    }
    list.innerHTML = history.map(function(s) {
      const mins = Math.floor(s.durationSec / 60);
      const secs = s.durationSec % 60;
      return '<div style="background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:8px 10px;margin-bottom:6px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">' +
          '<span style="font-size:11px;color:var(--b24t-text);font-weight:600;">' + s.projectName + '</span>' +
          '<span style="font-size:9px;color:var(--b24t-text-faint);">' + s.date + '</span>' +
        '</div>' +
        '<div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:3px;">📄 ' + s.fileName + '</div>' +
        '<div style="display:flex;gap:10px;font-size:10px;">' +
          '<span style="color:#4ade80;">✓ ' + s.tagged + ' otagowano</span>' +
          '<span style="color:#facc15;">⚠ ' + s.skipped + ' pominięto</span>' +
          (s.noMatch ? '<span style="color:#f87171;">✗ ' + s.noMatch + ' brak matcha</span>' : '') +
          (s.deleted ? '<span style="color:#f87171;">🗑 ' + s.deleted + ' usunięto</span>' : '') +
        '</div>' +
        '<div style="font-size:9px;color:var(--b24t-text-faint);margin-top:3px;">' + s.mode + ' · ' + mins + 'm ' + secs + 's</div>' +
      '</div>';
    }).join('');
  }

  function wireHistoryTab() {
    const clearBtn = document.getElementById('b24t-history-clear');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      if (confirm('Wyczyścić całą historię sesji? Tego nie można cofnąć.')) {
        lsSet(LS.HISTORY, []);
        renderHistoryTab();
      }
    });
    const tab = document.getElementById('b24t-history-tab');
    if (tab) new MutationObserver(function() {
      if (tab.style.display !== 'none') renderHistoryTab();
    }).observe(tab, { attributes: true, attributeFilter: ['style'] });
  }

  // ───────────────────────────────────────────
  // F5 - FILE VALIDATION
  // ───────────────────────────────────────────

  function validateFile(rows, colMap) {
    const warnings = [];
    // BŁĘDY KRYTYCZNE — blokują Start
    if (!colMap.url) {
      warnings.push({ type: 'error', msg: 'Brak kolumny URL — matching wzmianek nie zadziała. Sprawdź plik lub użyj "Zmień wykryte kolumny".' });
    }
    if (!colMap.assessment) {
      warnings.push({ type: 'error', msg: 'Brak kolumny z ocenami (assessment) — nie wiadomo jak tagować wzmianki.' });
    }
    if (colMap.date) {
      const validDates = rows.filter(function(r){ return /^\d{4}-\d{2}-\d{2}/.test((r[colMap.date] || '')); });
      if (validDates.length === 0) {
        warnings.push({ type: 'error', msg: 'Kolumna daty wykryta ("' + colMap.date + '"), ale wszystkie wartości są puste — zakres dat nieznany. Matching użyje bieżącego miesiąca jako fallback.' });
      }
    } else {
      warnings.push({ type: 'error', msg: 'Brak kolumny z datami — zakres dat nieznany. Matching użyje bieżącego miesiąca jako fallback. Upewnij się że plik zawiera kolumnę "created_date" lub "date".' });
    }
    const urlSet = new Set();
    let dupUrls = 0, noUrl = 0, noAssessment = 0, badUrl = 0;
    rows.forEach(function(row) {
      const url = colMap.url ? (row[colMap.url] || '').trim() : '';
      const assessment = colMap.assessment ? (row[colMap.assessment] || '').trim() : '';
      if (!url) { noUrl++; }
      else if (!/^https?:\/\//.test(url)) { badUrl++; }
      else if (urlSet.has(url)) { dupUrls++; }
      else { urlSet.add(url); }
      if (!assessment) noAssessment++;
    });
    if (dupUrls > 0)        warnings.push({ type: 'warn', msg: dupUrls + ' zduplikowanych URLi — te wzmianki mogą być otagowane podwójnie' });
    if (noUrl > 0)          warnings.push({ type: 'warn', msg: noUrl + ' wierszy bez URL — zostaną pominięte' });
    if (badUrl > 0)         warnings.push({ type: 'warn', msg: badUrl + ' URLi bez http/https' });
    if (noAssessment > 0)   warnings.push({ type: 'info', msg: noAssessment + ' wierszy bez oceny — zostaną pominięte' });
    if (rows.length > 5000) warnings.push({ type: 'warn', msg: 'Duży plik: ' + rows.length + ' wierszy. Operacja może potrwać kilkadziesiąt sekund.' });
    if (colMap.date) {
      const dates = rows.map(function(r){ return (r[colMap.date] || '').substring(0,10); }).filter(function(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d); });
      if (dates.length) {
        const min = dates.reduce(function(a,b){ return a<b?a:b; });
        const max = dates.reduce(function(a,b){ return a>b?a:b; });
        const days = Math.round((new Date(max) - new Date(min)) / 86400000);
        if (days > 90) warnings.push({ type: 'warn', msg: 'Szeroki zakres dat: ' + days + ' dni (' + min + ' \u2192 ' + max + '). Rozważ podział na mniejsze pliki.' });
      }
    }
    return warnings;
  }

  function renderFileValidation(warnings) {
    const el = document.getElementById('b24t-file-validation');
    if (!el) return;
    if (!warnings.length) {
      el.style.display = 'none';
      el.dataset.hasErrors = '';
      _updateStartBtnBlock();
      return;
    }
    const hasErrors = warnings.some(function(w){ return w.type === 'error'; });
    el.dataset.hasErrors = hasErrors ? '1' : '';
    el.style.display = 'block';
    el.style.borderColor = hasErrors ? '#f87171' : 'var(--b24t-border)';
    el.innerHTML = warnings.map(function(w) {
      var color, icon;
      if (w.type === 'error')      { color = '#f87171'; icon = '✕'; }
      else if (w.type === 'warn')  { color = '#facc15'; icon = '⚠'; }
      else                          { color = 'var(--b24t-text-faint)'; icon = 'ℹ'; }
      return '<div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--b24t-border-sub);">' +
        '<span style="flex-shrink:0;color:' + color + ';">' + icon + '</span>' +
        '<span style="font-size:10px;color:' + (w.type === 'error' ? '#f8a4a4' : '#9090bb') + ';">' + w.msg + '</span></div>';
    }).join('') + (hasErrors
      ? '<div style="margin-top:6px;font-size:10px;color:#f87171;font-weight:600;">⛔ Start zablokowany — popraw błędy lub użyj ręcznego mapowania kolumn.</div>'
      : '');
    _updateStartBtnBlock();
  }

  function _updateStartBtnBlock() {
    var startBtn = document.getElementById('b24t-btn-start');
    var previewBtn = document.getElementById('b24t-btn-preview');
    var auditBtn = document.getElementById('b24t-btn-audit');
    var el = document.getElementById('b24t-file-validation');
    var mpEl = document.getElementById('b24t-multiproject-section');
    var blocked = !!(el && el.dataset.hasErrors === '1') || !!(mpEl && mpEl.dataset.blocked === '1');
    if (startBtn) {
      startBtn.disabled = blocked;
      startBtn.title = blocked ? 'Zablokowany — plik ma błędy krytyczne (brak URL lub daty)' : '';
      startBtn.style.opacity = blocked ? '0.45' : '';
      startBtn.style.cursor = blocked ? 'not-allowed' : '';
    }
    if (previewBtn) {
      previewBtn.disabled = blocked;
      previewBtn.style.opacity = blocked ? '0.45' : '';
    }
    if (auditBtn) {
      auditBtn.disabled = blocked;
      auditBtn.style.opacity = blocked ? '0.45' : '';
    }
  }

  // ───────────────────────────────────────────
  // F6 - AUDIT MODE
  // ───────────────────────────────────────────

  async function runAuditMode() {
    if (!state.file || !state.projectId) return;
    state.status = 'running';
    state.sessionStart = Date.now();
    updateStatusUI();
    startSessionTimer();
    addLog('🔍 Audit Mode — porównuję plik z Brand24 (bez tagowania)...', 'info');

    const dateFrom = state.file.meta.minDate;
    const dateTo   = state.file.meta.maxDate;
    const colMap   = state.file.colMap;

    const map = await buildUrlMap(dateFrom, dateTo, false);

    const result = { alreadyTagged: [], untagged: [], taggedWrong: [], notFound: [], notInFile: 0 };
    const fileUrls = new Set(state.file.rows.map(function(r){
      return normalizeUrl(colMap.url ? (r[colMap.url] || '') : '');
    }).filter(Boolean));
    result.notInFile = Object.keys(map).filter(function(k){ return !fileUrls.has(k); }).length;

    state.file.rows.forEach(function(row) {
      const assessment = (colMap.assessment ? (row[colMap.assessment] || '') : '').trim().toUpperCase();
      if (!assessment) return;
      const urlRaw = colMap.url ? (row[colMap.url] || '') : '';
      if (!urlRaw) return;
      const entry = map[normalizeUrl(urlRaw)];
      const expectedMapping = state.mapping[assessment];
      if (!entry) { result.notFound.push(urlRaw); return; }
      const tags = (entry.existingTags || []).map(function(t){ return t.id; });
      if (tags.length === 0) {
        result.untagged.push({ url: urlRaw, expected: expectedMapping ? expectedMapping.tagName : assessment });
      } else if (expectedMapping && tags.includes(expectedMapping.tagId)) {
        result.alreadyTagged.push(urlRaw);
      } else {
        result.taggedWrong.push({ url: urlRaw, expected: expectedMapping ? expectedMapping.tagName : assessment, actual: (entry.existingTags || []).map(function(t){ return t.title; }).join(', ') });
      }
    });

    state.status = 'done';
    updateStatusUI();
    window.B24Tagger._lastAuditResult = result;
    showAuditReport(result);
    addLog('✓ Audit: ' + result.alreadyTagged.length + ' OK, ' + result.untagged.length + ' nieztagowane, ' + result.taggedWrong.length + ' złe tagi, ' + result.notFound.length + ' nie znaleziono', 'success');
    saveSessionToHistory();
  }

  function showAuditReport(result) {
    const modal = document.getElementById('b24t-report-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    const content = modal.querySelector('.b24t-report-content');
    if (!content) return;
    let wrongHtml = '';
    if (result.taggedWrong.length > 0) {
      wrongHtml = '<div style="margin-top:12px;font-size:10px;color:var(--b24t-text-faint);">Błędne tagi (pierwsze 5):</div>';
      result.taggedWrong.slice(0,5).forEach(function(e) {
        wrongHtml += '<div style="font-size:9px;color:var(--b24t-text-faint);padding:3px 0;border-bottom:1px solid var(--b24t-border-sub);">' +
          e.url.substring(0,50) + '<br>' +
          '<span style="color:var(--b24t-err);">✗ ma: ' + e.actual + '</span> <span style="color:var(--b24t-ok);">\u2192 powinien: ' + e.expected + '</span></div>';
      });
    }
    content.innerHTML =
      '<h3 style="color:var(--b24t-primary);font-size:14px;margin-bottom:16px;">🔍 Raport Audit Mode</h3>' +
      '<div class="b24t-report-row"><span>✓ Prawidłowo otagowane</span><strong style="color:var(--b24t-ok);">' + result.alreadyTagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>⚠ Nieztagowane</span><strong style="color:var(--b24t-warn);">' + result.untagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>✗ Błędny tag</span><strong style="color:var(--b24t-err);">' + result.taggedWrong.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>? Nie znaleziono w Brand24</span><strong style="color:var(--b24t-text-faint);">' + result.notFound.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>~ W Brand24, brak w pliku</span><strong>' + result.notInFile + '</strong></div>' +
      wrongHtml +
      '<div style="display:flex;gap:6px;margin-top:16px;">' +
        '<button onclick="document.getElementById(\'b24t-report-modal\').style.display=\'none\'" class="b24t-btn-secondary" style="flex:1;">Zamknij</button>' +
        '<button onclick="window.B24Tagger.exportAuditReport()" class="b24t-btn-primary" style="flex:1;">\u2193 Eksport CSV</button>' +
      '</div>';
  }

  // ───────────────────────────────────────────
  // F9 - SOUND NOTIFICATION
  // ───────────────────────────────────────────

  function playDoneSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [523.25, 659.25, 783.99].forEach(function(freq, i) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'sine';
        const t = ctx.currentTime + i * 0.13;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        osc.start(t); osc.stop(t + 0.45);
      });
    } catch(e) {}
  }

  // ───────────────────────────────────────────
  // F11 - TAG COUNTS IN MAPPING
  // ───────────────────────────────────────────

  function updateTagCountsInMapping() {
    if (!state.file || !state.file.meta || !state.file.meta.assessments) return;
    const container = document.getElementById('b24t-mapping-rows');
    if (!container) return;
    const tagBuckets = {};
    Object.entries(state.mapping).forEach(function(entry) {
      const label = entry[0]; const m = entry[1];
      const count = state.file.meta.assessments[label] || 0;
      tagBuckets[m.tagId] = (tagBuckets[m.tagId] || 0) + count;
    });
    container.querySelectorAll('.b24t-tag-select').forEach(function(sel) {
      const label = sel.dataset.label;
      if (!label) return;
      const mapping = state.mapping[label.toUpperCase()];
      if (!mapping) return;
      const total = tagBuckets[mapping.tagId] || 0;
      if (!total) return;
      Array.from(sel.options).forEach(function(opt) {
        if (parseInt(opt.value) === mapping.tagId) {
          if (!opt.dataset.origText) opt.dataset.origText = opt.textContent.replace(/ \(\d+\)$/, '');
          opt.textContent = opt.dataset.origText + ' (' + total + ')';
        }
      });
    });
  }


  // ───────────────────────────────────────────
  // FEATURE: MATCH PREVIEW
  // ───────────────────────────────────────────

  async function runMatchPreview() {
    if (!state.file || !state.projectId || !state.tokenHeaders) return null;
    const dateFrom = state.file.meta.minDate;
    const dateTo   = state.file.meta.maxDate;
    if (!dateFrom || !dateTo) return null;
    addLog('→ Match Preview: buduję mapę...', 'info');
    const map = await buildUrlMap(dateFrom, dateTo, state.mapMode === 'untagged');
    const colMap = state.file.colMap;
    let matched = 0, unmatched = 0, noAssessment = 0;
    const unmatchedList = [];
    state.file.rows.forEach(row => {
      const assessment = colMap.assessment ? (row[colMap.assessment] || '').trim() : '';
      if (!assessment) { noAssessment++; return; }
      const urlRaw = colMap.url ? (row[colMap.url] || '') : '';
      if (!urlRaw) { unmatched++; return; }
      if (map[normalizeUrl(urlRaw)]) { matched++; }
      else { unmatched++; if (unmatchedList.length < 50) unmatchedList.push(urlRaw); }
    });
    state.matchPreview = {
      matched, unmatched, noAssessment,
      total: state.file.rows.length,
      pct: Math.round(matched / Math.max(1, matched + unmatched) * 100),
      unmatchedList, dateFrom, dateTo,
    };
    return state.matchPreview;
  }

  // ───────────────────────────────────────────
  // FEATURE: MANUAL COLUMN MAPPING

  // ───────────────────────────────────────────
  // FEATURE: SESSION HISTORY

  // ───────────────────────────────────────────
  // FEATURE: FILE VALIDATION

  // ───────────────────────────────────────────
  // FEATURE: AUDIT MODE

  // ───────────────────────────────────────────
  // FEATURE: SOUND NOTIFICATION

  // ───────────────────────────────────────────
  // FEATURE: TAG COUNTS IN MAPPING


  // ───────────────────────────────────────────
  // NEWS MODULE — v0.15.1
  // Floating 3-panel system attached to Annotators Tab
  // ───────────────────────────────────────────

  var newsState = {
    urls: [],
    activeIdx: -1,
    sessionUrls: {},
    detectedCountry: null,
    panelsOpen: false,
    wired: false,
    scanning: false,
    scanTotal: 0,
    scanDone: 0,
    hideNonArticles: false,
  };

  // Ustawienia importu — zapisywane w localStorage
  var _newsImportOpts = (function() {
    try {
      var raw = localStorage.getItem('b24t_news_import_opts');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch(e) {}
    return { urlSimpleMode: false };
  })();
  function _saveNewsImportOpts() {
    try { localStorage.setItem('b24t_news_import_opts', JSON.stringify(_newsImportOpts)); } catch(e) {}
  }

  var _newsChipsRenderer = null; // set by _wireNewsPanels, called on every panel open

  var NEWS_DEFAULT_KEYWORDS = [
    'hm-', '-hm-', '-hm', '/hm/', '/hm',
    'h-m', 'h&m', 'h%26m', 'hennes', 'mauritz',
  ];
  var NEWS_KEYWORD_EXCLUSIONS = ['h-mart'];

  var NEWS_TLD_MAP = {
    pl:'PL', tr:'TR', gr:'GR', hr:'HR', ro:'RO', bg:'BG',
    hu:'HU', cz:'CZ', sk:'SK', lt:'LT', lv:'LV', ee:'EE',
    rs:'RS', ge:'GE', ua:'UA', ba:'BA', mk:'MK', al:'AL',
    xk:'XK', kz:'KZ', me:'ME', md:'MD', am:'AM', az:'AZ',
  };

  // Mapa kraj → oczekiwany język(i) strony (BCP 47 base tag)
  // Używana do wykrywania stron w złym języku dla projektu
  var _NEWS_LANG_MAP = {
    'pl':['pl'], 'cz':['cs'], 'sk':['sk'], 'hu':['hu'], 'ro':['ro'],
    'bg':['bg'], 'hr':['hr'], 'rs':['sr'], 'lt':['lt'], 'lv':['lv'],
    'ee':['et'], 'fi':['fi'], 'se':['sv'], 'no':['no','nb'], 'dk':['da'],
    'de':['de'], 'at':['de'], 'fr':['fr'], 'nl':['nl'], 'it':['it'],
    'es':['es'], 'pt':['pt'], 'br':['pt'], 'tr':['tr'], 'gr':['el'],
    'ua':['uk'], 'ru':['ru'], 'ge':['ka'], 'am':['hy'], 'az':['az'],
    'al':['sq'], 'mk':['mk'], 'ba':['bs'], 'me':['sr'], 'md':['ro'],
    'xk':['sq'], 'kz':['kk'], 'gb':['en'], 'us':['en'], 'au':['en'],
    'ie':['en'], 'ca':['en','fr'], 'nz':['en'],
  };

  function _newsCountryFromUrl(url) {
    try {
      var h = new URL(url).hostname.toLowerCase();
      var subMatch = h.match(/^([a-z]{2})\./);
      if (subMatch && NEWS_TLD_MAP[subMatch[1]]) return NEWS_TLD_MAP[subMatch[1]];
      var tld = h.split('.').pop();
      return NEWS_TLD_MAP[tld] || null;
    } catch(e) { return null; }
  }

  function _newsDetectCountryFromUrls(urls) {
    var counts = {};
    urls.forEach(function(u) {
      var c = _newsCountryFromUrl(u.url);
      if (c) counts[c] = (counts[c] || 0) + 1;
    });
    var total = urls.length;
    var best = null, bestN = 0;
    Object.keys(counts).forEach(function(c) { if (counts[c] > bestN) { bestN = counts[c]; best = c; } });
    return (best && bestN / total >= 0.3) ? best : null;
  }

  function _newsProjectCountry() {
    var name = (state.projectName || '').toUpperCase();
    var m = name.match(/_([A-Z]{2})$/);
    return m ? m[1] : null;
  }

  function _newsGetKeywords(cc) {
    var all = lsGet(LS.NEWS_KEYWORDS, {});
    var saved = all[cc];
    return (Array.isArray(saved) && saved.length > 0) ? saved : NEWS_DEFAULT_KEYWORDS.slice();
  }
  function _newsSaveKeywords(cc, chips) {
    var all = lsGet(LS.NEWS_KEYWORDS, {});
    all[cc] = chips;
    lsSet(LS.NEWS_KEYWORDS, all);
  }
  function _newsGetLangMap() { return lsGet(LS.NEWS_LANG_MAP, {}); }
  function _newsSaveLangMap(map) { lsSet(LS.NEWS_LANG_MAP, map); }
  function _newsGetSessionUrls() { return lsGet(LS.NEWS_SESSION_URLS, {}); }
  function _newsMarkSessionUrl(url) {
    var s = _newsGetSessionUrls(); s[url] = true; lsSet(LS.NEWS_SESSION_URLS, s);
  }

  // Country path segments and subdomains to detect in URLs
  // Maps country indicators (path segments, subdomains) → country code
  var NEWS_COUNTRY_PATH_MAP = {
    'uk':'GB', 'en-gb':'GB', 'gb':'GB',
    'de':'DE', 'en-de':'DE',
    'fr':'FR', 'en-fr':'FR',
    'us':'US', 'en-us':'US',
    'au':'AU', 'en-au':'AU',
    'ca':'CA', 'en-ca':'CA',
    'es':'ES', 'en-es':'ES',
    'it':'IT', 'en-it':'IT',
    'nl':'NL', 'en-nl':'NL',
    'be':'BE', 'en-be':'BE',
    'pt':'PT', 'en-pt':'PT',
    'se':'SE', 'en-se':'SE',
    'no':'NO', 'en-no':'NO',
    'dk':'DK', 'en-dk':'DK',
    'fi':'FI', 'en-fi':'FI',
    'at':'AT', 'en-at':'AT',
    'ch':'CH', 'en-ch':'CH',
    'ie':'IE', 'en-ie':'IE',
    'nz':'NZ', 'en-nz':'NZ',
    'za':'ZA', 'en-za':'ZA',
    'in':'IN', 'en-in':'IN',
    'sg':'SG', 'en-sg':'SG',
    'hk':'HK', 'en-hk':'HK',
    'jp':'JP', 'en-jp':'JP',
    'kr':'KR', 'en-kr':'KR',
    'cn':'CN', 'en-cn':'CN',
    'mx':'MX', 'en-mx':'MX',
    'ar':'AR', 'en-ar':'AR',
    'br':'BR', 'en-br':'BR',
    'ru':'RU', 'en-ru':'RU',
    // TLD-map countries also checked via path
    'pl':'PL', 'tr':'TR', 'gr':'GR', 'hr':'HR', 'ro':'RO', 'bg':'BG',
    'hu':'HU', 'cz':'CZ', 'sk':'SK', 'lt':'LT', 'lv':'LV', 'ee':'EE',
    'rs':'RS', 'ge':'GE', 'ua':'UA', 'ba':'BA', 'mk':'MK', 'al':'AL',
    'kz':'KZ', 'me':'ME', 'md':'MD', 'am':'AM', 'az':'AZ',
  };

  // Extract country signals from a URL: TLD, subdomain, path segments
  function _newsCountriesInUrl(url) {
    var found = {};
    try {
      var parsed = new URL(url);
      var host = parsed.hostname.toLowerCase();
      var path = parsed.pathname.toLowerCase();

      // 1. TLD
      var tld = host.split('.').pop();
      if (NEWS_TLD_MAP[tld]) found[NEWS_TLD_MAP[tld]] = 'tld';

      // 2. Known 2-letter subdomain (e.g. tr.cosmopolitan.com)
      var hostParts = host.split('.');
      if (hostParts.length >= 3) {
        var sub = hostParts[0];
        if (NEWS_COUNTRY_PATH_MAP[sub]) found[NEWS_COUNTRY_PATH_MAP[sub]] = 'subdomain';
        if (NEWS_TLD_MAP[sub]) found[NEWS_TLD_MAP[sub]] = 'subdomain';
      }

      // 3. Path segments: /uk/, /en-gb/, /tr/, etc.
      var segments = path.split('/').filter(Boolean);
      segments.forEach(function(seg) {
        if (NEWS_COUNTRY_PATH_MAP[seg]) found[NEWS_COUNTRY_PATH_MAP[seg]] = 'path';
        if (NEWS_TLD_MAP[seg]) found[NEWS_TLD_MAP[seg]] = 'path';
      });

    } catch(e) {}
    return found; // { 'GB': 'tld', 'TR': 'path' } etc.
  }

  // Main relevance check — returns 'match', 'wrongcountry', or 'nomatch'
  // 'match'        = keyword found AND no conflicting foreign country in URL
  // 'wrongcountry' = keyword found BUT URL signals a different country than project
  // 'nomatch'      = keyword not found
  function _newsUrlRelevant(url, chips, projectCountry) {
    var lurl = url.toLowerCase();

    // Exclusion check
    if (NEWS_KEYWORD_EXCLUSIONS.some(function(ex) { return lurl.indexOf(ex) !== -1; })) {
      return 'nomatch';
    }

    // Keyword check
    var hasKeyword = chips.some(function(chip) { return lurl.indexOf(chip.toLowerCase()) !== -1; });
    if (!hasKeyword) return 'nomatch';

    // If no project country configured — keyword match is enough
    if (!projectCountry) return 'match';

    // Country signal check
    var countries = _newsCountriesInUrl(url);
    var countryKeys = Object.keys(countries);

    if (countryKeys.length === 0) return 'match'; // no country signals → assume ok

    // If project country is explicitly present → match
    if (countries[projectCountry]) return 'match';

    // If only foreign country signals present → wrong country
    // Exception: .com / international TLD with no path country = neutral
    var nonNeutral = countryKeys.filter(function(c) { return c !== projectCountry; });
    if (nonNeutral.length > 0) return 'wrongcountry';

    return 'match';
  }

  // ── NEWS CONTENT SCANNER ──
  // Skanuje treść strony pod kątem słów kluczowych gdy URL nie zawiera żadnego dopasowania.
  // Zwraca Promise<{status:'mention'|'contentmatch'|'keytopic'|'teasermatch'|'nomatch'|'blocked', score:Number, snippet:String}>
  //
  // Progi punktowe:
  //   keyword w tytule/og:title          → +8  (silny sygnał — autor strony wybrał ten tytuł)
  //   keyword w og:description/meta desc → +5  (silny sygnał — opis meta)
  //   keyword w h1                       → +5  (silny sygnał — nagłówek artykułu)
  //   keyword w h2/h3 (podrozdziały)     → +3  (wyraźny sygnał — keyword w sekcji artykułu)
  //   keyword w pierwszym akapicie       → +4  (umiarkowany — lede artykułu)
  //   keyword w kolejnych akapitach      → +1 za każdy, maks. +3 łącznie
  //   keyword w blockquote               → +2  (cytat w treści artykułu)
  //   keyword w tagach artykułu          → +4  (sygnał redakcyjny — tag dodany przez autora)
  //
  // Poziomy relevancji:
  //   mention     → 1–4 pkt   (wzmianka w treści — poboczna, ale relevantna)
  //   contentmatch→ 5–11 pkt  (keyword w opisie meta lub kilka akapitów)
  //   keytopic    → 12+ pkt   (keyword w tytule — artykuł o marce)
  //   teasermatch → 0 pkt     (keyword tylko w sekcji polecanych artykułów, nie w głównej treści)

  var NEWS_CONTENT_SCAN_CONCURRENCY = 5;
  var NEWS_CONTENT_SCAN_TIMEOUT_MS  = 8000; // minimum / fallback
  var _scanTimings = []; // sliding window: czasy udanych skanów (ms), max 20

  function _getAdaptiveScanTimeout() {
    if (_scanTimings.length < 4) return NEWS_CONTENT_SCAN_TIMEOUT_MS;
    var sorted = _scanTimings.slice().sort(function(a, b) { return a - b; });
    var p90 = sorted[Math.floor(sorted.length * 0.9)];
    return Math.max(NEWS_CONTENT_SCAN_TIMEOUT_MS, Math.min(p90 * 2, 40000));
  }
  function _recordScanTiming(ms) {
    _scanTimings.push(ms);
    if (_scanTimings.length > 20) _scanTimings.shift();
  }

  var NEWS_NOISE_SELECTORS = [
    'script','style','noscript','svg','iframe',
    'aside','footer','nav','body > header','form',
    '[class*="ad-"]','[class*="-ad"]','[class*="__ad"]',
    '[class*="banner"]','[class*="sponsor"]','[class*="widget"]',
    '[class*="sidebar"]','[class*="promo"]','[class*="popup"]',
    '[class*="newsletter"]','[class*="cookie"]','[class*="consent"]',
    '[id*="banner"]','[id*="sidebar"]','[id*="cookie"]','[id*="popup"]',
  ];

  // Selektory sekcji z polecanymi/powiązanymi artykułami — wycinane PRZED skanowaniem głównej treści.
  // Tekst z tych sekcji trafia do osobnego bucketu (_teaserTexts) — jeśli keyword trafił TYLKO tu,
  // status = 'teasermatch' (nie liczy jako relevantny artykuł).
  var NEWS_TEASER_SELECTORS = [
    '[class*="related"]','[class*="recommended"]',
    '[class*="more-articles"]','[class*="more-stories"]','[class*="more-news"]',
    '[class*="also-read"]','[class*="you-may"]','[class*="you-might"]',
    '[class*="read-next"]','[class*="next-article"]',
    '[class*="suggestions"]','[class*="suggested"]',
    '[data-module*="related"]','[data-type*="related"]','[data-widget*="related"]',
  ];

  function _newsParseContent(html, chips) {
    var doc;
    try {
      doc = (new DOMParser()).parseFromString(html, 'text/html');
    } catch(e) {
      return { status: 'nomatch', score: 0, snippet: '' };
    }

    // ── DETEKCJA TYPU STRONY (przed usunięciem szumu — skrypty jeszcze obecne) ──
    var _articleSignals = [];

    // Język strony — <html lang="pl-PL"> → "pl"
    var _pageLang = (doc.documentElement.getAttribute('lang') || '').toLowerCase();
    if (_pageLang.indexOf('-') !== -1) _pageLang = _pageLang.split('-')[0];

    // og:type = "article" / "news_article" itp.
    var _ogTypeEl = doc.querySelector('meta[property="og:type"]');
    var _ogType = _ogTypeEl ? (_ogTypeEl.getAttribute('content') || '').toLowerCase() : '';
    if (_ogType === 'article' || (_ogType.length > 0 && (_ogType.indexOf('article') !== -1 || _ogType.indexOf('news') !== -1))) {
      _articleSignals.push('og:type');
    }

    // article:published_time — sygnał artykułu + ekstrakcja daty
    var _articleDate = null;
    var _pubTimeMeta = doc.querySelector('meta[property="article:published_time"]') ||
                       doc.querySelector('meta[name="article:published_time"]') ||
                       doc.querySelector('meta[property="og:article:published_time"]');
    if (_pubTimeMeta) {
      _articleSignals.push('published_time');
      var _rawDate = (_pubTimeMeta.getAttribute('content') || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(_rawDate)) _articleDate = _rawDate;
    }

    // JSON-LD — jeden przebieg: typ artykułu + data publikacji + paywall
    var _ARTICLE_LD_TYPES = ['NewsArticle','Article','BlogPosting','ReportageNewsArticle','AnalysisNewsArticle','Review'];
    var _isPaywall = false;
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(function(el) {
      try {
        var _ld = JSON.parse(el.textContent);
        var _ldArr = Array.isArray(_ld) ? _ld : [_ld];
        _ldArr.forEach(function(item) {
          // @type → artykuł?
          if (_articleSignals.indexOf('ld+json') === -1) {
            var _t = item['@type'] || '';
            if (typeof _t === 'string') _t = [_t];
            if (Array.isArray(_t) && _t.some(function(x) { return _ARTICLE_LD_TYPES.indexOf(x) !== -1; })) {
              _articleSignals.push('ld+json');
            }
          }
          // datePublished / dateCreated → data artykułu
          if (!_articleDate) {
            var _d = item.datePublished || item.dateCreated || '';
            if (_d) { var _ds = String(_d).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(_ds)) _articleDate = _ds; }
          }
          // isAccessibleForFree: false → paywall
          var _iaf = item.isAccessibleForFree;
          if (_iaf === false || _iaf === 'False' || _iaf === 'false') _isPaywall = true;
        });
      } catch(e) {}
    });

    // Paywall — meta access/content_tier
    var _accessMeta = doc.querySelector('meta[name="access"]') ||
                      doc.querySelector('meta[property="article:content_tier"]');
    if (_accessMeta) {
      var _ac = (_accessMeta.getAttribute('content') || '').toLowerCase();
      if (_ac === 'subscription' || _ac === 'locked' || _ac === 'metered') _isPaywall = true;
    }

    // ── TEASER EXTRACTION — przed usunięciem szumu, żeby nie stracić tekstu ──
    // Wytnij sekcje polecanych/powiązanych artykułów do osobnego bucketu.
    // Jeśli keyword trafia TYLKO tu (nie w głównej treści) → status 'teasermatch'.
    var _teaserTexts = [];
    NEWS_TEASER_SELECTORS.forEach(function(sel) {
      try {
        doc.querySelectorAll(sel).forEach(function(el) {
          var t = (el.textContent || '').toLowerCase();
          if (t.length > 10) _teaserTexts.push(t);
          el.remove();
        });
      } catch(e) {}
    });

    // ── WCZESNA IDENTYFIKACJA STREFY TREŚCI — przed usunięciem szumu ──
    // Agresywne selektory noise (np. [class*="widget"]) mogą usunąć kontener artykułu
    // gdy ma klasę zawierającą "widget" (np. "article-widget__body", "content-widget").
    // Dlatego bodyEl musi być znaleziony ZANIM usuniemy szum — potem jest chroniony.
    var _CONTENT_ZONE_SEL =
      '[role="article"],[class*="article-body"],[class*="article-content"],' +
      '[class*="article__body"],[class*="article__text"],[class*="article__content"],' +
      '[class*="post-content"],[class*="post__content"],[class*="entry-content"],' +
      '[class*="story-body"],[class*="story__content"],[class*="story-content"],' +
      '[class*="content-body"],[class*="text-content"],[class*="body-copy"],' +
      '[class*="content__body"],[class*="text-body"],[class*="article__lead"],' +
      '[id*="article-body"],[id*="articleBody"],[id*="story-body"]';
    var bodyEl = doc.querySelector('article') ||
      doc.querySelector('main') ||
      (function() { try { return doc.querySelector(_CONTENT_ZONE_SEL); } catch(e) { return null; } })() ||
      doc.body;

    // Usuń szum — reklamy, nawigację, stopki, popupy.
    // bodyEl i jego przodkowie są chronieni: el !== bodyEl && !el.contains(bodyEl)
    // zapobiega usunięciu kontenera artykułu lub jego rodzica przez szerokie selektory.
    NEWS_NOISE_SELECTORS.forEach(function(sel) {
      try {
        doc.querySelectorAll(sel).forEach(function(el) {
          if (el !== bodyEl && !el.contains(bodyEl)) el.remove();
        });
      } catch(e) {}
    });

    // Wyciągnij tekst z kluczowych stref strony
    var titleText = '';
    var titleEl = doc.querySelector('title');
    if (titleEl) titleText = (titleEl.textContent || '').trim();

    var ogTitle = '';
    var ogTitleEl = doc.querySelector('meta[property="og:title"]') || doc.querySelector('meta[name="og:title"]');
    if (ogTitleEl) ogTitle = (ogTitleEl.getAttribute('content') || '').trim();

    var ogDesc = '';
    var ogDescEl = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="og:description"]');
    if (ogDescEl) ogDesc = (ogDescEl.getAttribute('content') || '').trim();

    var metaDesc = '';
    var metaDescEl = doc.querySelector('meta[name="description"]');
    if (metaDescEl) metaDesc = (metaDescEl.getAttribute('content') || '').trim();

    var h1Text = '';
    var h1El = doc.querySelector('h1');
    if (h1El) h1Text = (h1El.textContent || '').trim();

    var contentTitle = '';
    var contentTitleEl = doc.querySelector('meta[name="content_title"]') || doc.querySelector('meta[property="content_title"]');
    if (contentTitleEl) contentTitle = (contentTitleEl.getAttribute('content') || '').trim();

    // h1 z wnętrza artykułu — dokładniejszy niż globalny h1 (logo/nawigacja mogą mieć h1)
    var articleH1El = bodyEl ? bodyEl.querySelector('h1') : null;
    var articleH1Text = articleH1El ? (articleH1El.textContent || '').trim() : h1Text;
    var paragraphs = [];
    if (bodyEl) {
      paragraphs = Array.from(bodyEl.querySelectorAll('p'))
        .map(function(p) { return (p.textContent || '').trim(); })
        .filter(function(t) { return t.length > 40; }) // pomijaj krótkie fragmenty (np. podpisy, etykiety)
        .slice(0, 12); // max 12 pierwszych akapitów — lede artykułu, nie ogon
    }

    // h2/h3 podrozdziały — tylko wewnątrz artykułu/main (nie globalne nagłówki nawigacji)
    var subHeadings = [];
    if (bodyEl) {
      subHeadings = Array.from(bodyEl.querySelectorAll('h2,h3'))
        .map(function(h) { return (h.textContent || '').trim(); })
        .filter(function(t) { return t.length > 3 && t.length < 200; });
    }

    // Cytaty blockquote w treści artykułu
    var blockquotes = [];
    if (bodyEl) {
      blockquotes = Array.from(bodyEl.querySelectorAll('blockquote'))
        .map(function(q) { return (q.textContent || '').trim(); })
        .filter(function(t) { return t.length > 10; });
    }

    // Tagi redakcyjne artykułu — bardzo silny sygnał (autor/redakcja oznaczyła temat)
    var articleTagTexts = [];
    if (bodyEl) {
      try {
        bodyEl.querySelectorAll(
          '[rel="tag"],[class*="article-tag"],[class*="entry-tag"],[class*="post-tag"],' +
          '[class*="article__tag"],[class*="tags__item"],[class*="tag-list"] a'
        ).forEach(function(el) {
          var t = (el.textContent || '').trim().toLowerCase();
          if (t.length > 1 && t.length < 60) articleTagTexts.push(t);
        });
      } catch(e) {}
    }

    // Detekcja artykułu — sygnały po usunięciu szumu (bodyEl dostępny)
    var _timeEl = bodyEl ? bodyEl.querySelector('time[datetime]') : null;
    if (_timeEl) _articleSignals.push('time[datetime]');
    if (paragraphs.length >= 5) _articleSignals.push('5+p');
    // Klasyfikacja: 2+ sygnałów = artykuł, 1 = niepewny, 0 = nie-artykuł/katalog
    var _pageType = _articleSignals.length >= 2 ? 'article' :
                    _articleSignals.length === 1 ? 'uncertain' : 'nonArticle';

    // Data — fallback z <time datetime> jeśli nie znaleziono w meta/JSON-LD
    if (!_articleDate && _timeEl) {
      var _td = (_timeEl.getAttribute('datetime') || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(_td)) _articleDate = _td;
    }

    // Paywall — oblicz raz długość tekstu body (używane w kilku sprawdzeniach)
    var _bodyTextLen = bodyEl ? bodyEl.textContent.trim().length : 0;

    // Paywall — silne sygnały CSS: samo istnienie = twarda blokada (nie zależy od ilości tekstu)
    if (!_isPaywall) {
      try {
        if (doc.querySelectorAll(
          '[class*="access-denied"],[class*="subscriber-only"],[class*="premium-only"],' +
          '[class*="locked-content"],[class*="paywalled"],[class*="subscribe-wall"]'
        ).length > 0) _isPaywall = true;
      } catch(e) {}
    }
    // Paywall — słabe sygnały CSS (piano, tinypass, klasa paywall):
    // flaguj TYLKO gdy treści jest mało — jeśli body ma >1200 znaków, treść jest dostępna mimo popupów
    if (!_isPaywall && _bodyTextLen < 1200) {
      try {
        if (doc.querySelectorAll(
          '[class*="paywall"],[id*="paywall"],[class*="piano-"],[class*="tp-container"],[class*="tinypass"]'
        ).length > 0) _isPaywall = true;
      } catch(e) {}
    }
    // Paywall fallback — duży HTML ale bardzo mały tekst body → treść ukryta za blokadą
    if (!_isPaywall && html.length > 80000 && _bodyTextLen < 600) _isPaywall = true;

    // Strefy poboczne — podpisy zdjęć, opisy galerii, adresy/lokalizacje
    // Przeszukiwane po usunięciu szumu; keyword tu punktuje +2 (słabszy sygnał) z oznaczeniem w liście URLi
    var _secZones = [];
    if (bodyEl) {
      var _secSeen = new Set();
      var _addSec = function(el, hint) {
        var t = (el.textContent || '').trim();
        if (t.length < 4 || t.length > 600 || _secSeen.has(t)) return;
        _secSeen.add(t);
        _secZones.push({ text: t, hint: hint });
      };
      bodyEl.querySelectorAll('figcaption').forEach(function(el) { _addSec(el, 'podpis zdjęcia'); });
      try { bodyEl.querySelectorAll('[class*="caption"],[id*="caption"]').forEach(function(el) {
        if (el.matches('figcaption')) return;
        _addSec(el, 'podpis');
      }); } catch(e) {}
      try { bodyEl.querySelectorAll('[class*="address"],[id*="address"],[class*="location"],[id*="location"]').forEach(function(el) {
        _addSec(el, 'adres/lokalizacja');
      }); } catch(e) {}
      try { bodyEl.querySelectorAll(
        '[class*="slide"] [class*="description"],[class*="carousel"] [class*="description"],' +
        '[class*="gallery"] [class*="caption"],[class*="gallery"] [class*="description"]'
      ).forEach(function(el) { _addSec(el, 'opis galerii'); }); } catch(e) {}
    }

    // Pełny tekst body — fallback dla stron katalogowych (firmy.cz itp.) które nie używają <p>
    var _genericText = bodyEl ? (bodyEl.textContent || '') : '';
    var _genericTextLower = _genericText.toLowerCase();

    var score = 0;
    var _bodySnippet = '';      // snippet z body (h1, akapity) — preferowany dla pola Treść
    var _metaSnippet = '';      // snippet z meta/og:description — fallback
    var matchedChips = [];      // chipy które znaleziono na stronie
    var _matchedZoneHints = []; // zone hints dla stref pobocznych (podpis, adres itp.)
    var _secondaryChips = [];   // chipy dopasowane wyłącznie w strefach pobocznych

    chips.forEach(function(chip) {
      var kw = chip.toLowerCase();
      var chipMatched = false;

      // Strefa tytułu — najsilniejszy sygnał (tylko score, tytuł idzie do osobnego pola)
      var inTitle = titleText.toLowerCase().indexOf(kw) !== -1 || ogTitle.toLowerCase().indexOf(kw) !== -1;
      if (inTitle) {
        score += 8;
        chipMatched = true;
      }

      // Strefa opisu meta
      var inMeta = ogDesc.toLowerCase().indexOf(kw) !== -1 || metaDesc.toLowerCase().indexOf(kw) !== -1;
      if (inMeta) {
        score += 5;
        chipMatched = true;
        if (!_metaSnippet) _metaSnippet = (ogDesc || metaDesc).slice(0, 500);
      }

      // Strefa nagłówka h1
      if (h1Text.toLowerCase().indexOf(kw) !== -1) {
        score += 5;
        chipMatched = true;
        // h1 liczy do scoringu, ale nie do snippetu — tytuł nie trafia do pola Treść
      }

      // Strefa nagłówków h2/h3 — podrozdziały artykułu (po usunięciu szumu i teaserów, tylko bodyEl)
      var h2h3Match = false;
      for (var _hi = 0; _hi < subHeadings.length; _hi++) {
        if (subHeadings[_hi].toLowerCase().indexOf(kw) !== -1) { h2h3Match = true; break; }
      }
      if (h2h3Match) { score += 3; chipMatched = true; }

      // Strefa akapitów — rozróżniamy pierwszy akapit (lede) od reszty
      var firstPMatch = false;
      var extraPMatches = 0;
      paragraphs.forEach(function(p, idx) {
        if (p.toLowerCase().indexOf(kw) !== -1) {
          if (idx === 0) { firstPMatch = true; }
          else { extraPMatches++; }
          chipMatched = true;
          if (!_bodySnippet) {
            if (p.length <= 600) {
              _bodySnippet = p;
            } else {
              // Akapit zbyt długi — wytnij 3 zdania wokół słowa kluczowego
              var _sents = p.replace(/([.!?])\s+/g, '$1\x00').split('\x00').filter(Boolean);
              var _kwI = -1;
              for (var _si = 0; _si < _sents.length; _si++) {
                if (_sents[_si].toLowerCase().indexOf(kw) !== -1) { _kwI = _si; break; }
              }
              _bodySnippet = _kwI >= 0
                ? _sents.slice(Math.max(0, _kwI - 1), Math.min(_sents.length, _kwI + 2)).join(' ').trim()
                : p.slice(0, 500);
            }
          }
        }
      });
      if (firstPMatch) score += 4;
      if (extraPMatches > 0) score += Math.min(extraPMatches, 3); // maks. +3 za wielokrotne wzmianki w treści

      // Strefa blockquote — cytaty w treści artykułu
      var inBlockquote = blockquotes.some(function(q) { return q.toLowerCase().indexOf(kw) !== -1; });
      if (inBlockquote) { score += 2; chipMatched = true; }

      // Tagi redakcyjne artykułu — bardzo silny sygnał (autor/redakcja oznaczyła temat tagem)
      var inArticleTags = articleTagTexts.some(function(t) { return t.indexOf(kw) !== -1; });
      if (inArticleTags) { score += 4; chipMatched = true; }

      // Strefy poboczne — tylko jeśli chip nie trafił w żadną strefę główną
      if (!chipMatched && _secZones.length > 0) {
        for (var _szi = 0; _szi < _secZones.length; _szi++) {
          if (_secZones[_szi].text.toLowerCase().indexOf(kw) !== -1) {
            score += 2;
            chipMatched = true;
            if (!_bodySnippet) _bodySnippet = _secZones[_szi].text.slice(0, 200);
            if (_matchedZoneHints.indexOf(_secZones[_szi].hint) === -1) _matchedZoneHints.push(_secZones[_szi].hint);
            _secondaryChips.push(chip);
            break;
          }
        }
      }

      // Fallback: pełny tekst body — łapie keyword w <div>, <li>, <dd> itp. (strony katalogowe)
      if (!chipMatched && _genericTextLower.indexOf(kw) !== -1) {
        score += 1;
        chipMatched = true;
        if (!_bodySnippet) {
          var _gIdx = _genericTextLower.indexOf(kw);
          _bodySnippet = _genericText.slice(Math.max(0, _gIdx - 80), _gIdx + 150).trim();
        }
      }

      if (chipMatched) matchedChips.push(chip);
    });

    // snippet dla pola Treść: preferuj body (akapity/h1) nad meta — nigdy tytuł
    var snippet = _bodySnippet || _metaSnippet;

    score = Math.min(score, 30); // cap — żeby jeden artykuł pełen keywordów nie zaburzał skali

    var status;
    if (score <= 0)       status = 'nomatch';
    else if (score <= 4)  status = 'mention';
    else if (score <= 11) status = 'contentmatch';
    else                  status = 'keytopic';

    // Teasermatch — keyword tylko w sekcji polecanych artykułów, nie w głównej treści.
    // Sprawdzamy wyłącznie gdy score=0 (główna treść czysta) i są zebrane teasery.
    var _teaserChips = [];
    if (score === 0 && _teaserTexts.length > 0) {
      chips.forEach(function(chip) {
        var kw = chip.toLowerCase();
        for (var _ti = 0; _ti < _teaserTexts.length; _ti++) {
          if (_teaserTexts[_ti].indexOf(kw) !== -1) { _teaserChips.push(chip); break; }
        }
      });
      if (_teaserChips.length > 0) status = 'teasermatch';
    }
    var _teaserMatchOnly = status === 'teasermatch';

    // Tytuł artykułu — h1 z artykułu (widoczny nagłówek) > content_title (custom meta) > og:title > <title>
    var articleTitle = (articleH1Text || contentTitle || ogTitle || titleText).trim();
    // Ogranicz do 200 znaków — <title> może być długi
    if (articleTitle.length > 200) articleTitle = articleTitle.slice(0, 200);

    var secondaryZoneOnly = _secondaryChips.length > 0 && matchedChips.length === _secondaryChips.length;

    // Konteksty tekstowe per chip — do analizy AI (150 znaków wokół każdego trafienia)
    var keywordContexts = {};
    matchedChips.forEach(function(chip) {
      var kw = chip.toLowerCase();
      var ctxs = [];
      paragraphs.forEach(function(p) {
        if (ctxs.length >= 3) return;
        var pidx = p.toLowerCase().indexOf(kw);
        if (pidx !== -1) ctxs.push(p.slice(Math.max(0, pidx - 100), Math.min(p.length, pidx + kw.length + 100)).trim());
      });
      if (ctxs.length === 0) {
        var metaTxt = ogDesc || metaDesc || '';
        var midx = metaTxt.toLowerCase().indexOf(kw);
        if (midx !== -1) ctxs.push(metaTxt.slice(Math.max(0, midx - 100), Math.min(metaTxt.length, midx + kw.length + 100)).trim());
      }
      keywordContexts[chip] = ctxs;
    });

    // Autor — meta[name="author"] > JSON-LD author.name > itemprop=author > byline class
    var _author = '';
    var _authorMeta = doc.querySelector('meta[name="author"]') || doc.querySelector('meta[property="author"]');
    if (_authorMeta) _author = (_authorMeta.getAttribute('content') || '').trim();
    if (!_author) {
      doc.querySelectorAll('script[type="application/ld+json"]').forEach(function(el) {
        if (_author) return;
        try {
          var _ld = JSON.parse(el.textContent);
          var _ldArr = Array.isArray(_ld) ? _ld : [_ld];
          _ldArr.forEach(function(item) {
            if (_author) return;
            var _a = item.author;
            if (!_a) return;
            if (typeof _a === 'string') _author = _a;
            else if (Array.isArray(_a) && _a[0]) _author = _a[0].name || _a[0];
            else if (_a.name) _author = _a.name;
          });
        } catch(e) {}
      });
    }
    if (!_author) {
      try {
        var _bylineEl = doc.querySelector('[itemprop="author"]') ||
          doc.querySelector('[class*="author__name"],[class*="byline__name"],[class*="article-author"],[class*="post-author"],[rel="author"]');
        if (_bylineEl) _author = (_bylineEl.textContent || '').trim().slice(0, 80);
      } catch(e) {}
    }

    // Liczba słów w treści artykułu
    var _wordCount = 0;
    if (bodyEl) {
      var _bodyText = (bodyEl.textContent || '').trim();
      _wordCount = _bodyText ? _bodyText.split(/\s+/).filter(Boolean).length : 0;
    }

    return {
      status:            status,
      score:             score,
      snippet:           snippet,
      title:             articleTitle,
      matchedChips:      matchedChips,
      keywordContexts:   keywordContexts,
      secondaryZoneOnly: secondaryZoneOnly,
      zoneHints:         _matchedZoneHints,
      teaserMatchOnly:   _teaserMatchOnly,
      teaserChips:       _teaserChips,
      pageType:          _pageType,
      pageTypeSignals:   _articleSignals,
      pageLang:          _pageLang,
      articleDate:       _articleDate,
      isPaywall:         _isPaywall,
      author:            _author,
      wordCount:         _wordCount,
    };
  }

  // ── NEWS ANALYTICS ──

  function _naIsPositive(s) {
    return s === 'keytopic' || s === 'contentmatch' || s === 'mention' || s === 'match';
  }

  function _naTagOutcome(entry, outcome) {
    if (entry) entry.naOutcome = outcome;
  }

  function _naNewSession(country) {
    if (lsGet(LS.NA_CONSENT) !== '1') return;
    if (newsState.sessionId) {
      var prevAgg = _naAggSession();
      var stats = lsGet(LS.NA_SESSION_STATS, []);
      stats.push(prevAgg);
      lsSet(LS.NA_SESSION_STATS, stats);
    }
    newsState.sessionId = 'ses_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    newsState.naSessionStart = Date.now();
    if (newsState.naVisChangeHandler) {
      document.removeEventListener('visibilitychange', newsState.naVisChangeHandler);
    }
    newsState.naVisChangeHandler = function() {
      if (document.visibilityState === 'hidden' && newsState.sessionId) {
        _naPushSession(_naBuildSessionData(), null);
        // Nie finalizujemy sesji — zmiana zakładki nie kończy pracy
      }
    };
    document.addEventListener('visibilitychange', newsState.naVisChangeHandler);
    if (newsState.naFlushInterval) clearInterval(newsState.naFlushInterval);
    newsState.naFlushInterval = setInterval(_naTryPeriodicPush, 5 * 60 * 1000);
  }

  function _naFinalizeSession() {
    if (!newsState.sessionId) return;
    if (newsState.naFlushInterval) { clearInterval(newsState.naFlushInterval); newsState.naFlushInterval = null; }
    if (newsState.naVisChangeHandler) {
      document.removeEventListener('visibilitychange', newsState.naVisChangeHandler);
      newsState.naVisChangeHandler = null;
    }
    newsState.sessionId = null;
  }

  function _naShowConsentIfNeeded() {
    var consent = lsGet(LS.NA_CONSENT);
    if (consent === '1' || consent === '0') return;
    var dark = typeof _newsIsDark === 'function' ? _newsIsDark() : true;
    var bg          = dark ? '#1e1e2e' : '#ffffff';
    var colorText   = dark ? '#e2e8f0' : '#1e293b';
    var colorMuted  = dark ? '#94a3b8' : '#64748b';
    var colorBorder = dark ? '#334155' : '#e2e8f0';
    var pop = document.createElement('div');
    pop.id = 'b24t-na-consent';
    pop.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;';
    pop.innerHTML =
      '<div style="background:' + bg + ';border:1px solid ' + colorBorder + ';border-radius:16px;padding:24px 28px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">' +
        '<div style="font-size:15px;font-weight:700;color:' + colorText + ';margin-bottom:12px;">📊 Analityka skanowania News</div>' +
        '<div style="font-size:12px;color:' + colorMuted + ';line-height:1.6;margin-bottom:8px;">Wtyczka zbiera anonimowe dane statystyczne z modułu News:</div>' +
        '<ul style="font-size:12px;color:' + colorMuted + ';line-height:1.8;margin:0 0 12px 0;padding-left:18px;">' +
          '<li>Wyniki skanowania (statusy, score, typ strony, język)</li>' +
          '<li>Decyzja annotatora (dodano / pominięto)</li>' +
          '<li>Ocena AI (jeśli włączona)</li>' +
        '</ul>' +
        '<div style="font-size:11px;color:' + colorMuted + ';margin-bottom:20px;">Dane <strong style="color:' + colorText + ';">NIE</strong> zawierają adresów URL ani żadnych treści artykułów. Są zapisywane na firmowym GitHub i służą poprawie trafności skanera.</div>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="b24t-na-consent-yes" style="flex:1;padding:9px;border-radius:9px;border:none;background:linear-gradient(135deg,#14b8a6,#6366f1);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">Rozumiem, kontynuuj</button>' +
          '<button id="b24t-na-consent-no" style="padding:9px 14px;border-radius:9px;border:1px solid ' + colorBorder + ';background:transparent;color:' + colorMuted + ';font-size:12px;cursor:pointer;">Wyłącz</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(pop);
    document.getElementById('b24t-na-consent-yes').addEventListener('click', function() {
      lsSet(LS.NA_CONSENT, '1');
      pop.remove();
    });
    document.getElementById('b24t-na-consent-no').addEventListener('click', function() {
      lsSet(LS.NA_CONSENT, '0');
      pop.remove();
    });
  }

  function _naGetSettings() {
    return lsGet(LS.NA_SETTINGS, { enabled: false, pat: '', repo: 'i24dev/i24_analytics', lastPush: null });
  }

  function _naSaveSettings(s) {
    lsSet(LS.NA_SETTINGS, s);
  }

  function _naAggSession() {
    var scanner = {
      keytopic:     { added: 0, skipped: 0 },
      contentmatch: { added: 0, skipped: 0 },
      mention:      { added: 0, skipped: 0 },
      match:        { added: 0, skipped: 0 },
    };
    var manual_add = 0, blocked = 0;
    var ai = { tp: 0, fp: 0, fn: 0, tn: 0, errors: 0, ran: 0 };
    (newsState.urls || []).forEach(function(e) {
      var outcome = e.naOutcome;
      if (e.status === 'blocked' || e.status === 'error') { blocked++; return; }
      if (!_naIsPositive(e.status)) {
        if (outcome === 'added' || outcome === 'manual_add') manual_add++;
        return;
      }
      if (!outcome) return;
      var bucket = scanner[e.status];
      if (bucket) {
        if (outcome === 'added') bucket.added++;
        else                     bucket.skipped++;
      }
      if (e.aiStatus === 'done') {
        ai.ran++;
        var rel = !!e.aiRelevant, add = outcome === 'added';
        if (rel && add)  ai.tp++;
        else if (rel)    ai.fp++;
        else if (add)    ai.fn++;
        else             ai.tn++;
      } else if (e.aiStatus === 'error') {
        ai.errors++; ai.ran++;
      }
    });
    return {
      date:       _localDateStr(new Date()),
      country:    newsState.detectedCountry || _newsProjectCountry() || '',
      projectId:  String(state.projectId || ''),
      sessionId:  newsState.sessionId || ('ses_' + Date.now().toString(36)),
      duration_s: newsState.naSessionStart ? Math.round((Date.now() - newsState.naSessionStart) / 1000) : 0,
      aiEnabled:  _newsAiShouldRun(),
      scanner:    scanner,
      manual_add: manual_add,
      blocked:    blocked,
      ai:         ai,
    };
  }

  function _naBuildSessionData() {
    return { session: _naAggSession() };
  }

  function _naAddPending(sessionData) {
    var sid = sessionData.session && sessionData.session.sessionId;
    var pending = lsGet(LS.NA_PENDING, []);
    if (!pending.some(function(p) { return p.sessionId === sid; })) {
      pending.push({ sessionId: sid, sessionData: sessionData });
      lsSet(LS.NA_PENDING, pending);
    }
  }

  function _naPushSession(sessionData, onDone) {
    var ns = _naGetSettings();
    if (!ns.enabled || !ns.pat || lsGet(LS.NA_CONSENT) !== '1') {
      if (onDone) onDone('skip');
      return;
    }
    var repo    = ns.repo || 'i24dev/i24_analytics';
    var country = (sessionData.session && sessionData.session.country) || 'XX';
    var date    = (sessionData.session && sessionData.session.date) || _localDateStr(new Date());
    var path    = 'Tagger/statistics/' + date + '_' + country + '.json';
    var apiUrl  = 'https://api.github.com/repos/' + repo + '/contents/' + path;
    var auth    = 'token ' + ns.pat;
    GM_xmlhttpRequest({
      method: 'GET',
      url: apiUrl,
      headers: { 'Authorization': auth, 'Accept': 'application/vnd.github+json' },
      onload: function(getR) {
        var sha = null;
        var existingSessions = [];
        if (getR.status === 200) {
          try {
            var j = JSON.parse(getR.responseText);
            sha = j.sha;
            var dec = JSON.parse(atob(j.content.replace(/\n/g, '')));
            existingSessions = dec.sessions || [];
          } catch(e) { /* use empty */ }
        } else if (getR.status !== 404) {
          _naAddPending(sessionData); if (onDone) onDone('error'); return;
        }
        var merged = { sessions: existingSessions.concat([sessionData.session]) };
        var putBodyObj = {
          message: 'analytics: ' + date + '_' + country,
          content: btoa(unescape(encodeURIComponent(JSON.stringify(merged)))),
        };
        if (sha) putBodyObj.sha = sha;
        GM_xmlhttpRequest({
          method: 'PUT',
          url: apiUrl,
          headers: { 'Authorization': auth, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          data: JSON.stringify(putBodyObj),
          onload: function(putR) {
            if (putR.status === 200 || putR.status === 201) {
              var upd = _naGetSettings(); upd.lastPush = Date.now(); _naSaveSettings(upd);
              if (onDone) onDone('ok');
            } else {
              _naAddPending(sessionData); if (onDone) onDone('error');
            }
          },
          onerror: function() { _naAddPending(sessionData); if (onDone) onDone('error'); },
        });
      },
      onerror: function() { _naAddPending(sessionData); if (onDone) onDone('error'); },
    });
  }

  function _naRetryPending() {
    if (lsGet(LS.NA_CONSENT) !== '1') return;
    var pending = lsGet(LS.NA_PENDING, []);
    if (!pending.length) return;
    lsSet(LS.NA_PENDING, []);
    function retryNext(items, idx) {
      if (idx >= items.length) return;
      var item = items[idx];
      _naPushSession(item.sessionData, function(result) {
        if (result !== 'ok') {
          var curr = lsGet(LS.NA_PENDING, []);
          if (!curr.some(function(p) { return p.sessionId === item.sessionId; })) {
            curr.push(item);
            lsSet(LS.NA_PENDING, curr);
          }
        }
        retryNext(items, idx + 1);
      });
    }
    retryNext(pending, 0);
  }

  function _naTryPeriodicPush() {
    if (!newsState.sessionId) return;
    var agg = _naAggSession();
    var hasData = ['keytopic','contentmatch','mention','match'].some(function(st) {
      return agg.scanner[st].added > 0 || agg.scanner[st].skipped > 0;
    });
    if (!hasData) return;
    agg.partial = true;
    _naPushSession({ session: agg }, null);
  }

  function _naTestPush(pat, repo, onDone) {
    if (!pat) { if (onDone) onDone('nopat'); return; }
    repo = repo || 'i24dev/i24_analytics';
    var path   = 'Tagger/statistics/_test_push.json';
    var apiUrl = 'https://api.github.com/repos/' + repo + '/contents/' + path;
    var auth   = 'token ' + pat;
    var today = _localDateStr(new Date());
    var country = newsState.detectedCountry || _newsProjectCountry() || 'PL';
    var projId  = String(state.projectId || '0');
    var payload = {
      _test: true,
      _generated: new Date().toISOString(),
      _version: VERSION,
      sessions: [
        {
          date: today, country: country, projectId: projId,
          sessionId: 'test_ses_example', duration_s: 720, aiEnabled: true,
          scanner: {
            keytopic:     { added: 5, skipped: 2 },
            contentmatch: { added: 3, skipped: 1 },
            mention:      { added: 1, skipped: 3 },
            match:        { added: 0, skipped: 2 },
          },
          manual_add: 1, blocked: 4,
          ai: { tp: 4, fp: 1, fn: 1, tn: 3, errors: 1, ran: 10 },
        },
      ],
    };
    GM_xmlhttpRequest({
      method: 'GET',
      url: apiUrl,
      headers: { 'Authorization': auth, 'Accept': 'application/vnd.github+json' },
      onload: function(getR) {
        var sha = null;
        if (getR.status === 200) {
          try { sha = JSON.parse(getR.responseText).sha; } catch(e) {}
        } else if (getR.status !== 404) {
          if (onDone) onDone('error', getR.status); return;
        }
        var putBody = {
          message: 'analytics: test push ' + _localDateStr(new Date()),
          content: btoa(JSON.stringify(payload, null, 2)),
        };
        if (sha) putBody.sha = sha;
        GM_xmlhttpRequest({
          method: 'PUT',
          url: apiUrl,
          headers: { 'Authorization': auth, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          data: JSON.stringify(putBody),
          onload: function(putR) {
            if (putR.status === 200 || putR.status === 201) {
              if (onDone) onDone('ok', repo, path);
            } else {
              if (onDone) onDone('error', putR.status);
            }
          },
          onerror: function() { if (onDone) onDone('error', 0); },
        });
      },
      onerror: function() { if (onDone) onDone('error', 0); },
    });
  }

  function _naCompute(filters) {
    var f = filters || {};
    var allSessions = lsGet(LS.NA_SESSION_STATS, []);
    var pending = lsGet(LS.NA_PENDING, []);
    pending.forEach(function(item) {
      if (item.sessionData && item.sessionData.session) allSessions.push(item.sessionData.session);
    });
    if (newsState.sessionId) allSessions.push(_naAggSession());

    function passFilter(s) {
      if (f.dateFrom  && s.date      < f.dateFrom)            return false;
      if (f.dateTo    && s.date      > f.dateTo)              return false;
      if (f.country   && s.country   !== f.country)           return false;
      if (f.projectId && s.projectId !== String(f.projectId)) return false;
      return true;
    }
    var sessions = allSessions.filter(passFilter);

    var scanTotals = { keytopic:{tp:0,fp:0}, contentmatch:{tp:0,fp:0}, mention:{tp:0,fp:0}, match:{tp:0,fp:0} };
    var aiT = { tp:0, fp:0, fn:0, tn:0, errors:0, ran:0 };
    var manualAdd = 0, totalDur = 0, aiEnabled = 0;
    sessions.forEach(function(s) {
      ['keytopic','contentmatch','mention','match'].forEach(function(st) {
        if (s.scanner && s.scanner[st]) {
          scanTotals[st].tp += s.scanner[st].added   || 0;
          scanTotals[st].fp += s.scanner[st].skipped || 0;
        }
      });
      manualAdd  += s.manual_add || 0;
      totalDur   += s.duration_s || 0;
      if (s.aiEnabled) aiEnabled++;
      if (s.ai) {
        aiT.tp     += s.ai.tp     || 0;
        aiT.fp     += s.ai.fp     || 0;
        aiT.fn     += s.ai.fn     || 0;
        aiT.tn     += s.ai.tn     || 0;
        aiT.errors += s.ai.errors || 0;
        aiT.ran    += s.ai.ran    || 0;
      }
    });

    function mkCM(tp, fp) { return { tp: tp, fp: fp, precision: (tp+fp) > 0 ? tp/(tp+fp) : null }; }
    var byStatus = {};
    ['keytopic','contentmatch','mention','match'].forEach(function(st) {
      byStatus[st] = mkCM(scanTotals[st].tp, scanTotals[st].fp);
    });
    var allTp = 0, allFp = 0;
    ['keytopic','contentmatch','mention','match'].forEach(function(st) { allTp += scanTotals[st].tp; allFp += scanTotals[st].fp; });

    var sessN = sessions.length;
    var dates = sessions.map(function(s) { return s.date; }).filter(Boolean).sort();
    var countries = [], projects = [];
    sessions.forEach(function(s) {
      if (s.country   && countries.indexOf(s.country)   < 0) countries.push(s.country);
      if (s.projectId && projects.indexOf(s.projectId)  < 0) projects.push(s.projectId);
    });

    return {
      scanner: {
        tp: allTp, fp: allFp, precision: (allTp+allFp) > 0 ? allTp/(allTp+allFp) : null,
        byStatus: byStatus,
        manualAddCount: manualAdd,
      },
      ai: {
        tp: aiT.tp, fp: aiT.fp, fn: aiT.fn, tn: aiT.tn,
        precision:    (aiT.tp+aiT.fp) > 0 ? aiT.tp/(aiT.tp+aiT.fp) : null,
        recall:       (aiT.tp+aiT.fn) > 0 ? aiT.tp/(aiT.tp+aiT.fn) : null,
        accuracy:     (aiT.tp+aiT.fp+aiT.fn+aiT.tn) > 0 ? (aiT.tp+aiT.tn)/(aiT.tp+aiT.fp+aiT.fn+aiT.tn) : null,
        overrideRate: (aiT.fn+aiT.tn) > 0 ? aiT.fn/(aiT.fn+aiT.tn) : null,
        errorRate:    aiT.ran > 0 ? aiT.errors/aiT.ran : null,
      },
      sessions: {
        total:         sessN,
        totalAdded:    allTp + manualAdd,
        totalBlocked:  sessions.reduce(function(a,s) { return a + (s.blocked || 0); }, 0),
        avgDuration_s: sessN > 0 ? Math.round(totalDur/sessN) : 0,
        aiEnabledRate: sessN > 0 ? aiEnabled/sessN : null,
      },
      meta: {
        dateRange: dates.length ? { from: dates[0], to: dates[dates.length-1] } : null,
        countries: countries,
        projects:  projects,
      },
    };
  }

  function _naStatCard(label, value, sub, t, tip) {
    return '<div style="flex:1;min-width:100px;padding:10px 14px;border-radius:9px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';"' + (tip ? ' title="' + tip + '"' : '') + '>' +
      '<div style="font-size:9px;font-weight:700;color:' + t.textMuted + ';letter-spacing:0.06em;margin-bottom:4px;">' + label.toUpperCase() + '</div>' +
      '<div style="font-size:20px;font-weight:700;color:' + t.text + ';line-height:1.2;">' + value + '</div>' +
      '<div style="font-size:9px;color:' + t.textFaint + ';margin-top:2px;">' + sub + '</div>' +
    '</div>';
  }

  function _naRenderStats(container, filters) {
    var t = _newsThemeVars();
    var data = _naCompute(filters || {});
    var sc = data.scanner;
    var ai = data.ai;
    var sess = data.sessions;
    var meta = data.meta;

    function pct(v) { return v === null ? '—' : Math.round(v * 100) + '%'; }
    function precBar(v, color) {
      var w = v === null ? 0 : Math.round(v * 100);
      return '<div style="height:5px;border-radius:3px;background:' + t.bgDeep + ';overflow:hidden;flex:1;min-width:60px;">' +
        '<div style="height:5px;width:' + w + '%;background:' + (color || 'var(--b24t-primary)') + ';border-radius:3px;transition:width 0.3s;"></div>' +
      '</div>';
    }
    function statusColor(st) {
      return st === 'keytopic' ? '#22c55e' : st === 'contentmatch' ? '#818cf8' : st === 'mention' ? '#fb923c' : '#6b7280';
    }
    function statusLabel(st) {
      return st === 'keytopic' ? 'Główny temat' : st === 'contentmatch' ? 'W treści' : st === 'mention' ? 'Wzmianka' : 'URL match';
    }

    if (sess.total === 0 && !newsState.sessionId) {
      container.innerHTML = '<div style="padding:40px;text-align:center;">' +
        '<div style="font-size:32px;margin-bottom:10px;">📊</div>' +
        '<div style="font-size:13px;font-weight:600;color:' + t.text + ';margin-bottom:6px;">Brak danych</div>' +
        '<div style="font-size:11px;color:' + t.textFaint + ';line-height:1.8;">Przeskanuj URLe i dodaj wzmianki, żeby zbierać metryki.<br>Upewnij się że Analityka jest włączona w <strong>⚙ Ustawieniach</strong>.</div>' +
      '</div>';
      return;
    }

    var statusRows = ['keytopic', 'contentmatch', 'mention', 'match'].map(function(st) {
      var cm = sc.byStatus[st];
      var total = cm.tp + cm.fp;
      return '<tr style="border-top:1px solid ' + t.borderSub + ';">' +
        '<td style="padding:6px 8px;">' +
          '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + statusColor(st) + ';margin-right:6px;vertical-align:middle;"></span>' +
          '<span style="font-size:11px;font-weight:600;color:' + t.text + ';">' + statusLabel(st) + '</span>' +
        '</td>' +
        '<td style="padding:6px 8px;text-align:center;font-size:11px;font-weight:600;color:#22c55e;">' + cm.tp + '</td>' +
        '<td style="padding:6px 8px;text-align:center;font-size:11px;font-weight:600;color:#ef4444;">' + cm.fp + '</td>' +
        '<td style="padding:6px 8px;width:120px;">' + (total > 0 ? precBar(cm.precision, statusColor(st)) : '') + '</td>' +
        '<td style="padding:6px 12px 6px 4px;text-align:right;font-size:12px;font-weight:700;color:' + t.text + ';">' + pct(cm.precision) + '</td>' +
      '</tr>';
    }).join('');

    var aiTotal = ai.tp + ai.fp + ai.tn + ai.fn;
    var hasAi = aiTotal > 0;
    var sec = 'margin-bottom:16px;';
    var hd  = 'font-size:10px;font-weight:700;color:' + t.textMuted + ';letter-spacing:0.06em;margin-bottom:6px;';

    container.innerHTML = [
      '<div style="' + sec + 'display:flex;gap:8px;flex-wrap:wrap;">',
        _naStatCard('Precision skanera', pct(sc.precision), 'n=' + (sc.tp + sc.fp), t),
        _naStatCard('Dodane', String(sc.tp + sc.manualAddCount), 'w tym ' + sc.manualAddCount + ' manual_add', t),
        _naStatCard('Sesje', String(sess.total), 'śr. ' + Math.round(sess.avgDuration_s / 60) + ' min', t),
        meta.dateRange ? _naStatCard('Zakres', meta.dateRange.from, '– ' + meta.dateRange.to, t) : '',
      '</div>',

      '<div style="' + sec + '">',
        '<div style="' + hd + '">SKANER — precision per status</div>',
        '<div style="border:1px solid ' + t.borderSub + ';border-radius:8px;overflow:hidden;">',
        '<table style="width:100%;border-collapse:collapse;">',
          '<thead><tr style="background:' + t.bgDeep + ';">',
            '<th style="text-align:left;font-size:9px;font-weight:700;color:' + t.textFaint + ';padding:5px 8px;letter-spacing:0.06em;">STATUS</th>',
            '<th style="text-align:center;font-size:9px;font-weight:700;color:#22c55e;padding:5px 8px;">TP</th>',
            '<th style="text-align:center;font-size:9px;font-weight:700;color:#ef4444;padding:5px 8px;">FP</th>',
            '<th style="padding:5px 8px;"></th>',
            '<th style="text-align:right;font-size:9px;font-weight:700;color:' + t.textFaint + ';padding:5px 12px;">PRECISION</th>',
          '</tr></thead>',
          '<tbody>' + statusRows + '</tbody>',
        '</table>',
        '</div>',
      '</div>',

      hasAi ? [
        '<div style="' + sec + '">',
          '<div style="' + hd + '">AI — confusion matrix (n=' + aiTotal + ')</div>',
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">',
            _naStatCard('Precision AI', pct(ai.precision), 'TP=' + ai.tp + ' FP=' + ai.fp, t),
            _naStatCard('Recall AI', pct(ai.recall), 'TP=' + ai.tp + ' FN=' + ai.fn, t),
            _naStatCard('Accuracy AI', pct(ai.accuracy), 'n=' + aiTotal, t),
          '</div>',
          '<div style="font-size:10px;color:' + t.textMuted + ';line-height:1.8;">' +
            'Override AI=false: <strong style="color:' + t.text + ';">' + ai.fn + '</strong> (' + pct(ai.overrideRate) + ')' +
            ' &nbsp;·&nbsp; Błędy AI: <strong style="color:' + t.text + ';">' + pct(ai.errorRate) + '</strong>' +
          '</div>',
        '</div>',
      ].join('') : '<div style="' + sec + 'font-size:10px;color:' + t.textFaint + ';padding:4px 0;">Brak danych AI — AI ocenia wzmianki dopiero po zakończeniu sesji.</div>',

      sess.total > 0 ? [
        '<div style="' + sec + '">',
          '<div style="' + hd + '">SESJE</div>',
          '<div style="font-size:11px;color:' + t.textMuted + ';line-height:1.9;padding:8px 12px;border-radius:8px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';">' +
            'Dodane: <strong style="color:#22c55e;">' + sess.totalAdded + '</strong> &nbsp;·&nbsp; ' +
            'Niedostępne: <strong style="color:' + t.text + ';">' + sess.totalBlocked + '</strong><br>' +
            'AI włączone: <strong style="color:' + t.text + ';">' + pct(sess.aiEnabledRate) + '</strong> sesji' +
            (meta.countries.length ? ' &nbsp;·&nbsp; Kraje: <strong style="color:' + t.text + ';">' + meta.countries.join(', ') + '</strong>' : '') +
          '</div>',
        '</div>',
      ].join('') : '',
    ].join('');
  }

  function _naExportCsv(filters) {
    var sessions = lsGet(LS.NA_SESSION_STATS, []);
    var pending = lsGet(LS.NA_PENDING, []);
    pending.forEach(function(item) {
      if (item.sessionData && item.sessionData.session) sessions.push(item.sessionData.session);
    });
    if (newsState.sessionId) sessions.push(_naAggSession());
    var f = filters || {};
    if (f.dateFrom || f.dateTo || f.country || f.projectId) {
      sessions = sessions.filter(function(s) {
        if (f.dateFrom  && s.date      < f.dateFrom)            return false;
        if (f.dateTo    && s.date      > f.dateTo)              return false;
        if (f.country   && s.country   !== f.country)           return false;
        if (f.projectId && s.projectId !== String(f.projectId)) return false;
        return true;
      });
    }
    var headers = ['date','country','projectId','sessionId','duration_s','aiEnabled','partial',
      'sc_keytopic_added','sc_keytopic_skipped','sc_contentmatch_added','sc_contentmatch_skipped',
      'sc_mention_added','sc_mention_skipped','sc_match_added','sc_match_skipped',
      'manual_add','blocked','ai_tp','ai_fp','ai_fn','ai_tn','ai_errors','ai_ran'];
    var rows = sessions.map(function(s) {
      var sc = s.scanner || {};
      var ai = s.ai || {};
      function g(st, k) { return sc[st] ? (sc[st][k] || 0) : 0; }
      return [
        s.date, s.country, s.projectId, s.sessionId, s.duration_s, s.aiEnabled ? '1' : '0', s.partial ? '1' : '0',
        g('keytopic','added'), g('keytopic','skipped'), g('contentmatch','added'), g('contentmatch','skipped'),
        g('mention','added'), g('mention','skipped'), g('match','added'), g('match','skipped'),
        s.manual_add || 0, s.blocked || 0,
        ai.tp || 0, ai.fp || 0, ai.fn || 0, ai.tn || 0, ai.errors || 0, ai.ran || 0,
      ].map(function(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; });
    });
    var csv = [headers].concat(rows).map(function(r) { return r.join(','); }).join('\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'b24t_news_analytics_' + _localDateStr(new Date()) + '.csv';
    a.click(); URL.revokeObjectURL(url);
  }

  function _naExportJson(filters) {
    var data = _naCompute(filters || {});
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'b24t_news_stats_' + _localDateStr(new Date()) + '.json';
    a.click(); URL.revokeObjectURL(url);
  }

  // ── NEWS AI SCORING ──

  function _newsAiGetBrandCtx(projectId) {
    return lsGet('b24t_news_ai_brand_ctx_' + (projectId || 'default'), '');
  }
  function _newsAiSetBrandCtx(projectId, text) {
    lsSet('b24t_news_ai_brand_ctx_' + (projectId || 'default'), text);
  }
  function _newsAiShouldRun() {
    var s = _aiGetSettings();
    if (!s.news || !s.news.enabled) return false;
    if (!s.apiKey) return false;
    return true;
  }
  function _newsAiBuildSystemPrompt() {
    var s = _aiGetSettings();
    if (!s.news || !s.news.activePromptId || !s.prompts) return null;
    var found = null;
    for (var _pi = 0; _pi < s.prompts.length; _pi++) {
      if (s.prompts[_pi].id === s.news.activePromptId) { found = s.prompts[_pi]; break; }
    }
    if (!found || !found.system) return null;
    var projectName = state.projectId ? (_pnResolve(state.projectId) || '') : '';
    var brandCtx = _newsAiGetBrandCtx(state.projectId);
    return found.system
      .replace(/\{PROJECT_NAME\}/g, projectName)
      .replace(/\{BRAND_CONTEXT\}/g, brandCtx);
  }
  function _newsAiAnalyze(entry) {
    if (!_newsAiShouldRun()) return;
    var systemPrompt = _newsAiBuildSystemPrompt();
    if (!systemPrompt) return;
    entry.aiStatus = 'pending';
    entry.aiError = '';
    renderUrlList();
    try {
      var s = _aiGetSettings();
      var model = (s.news && s.news.model) || 'claude-haiku-4-5-20251001';
      var ctxLines = Object.keys(entry.keywordContexts || {}).map(function(chip) {
        return chip + ':\n' + (entry.keywordContexts[chip] || []).join('\n---\n');
      }).join('\n\n');
      var userPrompt = [
        'Title: ' + (entry.title || ''),
        'Snippet: ' + (entry.snippet || ''),
        'Keywords matched: ' + (entry.matchedChips || []).join(', '),
        'Scanner status: ' + entry.status,
        'Secondary zone only: ' + !!entry.secondaryZoneOnly,
        'Teaser match only: ' + !!entry.teaserMatchOnly,
        'Paywall: ' + !!entry.isPaywall,
        ctxLines ? 'Keyword contexts:\n' + ctxLines : '',
      ].filter(Boolean).join('\n');
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': s.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        data: JSON.stringify({
          model: model,
          max_tokens: 120,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: userPrompt }],
        }),
        timeout: 15000,
        onload: function(resp) {
          try {
            if (resp.status === 401) {
              var cfg = _aiGetSettings();
              if (!cfg.news) cfg.news = {};
              cfg.news.enabled = false;
              _aiSaveSettings(cfg);
              entry.aiStatus = 'error';
              entry.aiError = 'błędny klucz API';
              renderUrlList();
              return;
            }
            if (resp.status === 429) {
              entry.aiStatus = 'error';
              entry.aiError = 'limit API (429)';
              renderUrlList();
              return;
            }
            if (resp.status >= 500) {
              entry.aiStatus = 'error';
              entry.aiError = 'błąd serwera (' + resp.status + ')';
              renderUrlList();
              return;
            }
            if (resp.status < 200 || resp.status >= 300) {
              entry.aiStatus = 'error';
              entry.aiError = 'HTTP ' + resp.status;
              renderUrlList();
              return;
            }
            var data = JSON.parse(resp.responseText);
            var text = (data.content && data.content[0] && data.content[0].text) || '';
            var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
            entry.aiStatus = 'done';
            entry.aiRelevant = !!parsed.relevant;
            entry.aiReason = parsed.reason || '';
          } catch(e) {
            entry.aiStatus = 'error';
            entry.aiError = 'błąd parsowania';
          }
          renderUrlList();
        },
        onerror: function() { entry.aiStatus = 'error'; entry.aiError = 'brak połączenia'; renderUrlList(); },
        ontimeout: function() { entry.aiStatus = 'error'; entry.aiError = 'timeout'; renderUrlList(); },
      });
    } catch(e) {
      entry.aiStatus = 'error';
      entry.aiError = 'błąd wywołania';
      renderUrlList();
    }
  }

  // Pobiera stronę przez GM_xmlhttpRequest (pomija CORS) i skanuje jej treść.
  // Dla URL-i które już mają status 'match' nie wywołuj tej funkcji — jest zbędna.
  // Timeout jest adaptacyjny: rośnie na podstawie historii udanych skanów (p90 * 2, min 8s, max 40s).
  // Przy pierwszym timeout: jeden retry z 2× timeout. onerror → blocked bez retry (prawdziwy block).
  function _newsContentScan(url, chips) {
    return new Promise(function(resolve) {
      var resolved = false;
      var _scanStart = Date.now();

      function _done(result, _success) {
        if (!resolved) {
          resolved = true;
          if (_success) _recordScanTiming(Date.now() - _scanStart);
          resolve(result);
        }
      }

      function _attempt(timeoutMs, isRetry) {
        // Zewnętrzny timer — ochrona gdyby GM_xmlhttpRequest nie wywołał żadnego callbacku
        var timer = setTimeout(function() {
          _done({ status: 'blocked', blockReason: 'timeout', score: 0, snippet: '' });
        }, timeoutMs + 500);

        try {
          GM_xmlhttpRequest({
            method:  'GET',
            url:     url,
            headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
            timeout: timeoutMs,
            onload: function(resp) {
              clearTimeout(timer);
              try {
                if (resp.status < 200 || resp.status >= 400) {
                  _done({ status: 'blocked', blockReason: 'http', httpStatus: resp.status, score: 0, snippet: '' });
                  return;
                }
                // Odrzuć non-HTML (PDFy, obrazy, feed XML itp.)
                var ct = (resp.responseHeaders || '').toLowerCase();
                var isHtml = ct.indexOf('content-type: text/html') !== -1 ||
                             ct.indexOf('content-type: application/xhtml') !== -1;
                // Fallback: jeśli brak nagłówka content-type, sprawdź czy odpowiedź zaczyna się od '<'
                if (!isHtml && (resp.responseText || '').trimStart().charAt(0) !== '<') {
                  _done({ status: 'nomatch', score: 0, snippet: '' });
                  return;
                }
                // Iframeable — X-Frame-Options lub CSP frame-ancestors
                var _rh = ct; // już lowercase
                var _iframeable = true;
                var _xfoM = _rh.match(/x-frame-options:\s*([a-z\-]+)/);
                if (_xfoM && (_xfoM[1] === 'deny' || _xfoM[1] === 'sameorigin')) _iframeable = false;
                if (_iframeable) {
                  var _cspIdx = _rh.indexOf('content-security-policy:');
                  if (_cspIdx !== -1) {
                    var _cspEnd = _rh.indexOf('\n', _cspIdx);
                    var _cspLine = _cspEnd !== -1 ? _rh.slice(_cspIdx, _cspEnd) : _rh.slice(_cspIdx);
                    var _faIdx = _cspLine.indexOf('frame-ancestors');
                    if (_faIdx !== -1) {
                      var _faVal = _cspLine.slice(_faIdx + 15).replace(/^\s+/, '').split(';')[0];
                      if (_faVal.indexOf('*') === -1) _iframeable = false;
                    }
                  }
                }
                var _sr = _newsParseContent(resp.responseText, chips);
                _sr.iframeable = _iframeable;
                _done(_sr, true);
              } catch(e) {
                _done({ status: 'blocked', blockReason: 'exception', score: 0, snippet: '' });
              }
            },
            onerror: function() {
              clearTimeout(timer);
              _done({ status: 'blocked', blockReason: 'error', score: 0, snippet: '' });
            },
            ontimeout: function() {
              clearTimeout(timer);
              if (!isRetry) {
                _attempt(Math.min(timeoutMs * 2, 40000), true);
              } else {
                _done({ status: 'blocked', blockReason: 'timeout', score: 0, snippet: '' });
              }
            },
          });
        } catch(e) {
          clearTimeout(timer);
          _done({ status: 'blocked', blockReason: 'exception', score: 0, snippet: '' });
        }
      }

      _attempt(_getAdaptiveScanTimeout(), false);
    });
  }

  // ── NEWS URL OPENER (sized window) ──
  var NEWS_WIN_SIZES = {
    '900x700':  { w: 900,  h: 700  },
    '1100x800': { w: 1100, h: 800  },
    '800x600':  { w: 800,  h: 600  },
    'half':     { w: null, h: null }, // dynamic — half screen
  };
  function _newsOpenUrl(url) {
    var sizeKey = lsGet(LS.NEWS_WIN_SIZE, '900x700');
    var sz = NEWS_WIN_SIZES[sizeKey] || NEWS_WIN_SIZES['900x700'];
    var w = sz.w || Math.round(window.screen.availWidth / 2);
    var h = sz.h || Math.round(window.screen.availHeight * 0.85);
    // Position: top-left corner of screen so Brand24 (usually right side) stays visible
    var left = 0;
    var top  = Math.round((window.screen.availHeight - h) / 2);
    var features = 'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
                   ',resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=yes,status=no';
    // Reuse existing window — open with features only on first call, then just navigate
    var existingWin = window._b24tnewsWin;
    if (existingWin && !existingWin.closed) {
      existingWin.location.href = url;
      existingWin.focus();
    } else {
      window._b24tnewsWin = window.open(url, '_b24tnews', features);
    }
  }

  // ── CSRF TOKEN RESOLUTION ──
  function _newsGetTknB24(cb) {
    // 1. state.tknB24 — captured earlier in this session
    if (state.tknB24) { cb(state.tknB24, null); return; }
    // 2. Live DOM (only present on /searches/add-new-mention/ page itself)
    var el = document.querySelector('[name="tknB24"]');
    if (el && el.value) { state.tknB24 = el.value; cb(el.value, null); return; }
    // 3. GM fetch /searches/add-new-mention/?sid=ID — Django page that always has tknB24 hidden input
    var sid = state.projectId || '';
    if (!sid) { cb(null, '\u26a0 Brak ID projektu. Przejd\u017a na stron\u0119 projektu Brand24.'); return; }
    var _b24base = window.location.hostname.indexOf('brand24.pl') !== -1 ? 'https://panel.brand24.pl' : 'https://app.brand24.com';
    var fetchUrl = _b24base + '/searches/add-new-mention/?sid=' + sid;
    GM_xmlhttpRequest({
      method: 'GET',
      url: fetchUrl,
      onload: function(resp) {
        // Token is a 32-char hex in: <input type="hidden" name="tknB24" id="tknB24" value="XXXXXXXX...">
        var m = (resp.responseText || '').match(/name="tknB24"[^>]*value="([a-f0-9]{32})"/);
        if (!m) m = (resp.responseText || '').match(/value="([a-f0-9]{32})"[^>]*name="tknB24"/);
        if (m && m[1]) { state.tknB24 = m[1]; cb(m[1], null); return; }
        cb(null, '\u26a0 Nie mo\u017cna pobra\u0107 tokenu CSRF. Spr\u00f3buj od\u015bwie\u017cy\u0107 stron\u0119 Brand24.');
      },
      onerror: function() {
        cb(null, '\u26a0 B\u0142\u0105d sieci przy pobieraniu tokenu CSRF. Upewnij si\u0119, \u017ce jeste\u015b zalogowany.');
      }
    });
  }

  // ── CMS DOMAIN CHECK ──

  function _newsCmsStatus() {
    // Returns domain only — CMS tag availability is checked via state.tags in _newsCheckTagDodane()
    var host = window.location.hostname;
    var domain = host.indexOf('brand24.com') !== -1 ? 'com' : host.indexOf('brand24.pl') !== -1 ? 'pl' : null;
    return { domain: domain };
  }

  // Try to detect article publish date from fetched HTML
  function _newsDetectDateFromHtml(html) {
    if (!html) return null;
    var patterns = [
      // JSON-LD datePublished
      /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/,
      // meta property=article:published_time
      /published_time[^"]*"\s+content="(\d{4}-\d{2}-\d{2})/,
      // meta name=date
      /name="date"[^>]+content="(\d{4}-\d{2}-\d{2})/i,
      // itemprop=datePublished
      /datePublished[^"]*"[^>]*content="(\d{4}-\d{2}-\d{2})/i,
      // og:article:published_time jako meta
      /property=["']article:published_time["'][^>]+content=["'](\d{4}-\d{2}-\d{2})/i,
      /content=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]+property=["']article:published_time["']/i,
      // dateCreated (schema.org)
      /"dateCreated"\s*:\s*"(\d{4}-\d{2}-\d{2})/,
      // pubdate attribute on time
      /<time[^>]+pubdate[^>]*datetime=["'](\d{4}-\d{2}-\d{2})/i,
      // data-date attributes (rozszerzone)
      /data-(?:publish|pub|created|article|date)-?(?:date|time|at)?=["'](\d{4}-\d{2}-\d{2})/i,
      // itemprop="datePublished" z content= (kolejność atrybutów odwrócona)
      /content=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]+itemprop=["']datePublished["']/i,
      // meta name="publishdate" / "publish-date" / "article.published"
      /name=["'](?:publishdate|publish[-_]date|article\.published|cXenseParse:recs:publishtime)["'][^>]+content=["'](\d{4}-\d{2}-\d{2})/i,
      /content=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]+name=["'](?:publishdate|publish[-_]date|article\.published)["']/i,
      // Dublin Core
      /name=["']DC\.date[^"']*["'][^>]+content=["'](\d{4}-\d{2}-\d{2})/i,
      // <time datetime="YYYY-MM-DD (z cudzysłowem pojedynczym też)
      /<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2})/i,
      // JSON-LD dateModified jako ostatnia deska ratunku
      /"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})/,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = html.match(patterns[i]);
      if (m) {
        var d = m[1];
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > '2000-01-01' && d <= _localDateStr(new Date())) return d;
      }
    }
    // Fallback: widoczny tekst z nazwą miesiąca blisko słowa-klucza publikacji
    var _mn = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    var _textPatterns = [
      /(?:published|posted|written|created|date)[^<]{0,80}(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i,
      /(?:published|posted|written|created|date)[^<]{0,80}(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i,
    ];
    for (var j = 0; j < _textPatterns.length; j++) {
      var tm = html.match(_textPatterns[j]);
      if (tm) {
        var y, mo, dy;
        if (/^\d/.test(tm[1])) { dy = parseInt(tm[1], 10); mo = _mn[tm[2].toLowerCase()]; y = parseInt(tm[3], 10); }
        else                   { mo = _mn[tm[1].toLowerCase()]; dy = parseInt(tm[2], 10); y = parseInt(tm[3], 10); }
        if (y && mo && dy) {
          var ds = y + '-' + String(mo).padStart(2, '0') + '-' + String(dy).padStart(2, '0');
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds) && ds > '2000-01-01' && ds <= _localDateStr(new Date())) return ds;
        }
      }
    }
    return null;
  }

  function _newsDetectLangFromResponse(html, url) {
    var m = html && html.match(/<html[^>]+lang=["']([a-z]{2})/i);
    if (m) return m[1].toLowerCase();
    var m2 = html && html.match(/content-language[^>]+content=["']([a-z]{2})/i);
    if (m2) return m2[1].toLowerCase();
    try {
      var h = new URL(url).hostname.toLowerCase().split('.');
      if (h.length >= 3 && h[0].length === 2 && /^[a-z]{2}$/.test(h[0])) return h[0];
    } catch(e) {}
    return null;
  }

  // ── THEME HELPER ──
  function _newsIsDark() {
    return document.documentElement.getAttribute('data-b24t-theme') === 'dark';
  }

  // ── BUILD & OPEN NEWS PANELS ──
  function _newsRefillTags() {
    var tagList = document.getElementById('b24t-news-tag-list');
    if (!tagList) return;
    var tags = Object.entries(state.tags || {}).sort(function(a, b) {
      var aD = a[0].toLowerCase().indexOf('dodane') !== -1;
      var bD = b[0].toLowerCase().indexOf('dodane') !== -1;
      if (aD !== bD) return aD ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
    if (tags.length === 0) {
      // Projekt jeszcze nie załadowany — spróbuj za chwilę (race condition przy wolnym ładowaniu, np. panel.brand24.pl)
      setTimeout(function() { if (Object.keys(state.tags || {}).length > 0) _newsRefillTags(); }, 1500);
      return;
    }
    var t2 = _newsThemeVars();
    tagList.innerHTML = tags.map(function(entry) {
      var name = entry[0], tid = entry[1];
      var isDodane = name.toLowerCase().indexOf('dodane') !== -1;
      return '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;padding:3px 7px;border-radius:6px;background:' + (isDodane ? 'rgba(99,102,241,0.15)' : t2.bgInput) + ';border:1px solid ' + (isDodane ? 'rgba(99,102,241,0.35)' : t2.borderSub) + ';">' +
        '<input type="checkbox" data-tag-id="' + tid + '"' + (isDodane ? ' id="b24t-news-tag-dodane" checked' : '') + ' style="cursor:pointer;accent-color:#6366f1;width:11px;height:11px;">' +
        '<span style="font-size:10px;font-weight:' + (isDodane ? '700' : '500') + ';color:' + t2.text + ';">' + name + '</span>' +
        (isDodane ? '<span id="b24t-news-tag-dodane-status" style="font-size:9px;color:' + t2.textFaint + ';">(sprawdzanie...)</span>' : '') +
      '</label>';
    }).join('');
    _newsCheckTagDodane();
  }

  function openNewsPanels() {
    var overlay = document.getElementById('b24t-news-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      newsState.panelsOpen = true;
      if (!newsState.wired) { _wireNewsPanels(); newsState.wired = true; }
      requestAnimationFrame(function() {
        if (_newsChipsRenderer) _newsChipsRenderer();
        _newsRefillTags();
      });
      return;
    }
    _buildNewsPanels();
    _wireNewsPanels();
    newsState.wired = true;
    newsState.panelsOpen = true;
  }

  function _newsThemeVars() {
    var dark = _newsIsDark();
    return {
      bg:          'var(--b24t-bg)',
      bgDeep:      'var(--b24t-bg-deep)',
      bgInput:     'var(--b24t-bg-input)',
      border:      'var(--b24t-border)',
      borderSub:   'var(--b24t-border-sub)',
      text:        'var(--b24t-text)',
      textMuted:   'var(--b24t-text-muted)',
      textFaint:   'var(--b24t-text-faint)',
      accent:      'var(--b24t-primary)',
      accentAlpha: 'var(--b24t-primary-bg)',
      accentBorder:'color-mix(in srgb, var(--b24t-primary) 35%, transparent)',
      shadow:      'var(--b24t-shadow-h)',
      green:    '#22c55e', greenBg: dark ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.08)',
      red:      '#ef4444', redBg:   dark ? 'rgba(239,68,68,0.12)'  : 'rgba(239,68,68,0.08)',
      yellow:   '#f59e0b', yellowBg:dark ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.08)',
      purple:   '#a78bfa', purpleBg:dark ? 'rgba(167,139,250,0.12)': 'rgba(167,139,250,0.08)',
    };
  }


  function closeNewsPanels() {
    var _naSD = newsState.sessionId ? _naBuildSessionData() : null;
    _naFinalizeSession();
    if (_naSD) _naPushSession(_naSD, null);
    var overlay = document.getElementById('b24t-news-overlay');
    if (overlay) overlay.style.display = 'none';
    var modal = document.getElementById('b24t-news-import-modal');
    if (modal) modal.style.display = 'none';
    newsState.panelsOpen = false;
    var nst = document.getElementById('b24t-news-side-tab');
    if (nst) {
      nst.classList.remove('active');
      nst.style.display = 'flex';
    }
  }

  function _buildNewsPanels() {
    var t = _newsThemeVars();

    // ─── IMPORT MODAL ───
    var modal = document.createElement('div');
    modal.id = 'b24t-news-import-modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,0.72);align-items:center;justify-content:center;font-family:Geist,\'Segoe UI\',system-ui,sans-serif;';
    var modalInner = document.createElement('div');
    modalInner.style.cssText = 'background:' + t.bg + ';border:1px solid ' + t.border + ';border-radius:14px;padding:20px;width:500px;max-width:calc(100vw - 40px);max-height:88vh;overflow-y:auto;box-shadow:' + t.shadow + ';color:' + t.text + ';';
    modalInner.innerHTML = [
      '<div style="display:flex;align-items:center;margin-bottom:14px;">',
        '<span style="font-size:14px;font-weight:700;color:' + t.text + ';flex:1;">📥 Importuj URLe</span>',
        '<button id="b24t-news-import-settings-btn" style="background:transparent;border:1px solid ' + t.border + ';color:' + t.textMuted + ';cursor:pointer;font-size:13px;padding:2px 8px;border-radius:5px;margin-right:8px;" title="Ustawienia skanowania">⚙</button>',
        '<button id="b24t-news-modal-close-btn" style="background:transparent;border:none;color:' + t.textMuted + ';cursor:pointer;font-size:22px;line-height:1;padding:0 4px;">×</button>',
      '</div>',
      '<div id="b24t-news-import-settings" style="display:none;padding:10px 12px;border-radius:8px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';font-size:11px;margin-bottom:12px;">',
        '<div style="font-size:10px;font-weight:700;color:' + t.textMuted + ';letter-spacing:0.06em;margin-bottom:8px;">USTAWIENIA SKANOWANIA</div>',
        '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;">',
          '<input type="checkbox" id="b24t-news-opt-urlsimple" style="margin-top:2px;flex-shrink:0;"' + (_newsImportOpts.urlSimpleMode ? ' checked' : '') + '>',
          '<span>',
            '<span style="font-weight:600;color:' + t.text + ';">Uproszczone skanowanie (URL)</span>',
            '<br><span style="font-size:10px;color:' + t.textFaint + ';line-height:1.4;">Klasyfikuje URLe tylko po adresie — szybsze, bez tytułu i daty.</span>',
          '</span>',
        '</label>',
      '</div>',
      '<div id="b24t-news-ai-brand-section" style="display:none;padding:10px 12px;border-radius:8px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';font-size:11px;margin-bottom:12px;">',
        '<div style="font-size:10px;font-weight:700;color:' + t.textMuted + ';letter-spacing:0.06em;margin-bottom:6px;">OPIS MARKI (AI)</div>',
        '<textarea id="b24t-news-ai-brand-ctx" rows="3" placeholder="Opisz mark\u0119: czym si\u0119 zajmuje, jakie produkty/brandy, kim jest odbiorca..." style="width:100%;box-sizing:border-box;font-size:11px;padding:7px 9px;border-radius:7px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';resize:vertical;font-family:inherit;line-height:1.5;"></textarea>',
        '<div style="margin-top:4px;font-size:9px;color:' + t.textFaint + ';">Kontekst dla AI. Zapisywany per projekt. U\u017cyj <code>{PROJECT_NAME}</code> i <code>{BRAND_CONTEXT}</code> w swoim prompcie.</div>',
      '</div>',
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">',
        '<label style="font-size:11px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">WKLEJ ADRESY URL</label>',
        '<span style="font-size:9px;color:' + t.textFaint + ';">jeden na linię</span>',
      '</div>',
      '<textarea id="b24t-news-paste-area" rows="7" placeholder="Wklej URLe...\n\nhttps://example.com/artykul-1\nhttps://example.com/artykul-2" style="width:100%;box-sizing:border-box;font-size:10px;padding:8px 10px;border-radius:8px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';resize:vertical;font-family:monospace;line-height:1.5;min-height:130px;"></textarea>',
      '<div id="b24t-news-country-row" style="display:none;padding:7px 10px;border-radius:8px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';font-size:11px;margin-top:8px;">',
        '<div style="display:flex;align-items:center;gap:6px;">',
          '<span style="font-size:10px;color:' + t.textMuted + ';">Wykryty kraj URLi:</span>',
          '<span id="b24t-news-country-badge" style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;background:var(--b24t-primary);color:#fff;"></span>',
          '<span id="b24t-news-country-proj" style="font-size:10px;color:' + t.textMuted + ';"></span>',
        '</div>',
        '<div id="b24t-news-country-warn" style="display:none;margin-top:5px;font-size:10px;color:#f59e0b;line-height:1.4;"></div>',
      '</div>',
      '<div style="margin-top:12px;">',
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">',
          '<label style="font-size:11px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">SŁOWA KLUCZOWE</label>',
          '<div style="display:flex;gap:4px;">',
            '<button id="b24t-news-add-chip-btn" style="font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;">+ Dodaj</button>',
            '<button id="b24t-news-reset-chips-btn" style="font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textFaint + ';cursor:pointer;" title="Przywróć domyślne">↺</button>',
          '</div>',
        '</div>',
        '<div id="b24t-news-chips" style="display:flex;flex-wrap:wrap;gap:4px;min-height:24px;padding:6px 8px;border-radius:8px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';"></div>',
        '<div style="margin-top:4px;font-size:9px;color:' + t.textFaint + ';">Chipy filtrowane per kraj i zapisywane automatycznie.</div>',
      '</div>',
      '<button id="b24t-news-import-btn" style="margin-top:14px;width:100%;padding:10px;border-radius:9px;border:none;background:var(--b24t-accent-grad);color:#fff;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:0.02em;box-shadow:inset 0 1px 0 rgba(255,255,255,0.15);">▶ Skanuj URLe</button>',
    ].join('');
    modal.appendChild(modalInner);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.body.appendChild(modal);

    // ─── MAIN OVERLAY ───
    var overlay = document.createElement('div');
    overlay.id = 'b24t-news-overlay';
    overlay.style.cssText = 'display:flex;position:fixed;inset:0;z-index:2147483632;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;font-family:Geist,\'Segoe UI\',system-ui,sans-serif;animation:b24t-fadein 0.2s ease both;';

    var panelMain = document.createElement('div');
    panelMain.id = 'b24t-news-panel-main';
    panelMain.style.cssText = 'position:relative;width:calc(100vw - 40px);max-width:1400px;height:calc(100vh - 40px);max-height:900px;background:' + t.bg + ';border-radius:16px;border:1px solid ' + t.border + ';box-shadow:' + t.shadow + ';display:flex;flex-direction:column;overflow:hidden;color:' + t.text + ';';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--b24t-accent-grad);flex-shrink:0;';
    var _aiChipHtml = _newsAiShouldRun()
      ? '<span id="b24t-news-ai-chip" title="AI News aktywne — artykuły będą analizowane przez Claude" style="font-size:11px;padding:3px 9px;border-radius:12px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.40);color:#fff;font-weight:600;flex-shrink:0;cursor:default;letter-spacing:0.01em;">🤖 AI</span>'
      : '';
    header.innerHTML = [
      '<span style="font-size:13px;font-weight:700;color:#fff;flex:1;text-shadow:0 1px 3px rgba(0,0,0,0.2);">📰 News</span>',
      _aiChipHtml,
      '<button id="b24t-news-legend-btn" style="background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);color:#fff;cursor:pointer;font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;flex-shrink:0;" title="Legenda oznaczeń">?</button>',
      '<button id="b24t-news-stats-btn" style="background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);color:#fff;cursor:pointer;font-size:12px;font-weight:600;padding:3px 8px;border-radius:6px;flex-shrink:0;" title="News Analytics">📊</button>',
      '<button id="b24t-news-langmap-btn" style="background:rgba(255,255,255,0.20);border:1px solid rgba(255,255,255,0.35);color:#fff;cursor:pointer;font-size:11px;padding:3px 9px;border-radius:6px;flex-shrink:0;" title="Mapa języków">⚙ Języki</button>',
      '<button id="b24t-news-modal-open-btn" style="background:rgba(255,255,255,0.25);border:1px solid rgba(255,255,255,0.55);color:#fff;cursor:pointer;font-size:12px;font-weight:700;padding:5px 14px;border-radius:7px;flex-shrink:0;letter-spacing:0.01em;">+ Importuj URLe</button>',
      '<span id="b24t-news-cms-dot" class="b24t-cms-checking" style="font-size:11px;font-weight:700;flex-shrink:0;cursor:default;color:rgba(255,255,255,0.5);" title="Sprawdzanie CMS...">● CMS</span>',
      '<button class="b24t-news-close-all" style="background:rgba(255,255,255,0.20);border:1px solid rgba(255,255,255,0.4);color:#fff;cursor:pointer;font-size:17px;line-height:1;padding:1px 7px;border-radius:5px;flex-shrink:0;">×</button>',
    ].join('');

    // Tab bar (small screens < 880px)
    var tabsBar = document.createElement('div');
    tabsBar.id = 'b24t-news-tabs';
    tabsBar.style.cssText = 'display:none;border-bottom:1px solid ' + t.border + ';flex-shrink:0;background:' + t.bg + ';';
    tabsBar.innerHTML = [
      '<button class="b24t-news-tab b24t-news-tab-active" data-tab="list" style="padding:8px 16px;border:none;background:transparent;font-size:12px;font-weight:600;color:var(--b24t-primary);cursor:pointer;border-bottom:2px solid var(--b24t-primary);">Lista</button>',
      '<button class="b24t-news-tab" data-tab="preview" style="padding:8px 16px;border:none;background:transparent;font-size:12px;font-weight:500;color:' + t.textMuted + ';cursor:pointer;border-bottom:2px solid transparent;">Podgląd</button>',
      '<button class="b24t-news-tab" data-tab="form" style="padding:8px 16px;border:none;background:transparent;font-size:12px;font-weight:500;color:' + t.textMuted + ';cursor:pointer;border-bottom:2px solid transparent;">Formularz</button>',
      '<button class="b24t-news-tab" data-tab="stats" style="padding:8px 16px;border:none;background:transparent;font-size:12px;font-weight:500;color:' + t.textMuted + ';cursor:pointer;border-bottom:2px solid transparent;">Statystyki</button>',
    ].join('');

    // Columns container
    var cols = document.createElement('div');
    cols.id = 'b24t-news-cols';
    cols.style.cssText = 'display:flex;flex:1;min-height:0;overflow:hidden;';

    // Left column: URL list
    var colList = document.createElement('div');
    colList.id = 'b24t-news-col-list';
    colList.style.cssText = 'width:270px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid ' + t.border + ';min-height:0;overflow:hidden;';
    colList.innerHTML = [
      // Progress bar (scan + session) — shown when URLs present
      '<div id="b24t-news-progress-wrap" style="display:none;padding:8px 10px 0;flex-shrink:0;">',
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + t.textMuted + ';margin-bottom:4px;">',
          '<span>Postęp sesji</span>',
          '<span id="b24t-news-progress-label">0 / 0</span>',
        '</div>',
        '<div style="height:6px;border-radius:2px;background:' + t.bgDeep + ';overflow:hidden;">',
          '<div id="b24t-news-progress-bar" style="height:6px;background:var(--b24t-accent-grad);width:0%;border-radius:2px;"></div>',
        '</div>',
      '</div>',
      // Filter bar
      '<div id="b24t-news-filter-bar" style="display:none;padding:4px 8px;flex-shrink:0;border-bottom:1px solid ' + t.borderSub + ';align-items:center;gap:6px;flex-wrap:wrap;">',
        '<button id="b24t-news-filter-nonarticle" style="font-size:9px;padding:2px 8px;border-radius:4px;border:1px solid ' + t.border + ';background:rgba(107,114,128,0.08);color:' + t.textMuted + ';cursor:pointer;">Ukryj nie-artykuły (0)</button>',
      '</div>',
      // URL list
      '<div id="b24t-news-url-list" style="flex:1;overflow-y:auto;padding:8px 6px;display:flex;flex-direction:column;gap:3px;min-height:0;">',
        '<div id="b24t-news-empty" style="padding:32px 16px;text-align:center;">',
          '<div style="font-size:32px;margin-bottom:10px;">📋</div>',
          '<div style="font-size:13px;font-weight:600;color:' + t.text + ';margin-bottom:6px;">Brak URLi</div>',
          '<div style="font-size:11px;color:' + t.textFaint + ';line-height:1.7;">Kliknij <strong style="color:' + t.text + ';">+ Importuj URLe</strong><br>i wklej adresy do przeskanowania.</div>',
        '</div>',
      '</div>',
      // Bulk bar
      '<div id="b24t-news-bulk-bar" style="display:flex;flex-wrap:wrap;gap:4px;padding:5px 8px;flex-shrink:0;border-top:1px solid ' + t.borderSub + ';min-height:0;"></div>',
      // Scan status info (visible in main panel)
      '<div id="b24t-news-import-info" style="display:none;font-size:10px;text-align:center;padding:3px 8px;flex-shrink:0;"></div>',
      '<div id="b24t-news-project-info" style="display:none;font-size:10px;text-align:center;padding:2px 8px 4px;flex-shrink:0;"></div>',
      // Import button
      '<div style="padding:4px 8px 8px;flex-shrink:0;">',
        '<button id="b24t-news-bottom-import-btn" title="Otwórz formularz importu URLi" style="width:100%;padding:6px;border-radius:7px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';font-size:11px;cursor:pointer;font-weight:500;">↑ Wczytaj URLe</button>',
      '</div>',
    ].join('');

    // Middle column: article preview (iframe / rich card)
    var colPreview = document.createElement('div');
    colPreview.id = 'b24t-news-col-preview';
    colPreview.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid ' + t.border + ';overflow:hidden;';
    colPreview.innerHTML = [
      '<div id="b24t-news-preview-header" style="display:none;flex-shrink:0;padding:4px 10px;background:' + t.bgDeep + ';border-bottom:1px solid ' + t.borderSub + ';align-items:center;gap:6px;">',
        '<span id="b24t-news-preview-url-label" style="flex:1;font-size:10px;font-family:monospace;color:' + t.textFaint + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>',
        '<button id="b24t-news-preview-switch-rich-btn" style="flex-shrink:0;font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;" title="Przełącz na kartę podglądu">▢ Karta</button>',
        '<a id="b24t-news-preview-open-link" href="#" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textMuted + ';text-decoration:none;" title="Otwórz w nowej karcie">↗</a>',
      '</div>',
      '<div id="b24t-news-preview-empty" style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:24px;">',
        '<div style="font-size:30px;margin-bottom:10px;opacity:0.4;">📄</div>',
        '<div style="font-size:13px;font-weight:600;color:' + t.textMuted + ';margin-bottom:5px;">Kliknij artykuł z listy</div>',
        '<div style="font-size:11px;color:' + t.textFaint + ';">Podgląd pojawi się tutaj</div>',
      '</div>',
      '<iframe id="b24t-news-iframe" src="" style="display:none;flex:1;width:100%;border:none;background:#fff;"></iframe>',
      '<div id="b24t-news-rich-preview" style="display:none;flex:1;overflow-y:auto;padding:16px 14px;flex-direction:column;gap:12px;"></div>',
    ].join('');

    // Right column: mention form
    var colForm = document.createElement('div');
    colForm.id = 'b24t-news-col-form';
    colForm.style.cssText = 'width:285px;flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto;padding:14px 16px;gap:10px;min-width:0;';

    colForm.innerHTML = [
      '<div id="b24t-news-cms-warn" style="display:none;padding:7px 10px;border-radius:8px;background:' + t.yellowBg + ';border:1px solid rgba(245,158,11,0.35);font-size:10px;color:' + t.yellow + ';line-height:1.5;flex-shrink:0;">' +
        '<span id="b24t-news-cms-warn-text"></span>' +
        '<button id="b24t-news-cms-recheck" style="display:inline-block;margin-left:8px;font-size:9px;padding:2px 8px;border-radius:5px;border:1px solid rgba(245,158,11,0.4);background:transparent;color:' + t.yellow + ';cursor:pointer;">↺ Sprawdź ponownie</button>' +
      '</div>',
      '<div id="b24t-news-form-err" style="display:none;padding:7px 10px;border-radius:8px;background:' + t.redBg + ';border:1px solid rgba(239,68,68,0.35);font-size:10px;color:' + t.red + ';line-height:1.4;flex-shrink:0;"></div>',
      '<div id="b24t-news-lang-warn" style="display:none;padding:7px 10px;border-radius:8px;background:' + t.yellowBg + ';border:1px solid rgba(245,158,11,0.35);font-size:10px;color:' + t.yellow + ';line-height:1.4;flex-shrink:0;"></div>',
      _newsFormRow('URL wzmianki', '<input id="b24t-news-f-url" type="text" readonly placeholder="(kliknij URL z listy)" style="' + _newsInputCss(t) + 'font-family:monospace;font-size:10px;opacity:0.75;"><button id="b24t-news-lang-force-open" style="display:none;flex-shrink:0;font-size:9px;padding:3px 6px;border-radius:5px;border:1px solid rgba(245,158,11,0.4);background:transparent;color:' + t.yellow + ';cursor:pointer;margin-left:4px;" title="Otwórz mimo ostrzeżenia">Otwórz</button>', true, 'flex'),
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">',
        '<span style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">DANE ARTYKUŁU</span>',
        '<button id="b24t-news-clear-btn" style="background:transparent;border:1px solid ' + t.border + ';color:' + t.textMuted + ';cursor:pointer;font-size:10px;padding:2px 8px;border-radius:5px;">✕ Wyczyść</button>',
      '</div>',
      _newsFormRow('Tytuł artykułu', '<input id="b24t-news-f-title" type="text" placeholder="Wklej tytuł artykułu..." style="' + _newsInputCss(t) + '">', true),
      '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">' +
        '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">TREŚĆ <span style="color:#ef4444;">*</span></label>' +
        '<textarea id="b24t-news-f-content" rows="3" placeholder="Wklej fragment treści artykułu..." style="' + _newsInputCss(t) + 'resize:vertical;min-height:60px;"></textarea>' +
      '</div>',
      '<div style="display:flex;gap:6px;flex-shrink:0;">',
        '<div style="flex:2;display:flex;flex-direction:column;gap:4px;">',
          '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">DATA <span style="color:#ef4444;">*</span></label>',
          '<div style="display:flex;gap:4px;align-items:center;">',
            '<input id="b24t-news-f-date" type="text" placeholder="YYYY-MM-DD" style="' + _newsInputCss(t) + 'flex:1;">',
            '<span id="b24t-news-date-detect-icon" style="display:none;font-size:14px;cursor:default;" title="Data wykryta automatycznie">🔍</span>',
          '</div>',
        '</div>',
        '<div style="flex:1;display:flex;flex-direction:column;gap:4px;">',
          '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">GODZ.</label>',
          '<input id="b24t-news-f-hour" type="text" value="12" style="' + _newsInputCss(t) + '">',
        '</div>',
        '<div style="flex:1;display:flex;flex-direction:column;gap:4px;">',
          '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">MIN.</label>',
          '<input id="b24t-news-f-minute" type="text" value="00" style="' + _newsInputCss(t) + '">',
        '</div>',
      '</div>',
      '<div style="display:flex;gap:6px;flex-shrink:0;">',
        '<div style="flex:2;display:flex;flex-direction:column;gap:4px;">',
          '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">KAT.</label>',
          '<input type="text" value="7 — News" readonly style="' + _newsInputCss(t) + 'opacity:0.5;">',
        '</div>',
        '<div style="flex:1;display:flex;flex-direction:column;gap:4px;">',
          '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">KRAJ</label>',
          '<input id="b24t-news-f-country" type="text" readonly style="' + _newsInputCss(t) + 'opacity:0.6;" placeholder="z proj.">',
          '<span id="b24t-news-proj-lang-hint" style="display:none;font-size:8px;color:' + t.textFaint + ';text-align:center;letter-spacing:0.02em;"></span>',
        '</div>',
        '<div style="flex:1;display:flex;flex-direction:column;gap:4px;">',
          '<label style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">SENT.</label>',
          '<select id="b24t-news-f-sentiment" style="' + _newsInputCss(t) + '">',
            '<option value="0">0 Neutral</option>',
            '<option value="1">+1 Poz.</option>',
            '<option value="-1">-1 Neg.</option>',
          '</select>',
        '</div>',
      '</div>',
      '<div id="b24t-news-tag-row" style="border-radius:8px;background:' + t.bgDeep + ';border:1px solid ' + t.borderSub + ';font-size:11px;overflow:hidden;flex-shrink:0;">' +
        '<div id="b24t-news-tag-toggle" style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;cursor:pointer;user-select:none;" title="Rozwiń/zwiń listę tagów">' +
          '<span style="font-size:10px;font-weight:600;color:' + t.textMuted + ';letter-spacing:0.04em;">TAGI</span>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<span id="b24t-news-tag-summary" style="font-size:10px;color:' + t.textFaint + ';">Dodane</span>' +
            '<span id="b24t-news-tag-chevron" style="font-size:10px;color:' + t.textFaint + ';transition:transform 0.2s;">▼</span>' +
          '</div>' +
        '</div>' +
        '<div id="b24t-news-tag-list" style="display:none;flex-wrap:wrap;gap:5px;padding:0 10px 8px;max-height:160px;overflow-y:auto;"></div>' +
      '</div>',
      '<button id="b24t-news-submit-btn" style="flex-shrink:0;padding:9px;border-radius:9px;border:none;background:var(--b24t-accent-grad);color:#fff;font-size:12px;font-weight:700;cursor:pointer;width:100%;letter-spacing:0.03em;transition:opacity 0.15s;">✚ Dodaj wzmiankę do Brand24</button>',
      '<div id="b24t-news-submit-status" style="font-size:10px;text-align:center;min-height:14px;font-weight:500;flex-shrink:0;"></div>',
    ].join('');

    cols.appendChild(colList);
    cols.appendChild(colPreview);
    cols.appendChild(colForm);
    // Legend overlay — shows badge descriptions when ? is clicked
    var legendOverlay = document.createElement('div');
    legendOverlay.id = 'b24t-news-legend-overlay';
    legendOverlay.style.cssText = 'display:none;position:absolute;inset:0;z-index:10;background:' + t.bg + ';border-radius:16px;overflow-y:auto;padding:20px 24px;';
    var _legendRows = [
      ['◆', '#22c55e',  'Główny temat',   'Keyword w tytule artykułu (score 12+)'],
      ['◆', '#818cf8',  'W treści',       'Keyword wielokrotnie w treści (score 5–11)'],
      ['◆', '#fb923c',  'Wzmianka',       'Keyword pobocznie w treści (score 1–4)'],
      ['●', '#22c55e',  'URL match',      'Keyword znaleziony w adresie URL'],
      ['◇', '#9ca3af',  'W polecanych',   'Keyword tylko w sekcji polecanych artykułów'],
      ['●', '#f97316',  'Inny kraj',      'Keyword w URL, ale adres wskazuje inny kraj'],
      ['—', '#6b7280',  'Nieprzeskan.',   'Strona niedostępna — kliknij wiersz aby sprawdzić ręcznie'],
      ['✓', '#15803d',  'Dodany',         'Wzmianka dodana do projektu Brand24'],
      ['✗', '#ef4444',  'Błąd/duplikat',  'Błąd dodawania lub duplikat w projekcie'],
      ['📅', t.textMuted, 'Data',         'Data publikacji artykułu (wykryta ze strony)'],
      ['🌐', '#a78bfa',  'Język',         'Język strony wykryty ze znacznika <html lang>'],
      ['🔒', '#f59e0b',  'Paywall',       'Strona za paywallem — treść może być niepełna'],
      ['📄', t.textMuted, 'Nie-artykuł',  'Strona katalogowa, firmowa lub inny typ niż artykuł'],
      ['▢',  '#818cf8',  'iframe',        'Podgląd bezpośredni w panelu dostępny'],
      ['⏳', '#818cf8',  'AI...',         'Oczekuje na analizę AI'],
      ['🤖', '#22c55e',  'AI Relevant',   'AI oceniło artykuł jako relevantny dla marki'],
      ['🤖', '#9ca3af',  'AI Not rel.',   'AI oceniło artykuł jako nierelevantny'],
      ['🤖', '#f87171',  'AI błąd',       'Błąd analizy AI — najedź na badge aby zobaczyć szczegóły'],
    ];
    legendOverlay.innerHTML =
      '<div style="display:flex;align-items:center;margin-bottom:16px;">' +
        '<span style="font-size:14px;font-weight:700;color:' + t.text + ';flex:1;">Legenda oznaczeń</span>' +
        '<button id="b24t-news-legend-close" style="background:transparent;border:1px solid ' + t.border + ';color:' + t.textMuted + ';cursor:pointer;font-size:17px;line-height:1;padding:1px 7px;border-radius:5px;">×</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:24px 1fr 1fr;gap:6px 12px;align-items:center;">' +
      _legendRows.map(function(r) {
        return '<span style="font-size:13px;color:' + r[1] + ';text-align:center;">' + r[0] + '</span>' +
               '<span style="font-size:11px;font-weight:600;color:' + t.text + ';">' + r[2] + '</span>' +
               '<span style="font-size:11px;color:' + t.textMuted + ';">' + r[3] + '</span>';
      }).join('') +
      '</div>';

    // Stats overlay — full-panel, z-index:10, shown by 📊 button or Statystyki tab
    var statsOverlay = document.createElement('div');
    statsOverlay.id = 'b24t-news-stats-overlay';
    statsOverlay.style.cssText = 'display:none;position:absolute;inset:0;z-index:10;background:' + t.bg + ';border-radius:16px;overflow-y:auto;padding:20px 24px;color:' + t.text + ';';
    statsOverlay.innerHTML = [
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">',
        '<span style="font-size:14px;font-weight:700;color:' + t.text + ';flex:1;">📊 News Analytics</span>',
        '<select id="b24t-news-stats-period" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';cursor:pointer;">',
          '<option value="7">Ostatnie 7 dni</option>',
          '<option value="30">Ostatnie 30 dni</option>',
          '<option value="90" selected>Ostatnie 90 dni</option>',
          '<option value="0">Wszystko</option>',
        '</select>',
        '<select id="b24t-news-stats-project" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';cursor:pointer;max-width:140px;">',
          '<option value="">Wszystkie projekty</option>',
        '</select>',
        '<select id="b24t-news-stats-country" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';cursor:pointer;">',
          '<option value="">Wszystkie kraje</option>',
        '</select>',
        '<button id="b24t-news-stats-refresh" style="font-size:13px;padding:2px 7px;border-radius:6px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;" title="Odśwież dane">🔄</button>',
        '<button id="b24t-news-stats-csv" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;" title="Eksportuj surowe rekordy (CSV)">↓ CSV</button>',
        '<button id="b24t-news-stats-json" style="font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;" title="Eksportuj statystyki z aktywnym filtrem (JSON)">↓ JSON</button>',
        '<button id="b24t-news-stats-close" style="background:transparent;border:1px solid ' + t.border + ';color:' + t.textMuted + ';cursor:pointer;font-size:17px;line-height:1;padding:1px 7px;border-radius:5px;">×</button>',
      '</div>',
      '<div id="b24t-news-stats-content"></div>',
    ].join('');

    panelMain.appendChild(header);
    panelMain.appendChild(tabsBar);
    panelMain.appendChild(cols);
    panelMain.appendChild(legendOverlay);
    panelMain.appendChild(statsOverlay);
    overlay.appendChild(panelMain);
    document.body.appendChild(overlay);

    // Responsive: switch between columns and tabs at < 960px (3 columns)
    function _newsApplyResponsive() {
      var narrow = panelMain.offsetWidth < 960;
      tabsBar.style.display = narrow ? '' : 'none';
      if (!narrow) {
        colList.style.display = 'flex';
        colPreview.style.display = 'flex';
        colForm.style.display = 'flex';
        colList.style.width = '270px';
        colList.style.borderRight = '1px solid ' + t.border;
        colPreview.style.width = '';
        colPreview.style.borderRight = '1px solid ' + t.border;
        colForm.style.width = '285px';
      } else {
        var activeTab = tabsBar.querySelector('.b24t-news-tab-active');
        var activeTabName = activeTab ? activeTab.dataset.tab : 'list';
        var isStats = activeTabName === 'stats';
        colList.style.display = activeTabName === 'list' ? 'flex' : 'none';
        colPreview.style.display = activeTabName === 'preview' ? 'flex' : 'none';
        colForm.style.display = activeTabName === 'form' ? 'flex' : 'none';
        var _sOvrl = document.getElementById('b24t-news-stats-overlay');
        if (_sOvrl) _sOvrl.style.display = isStats ? '' : 'none';
        colList.style.width = '100%';
        colPreview.style.width = '100%';
        colForm.style.width = '100%';
        colList.style.borderRight = 'none';
        colPreview.style.borderRight = 'none';
      }
    }
    requestAnimationFrame(_newsApplyResponsive);
    if (window.ResizeObserver) {
      new ResizeObserver(_newsApplyResponsive).observe(panelMain);
    }

    tabsBar.querySelectorAll('.b24t-news-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        tabsBar.querySelectorAll('.b24t-news-tab').forEach(function(b) {
          b.classList.remove('b24t-news-tab-active');
          b.style.color = t.textMuted;
          b.style.fontWeight = '500';
          b.style.borderBottom = '2px solid transparent';
        });
        btn.classList.add('b24t-news-tab-active');
        btn.style.color = 'var(--b24t-primary)';
        btn.style.fontWeight = '600';
        btn.style.borderBottom = '2px solid var(--b24t-primary)';
        _newsApplyResponsive();
      });
    });

    _newsRefillTags();
  }
  function _newsInputCss(t) {
    return 'width:100%;box-sizing:border-box;font-size:11px;padding:6px 8px;border-radius:7px;border:1px solid ' + t.border + ';background:' + t.bgInput + ';color:' + t.text + ';font-family:Geist,\'Segoe UI\',system-ui,sans-serif;outline:none;transition:border-color 0.15s;';
  }

  function _newsFormRow(label, inputHtml, required, display) {
    return '<div style="display:flex;flex-direction:column;gap:4px;">' +
      '<label style="font-size:10px;font-weight:600;color:var(--b24t-text-muted, #8b8fa8);letter-spacing:0.04em;">' + label.toUpperCase() + (required ? ' <span style="color:#ef4444;">*</span>' : '') + '</label>' +
      '<div style="display:' + (display || 'block') + ';align-items:center;">' + inputHtml + '</div>' +
    '</div>';
  }

  function _newsCheckTagDodane() {
    var statusEl   = document.getElementById('b24t-news-tag-dodane-status');
    var checkboxEl = document.getElementById('b24t-news-tag-dodane');
    var cmsBanner  = document.getElementById('b24t-news-cms-warn');
    var cmsDot     = document.getElementById('b24t-news-cms-dot');
    var warnText   = document.getElementById('b24t-news-cms-warn-text');
    var domain     = _newsCmsStatus().domain === 'pl' ? 'panel.brand24.pl' : 'app.brand24.com';

    var hasDodane = state.tags && Object.keys(state.tags).some(function(k) {
      return k.toLowerCase().indexOf('dodane') !== -1;
    });

    if (hasDodane) {
      // Stan 1: tag dodane istnieje w projekcie — CMS aktywny ✓
      if (statusEl)  { statusEl.textContent = '✓ dostępny'; statusEl.style.color = '#22c55e'; }
      if (checkboxEl){ checkboxEl.disabled = false; checkboxEl.checked = true; }
      if (cmsBanner) cmsBanner.style.display = 'none';
      if (cmsDot)    { cmsDot.style.color = '#22c55e'; cmsDot.classList.remove('b24t-cms-checking'); cmsDot.title = 'CMS aktywny — tag "dodane" dostępny'; }
      return;
    }

    // Brak tagu dodane — sprawdź czy użytkownik jest zalogowany do CMS (async)
    if (statusEl)  { statusEl.textContent = '⏳ sprawdzanie...'; statusEl.style.color = '#6b7280'; }
    if (checkboxEl){ checkboxEl.checked = false; checkboxEl.disabled = true; }
    if (cmsBanner) cmsBanner.style.display = 'none';
    if (cmsDot)    { cmsDot.style.color = '#6b7280'; cmsDot.classList.add('b24t-cms-checking'); cmsDot.title = 'Sprawdzanie CMS...'; }

    var sid = state.projectId || '';
    if (!sid) {
      // Brak ID projektu — pokaż ogólny błąd logowania
      if (statusEl)  { statusEl.textContent = '⚠ brak projektu'; statusEl.style.color = '#f59e0b'; }
      if (cmsDot)    { cmsDot.style.color = '#ef4444'; cmsDot.classList.remove('b24t-cms-checking'); cmsDot.title = 'CMS niedostępny — brak projektu'; }
      return;
    }

    var _b24base = window.location.hostname.indexOf('brand24.pl') !== -1 ? 'https://panel.brand24.pl' : 'https://app.brand24.com';
    GM_xmlhttpRequest({
      method: 'GET',
      url: _b24base + '/searches/add-new-mention/?sid=' + sid,
      onload: function(resp) {
        var m = (resp.responseText || '').match(/name="tknB24"[^>]*value="([a-f0-9]{32})"/);
        if (!m) m = (resp.responseText || '').match(/value="([a-f0-9]{32})"[^>]*name="tknB24"/);
        if (m && m[1]) {
          // Stan 2: zalogowany do CMS, ale brak tagu "dodane" w projekcie
          state.tknB24 = m[1];
          if (statusEl)  { statusEl.textContent = '⚠ brak tagu'; statusEl.style.color = '#f59e0b'; }
          if (cmsDot)    { cmsDot.style.color = '#f59e0b'; cmsDot.classList.remove('b24t-cms-checking'); cmsDot.title = 'CMS aktywny — brak tagu "dodane" w projekcie'; }
          if (cmsBanner) {
            if (warnText) warnText.innerHTML = '⚠ CMS aktywny, ale brak tagu <strong>dodane</strong> w tym projekcie — dodaj go w Brand24 w Ustawieniach tagów.';
            cmsBanner.style.display = '';
          }
        } else {
          // Stan 3: niezalogowany do CMS
          if (statusEl)  { statusEl.textContent = '⚠ niezalogowany'; statusEl.style.color = '#f59e0b'; }
          if (cmsDot)    { cmsDot.style.color = '#ef4444'; cmsDot.classList.remove('b24t-cms-checking'); cmsDot.title = 'CMS niedostępny — zaloguj się do Brand24'; }
          if (cmsBanner) {
            if (warnText) warnText.innerHTML = '⚠ Tag <strong>dodane</strong> niedostępny — zaloguj się do CMS Brand24 (' + domain + ').';
            cmsBanner.style.display = '';
          }
        }
      },
      onerror: function() {
        // Błąd sieci — zakładamy brak logowania (bezpieczniejszy fallback)
        if (statusEl)  { statusEl.textContent = '⚠ błąd sprawdzania'; statusEl.style.color = '#f59e0b'; }
        if (cmsDot)    { cmsDot.style.color = '#ef4444'; cmsDot.classList.remove('b24t-cms-checking'); cmsDot.title = 'CMS: błąd sieci przy sprawdzaniu'; }
        if (cmsBanner) {
          if (warnText) warnText.innerHTML = '⚠ Tag <strong>dodane</strong> niedostępny — zaloguj się do CMS Brand24 (' + domain + ').';
          cmsBanner.style.display = '';
        }
      }
    });
  }

  // ── WIRE LOGIC ──
  function _wireNewsPanels() {
    _naShowConsentIfNeeded();
    _naRetryPending();
    var projectCountry = _newsProjectCountry();

    // ─── CLOSE ALL ───
    document.querySelectorAll('.b24t-news-close-all').forEach(function(btn) {
      btn.addEventListener('click', closeNewsPanels);
    });

    // ─── CMS RECHECK ───
    // Use event delegation — button may be re-rendered
    document.addEventListener('click', function(e) {
      if (e.target && e.target.id === 'b24t-news-cms-recheck') {
        var btn = e.target;
        btn.textContent = '⏳';
        btn.disabled = true;
        getTags().then(function(tags) {
          state.tags = {};
          tags.forEach(function(t) { if (!t.isProtected) state.tags[t.title] = t.id; });
          _newsRefillTags();
          btn.disabled = false;
          btn.textContent = '↺ Sprawdź ponownie';
        }).catch(function() {
          _newsCheckTagDodane();
          btn.disabled = false;
          btn.textContent = '↺ Sprawdź ponownie';
        });
      }
    });

    // ─── LEGEND BUTTON ───
    var legendBtn   = document.getElementById('b24t-news-legend-btn');
    var legendOvrl  = document.getElementById('b24t-news-legend-overlay');
    var legendClose = document.getElementById('b24t-news-legend-close');
    if (legendBtn && legendOvrl) {
      legendBtn.addEventListener('click', function() {
        var open = legendOvrl.style.display === 'none';
        legendOvrl.style.display = open ? '' : 'none';
        if (open) { var _so = document.getElementById('b24t-news-stats-overlay'); if (_so) _so.style.display = 'none'; }
      });
    }
    if (legendClose && legendOvrl) {
      legendClose.addEventListener('click', function() { legendOvrl.style.display = 'none'; });
    }

    // ─── STATS BUTTON ───
    var statsBtn  = document.getElementById('b24t-news-stats-btn');
    var statsOvrl = document.getElementById('b24t-news-stats-overlay');
    function _naDoOpenStats() {
      var allData = _naCompute({});
      var countrySel = document.getElementById('b24t-news-stats-country');
      if (countrySel && allData.meta.countries.length) {
        var existing = [];
        for (var _oi = 0; _oi < countrySel.options.length; _oi++) existing.push(countrySel.options[_oi].value);
        allData.meta.countries.forEach(function(c) {
          if (existing.indexOf(c) < 0) { var o = document.createElement('option'); o.value = c; o.text = c; countrySel.appendChild(o); }
        });
      }
      var projectSel = document.getElementById('b24t-news-stats-project');
      if (projectSel && allData.meta.projects.length) {
        var existingP = [];
        for (var _pi = 0; _pi < projectSel.options.length; _pi++) existingP.push(projectSel.options[_pi].value);
        allData.meta.projects.forEach(function(pid) {
          if (existingP.indexOf(pid) < 0) {
            var o = document.createElement('option');
            o.value = pid;
            o.text = _pnResolve(pid) || pid;
            projectSel.appendChild(o);
          }
        });
        var curPid = String(state.projectId || '');
        if (curPid && projectSel.value === '') {
          for (var _qi = 0; _qi < projectSel.options.length; _qi++) {
            if (projectSel.options[_qi].value === curPid) { projectSel.value = curPid; break; }
          }
        }
      }
      _naRefreshStats();
    }
    function _naRefreshStats() {
      var contentEl  = document.getElementById('b24t-news-stats-content');
      if (!contentEl) return;
      var periodSel  = document.getElementById('b24t-news-stats-period');
      var countrySel = document.getElementById('b24t-news-stats-country');
      var projectSel = document.getElementById('b24t-news-stats-project');
      var days = periodSel ? parseInt(periodSel.value, 10) : 0;
      var country = countrySel ? countrySel.value : '';
      var projectId = projectSel ? projectSel.value : '';
      var filters = {};
      if (days > 0) { var d = new Date(); d.setDate(d.getDate() - days); filters.dateFrom = _localDateStr(d); }
      if (country) filters.country = country;
      if (projectId) filters.projectId = projectId;
      _naRenderStats(contentEl, filters);
    }
    if (statsBtn && statsOvrl) {
      statsBtn.addEventListener('click', function() {
        if (statsOvrl.style.display !== 'none') { statsOvrl.style.display = 'none'; return; }
        var _lo = document.getElementById('b24t-news-legend-overlay'); if (_lo) _lo.style.display = 'none';
        _naDoOpenStats();
        statsOvrl.style.display = '';
      });
    }
    var statsCloseBtn   = document.getElementById('b24t-news-stats-close');
    var statsPeriodSel  = document.getElementById('b24t-news-stats-period');
    var statsCountrySel = document.getElementById('b24t-news-stats-country');
    var statsProjectSel = document.getElementById('b24t-news-stats-project');
    var statsRefreshBtn = document.getElementById('b24t-news-stats-refresh');
    if (statsCloseBtn   && statsOvrl)  statsCloseBtn.addEventListener('click', function() { statsOvrl.style.display = 'none'; });
    if (statsPeriodSel)  statsPeriodSel.addEventListener('change',  _naRefreshStats);
    if (statsCountrySel) statsCountrySel.addEventListener('change', _naRefreshStats);
    if (statsProjectSel) statsProjectSel.addEventListener('change', _naRefreshStats);
    if (statsRefreshBtn) statsRefreshBtn.addEventListener('click',  _naRefreshStats);
    var statsCsvBtn  = document.getElementById('b24t-news-stats-csv');
    var statsJsonBtn = document.getElementById('b24t-news-stats-json');
    if (statsCsvBtn) statsCsvBtn.addEventListener('click', function() {
      var periodSel  = document.getElementById('b24t-news-stats-period');
      var countrySel = document.getElementById('b24t-news-stats-country');
      var projectSel = document.getElementById('b24t-news-stats-project');
      var days = periodSel ? parseInt(periodSel.value, 10) : 0;
      var country = countrySel ? countrySel.value : '';
      var projectId = projectSel ? projectSel.value : '';
      var filters = {};
      if (days > 0) { var d = new Date(); d.setDate(d.getDate() - days); filters.dateFrom = _localDateStr(d); }
      if (country) filters.country = country;
      if (projectId) filters.projectId = projectId;
      _naExportCsv(filters);
    });
    if (statsJsonBtn) statsJsonBtn.addEventListener('click', function() {
      var periodSel  = document.getElementById('b24t-news-stats-period');
      var countrySel = document.getElementById('b24t-news-stats-country');
      var projectSel = document.getElementById('b24t-news-stats-project');
      var days = periodSel ? parseInt(periodSel.value, 10) : 0;
      var country = countrySel ? countrySel.value : '';
      var projectId = projectSel ? projectSel.value : '';
      var filters = {};
      if (days > 0) { var d = new Date(); d.setDate(d.getDate() - days); filters.dateFrom = _localDateStr(d); }
      if (country) filters.country = country;
      if (projectId) filters.projectId = projectId;
      _naExportJson(filters);
    });
    // Wire Statystyki tab (narrow mode) — tab click shows overlay and populates it
    var statsTabEl = document.querySelector('#b24t-news-tabs [data-tab="stats"]');
    if (statsTabEl) statsTabEl.addEventListener('click', _naDoOpenStats);

    // ─── LANG MAP BUTTON ───
    var langMapBtn = document.getElementById('b24t-news-langmap-btn');
    if (langMapBtn) langMapBtn.addEventListener('click', _newsOpenLangMapEditor);

    // ─── MODAL BUTTONS ───
    var modalOpenBtn = document.getElementById('b24t-news-modal-open-btn');
    var importModal  = document.getElementById('b24t-news-import-modal');
    if (modalOpenBtn && importModal) {
      modalOpenBtn.addEventListener('click', function() {
        importModal.style.display = 'flex';
        if (_newsChipsRenderer) _newsChipsRenderer();
        var pasteEl = document.getElementById('b24t-news-paste-area');
        if (pasteEl) setTimeout(function() { pasteEl.focus(); }, 50);
      });
    }
    var modalCloseBtn = document.getElementById('b24t-news-modal-close-btn');
    if (modalCloseBtn && importModal) {
      modalCloseBtn.addEventListener('click', function() {
        importModal.style.display = 'none';
      });
    }

    // ─── CHIPS ───
    // Eksportuj referencję na poziom modułu — żeby openNewsPanels() mogło wywołać re-render
    // przy każdym otwarciu panelu (nie tylko przy pierwszym).
    function renderChips() {
      var cc = newsState.detectedCountry || 'DEFAULT';
      var chips = _newsGetKeywords(cc);
      var container = document.getElementById('b24t-news-chips');
      if (!container) return;
      container.innerHTML = '';
      chips.forEach(function(kw, i) {
        var t = _newsThemeVars();
        var chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:3px 8px;border-radius:10px;background:' + t.accentAlpha + ';color:#818cf8;border:1px solid ' + t.accentBorder + ';';
        chip.innerHTML = '<span>' + kw.replace(/</g,'&lt;') + '</span><span data-idx="' + i + '" class="b24t-chip-rm" style="cursor:pointer;opacity:0.5;margin-left:2px;font-size:9px;">✕</span>';
        container.appendChild(chip);
      });
      container.querySelectorAll('.b24t-chip-rm').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var cc2 = newsState.detectedCountry || 'DEFAULT';
          var kws = _newsGetKeywords(cc2);
          kws.splice(parseInt(btn.dataset.idx), 1);
          _newsSaveKeywords(cc2, kws);
          renderChips();
          renderUrlList();
        });
      });
    }
    _newsChipsRenderer = renderChips;
    renderChips();

    var addChipBtn = document.getElementById('b24t-news-add-chip-btn');
    if (addChipBtn) {
      addChipBtn.addEventListener('click', function() {
        var kw = prompt('Nowe słowo kluczowe (fragment URL):');
        if (!kw || !kw.trim()) return;
        var cc = newsState.detectedCountry || 'DEFAULT';
        var chips = _newsGetKeywords(cc);
        if (!chips.includes(kw.trim())) { chips.push(kw.trim()); _newsSaveKeywords(cc, chips); }
        renderChips();
        renderUrlList();
      });
    }
    var resetChipsBtn = document.getElementById('b24t-news-reset-chips-btn');
    if (resetChipsBtn) {
      resetChipsBtn.addEventListener('click', function() {
        var cc = newsState.detectedCountry || 'DEFAULT';
        _newsSaveKeywords(cc, NEWS_DEFAULT_KEYWORDS.slice());
        renderChips();
        renderUrlList();
      });
    }

    // ─── URL LIST ───
    function _statusDot(s, entry) {
      if (s === 'match')        return { dot: '●', color: '#22c55e', label: 'Keyword w URL — relevantny' };
      if (s === 'keytopic')     return { dot: '◆', color: '#22c55e', label: 'Główny temat (score 12+)' };
      if (s === 'contentmatch') return { dot: '◆', color: '#818cf8', label: 'W treści (score 5–11)' };
      if (s === 'mention')      return { dot: '◆', color: '#fb923c', label: 'Wzmianka (score 1–4)' };
      if (s === 'teasermatch')  return { dot: '◇', color: '#9ca3af', label: 'Keyword tylko w polecanych artykułach — nie w treści głównej' };
      if (s === 'wrongcountry') return { dot: '●', color: '#f97316', label: 'Keyword w URL, ale wskazuje inny kraj' };
      if (s === 'opened')       return { dot: '●', color: '#a78bfa', label: 'Otwarty — w trakcie weryfikacji' };
      if (s === 'added')        return { dot: '✓', color: '#15803d', label: 'Dodany do Brand24' };
      if (s === 'error')        return { dot: '✗', color: '#ef4444', label: 'Błąd / duplikat w projekcie' };
      if (s === 'inproject')    return { dot: '●', color: '#64748b', label: 'Już w projekcie (ten miesiąc)' };
      if (s === 'scanning')     return { dot: '◌', color: '#818cf8', label: 'Skanowanie treści...' };
      if (s === 'blocked') {
        var _lbl = 'Nie przeskanowana — kliknij aby sprawdzić ręcznie';
        if (entry) {
          if (entry.blockReason === 'timeout')    _lbl = 'Timeout — brak odpowiedzi w wyznaczonym czasie. Kliknij aby otworzyć ręcznie';
          else if (entry.blockReason === 'error') _lbl = 'Błąd połączenia (DNS, SSL lub connection refused). Kliknij aby otworzyć ręcznie';
          else if (entry.blockReason === 'http')  _lbl = 'HTTP ' + (entry.httpStatus || '') + ' — serwer odrzucił zapytanie. Kliknij aby otworzyć ręcznie';
          else if (entry.blockReason === 'exception') _lbl = 'Nieoczekiwany błąd podczas skanowania. Kliknij aby otworzyć ręcznie';
        }
        return { dot: '—', color: '#6b7280', label: _lbl };
      }
      return { dot: '○', color: '#4b5563', label: 'Brak keyword w URL ani treści' };
    }

    function _newsUrlCounts() {
      var c = { match: 0, keytopic: 0, contentmatch: 0, mention: 0, teasermatch: 0, wrongcountry: 0, nomatch: 0, inproject: 0, opened: 0, added: 0, error: 0, scanning: 0, blocked: 0, total: 0 };
      newsState.urls.forEach(function(u) { c[u.status] = (c[u.status] || 0) + 1; c.total++; });
      return c;
    }

    function _newsRemoveByStatus(predicate) {
      var activeUrl = newsState.activeIdx >= 0 ? (newsState.urls[newsState.activeIdx] || {}).url : null;
      newsState.urls = newsState.urls.filter(function(u) { return !predicate(u); });
      newsState.activeIdx = -1;
      if (activeUrl) {
        newsState.urls.forEach(function(u, i) { if (u.url === activeUrl) newsState.activeIdx = i; });
      }
      renderUrlList();
    }

    function _newsUpdateBulkBar() {
      var bar = document.getElementById('b24t-news-bulk-bar');
      if (!bar) return;
      var t = _newsThemeVars();
      var counts = _newsUrlCounts();
      var nomatchCount = (counts.nomatch || 0) + (counts.wrongcountry || 0) + (counts.teasermatch || 0);
      var blockedCount = counts.blocked || 0; // osobno — blocked można otworzyć ręcznie
      var handledCount = (counts.added || 0) + (counts.error || 0);
      bar.innerHTML = '';
      if (nomatchCount > 0) {
        var b1 = document.createElement('button');
        b1.style.cssText = 'font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid rgba(239,68,68,0.4);background:rgba(239,68,68,0.1);color:#f87171;cursor:pointer;white-space:nowrap;';
        b1.textContent = '\u2715 Usu\u0144 ' + nomatchCount + ' bez keyword';
        b1.title = 'Usuwa URLe bez keyword, z b\u0142\u0119dnym krajem i z keyword tylko w polecanych artyku\u0142ach';
        b1.addEventListener('click', function() {
          _newsRemoveByStatus(function(u) { return u.status === 'nomatch' || u.status === 'wrongcountry' || u.status === 'teasermatch'; });
        });
        bar.appendChild(b1);
      }
      if (blockedCount > 0) {
        var bblk = document.createElement('button');
        bblk.style.cssText = 'font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid rgba(107,114,128,0.4);background:rgba(107,114,128,0.1);color:#9ca3af;cursor:pointer;white-space:nowrap;';
        bblk.textContent = '\u2715 Usu\u0144 nieprzeskanowane (' + blockedCount + ')';
        bblk.title = 'Usuwa URLe kt\u00f3re wtyczka nie mog\u0142a otworzy\u0107. Mo\u017cesz je sprawdzi\u0107 r\u0119cznie klikaj\u0105c na nie.';
        bblk.addEventListener('click', function() {
          _newsRemoveByStatus(function(u) { return u.status === 'blocked'; });
        });
        bar.appendChild(bblk);
      }
      if (handledCount > 0) {
        var b2 = document.createElement('button');
        b2.style.cssText = 'font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid ' + t.borderSub + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;white-space:nowrap;';
        b2.textContent = '\u2715 Usu\u0144 obsluz. (' + handledCount + ')';
        b2.title = 'Usuwa URLe dodane i bledy';
        b2.addEventListener('click', function() {
          _newsRemoveByStatus(function(u) { return u.status === 'added' || u.status === 'error'; });
        });
        bar.appendChild(b2);
      }
      if ((counts.inproject || 0) > 0) {
        var bip = document.createElement('button');
        bip.style.cssText = 'font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid rgba(100,116,139,0.4);background:rgba(100,116,139,0.1);color:#94a3b8;cursor:pointer;white-space:nowrap;';
        bip.textContent = '\u2715 Usu\u0144 ju\u017c w proj. (' + counts.inproject + ')';
        bip.title = 'Usuwa URLe kt\u00f3re s\u0105 ju\u017c w projekcie w tym miesi\u0105cu';
        bip.addEventListener('click', function() {
          _newsRemoveByStatus(function(u) { return u.status === 'inproject'; });
        });
        bar.appendChild(bip);
      }
      var bcheck = document.createElement('button');
      bcheck.id = 'b24t-news-recheck-btn';
      bcheck.style.cssText = 'font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid ' + t.borderSub + ';background:transparent;color:' + t.textMuted + ';cursor:pointer;white-space:nowrap;';
      bcheck.textContent = '\u21ba Sprawd\u017a w proj.';
      bcheck.title = 'Ponownie sprawdza kt\u00f3re URLe s\u0105 ju\u017c w projekcie (ten miesi\u0105c)';
      bcheck.addEventListener('click', function() { _newsRunProjectCheck(); });
      bar.appendChild(bcheck);
      if (counts.total > 0) {
        var b3 = document.createElement('button');
        b3.style.cssText = 'font-size:10px;padding:3px 9px;border-radius:6px;border:1px solid ' + t.borderSub + ';background:transparent;color:' + t.textFaint + ';cursor:pointer;white-space:nowrap;';
        b3.textContent = '\u2715 Wyczy\u015b\u0107 list\u0119';
        b3.addEventListener('click', function() {
          newsState.urls = []; newsState.activeIdx = -1; renderUrlList();
        });
        bar.appendChild(b3);
      }
    }

    // ─── PROJECT URL CHECK ───
    async function _newsRunProjectCheck() {
      if (!state.projectId) return;
      var recheckBtn = document.getElementById('b24t-news-recheck-btn');
      var projectInfo = document.getElementById('b24t-news-project-info');
      var origLabel = recheckBtn ? recheckBtn.textContent : '';
      if (recheckBtn) { recheckBtn.disabled = true; recheckBtn.textContent = '⟳ Pobieranie…'; }
      if (projectInfo) { projectInfo.textContent = '⟳ Sprawdzam wzmianki w projekcie…'; projectInfo.style.display = ''; projectInfo.style.color = '#a78bfa'; }

      try {
        var now = new Date();
        var dateFrom = _localDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
        var dateTo   = _localDateStr(now);
        var projectUrls = new Set();
        var page = 1;
        var total = null;
        while (true) {
          var res = await getMentions(state.projectId, dateFrom, dateTo, [], page);
          if (!res) break;
          if (total === null) total = res.count || 0;
          var results = res.results || [];
          if (results.length === 0) break;
          results.forEach(function(m) { if (m.url) projectUrls.add(m.url); });
          if (projectUrls.size >= total) break;
          page++;
          if (page > 50) break; // safety cap
        }

        var matchedCount = 0;
        newsState.urls.forEach(function(entry) {
          if (entry.status === 'inproject') entry.status = 'pending'; // reset poprzednich
        });
        newsState.urls.forEach(function(entry) {
          if (projectUrls.has(entry.url)) {
            entry.status = 'inproject';
            matchedCount++;
          }
        });

        var infoMsg = '✓ Projekt: ' + (total || projectUrls.size) + ' wzmianek w tym mies.';
        if (matchedCount > 0) infoMsg += ' — ' + matchedCount + ' URL' + (matchedCount === 1 ? '' : 'i') + ' już w projekcie';
        else infoMsg += ' — żadna nie pokrywa się z listą';
        if (projectInfo) { projectInfo.textContent = infoMsg; projectInfo.style.color = matchedCount > 0 ? '#f59e0b' : '#22c55e'; }
      } catch(e) {
        if (projectInfo) { projectInfo.textContent = '✗ Błąd sprawdzania: ' + e.message; projectInfo.style.color = '#ef4444'; }
      }

      if (recheckBtn) { recheckBtn.disabled = false; recheckBtn.textContent = origLabel; }
      renderUrlList();
    }

    function renderUrlList() {
      var t = _newsThemeVars();
      var list = document.getElementById('b24t-news-url-list');
      var empty = document.getElementById('b24t-news-empty');
      var progressWrap = document.getElementById('b24t-news-progress-wrap');
      var progressBar  = document.getElementById('b24t-news-progress-bar');
      var progressLbl  = document.getElementById('b24t-news-progress-label');
      if (!list) return;
      list.querySelectorAll('.b24t-news-url-row').forEach(function(r) { r.remove(); });

      var pc = _newsProjectCountry();
      var cc = newsState.detectedCountry || 'DEFAULT';
      var chips = _newsGetKeywords(cc);

      // Przelicz tylko statusy 'pending' — nie dotykaj 'scanning' ani gotowych
      newsState.urls.forEach(function(entry) {
        if (entry.status === 'pending') {
          entry.status = _newsUrlRelevant(entry.url, chips, pc);
        }
      });

      _newsUpdateBulkBar();

      // Filter bar — widoczny zawsze gdy są URLe na liście
      var _filterBar = document.getElementById('b24t-news-filter-bar');
      var _filterBtn = document.getElementById('b24t-news-filter-nonarticle');
      var _nonArticleCnt = newsState.urls.filter(function(e) { return e.pageType === 'nonArticle'; }).length;
      if (_filterBar) _filterBar.style.display = newsState.urls.length > 0 ? 'flex' : 'none';
      if (_filterBtn) {
        var _hasNonArticle = _nonArticleCnt > 0;
        _filterBtn.textContent = (newsState.hideNonArticles ? '\u21a9 Poka\u017c wszystkie' : 'Ukryj nie-artyku\u0142y') + ' (' + _nonArticleCnt + ')';
        // 3 stany: wciśnięty (indigo), aktywny z nie-artykułami (amber), nieaktywny (szary)
        if (newsState.hideNonArticles) {
          _filterBtn.style.background  = 'rgba(99,102,241,0.15)';
          _filterBtn.style.color       = '#818cf8';
          _filterBtn.style.borderColor = 'rgba(99,102,241,0.4)';
        } else if (_hasNonArticle) {
          _filterBtn.style.background  = t.yellowBg;
          _filterBtn.style.color       = t.yellow;
          _filterBtn.style.borderColor = 'rgba(245,158,11,0.35)';
        } else {
          _filterBtn.style.background  = 'rgba(107,114,128,0.08)';
          _filterBtn.style.color       = 'rgba(156,163,175,0.5)';
          _filterBtn.style.borderColor = '';
        }
        _filterBtn.style.cursor = _hasNonArticle ? 'pointer' : 'default';
        if (!_filterBtn.dataset.wired) {
          _filterBtn.dataset.wired = '1';
          _filterBtn.addEventListener('click', function() {
            var _cnt = newsState.urls.filter(function(e) { return e.pageType === 'nonArticle'; }).length;
            if (_cnt === 0) return;
            newsState.hideNonArticles = !newsState.hideNonArticles;
            renderUrlList();
          });
        }
      }

      if (newsState.urls.length === 0) {
        if (empty) empty.style.display = '';
        if (progressWrap) progressWrap.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (progressWrap) progressWrap.style.display = '';

      var counts = _newsUrlCounts();

      // Pasek postępu: tryb skanowania vs tryb sesji
      if (newsState.scanning) {
        var total = newsState.scanTotal || 1;
        var done  = newsState.scanDone  || 0;
        if (progressLbl) progressLbl.textContent = 'Skanowanie: ' + done + ' / ' + total;
        if (done === 0) _getBarNews().reset(); else _getBarNews().set(Math.round(done / total * 100));
      } else {
        var handled = (counts.added || 0) + (counts.error || 0);
        var workable = (counts.match || 0) + (counts.keytopic || 0) + (counts.contentmatch || 0) + (counts.mention || 0) + (counts.opened || 0) + handled;
        if (progressLbl) progressLbl.textContent = handled + ' / ' + workable + ' relevantnych';
        _getBarNews().set(workable > 0 ? Math.round(handled / workable * 100) : 0);
      }

      newsState.urls.forEach(function(entry, idx) {
        // Filtr nie-artykułów — ukryj wiersz (nie usuń z listy)
        if (newsState.hideNonArticles && entry.pageType === 'nonArticle') return;

        var isActive    = idx === newsState.activeIdx;
        var sd          = _statusDot(entry.status, entry);
        var isScanning  = entry.status === 'scanning';
        var isIrrelevant = entry.status === 'nomatch' || entry.status === 'wrongcountry' ||
                           entry.status === 'inproject';
        var isTeaserMatch = entry.status === 'teasermatch';
        var isBlocked   = entry.status === 'blocked'; // klikalny — annotator sprawdza ręcznie
        var isStale     = entry.isStale && !isIrrelevant && !isScanning && !isTeaserMatch;
        var isClickable = !isIrrelevant && !isScanning; // teasermatch i blocked są klikalne

        var row = document.createElement('div');
        row.className = 'b24t-news-url-row';
        row.dataset.idx = idx;
        row.style.cssText = [
          'display:flex;flex-direction:column;gap:3px;padding:7px 10px;border-radius:8px;',
          'cursor:' + (isClickable ? 'pointer' : 'default') + ';',
          'border:1px solid ' + (isActive ? 'var(--b24t-primary)' : isScanning ? 'rgba(129,140,248,0.25)' : isBlocked ? 'rgba(107,114,128,0.35)' : t.borderSub) + ';',
          'background:' + (isActive ? t.accentAlpha : (isIrrelevant || isScanning) ? 'transparent' : t.bgDeep) + ';',
          'opacity:' + (isIrrelevant ? '0.4' : isTeaserMatch ? '0.5' : isStale ? '0.55' : (isBlocked || isScanning) ? '0.6' : '1') + ';',
          'transition:background 0.1s,border-color 0.1s;',
        ].join('');
        if (!newsState.scanning) {
          row.style.animation = 'b24t-fadein 0.15s ease ' + Math.min(idx * 30, 240) + 'ms both';
        }
        if (isBlocked) {
          if (entry.blockReason === 'timeout')         row.title = 'Timeout — strona nie odpowiedziała w czasie. Kliknij aby otworzyć ręcznie';
          else if (entry.blockReason === 'error')      row.title = 'Błąd połączenia (DNS, SSL, connection refused). Kliknij aby otworzyć ręcznie';
          else if (entry.blockReason === 'http')       row.title = 'HTTP ' + (entry.httpStatus || '') + ' — serwer odrzucił zapytanie. Kliknij aby otworzyć ręcznie';
          else if (entry.blockReason === 'exception')  row.title = 'Nieoczekiwany błąd podczas skanowania. Kliknij aby otworzyć ręcznie';
          else                                         row.title = 'Wtyczka nie mogła przeskanować — kliknij aby sprawdzić ręcznie';
        }

        var displayUrl = entry.url.replace(/^https?:\/\//, '');

        // Snippet dla wyników content scan
        var snippetHtml = '';
        var _hasSnippet = (entry.status === 'contentmatch' || entry.status === 'mention' || entry.status === 'keytopic') && entry.snippet;
        if (_hasSnippet) {
          snippetHtml = '<div style="font-size:9px;color:' + t.textFaint + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + entry.snippet.replace(/"/g,'&quot;') + '">' + entry.snippet.slice(0,100) + '</div>';
        }

        // Status badge — pierwszy w górnym wierszu
        var _blockedLabel = isBlocked ? (
          entry.blockReason === 'timeout'   ? 'Timeout' :
          entry.blockReason === 'error'     ? 'B\u0142\u0105d sieci' :
          entry.blockReason === 'http'      ? 'HTTP ' + (entry.httpStatus || '') :
          entry.blockReason === 'exception' ? 'B\u0142\u0105d' :
          'Zablokowana'
        ) : 'Zablokowana';
        var _sLabels = { match:'Keyword w URL', keytopic:'G\u0142\u00f3wny temat', contentmatch:'W tre\u015bci', mention:'Wzmianka', teasermatch:'Polecany art.', wrongcountry:'Z\u0142y kraj', opened:'Otwarty', added:'Dodano \u2713', error:'B\u0142\u0105d', inproject:'W projekcie', scanning:'Skanowanie\u2026', blocked:_blockedLabel, nomatch:'Brak keyword' };
        var _sbStyle;
        if (isScanning) {
          _sbStyle = 'background:rgba(129,140,248,0.08);border:1px solid rgba(129,140,248,0.2);color:#818cf8;';
        } else if (entry.status === 'keytopic' || entry.status === 'match') {
          _sbStyle = 'background:rgba(34,197,94,0.10);border:1px solid rgba(34,197,94,0.25);color:#22c55e;';
        } else if (entry.status === 'contentmatch') {
          _sbStyle = 'background:rgba(129,140,248,0.10);border:1px solid rgba(129,140,248,0.25);color:#818cf8;';
        } else if (entry.status === 'mention') {
          _sbStyle = 'background:rgba(251,146,60,0.10);border:1px solid rgba(251,146,60,0.25);color:#fb923c;';
        } else if (entry.status === 'added') {
          _sbStyle = 'background:rgba(21,128,61,0.12);border:1px solid rgba(21,128,61,0.3);color:#15803d;';
        } else if (entry.status === 'error') {
          _sbStyle = 'background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:#ef4444;';
        } else if (entry.status === 'opened') {
          _sbStyle = 'background:rgba(167,139,250,0.10);border:1px solid rgba(167,139,250,0.25);color:#a78bfa;';
        } else {
          _sbStyle = 'background:rgba(107,114,128,0.08);border:1px solid rgba(107,114,128,0.2);color:#9ca3af;';
        }
        var _statusBadgeHtml = '<span style="font-size:8px;padding:1px 6px;border-radius:4px;font-weight:600;flex-shrink:0;' + _sbStyle + '" title="' + sd.label + '">' + sd.dot + ' ' + (_sLabels[entry.status] || entry.status) + '</span>';

        // Pozostałe badże
        var _metaBadges = [];

        if (entry.iframeable === true) {
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.18);color:#818cf8;" title="Podgl\u0105d iframe dost\u0119pny">\u25a2</span>');
        }

        var _chips = entry.matchedChips;
        if (_chips && _chips.length > 0 && entry.status !== 'nomatch' && entry.status !== 'blocked' && entry.status !== 'wrongcountry' && entry.status !== 'inproject') {
          _chips.forEach(function(c) {
            var safe = c.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);color:#a78bfa;font-family:monospace;">' + safe + '</span>');
          });
        }
        if (entry.zoneHints && entry.zoneHints.length > 0) {
          var _hintsLabel = entry.zoneHints.join(', ');
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;' +
            (entry.secondaryZoneOnly
              ? 'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;'
              : 'background:rgba(99,102,241,0.10);border:1px solid rgba(99,102,241,0.25);color:#a78bfa;') +
            '" title="Keyword znaleziony w: ' + _hintsLabel + '">' +
            (entry.secondaryZoneOnly ? '\u26a0 tylko w: ' : '+ ') + _hintsLabel + '</span>');
        }
        if (isTeaserMatch && entry.teaserChips && entry.teaserChips.length > 0) {
          var _tc = entry.teaserChips.map(function(c) { return c.replace(/&/g,'&amp;').replace(/</g,'&lt;'); }).join(', ');
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(107,114,128,0.12);border:1px solid rgba(107,114,128,0.3);color:#9ca3af;" title="Keyword \'' + _tc + '\' wyst\u0105pi\u0142 tylko w sekcji polecanych artyku\u0142\u00f3w \u2014 nie w g\u0142\u00f3wnej tre\u015bci">w polecanym art.</span>');
        }
        var _pt = entry.pageType;
        if (_pt === 'nonArticle') {
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(107,114,128,0.12);border:1px solid rgba(107,114,128,0.3);color:#9ca3af;" title="Brak sygna\u0142\u00f3w \u017ce to artyku\u0142/news (og:type, JSON-LD, published_time, &lt;time&gt;, paragraphs)">\uD83D\uDCC4 nie-artyku\u0142</span>');
        } else if (_pt === 'uncertain') {
          var _sigList = (entry.pageTypeSignals || []).join(', ');
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:#d97706;" title="Tylko 1 sygna\u0142 artyku\u0142u: ' + _sigList + '">? typ niepewny</span>');
        }
        if (entry.articleDate) {
          var _diffD = (Date.now() - new Date(entry.articleDate).getTime()) / 86400000;
          var _dc = _diffD > 60 ? '#f87171' : _diffD > 30 ? '#f59e0b' : '#4ade80';
          var _db = _diffD > 60 ? 'rgba(239,68,68,0.10)' : _diffD > 30 ? 'rgba(245,158,11,0.10)' : 'rgba(34,197,94,0.10)';
          var _dbd = _diffD > 60 ? 'rgba(239,68,68,0.3)' : _diffD > 30 ? 'rgba(245,158,11,0.3)' : 'rgba(34,197,94,0.25)';
          var _staleTitle = _diffD > 60 ? ' \u2014 zbyt stary artyku\u0142 (&gt;60 dni)' : '';
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:' + _db + ';border:1px solid ' + _dbd + ';color:' + _dc + ';" title="Data publikacji' + _staleTitle + '">' + entry.articleDate + '</span>');
        }
        if (entry.pageLang) {
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(99,102,241,0.10);border:1px solid rgba(99,102,241,0.25);color:#a78bfa;" title="Wykryty j\u0119zyk strony">' + entry.pageLang + '</span>');
        }
        if (entry.isPaywall) {
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);color:#f59e0b;" title="Strona za paywallem lub blokad\u0105 \u2014 tre\u015b\u0107 mo\u017ce by\u0107 niepe\u0142na">\uD83D\uDD12 paywall</span>');
        }
        if (entry.aiStatus === 'pending') {
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.2);color:#818cf8;">\u23f3 AI...</span>');
        } else if (entry.aiStatus === 'error') {
          var _aiErrMsg = entry.aiError ? '\uD83E\uDD16 ' + entry.aiError : '\uD83E\uDD16 b\u0142\u0105d';
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);color:#f87171;" title="AI nie mog\u0142o przeanalizowa\u0107 artyku\u0142u \u2014 ' + (entry.aiError || 'nieznany b\u0142\u0105d') + '">' + _aiErrMsg + '</span>');
        } else if (entry.aiStatus === 'done') {
          var _aic  = entry.aiRelevant ? '#22c55e' : '#9ca3af';
          var _aib  = entry.aiRelevant ? 'rgba(34,197,94,0.10)' : 'rgba(107,114,128,0.08)';
          var _aibd = entry.aiRelevant ? 'rgba(34,197,94,0.25)' : 'rgba(107,114,128,0.2)';
          var _ailbl = entry.aiRelevant ? '\uD83E\uDD16 Relevant' : '\uD83E\uDD16 Not relevant';
          var _airsn = (entry.aiReason || '').replace(/"/g, '&quot;');
          _metaBadges.push('<span style="font-size:8px;padding:1px 5px;border-radius:4px;background:' + _aib + ';border:1px solid ' + _aibd + ';color:' + _aic + ';" title="' + _airsn + '">' + _ailbl + '</span>');
        }

        var _delBtnHtml = isScanning ? '' : '<button class="b24t-news-del-btn" style="flex-shrink:0;margin-left:4px;font-size:11px;width:18px;height:18px;line-height:1;border-radius:4px;border:1px solid ' + t.border + ';background:transparent;color:' + t.textFaint + ';cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Usu\u0144 z listy">\u2715</button>';

        row.innerHTML =
          '<div style="display:flex;align-items:flex-start;gap:3px;">' +
            '<div style="flex:1;display:flex;flex-wrap:wrap;gap:3px;align-items:center;">' +
              _statusBadgeHtml + _metaBadges.join('') +
            '</div>' +
            _delBtnHtml +
          '</div>' +
          '<div style="font-size:11px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + t.text + ';" title="' + entry.url.replace(/"/g, '&quot;') + '">' + displayUrl + '</div>' +
          snippetHtml;

        list.appendChild(row);

        if (isClickable) {
          row.addEventListener('click', function(e) {
            if (e.target.classList.contains('b24t-news-del-btn')) return;
            activateUrl(idx);
          });
        }
        var delBtn = row.querySelector('.b24t-news-del-btn');
        if (delBtn) {
          delBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var wasActive = newsState.activeIdx === idx;
            newsState.urls.splice(idx, 1);
            if (wasActive) {
              newsState.activeIdx = -1;
            } else if (newsState.activeIdx > idx) {
              newsState.activeIdx--;
            }
            renderUrlList();
          });
        }
      });
    }


    // ─── ACTIVATE URL ───
    function activateUrl(idx) {
      var entry = newsState.urls[idx];
      if (!entry) return;
      newsState.activeIdx = idx;
      entry.status = 'opened';
      var fUrl = document.getElementById('b24t-news-f-url');
      if (fUrl) fUrl.value = entry.url;
      var pc = projectCountry || _newsProjectCountry();
      var fCountry = document.getElementById('b24t-news-f-country');
      if (fCountry && pc) fCountry.value = pc;
      var _langHintEl = document.getElementById('b24t-news-proj-lang-hint');
      if (_langHintEl) {
        var _expLangs = pc ? (_newsGetLangMap()[pc] || []) : [];
        if (_expLangs.length > 0) {
          _langHintEl.textContent = 'lang: ' + _expLangs.join(', ');
          _langHintEl.style.display = '';
        } else {
          _langHintEl.style.display = 'none';
        }
      }
      var langWarn = document.getElementById('b24t-news-lang-warn');
      var forceBtn = document.getElementById('b24t-news-lang-force-open');
      if (langWarn) { langWarn.style.display = 'none'; langWarn.innerHTML = ''; }
      if (forceBtn) forceBtn.style.display = 'none';
      var subStatus = document.getElementById('b24t-news-submit-status');
      if (subStatus) { subStatus.textContent = ''; subStatus.style.color = ''; }
      renderUrlList();
      // Prefill daty rok+miesiąc natychmiast — GM fetch nadpisze jeśli znajdzie pełną datę
      var _dateElPre = document.getElementById('b24t-news-f-date');
      var _dateIconPre = document.getElementById('b24t-news-date-detect-icon');
      if (_dateElPre) {
        var _now = new Date();
        var _yy = _now.getFullYear();
        var _mm = String(_now.getMonth() + 1).padStart(2, '0');
        _dateElPre.value = _yy + '-' + _mm + '-';
        try { _dateElPre.focus(); _dateElPre.setSelectionRange(_dateElPre.value.length, _dateElPre.value.length); } catch(e) {}
      }
      if (_dateIconPre) { _dateIconPre.style.display = 'none'; }
      // Pre-fill tytułu i snippetu ze skanowania treści (jeśli dostępne)
      var fTitle = document.getElementById('b24t-news-f-title');
      var fContent = document.getElementById('b24t-news-f-content');
      if (fTitle) fTitle.value = entry.title || '';
      if (fContent) fContent.value = entry.snippet || '';
      // Pokaż podgląd w środkowej kolumnie, fetch page info asynchronicznie
      _newsShowPreview(entry);
      _newsFetchPageInfo(entry.url);
    }

    // ─── PREVIEW — iframe lub rich card ───
    function _newsShowPreview(entry) {
      var t = _newsThemeVars();
      var emptyEl    = document.getElementById('b24t-news-preview-empty');
      var headerEl   = document.getElementById('b24t-news-preview-header');
      var urlLabelEl = document.getElementById('b24t-news-preview-url-label');
      var iframeEl   = document.getElementById('b24t-news-iframe');
      var richEl     = document.getElementById('b24t-news-rich-preview');
      var openLinkEl = document.getElementById('b24t-news-preview-open-link');
      var switchBtn  = document.getElementById('b24t-news-preview-switch-rich-btn');
      if (!iframeEl || !richEl) return;

      if (emptyEl) emptyEl.style.display = 'none';
      if (headerEl) headerEl.style.display = 'flex';

      var shortUrl = entry.url.replace(/^https?:\/\//, '');
      if (shortUrl.length > 60) shortUrl = shortUrl.substring(0, 60) + '\u2026';
      if (urlLabelEl) urlLabelEl.textContent = shortUrl;
      if (openLinkEl) openLinkEl.href = entry.url;

      if (switchBtn && !switchBtn.dataset.wired) {
        switchBtn.dataset.wired = '1';
        switchBtn.addEventListener('click', function() {
          if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = ''; }
          var _e = newsState.activeIdx >= 0 ? newsState.urls[newsState.activeIdx] : null;
          if (_e) { _e.iframeable = false; _newsShowRichPreviewCard(_e, t); }
        });
      }

      iframeEl.onload = null;
      iframeEl.onerror = null;
      if (entry.iframeable === true) {
        richEl.style.display = 'none';
        iframeEl.style.display = 'block';
        var _iframeFallback = function() {
          iframeEl.onload = null;
          iframeEl.onerror = null;
          entry.iframeable = false;
          iframeEl.style.display = 'none';
          iframeEl.src = '';
          _newsShowRichPreviewCard(entry, _newsThemeVars());
          renderUrlList();
        };
        iframeEl.onerror = _iframeFallback;
        iframeEl.onload = function() {
          try {
            var doc = iframeEl.contentDocument;
            if (doc && doc.body && doc.body.childElementCount === 0) _iframeFallback();
          } catch(e) { /* cross-origin = załadowano poprawnie */ }
        };
        iframeEl.src = entry.url;
      } else {
        iframeEl.style.display = 'none';
        iframeEl.src = '';
        _newsShowRichPreviewCard(entry, t);
      }

      // Na wąskim ekranie — przełącz na zakładkę Podgląd
      var tabsBarEl = document.getElementById('b24t-news-tabs');
      if (tabsBarEl && tabsBarEl.style.display !== 'none') {
        tabsBarEl.querySelectorAll('.b24t-news-tab').forEach(function(b) {
          var active = b.dataset.tab === 'preview';
          b.classList.toggle('b24t-news-tab-active', active);
          b.style.color = active ? 'var(--b24t-primary)' : t.textMuted;
          b.style.fontWeight = active ? '600' : '500';
          b.style.borderBottom = active ? '2px solid var(--b24t-primary)' : '2px solid transparent';
        });
        var colListEl    = document.getElementById('b24t-news-col-list');
        var colFormEl    = document.getElementById('b24t-news-col-form');
        var colPreviewEl = document.getElementById('b24t-news-col-preview');
        if (colListEl)    { colListEl.style.display = 'none'; colListEl.style.width = '100%'; }
        if (colFormEl)    { colFormEl.style.display = 'none'; colFormEl.style.width = '100%'; }
        if (colPreviewEl) { colPreviewEl.style.display = 'flex'; colPreviewEl.style.width = '100%'; }
      }
    }

    function _newsShowRichPreviewCard(entry, t) {
      var richEl = document.getElementById('b24t-news-rich-preview');
      if (!richEl) return;
      function _esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      var _statusColors = { keytopic: '#22c55e', contentmatch: '#818cf8', mention: '#fb923c', teasermatch: '#9ca3af', blocked: '#9ca3af', opened: '#818cf8' };
      var _statusBgs    = { keytopic: 'rgba(34,197,94,0.12)', contentmatch: 'rgba(129,140,248,0.12)', mention: 'rgba(251,146,60,0.12)', teasermatch: 'rgba(107,114,128,0.10)', blocked: 'rgba(107,114,128,0.10)', opened: 'rgba(99,102,241,0.10)' };
      var _statusLabels = { keytopic: 'Główny temat', contentmatch: 'W treści', mention: 'Wzmianka', teasermatch: 'w polecanych', blocked: 'zablokowany', opened: 'otwarty' };
      var _sc = _statusColors[entry.status] || '#9ca3af';
      var _sb = _statusBgs[entry.status]    || 'rgba(107,114,128,0.10)';
      var _sl = _statusLabels[entry.status] || entry.status || '';
      if (entry.status === 'blocked' && entry.blockReason) {
        if (entry.blockReason === 'timeout')         _sl = 'timeout';
        else if (entry.blockReason === 'error')      _sl = 'błąd sieci';
        else if (entry.blockReason === 'http')       _sl = 'HTTP ' + (entry.httpStatus || '');
        else if (entry.blockReason === 'exception')  _sl = 'błąd';
      }

      var _badges = [];
      if (_sl) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:' + _sb + ';border:1px solid ' + _sc + '33;color:' + _sc + ';font-weight:600;">' + _esc(_sl) + '</span>');
      if (entry.score !== undefined && entry.score > 0) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(107,114,128,0.08);border:1px solid rgba(107,114,128,0.2);color:' + t.textFaint + ';">score ' + entry.score + '</span>');
      if (entry.articleDate) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(107,114,128,0.08);border:1px solid rgba(107,114,128,0.2);color:' + t.textMuted + ';">\uD83D\uDCC5 ' + _esc(entry.articleDate) + '</span>');
      if (entry.pageLang) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);color:#a78bfa;">\uD83C\uDF10 ' + _esc(entry.pageLang) + '</span>');
      if (entry.isPaywall) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);color:#f59e0b;">\uD83D\uDD12 paywall</span>');
      if (entry.pageType === 'nonArticle') _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(107,114,128,0.08);border:1px solid rgba(107,114,128,0.2);color:' + t.textMuted + ';">\uD83D\uDCC4 nie-artyku\u0142</span>');
      if (entry.iframeable === true) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.18);color:#818cf8;" title="Podgl\u0105d iframe dost\u0119pny">▢ iframe</span>');
      if (entry.wordCount > 0) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(107,114,128,0.08);border:1px solid rgba(107,114,128,0.2);color:' + t.textFaint + ';">' + entry.wordCount + ' s\u0142\u00f3w</span>');
      if (entry.zoneHints && entry.zoneHints.length > 0) _badges.push('<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(251,146,60,0.08);border:1px solid rgba(251,146,60,0.25);color:#fb923c;" title="Keyword znaleziony w strefach: ' + _esc(entry.zoneHints.join(', ')) + '">\uD83D\uDCCD ' + _esc(entry.zoneHints[0]) + (entry.zoneHints.length > 1 ? ' +' + (entry.zoneHints.length - 1) : '') + '</span>');

      var _chipHtml = '';
      if (entry.matchedChips && entry.matchedChips.length > 0) {
        _chipHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;">' +
          entry.matchedChips.map(function(c) {
            return '<span style="font-size:10px;padding:2px 8px;border-radius:5px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.28);color:#a78bfa;font-family:monospace;">' + _esc(c) + '</span>';
          }).join('') + '</div>';
      }

      var _snippetText = entry.snippet ? entry.snippet.slice(0, 400) + (entry.snippet.length > 400 ? '\u2026' : '') : '';

      richEl.innerHTML =
        (entry.title ? '<div style="font-size:15px;font-weight:700;line-height:1.4;color:' + t.text + ';margin-bottom:' + (entry.author ? '4px' : '10px') + ';">' + _esc(entry.title) + '</div>' : '<div style="font-size:12px;color:' + t.textFaint + ';margin-bottom:10px;font-style:italic;">Brak tytu\u0142u — artyku\u0142 nie zosta\u0142 jeszcze przeskanowany</div>') +
        (entry.author ? '<div style="font-size:11px;color:' + t.textMuted + ';margin-bottom:10px;">✍ ' + _esc(entry.author) + '</div>' : '') +
        (_badges.length > 0 ? '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;">' + _badges.join('') + '</div>' : '') +
        (_chipHtml ? _chipHtml + '<div style="height:10px;"></div>' : '') +
        (_snippetText ? '<div style="font-size:12px;line-height:1.7;color:' + t.text + ';background:' + t.bgDeep + ';border-radius:8px;padding:10px 12px;border:1px solid ' + t.borderSub + ';margin-bottom:14px;">' + _esc(_snippetText) + '</div>' : '') +
        '<a href="' + _esc(entry.url) + '" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:7px 16px;border-radius:8px;background:var(--b24t-accent-grad);color:#fff;text-decoration:none;font-weight:600;box-shadow:0 2px 8px rgba(99,102,241,0.2);">\u2197 Otw\u00f3rz w nowej karcie</a>';

      richEl.style.display = 'flex';
      richEl.style.flexDirection = 'column';
    }

    // ─── FETCH PAGE INFO (lang + date) ───
    function _newsFetchPageInfo(url) {
      var dateEl = document.getElementById('b24t-news-f-date');
      var dateIcon = document.getElementById('b24t-news-date-detect-icon');
      if (dateIcon) { dateIcon.style.display = 'none'; }
      var pc = _newsProjectCountry();
      var langMap = _newsGetLangMap();
      var expectedLangs = pc ? (langMap[pc] || []) : [];

      function _processHtml(html) {
        // Date detection
        var detectedDate = _newsDetectDateFromHtml(html);
        if (detectedDate && dateEl) {
          dateEl.value = detectedDate;
          if (dateIcon) {
            dateIcon.style.display = 'inline';
            dateIcon.title = 'Data wykryta automatycznie ze strony (' + detectedDate + ') — mozesz ja edytowac';
          }
        }
        // Title — autofill jeśli pole jest puste (nie nadpisuj tego co wkleił użytkownik)
        var fTitleEl = document.getElementById('b24t-news-f-title');
        if (fTitleEl && !fTitleEl.value) {
          try {
            var _doc = (new DOMParser()).parseFromString(html, 'text/html');
            // Tytuł: h1 wewnątrz article/main > meta content_title > og:title > <title>
            var _bz = _doc.querySelector('article') || _doc.querySelector('main') || null;
            var _h1El = _bz ? _bz.querySelector('h1') : _doc.querySelector('h1');
            var _h1Txt = _h1El ? (_h1El.textContent || '').trim() : '';
            var _ctEl = _doc.querySelector('meta[name="content_title"]') || _doc.querySelector('meta[property="content_title"]');
            var _ctTxt = _ctEl ? (_ctEl.getAttribute('content') || '').trim() : '';
            var _ogTEl = _doc.querySelector('meta[property="og:title"]') || _doc.querySelector('meta[name="og:title"]');
            var _ogTxt = _ogTEl ? (_ogTEl.getAttribute('content') || '').trim() : '';
            var _tlEl = _doc.querySelector('title');
            var _pt = (_h1Txt.length > 3 ? _h1Txt : '') || _ctTxt || _ogTxt ||
                      (_tlEl ? (_tlEl.textContent || '').trim() : '');
            if (_pt) fTitleEl.value = _pt.slice(0, 200);
          } catch(e) {}
        }
        // Language check
        var detectedLang = _newsDetectLangFromResponse(html, url);
        var langWarn = document.getElementById('b24t-news-lang-warn');
        var forceBtn = document.getElementById('b24t-news-lang-force-open');
        if (pc && expectedLangs.length > 0 && detectedLang && !expectedLangs.includes(detectedLang)) {
          if (langWarn) {
            langWarn.innerHTML = '<strong>' + detectedLang + '</strong> — oczekiwano: <strong>' + expectedLangs.join(', ') + '</strong> (projekt ' + pc + ')';
            langWarn.innerHTML = '⚠ Wykryty jezyk: ' + langWarn.innerHTML;
            langWarn.style.display = '';
            var addBtn = document.createElement('button');
            addBtn.textContent = '+ Dodaj ' + detectedLang + ' do mapy dla ' + pc;
            addBtn.style.cssText = 'display:inline-block;margin-top:5px;font-size:9px;padding:2px 8px;border-radius:5px;border:1px solid rgba(245,158,11,0.4);background:transparent;color:#f59e0b;cursor:pointer;';
            addBtn.addEventListener('click', function() {
              var m = _newsGetLangMap();
              m[pc] = (m[pc] || []).concat([detectedLang]);
              _newsSaveLangMap(m);
              addBtn.textContent = '✓ Dodano';
              addBtn.disabled = true;
            });
            langWarn.appendChild(addBtn);
          }
          if (forceBtn) forceBtn.style.display = '';
        } else {
          if (langWarn) langWarn.style.display = 'none';
          if (forceBtn) forceBtn.style.display = 'none';
          if (pc && detectedLang && expectedLangs.length === 0) {
            var m = _newsGetLangMap();
            m[pc] = [detectedLang];
            _newsSaveLangMap(m);
          }
        }
      }

      // GM fetch jako fallback dla stron bez bot-protection (Cloudflare itp. zablokuje)
      // Główna metoda to postMessage relay z @match *://*/*
      // Trailing slash tylko gdy URL nie ma rozszerzenia w ścieżce i nie ma już slash-a
      var fetchUrl = (function(u) {
        try {
          var p = new URL(u).pathname;
          // Nie dokładaj slash gdy: już jest, ma rozszerzenie, lub jest query/hash-only
          if (p.endsWith('/') || /\.[a-z]{2,5}$/i.test(p)) return u;
          return u.replace(/([^/?#])([?#]|$)/, '$1/$2');
        } catch(e) { return u; }
      })(url);

      GM_xmlhttpRequest({
        method: 'GET',
        url: fetchUrl,
        timeout: 5000,
        redirect: 'follow',
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        onload: function(resp) {
          var html = resp.responseText || '';
          if (html.length > 100) {
            _processHtml(html);
          }
        },
        onerror: function() {},
        ontimeout: function() {},
      });
    }

    // ── postMessage listener: data z okna artykułu (relay z @match *://*/*) ──
    window.addEventListener('message', function(ev) {
      if (!ev.data || ev.data.type !== 'b24t_news_date') return;
      var date = ev.data.date;
      var url  = ev.data.url;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      // Sprawdź czy aktywny URL pasuje do nadawcy
      var activeEntry = newsState.activeIdx >= 0 ? newsState.urls[newsState.activeIdx] : null;
      if (!activeEntry) return;
      // Porównaj URL (ignoruj trailing slash)
      var normalize = function(u) { return u ? u.replace(/\/+$/, '') : ''; };
      if (url && normalize(url) !== normalize(activeEntry.url)) return;
      var dateEl = document.getElementById('b24t-news-f-date');
      if (!dateEl) return;
      dateEl.value = date;
      var dateIcon = document.getElementById('b24t-news-date-detect-icon');
      if (dateIcon) {
        dateIcon.style.display = 'inline';
        dateIcon.title = 'Data wykryta automatycznie ze strony (' + date + ') — możesz ją edytować';
      }
    }, false);

    // Force open button
    var forceOpenBtn = document.getElementById('b24t-news-lang-force-open');
    if (forceOpenBtn) {
      forceOpenBtn.addEventListener('click', function() {
        var fUrl = document.getElementById('b24t-news-f-url');
        if (fUrl && fUrl.value) _newsOpenUrl(fUrl.value);
        forceOpenBtn.style.display = 'none';
      });
    }

    // ─── IMPORT ───
    var importBtn = document.getElementById('b24t-news-import-btn');
    var pasteArea = document.getElementById('b24t-news-paste-area');
    var importInfo = document.getElementById('b24t-news-import-info');

    // "Opis marki" — show/hide + persystencja per projekt
    (function() {
      var brandSection = document.getElementById('b24t-news-ai-brand-section');
      var brandCtxTA   = document.getElementById('b24t-news-ai-brand-ctx');
      if (!brandSection || !brandCtxTA) return;
      if (_newsAiShouldRun()) {
        brandSection.style.display = '';
        brandCtxTA.value = _newsAiGetBrandCtx(state.projectId);
      }
      brandCtxTA.addEventListener('input', function() {
        _newsAiSetBrandCtx(state.projectId, brandCtxTA.value);
      });
    })();

    async function importUrls() {
      // Blokuj ponowne kliknięcie gdy skanowanie w toku
      if (newsState.scanning) return;

      // Zamknij modal importu — skan odbywa się na żywo w liście
      var _importModal = document.getElementById('b24t-news-import-modal');
      if (_importModal) _importModal.style.display = 'none';

      var raw = pasteArea ? pasteArea.value : '';
      var lines = raw.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return /^https?:\/\//.test(l); });
      var seen = {};
      var deduped = lines.filter(function(u) { if (seen[u]) return false; seen[u] = true; return true; });
      var dupeCount = lines.length - deduped.length;
      if (deduped.length === 0) return;

      newsState.activeIdx = -1;

      // Detekcja kraju
      var tempEntries = deduped.map(function(u) { return { url: u }; });
      var detected = _newsDetectCountryFromUrls(tempEntries);
      newsState.detectedCountry = detected;
      var pc = _newsProjectCountry();
      var cc = detected || 'DEFAULT';
      var chips = _newsGetKeywords(cc);
      _naNewSession(cc);

      // Country badge + warn
      var badgeEl = document.getElementById('b24t-news-country-badge');
      var rowEl   = document.getElementById('b24t-news-country-row');
      var projEl  = document.getElementById('b24t-news-country-proj');
      var warnEl  = document.getElementById('b24t-news-country-warn');
      if (rowEl) rowEl.style.display = detected ? '' : 'none';
      if (badgeEl && detected) badgeEl.textContent = detected;
      if (projEl) projEl.textContent = pc ? '(projekt: ' + pc + ')' : '';
      if (warnEl) {
        if (detected && pc && detected !== pc) {
          warnEl.textContent = '⚠ URLe wskazują kraj ' + detected + ', ale aktywny projekt to ' + pc + '. Sprawdź, czy wklejono właściwe linki.';
          warnEl.style.display = '';
        } else { warnEl.style.display = 'none'; }
      }

      if (pc) {
        var fCountry = document.getElementById('b24t-news-f-country');
        if (fCountry) fCountry.value = pc;
      }

      // Klasyfikacja wstępna — zależna od trybu
      if (_newsImportOpts.urlSimpleMode) {
        // Uproszczone skanowanie: tylko URL, bez wchodzenia na strony
        newsState.urls = deduped.map(function(u) {
          var urlStatus = _newsUrlRelevant(u, chips, pc);
          var urlChips = urlStatus !== 'nomatch'
            ? chips.filter(function(c) { return u.toLowerCase().indexOf(c.toLowerCase()) !== -1; })
            : [];
          return {
            url: u,
            status: urlStatus !== 'nomatch' ? urlStatus : 'nomatch',
            opened: false,
            score: 0,
            snippet: '',
            matchedChips: urlChips,
          };
        });

        renderChips();
        renderUrlList();
        if (pasteArea) pasteArea.value = '';

        var urlMsg = '✓ Wczytano ' + deduped.length + ' URL' + (deduped.length !== 1 ? 'i' : '') + ' (tryb URL)';
        if (dupeCount > 0) urlMsg += ' (usunięto ' + dupeCount + ' duplikat' + (dupeCount === 1 ? '' : dupeCount < 5 ? 'y' : 'ów') + ')';
        if (importInfo) { importInfo.textContent = urlMsg; importInfo.style.display = ''; importInfo.style.color = '#22c55e'; }
        _newsRunProjectCheck();
        return;
      }

      // Domyślne skanowanie: wszystkie URLe trafiają do skanowania treści
      newsState.urls = deduped.map(function(u) {
        return { url: u, status: 'scanning', opened: false, score: 0, snippet: '', matchedChips: [] };
      });

      renderChips();
      renderUrlList();
      if (pasteArea) pasteArea.value = '';

      var toScan = newsState.urls.slice(); // wszystkie do skanowania

      // Skanowanie treści — zablokuj przycisk
      newsState.scanning  = true;
      newsState.scanTotal = toScan.length;
      newsState.scanDone  = 0;
      var _newsBar = document.getElementById('b24t-news-progress-bar');
      if (_newsBar) _newsBar.classList.add('b24t-bar-active');
      if (importBtn) {
        importBtn.disabled = true;
        importBtn.textContent = '⟳ Skanowanie 0/' + toScan.length + '...';
        importBtn.style.opacity = '0.7';
      }
      if (importInfo) { importInfo.textContent = '⟳ Skanuję strony...'; importInfo.style.display = ''; importInfo.style.color = '#a78bfa'; }

      // Sliding window — NEWS_CONTENT_SCAN_CONCURRENCY równoległych workerów
      var nextScanIdx = 0;
      async function _scanWorker() {
        while (true) {
          var i = nextScanIdx++;
          if (i >= toScan.length) break;
          var entry = toScan[i];
          try {
            var result = await _newsContentScan(entry.url, chips);
            // Bug #4: jeśli URL sygnalizuje obcy kraj → nadpisz wynik content scan
            if (result.status !== 'nomatch' && result.status !== 'blocked' && pc) {
              var _urlCountries = _newsCountriesInUrl(entry.url);
              var _urlCountryKeys = Object.keys(_urlCountries);
              if (_urlCountryKeys.length > 0 && !_urlCountries[pc]) {
                result.status = 'wrongcountry';
              }
            }
            // Język strony vs kraj projektu — język musi się zgadzać dokładnie
            if (result.status !== 'nomatch' && result.status !== 'blocked' &&
                result.status !== 'wrongcountry' && result.pageLang && pc) {
              var _expLangs = (_NEWS_LANG_MAP[pc.toLowerCase()] || []);
              if (_expLangs.length > 0 && _expLangs.indexOf(result.pageLang) === -1) {
                result.status = 'wrongcountry';
              }
            }
            // Staleness — data publikacji vs dziś (próg: 60 dni)
            var _isStale = false;
            if (result.articleDate) {
              var _diffDays = (Date.now() - new Date(result.articleDate).getTime()) / 86400000;
              _isStale = _diffDays > 60;
            }
            entry.status             = result.status;
            entry.score              = result.score;
            entry.snippet            = result.snippet;
            entry.title              = result.title || '';
            entry.matchedChips       = result.matchedChips || [];
            entry.secondaryZoneOnly  = result.secondaryZoneOnly || false;
            entry.zoneHints          = result.zoneHints || [];
            entry.teaserMatchOnly    = result.teaserMatchOnly || false;
            entry.teaserChips        = result.teaserChips || [];
            entry.pageType           = result.pageType || 'unknown';
            entry.pageTypeSignals    = result.pageTypeSignals || [];
            entry.pageLang           = result.pageLang || '';
            entry.articleDate        = result.articleDate || null;
            entry.isStale            = _isStale;
            entry.isPaywall          = result.isPaywall || false;
            entry.keywordContexts    = result.keywordContexts || {};
            entry.author             = result.author || '';
            entry.wordCount          = result.wordCount || 0;
            if (result.iframeable !== undefined) entry.iframeable = result.iframeable;
            entry.blockReason = result.blockReason || null;
            entry.httpStatus  = result.httpStatus  || null;
          } catch(e) {
            entry.status = 'blocked'; entry.blockReason = 'exception';
          }
          if (entry.status === 'mention' || entry.status === 'contentmatch' || entry.status === 'keytopic') {
            try { _newsAiAnalyze(entry); } catch(e) {}
          }
          newsState.scanDone++;
          if (importBtn) importBtn.textContent = '⟳ Skanowanie ' + newsState.scanDone + '/' + newsState.scanTotal + '...';
          try { renderUrlList(); } catch(e) {}
        }
      }
      await Promise.all(Array.from({ length: NEWS_CONTENT_SCAN_CONCURRENCY }, _scanWorker));

      // Skanowanie zakończone
      newsState.scanning = false;
      if (_newsBar) _newsBar.classList.remove('b24t-bar-active');
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.textContent = '▶ Skanuj URLe';
        importBtn.style.opacity = '';
      }

      var counts = _newsUrlCounts();
      var matchCount    = counts.match        || 0;
      var keytopicCount = counts.keytopic     || 0;
      var cmCount       = counts.contentmatch || 0;
      var mentionCount  = counts.mention      || 0;
      var blockedCount  = counts.blocked      || 0;
      var doneMsg = '✓ ' + deduped.length + ' URL' + (deduped.length !== 1 ? 'i' : '');
      if (dupeCount > 0) doneMsg += ' (−' + dupeCount + ' dup.)';
      doneMsg += ' — ' + matchCount + ' URL match';
      if (keytopicCount > 0) doneMsg += ', ' + keytopicCount + ' gł. temat' + (keytopicCount > 1 ? 'y' : '');
      if (cmCount > 0)       doneMsg += ', ' + cmCount + ' w treści';
      if (mentionCount > 0)  doneMsg += ', ' + mentionCount + ' wzmiank' + (mentionCount === 1 ? 'a' : 'i');
      if (blockedCount > 0)  doneMsg += ', ' + blockedCount + ' nieprzeskanowanych';
      if (importInfo) { importInfo.textContent = doneMsg; importInfo.style.display = ''; importInfo.style.color = '#22c55e'; }

      renderUrlList();
      _newsRunProjectCheck();
    }

    if (importBtn) importBtn.addEventListener('click', importUrls);
    if (pasteArea) pasteArea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); importUrls(); }
    });

    // Gear button — toggle ustawień importu
    var settingsBtn = document.getElementById('b24t-news-import-settings-btn');
    var settingsPanel = document.getElementById('b24t-news-import-settings');
    if (settingsBtn && settingsPanel) {
      settingsBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var visible = settingsPanel.style.display !== 'none';
        settingsPanel.style.display = visible ? 'none' : '';
        settingsBtn.style.background = visible ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.35)';
      });
    }

    // Checkbox uproszczonego skanowania
    var cbUrlSimple = document.getElementById('b24t-news-opt-urlsimple');
    if (cbUrlSimple) {
      cbUrlSimple.addEventListener('change', function() {
        _newsImportOpts.urlSimpleMode = cbUrlSimple.checked;
        _saveNewsImportOpts();
      });
    }

    // ─── BOTTOM IMPORT BTN ───
    var bottomImportBtn = document.getElementById('b24t-news-bottom-import-btn');
    var _importModalRef = document.getElementById('b24t-news-import-modal');
    if (bottomImportBtn && _importModalRef) {
      bottomImportBtn.addEventListener('click', function() {
        _importModalRef.style.display = 'flex';
        if (_newsChipsRenderer) _newsChipsRenderer();
        var pasteEl = document.getElementById('b24t-news-paste-area');
        if (pasteEl) setTimeout(function() { pasteEl.focus(); }, 50);
      });
    }

    // ─── CLEAR BUTTON ───
    var clearBtn = document.getElementById('b24t-news-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        var el;
        el = document.getElementById('b24t-news-f-title');   if (el) el.value = '';
        el = document.getElementById('b24t-news-f-content'); if (el) el.value = '';
        el = document.getElementById('b24t-news-f-date');    if (el) el.value = '';
        el = document.getElementById('b24t-news-date-detect-icon'); if (el) el.style.display = 'none';
        var subStatus = document.getElementById('b24t-news-submit-status');
        if (subStatus) subStatus.textContent = '';
        var formErr = document.getElementById('b24t-news-form-err');
        if (formErr) formErr.style.display = 'none';
      });
    }

    // ─── SUBMIT ───
    var submitBtn = document.getElementById('b24t-news-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', function() {
        var fUrl     = (document.getElementById('b24t-news-f-url')      || {}).value || '';
        var fTitle   = (document.getElementById('b24t-news-f-title')    || {}).value || '';
        var fContent = (document.getElementById('b24t-news-f-content')  || {}).value || '';
        var fDate    = (document.getElementById('b24t-news-f-date')     || {}).value || '';
        var fHour    = (document.getElementById('b24t-news-f-hour')     || {}).value || '12';
        var fMinute  = (document.getElementById('b24t-news-f-minute')   || {}).value || '00';
        var fSent    = (document.getElementById('b24t-news-f-sentiment')|| {}).value || '0';
        var fCountry = (document.getElementById('b24t-news-f-country')  || {}).value || '';
        var formErr  = document.getElementById('b24t-news-form-err');
        var subStatus= document.getElementById('b24t-news-submit-status');

        function showErr(msg) { if (formErr) { formErr.innerHTML = msg; formErr.style.display = ''; } if (subStatus) subStatus.textContent = ''; }
        function clearErr()   { if (formErr) formErr.style.display = 'none'; }
        clearErr();

        // All fields required
        if (!fUrl)            { showErr('⚠ Brak URL. Wybierz adres z listy.'); return; }
        if (!fTitle.trim())   { showErr('⚠ Tytuł jest wymagany.'); return; }
        if (!fContent.trim()) { showErr('⚠ Treść jest wymagana.'); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fDate)) { showErr('⚠ Nieprawidłowy format daty — wymagany: YYYY-MM-DD'); return; }
        if (_newsGetSessionUrls()[fUrl]) { showErr('⚠ Ten URL był już dodany w tej sesji.'); return; }
        var pc = _newsProjectCountry();
        if (pc && fCountry && fCountry !== pc) { showErr('⚠ Kraj (' + fCountry + ') niezgodny z projektem (' + pc + ').'); return; }

        var sid = state.projectId || '';
        if (!sid) { showErr('⚠ Brak ID projektu. Przejdź na stronę projektu Brand24.'); return; }

        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.6';
        submitBtn.textContent = '⏳ Pobieram token...';

        _newsGetTknB24(function(tkn, tknErr) {
          if (!tkn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '';
            submitBtn.textContent = '✚ Dodaj wzmiankę do Brand24';
            showErr(tknErr || '⚠ Brak tokenu CSRF.');
            return;
          }

        // Zbierz zaznaczone tagi z listy
        var selectedTagIds = [];
        document.querySelectorAll('#b24t-news-tag-list input[type="checkbox"]:checked:not([disabled])').forEach(function(cb) {
          var tid = parseInt(cb.dataset.tagId);
          if (tid) selectedTagIds.push(tid);
        });

        var bodyParts = [
          'tknB24=' + encodeURIComponent(tkn),
          'f=fser',
          'search_id=' + encodeURIComponent(sid),
          'mention_url=' + encodeURIComponent(fUrl),
          'mention_title=' + encodeURIComponent(fTitle),
          'mention_content=' + encodeURIComponent(fContent),
          'mention_category=7',
          'mention_country=' + encodeURIComponent(fCountry),
          'mention_sentiment=' + encodeURIComponent(fSent),
          'mention_created_date_day=' + encodeURIComponent(fDate),
          'mention_created_date_hour=' + encodeURIComponent(fHour),
          'mention_created_date_minute=' + encodeURIComponent(fMinute),
        ];
        selectedTagIds.forEach(function(tid) { bodyParts.push('tag[]=' + encodeURIComponent(tid)); });
        var body = bodyParts.join('&');

        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.6';
        submitBtn.textContent = '⏳ Wysyłam...';

        GM_xmlhttpRequest({
          method: 'POST',
          url: (window.location.hostname.indexOf('brand24.pl') !== -1 ? 'https://panel.brand24.pl' : 'https://app.brand24.com') + '/searches/add-new-mention/?sid=' + sid,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
          data: body,
          onload: function(resp) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '';
            submitBtn.textContent = '✚ Dodaj wzmiankę do Brand24';
            var isDuplicate = resp.responseText && resp.responseText.indexOf('There is the entry with this address') !== -1;
            var isOk = resp.status >= 200 && resp.status < 400 && !isDuplicate;
            if (isDuplicate) {
              _newsMarkSessionUrl(fUrl);
              _naTagOutcome(newsState.urls.find(function(e) { return e.url === fUrl; }), 'duplicate');
              if (subStatus) { subStatus.textContent = '⚠ Brand24: taka wzmianka już istnieje.'; subStatus.style.color = '#f59e0b'; }
              if (newsState.activeIdx >= 0) newsState.urls[newsState.activeIdx].status = 'error';
              var tcD = document.getElementById('b24t-news-f-content');
              var ttD = document.getElementById('b24t-news-f-title');
              var tdD = document.getElementById('b24t-news-f-date');
              if (tcD) tcD.value = '';
              if (ttD) ttD.value = '';
              if (tdD) tdD.value = '';
              var diD = document.getElementById('b24t-news-date-detect-icon');
              if (diD) diD.style.display = 'none';
            } else if (isOk) {
              _newsMarkSessionUrl(fUrl);
              var _naE = newsState.urls.find(function(e) { return e.url === fUrl; });
              _naTagOutcome(_naE, _naE ? 'added' : 'manual_add');
              if (subStatus) { subStatus.textContent = '✓ Dodano do Brand24!'; subStatus.style.color = '#22c55e'; }
              if (newsState.activeIdx >= 0) newsState.urls[newsState.activeIdx].status = 'added';
              var tc = document.getElementById('b24t-news-f-content');
              var tt = document.getElementById('b24t-news-f-title');
              var td = document.getElementById('b24t-news-f-date');
              if (tc) tc.value = '';
              if (tt) tt.value = '';
              if (td) td.value = '';
              var di = document.getElementById('b24t-news-date-detect-icon');
              if (di) di.style.display = 'none';
            } else {
              if (subStatus) { subStatus.textContent = '✗ Błąd HTTP ' + resp.status; subStatus.style.color = '#ef4444'; }
              if (newsState.activeIdx >= 0) newsState.urls[newsState.activeIdx].status = 'error';
              _naTagOutcome(newsState.urls.find(function(e) { return e.url === fUrl; }), 'error');
            }
            renderUrlList();
          },
          onerror: function() {
            submitBtn.disabled = false; submitBtn.style.opacity = ''; submitBtn.textContent = '✚ Dodaj wzmiankę do Brand24';
            if (subStatus) { subStatus.textContent = '✗ Błąd sieci.'; subStatus.style.color = '#ef4444'; }
          },
        });
        }); // closes _newsGetTknB24 callback
      });
    }

    // ─── TAG SELECTOR TOGGLE ───
    (function() {
      var toggle  = document.getElementById('b24t-news-tag-toggle');
      var tagList = document.getElementById('b24t-news-tag-list');
      var chevron = document.getElementById('b24t-news-tag-chevron');
      var summary = document.getElementById('b24t-news-tag-summary');
      if (!toggle || !tagList) return;

      function _updateTagSummary() {
        if (!summary) return;
        var checked = Array.from(tagList.querySelectorAll('input[type="checkbox"]:checked'))
          .map(function(cb) {
            var lbl = cb.closest('label');
            return lbl ? (lbl.querySelector('span') || {}).textContent || '' : '';
          })
          .filter(Boolean);
        summary.textContent = checked.length > 0 ? checked.join(', ') : 'brak';
      }

      toggle.addEventListener('click', function() {
        var isOpen = tagList.style.display !== 'none';
        tagList.style.display = isOpen ? 'none' : 'flex';
        if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
        if (!isOpen) _updateTagSummary();
      });

      // Aktualizuj summary przy zmianie checkboxów
      tagList.addEventListener('change', function() { _updateTagSummary(); });

      // Inicjalny summary po załadowaniu tagów (tagi są już w DOM z _buildNewsPanels)
      requestAnimationFrame(function() { _updateTagSummary(); });
    })();

    // ─── LANG MAP EDITOR ───
    // Initial render
    renderChips();
    var pc2 = _newsProjectCountry();
    var fCountry2 = document.getElementById('b24t-news-f-country');
    if (fCountry2 && pc2) fCountry2.value = pc2;
  }

  function _newsOpenLangMapEditor() {
    if (document.getElementById('b24t-news-lm-overlay')) return;
    var map = _newsGetLangMap();
    var overlay = document.createElement('div');
    overlay.id = 'b24t-news-lm-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:2147483647;display:flex;align-items:center;justify-content:center;';

    function buildContent() {
      var keys = Object.keys(map).sort();
      var rows = keys.length ? keys.map(function(cc) {
        var langs = (map[cc] || []).join(', ');
        return '<tr>' +
          '<td style="padding:5px 8px;font-weight:700;font-size:12px;color:var(--b24t-text);">' + cc + '</td>' +
          '<td style="padding:5px 8px;"><input data-cc="' + cc + '" class="b24t-lm-inp" type="text" value="' + langs + '" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);border-radius:5px;color:var(--b24t-text);font-size:10px;padding:3px 7px;width:130px;"></td>' +
          '<td style="padding:5px 8px;"><button data-cc="' + cc + '" class="b24t-lm-del" style="font-size:9px;padding:2px 7px;border-radius:4px;border:1px solid color-mix(in srgb,var(--b24t-err) 33%,transparent);background:transparent;color:var(--b24t-err);cursor:pointer;">Usuń</button></td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="3" style="padding:16px;text-align:center;font-size:11px;color:var(--b24t-text-faint);">Mapa jest pusta. Zostanie uzupełniona automatycznie z Twojej pracy.</td></tr>';

      return '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:14px;padding:20px;min-width:360px;max-width:440px;max-height:80vh;overflow-y:auto;color:var(--b24t-text);font-family:Geist,\'Segoe UI\',sans-serif;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<span style="font-size:14px;font-weight:700;">⚙ Mapa projekt → języki</span>' +
          '<button id="b24t-lm-close" style="background:transparent;border:none;color:var(--b24t-text-faint);cursor:pointer;font-size:18px;">✕</button>' +
        '</div>' +
        '<p style="font-size:10px;color:var(--b24t-text-faint);margin:0 0 12px;line-height:1.6;">Mapa buduje się automatycznie gdy otwierasz strony z nowych krajów. Możesz ją ręcznie edytować. Jeśli kraj nie ma wpisów — sprawdzanie języka jest pomijane.</p>' +
        '<table style="width:100%;border-collapse:collapse;"><thead><tr>' +
          '<th style="font-size:9px;text-transform:uppercase;color:var(--b24t-text-faint);text-align:left;padding:2px 8px;">Kraj</th>' +
          '<th style="font-size:9px;text-transform:uppercase;color:var(--b24t-text-faint);text-align:left;padding:2px 8px;">Języki (kody, przecinkami)</th>' +
          '<th></th>' +
        '</tr></thead><tbody id="b24t-lm-tbody">' + rows + '</tbody></table>' +
        '<div style="display:flex;gap:6px;margin-top:14px;align-items:center;">' +
          '<input id="b24t-lm-cc" type="text" placeholder="Kraj (np. TR)" maxlength="3" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);border-radius:5px;color:var(--b24t-text);font-size:10px;padding:4px 7px;width:70px;">' +
          '<input id="b24t-lm-langs" type="text" placeholder="Języki (np. tr, az)" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);border-radius:5px;color:var(--b24t-text);font-size:10px;padding:4px 7px;flex:1;">' +
          '<button id="b24t-lm-add" style="font-size:11px;padding:4px 10px;border-radius:6px;border:none;background:var(--b24t-primary);color:#fff;cursor:pointer;">Dodaj</button>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          '<button id="b24t-lm-save" style="font-size:12px;padding:6px 16px;border-radius:8px;border:none;background:var(--b24t-primary);color:#fff;cursor:pointer;font-weight:600;">Zapisz</button>' +
        '</div>' +
      '</div>';
    }

    overlay.innerHTML = buildContent();
    document.body.appendChild(overlay);

    function wire() {
      var closeBtn = overlay.querySelector('#b24t-lm-close');
      var saveBtn  = overlay.querySelector('#b24t-lm-save');
      var addBtn   = overlay.querySelector('#b24t-lm-add');
      if (closeBtn) closeBtn.addEventListener('click', function() { overlay.remove(); });
      if (saveBtn) saveBtn.addEventListener('click', function() {
        overlay.querySelectorAll('.b24t-lm-inp').forEach(function(inp) {
          var langs = inp.value.split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
          map[inp.dataset.cc] = langs;
        });
        _newsSaveLangMap(map);
        overlay.remove();
      });
      if (addBtn) addBtn.addEventListener('click', function() {
        var cc = (overlay.querySelector('#b24t-lm-cc').value || '').toUpperCase().trim();
        var langs = overlay.querySelector('#b24t-lm-langs').value.split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
        if (!cc || !langs.length) return;
        map[cc] = (map[cc] || []).concat(langs.filter(function(l) { return !(map[cc] || []).includes(l); }));
        overlay.querySelector('#b24t-lm-cc').value = '';
        overlay.querySelector('#b24t-lm-langs').value = '';
        overlay.innerHTML = buildContent();
        wire();
      });
      overlay.querySelectorAll('.b24t-lm-del').forEach(function(btn) {
        btn.addEventListener('click', function() {
          delete map[btn.dataset.cc];
          overlay.innerHTML = buildContent();
          wire();
        });
      });
    }
    wire();
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  }





  // ───────────────────────────────────────────
  // CHANGELOG - historia wersji
  // ───────────────────────────────────────────

  // ── CHANGELOG (inline fallback: ostatnie 10 wersji; pełna lista ładowana z repo) ──
  const CHANGELOG_FALLBACK = [
    {
      "version": "0.23.80",
      "date": "2026-05-03",
      "label": "fix",
      "labelColor": "#22c55e",
      "changes": [
        {"type": "fix", "text": "News scan — concurrency 8→5 (mniej agresywne skanowanie równoległe)"},
        {"type": "ux", "text": "rozróżnienie przyczyn zablokowania URL — timeout / HTTP 403/429/5xx / błąd sieci / błąd wewnętrzny"}
      ]
    },
    {
      "version": "0.23.79",
      "date": "2026-04-30",
      "label": "fix",
      "labelColor": "#22c55e",
      "changes": [
        {"type": "fix", "text": "News Analytics — per-sesja confusion matrix zamiast per-rekord; fix wykrywania AI w statystykach (aiStatus teraz odczytywany z live entries na koniec sesji)"},
        {"type": "ux", "text": "zakładka 'News Analytics' (poprzednio 'Statystyki skanowania')"}
      ]
    },
    {
      "version": "0.23.78",
      "date": "2026-04-30",
      "label": "ux",
      "labelColor": "#a78bfa",
      "changes": [
        {"type": "ux", "text": "testowy push zapisuje realistyczne dane analityczne (przykładowa sesja + 5 rekordów z różnymi statusami) zamiast pustego payloadu"}
      ]
    },
    {
      "version": "0.23.77",
      "date": "2026-04-30",
      "label": "ux",
      "labelColor": "#a78bfa",
      "changes": [
        {"type": "ux", "text": "przycisk 'Testowy push' w ⚙ Analityka — weryfikuje zapis pliku na GitHub end-to-end (zapisuje Tagger/statistics/_test_push.json)"}
      ]
    },
    {
      "version": "0.23.76",
      "date": "2026-04-28",
      "label": "fix",
      "labelColor": "#22c55e",
      "changes": [
        {"type": "fix", "text": "News Analytics — karta 'Pozytywne URL' (n= keytopic+contentmatch+mention+match) oddzielona od 'Rekordy w bazie' (wszystkie rekordy łącznie z blocked/error)"},
        {"type": "fix", "text": "News Analytics — retry pending sekwencyjny zamiast równoległego — eliminacja race condition SHA 409 przy słabej sieci"},
        {"type": "fix", "text": "News Analytics — eksport ↓ CSV respektuje aktywny filtr okresu/kraju/projektu (analogicznie do eksportu JSON)"}
      ]
    },
    {
      "version": "0.23.75",
      "date": "2026-04-28",
      "label": "fix",
      "labelColor": "#22c55e",
      "changes": [
        {"type": "fix", "text": "News Analytics — statystyki nie znikają po pushu na GitHub (NA_RECORDS_ARCHIVE, bufor 500 rekordów)"},
        {"type": "fix", "text": "News Analytics — zmiana zakładki przeglądarki nie kończy sesji analitycznej"},
        {"type": "ux", "text": "News Analytics — filtr per projekt w zakładce Statystyki (domyślnie bieżący projekt) + przycisk 🔄 Odśwież"}
      ]
    },
    {
      "version": "0.23.74",
      "date": "2026-04-27",
      "label": "fix",
      "labelColor": "#22c55e",
      "changes": [
        {"type": "fix", "text": "News — adaptacyjny timeout skanowania (p90 historii × 2, min 8s, max 40s) + retry przy timeout zamiast od razu 'zablokowana'"}
      ]
    },
    {
      "version": "0.23.73",
      "date": "2026-04-26",
      "label": "ux",
      "labelColor": "#a78bfa",
      "changes": [
        {"type": "ux", "text": "przycisk 'Testuj połączenie' w ⚙ Analityka — weryfikuje PAT i uprawnienia do zapisu w repo GitHub (✓ OK / ✗ 401 / ✗ 404 / ⚠ brak uprawnień)"}
      ]
    },
    {
      "version": "0.23.72",
      "date": "2026-04-26",
      "label": "feature",
      "labelColor": "#6366f1",
      "changes": [
        {"type": "feat", "text": "News Analytics — Sesja 5: eksport ↓ CSV (surowe rekordy z LS + pending) i ↓ JSON (output _naCompute z aktywnym filtrem) w zakładce Statystyki"}
      ]
    },
    {
      "version": "0.23.71",
      "date": "2026-04-26",
      "label": "feature",
      "labelColor": "#6366f1",
      "changes": [
        {"type": "feat", "text": "News Analytics — zakładka 📊 Statystyki w panelu News: _naRenderStats, _naStatCard, statsOverlay, przycisk 📊 w headerze, zakładka Statystyki w trybie mobilnym, filtry okres + kraj"}
      ]
    },
  ];

  function _fetchChangelog(onDone) {
    const CACHE_KEY = 'b24tagger_cl_cache_' + lsGet(LS.UPDATE_CHANNEL, 'stable');
    const cached = (() => { try { return JSON.parse(sessionStorage.getItem(CACHE_KEY)); } catch(e) { return null; } })();
    if (cached) { onDone(cached); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: getChangelogUrl(),
      headers: { 'Cache-Control': 'no-cache' },
      onload(r) {
        try {
          const data = JSON.parse(r.responseText);
          sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
          onDone(data);
        } catch(e) { onDone(CHANGELOG_FALLBACK); }
      },
      onerror() { onDone(CHANGELOG_FALLBACK); }
    });
  }


  // ───────────────────────────────────────────
  // WHAT'S NEW - modal i przycisk
  // ───────────────────────────────────────────

  function showWelcomePanel() {
    if (lsGet(LS.WELCOME_SHOWN, false)) return;

    const prioMeta = {
      ai:     { color: '#a855f7', label: 'AI' },
      high:   { color: '#f87171', label: 'Krytyczne' },
      medium: { color: '#facc15', label: 'Ważne' },
      low:    { color: '#4ade80', label: 'Nice to have' },
    };

    let plannedHtml =
      '<div style="font-size:13px;font-weight:600;color:#c0c0e0;margin-bottom:12px;line-height:1.6;">Roadmap — v1.0.0 i nowsze</div>';
    PLANNED_FEATURES.forEach(function(f) {
      var pm = prioMeta[f.priority] || { color: '#6060aa' };
      plannedHtml +=
        '<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid #1a1a22;">' +
          '<span style="flex-shrink:0;width:8px;height:8px;border-radius:50%;background:' + pm.color + ';margin-top:5px;"></span>' +
          '<span style="font-size:13px;color:#a0a0cc;line-height:1.6;flex:1;">' + f.text + '</span>' +
        '</div>';
    });
    plannedHtml +=
      '<div style="padding:10px 0 4px;font-size:12px;color:#4a4a66;line-height:1.6;font-style:italic;">' +
        '...i inne funkcje zgłaszane przez użytkowników — masz pomysł lub coś nie działa? Napisz przez formularz Feedback.' +
      '</div>' +
      '<div style="margin-top:14px;padding:14px;background:#1a0d2e;border-radius:8px;border:1px solid #3d1a6e;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<span style="font-size:14px;">✨</span>' +
          '<span style="font-size:11px;font-weight:600;color:#a855f7;letter-spacing:0.06em;">W PLANACH</span>' +
        '</div>' +
        '<div style="font-size:13px;color:#9060cc;line-height:1.6;">Automatyczna klasyfikacja AI — tłumaczenie wzmianek na bieżąco, automatyczna ocena sentymentu i klasyfikacja za pomocą modeli AI.</div>' +
      '</div>';

    var modal = document.createElement('div');
    modal.id = 'b24t-welcome-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;';

    modal.innerHTML =
      '<div style="background:#0f0f13;border:1px solid #2a2a35;border-radius:14px;width:500px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.9);">' +
        // Header
        '<div style="padding:20px 24px 0;flex-shrink:0;border-bottom:1px solid #1e1e28;">' +
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">' +
            '<div style="width:38px;height:38px;background:#6c6cff22;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">🛠️</div>' +
            '<div style="flex:1;">' +
              '<div style="font-size:16px;font-weight:700;color:#e2e2e8;letter-spacing:-0.01em;">B24 Tagger <span style="font-size:11px;color:#6c6cff;letter-spacing:0.08em;font-weight:600;">BETA</span></div>' +
              '<div style="font-size:12px;color:#3a3a55;margin-top:3px;">v' + VERSION + ' · ostatnia wersja przed stabilną</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:2px;margin-bottom:0;">' +
            '<button class="b24t-wp-tab" data-tab="welcome" style="flex:1;background:none;border:none;border-bottom:2px solid #6c6cff;color:#6c6cff;font-size:11px;font-weight:600;padding:8px 4px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px;">👋 Witaj</button>' +
            '<button class="b24t-wp-tab" data-tab="planned" style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#4a4a66;font-size:11px;padding:8px 4px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:5px;">🗓 Planowane</button>' +
          '</div>' +
        '</div>' +
        // Body
        '<div style="overflow-y:auto;flex:1;min-height:0;">' +
          // Tab: Witaj
          '<div id="b24t-wp-welcome" style="padding:24px;">' +
            '<p style="font-size:14px;color:#c0c0e0;line-height:1.8;margin:0 0 14px 0;">' +
              'Wersja <strong style="color:#e2e2e8;">0.21.0</strong> to ostatnia oficjalna wersja przed wydaniem wersji <strong style="color:#6c6cff;">1.0.0 stabilnej</strong>.' +
            '</p>' +
            '<p style="font-size:14px;color:#c0c0e0;line-height:1.8;margin:0 0 14px 0;">' +
              'Od poprzedniej wersji naprawiono kilka błędów związanych z tagowaniem za pomocą pliku.' +
            '</p>' +
            '<p style="font-size:13px;color:#4a4a66;line-height:1.7;margin:0;">' +
              'To okienko pojawi się tylko raz. Co jest planowane na wersję 1.0.0 i nowsze — znajdziesz w zakładce <strong style="color:#6060aa;">Planowane</strong>.' +
            '</p>' +
          '</div>' +
          // Tab: Planowane
          '<div id="b24t-wp-planned" style="display:none;padding:20px 24px;">' + plannedHtml + '</div>' +
        '</div>' +
        // Footer z checkboxem
        '<div style="padding:14px 24px;border-top:1px solid #1a1a22;flex-shrink:0;">' +
          '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:12px;">' +
            '<input type="checkbox" id="b24t-wp-checkbox" style="width:16px;height:16px;cursor:pointer;accent-color:#6c6cff;">' +
            '<span style="font-size:13px;color:#6060aa;">Przeczytałem/am</span>' +
          '</label>' +
          '<button id="b24t-wp-close" disabled style="width:100%;background:#2a2a3a;color:#4a4a66;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:not-allowed;font-family:inherit;transition:background 0.2s,color 0.2s;">Zamknij</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    // Tab switching
    modal.querySelectorAll('.b24t-wp-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        modal.querySelectorAll('.b24t-wp-tab').forEach(function(b) {
          b.style.borderBottomColor = 'transparent';
          b.style.color = '#4a4a66';
          b.style.fontWeight = 'normal';
        });
        btn.style.borderBottomColor = '#6c6cff';
        btn.style.color = '#6c6cff';
        btn.style.fontWeight = '600';
        document.getElementById('b24t-wp-welcome').style.display = btn.dataset.tab === 'welcome' ? 'block' : 'none';
        document.getElementById('b24t-wp-planned').style.display = btn.dataset.tab === 'planned' ? 'block' : 'none';
      });
    });

    // Checkbox enables close button
    document.getElementById('b24t-wp-checkbox').addEventListener('change', function() {
      var btn = document.getElementById('b24t-wp-close');
      if (this.checked) {
        btn.disabled = false;
        btn.style.background = '#6c6cff';
        btn.style.color = '#fff';
        btn.style.cursor = 'pointer';
      } else {
        btn.disabled = true;
        btn.style.background = '#2a2a3a';
        btn.style.color = '#4a4a66';
        btn.style.cursor = 'not-allowed';
      }
    });

    document.getElementById('b24t-wp-close').addEventListener('click', function() {
      if (!document.getElementById('b24t-wp-checkbox').checked) return;
      lsSet(LS.WELCOME_SHOWN, true);
      modal.remove();
    });
  }

  // ───────────────────────────────────────────
  // FEEDBACK & PLANNED FEATURES
  // ───────────────────────────────────────────

  // ───────────────────────────────────────────
  // KONFIGURACJA — uzupełnij przed użyciem
  // ───────────────────────────────────────────
  // Slack Webhook URL — przechowywany w localStorage (klucz: b24tagger_slack_webhook)
  // Ustaw raz w konsoli: localStorage.setItem('b24tagger_slack_webhook', 'https://hooks.slack.com/...')
  const SLACK_WEBHOOK_URL = localStorage.getItem('b24tagger_slack_webhook') || '';
  const RAW_URL_STABLE       = 'https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js';
  const RAW_URL_EXPERIMENTAL = 'https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/experimental/b24tagger.user.js';
  const CHANGELOG_URL_STABLE       = 'https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/CHANGELOG.json';
  const CHANGELOG_URL_EXPERIMENTAL = 'https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/experimental/CHANGELOG.json';
  function getRawUrl() { return lsGet(LS.UPDATE_CHANNEL, 'stable') === 'experimental' ? RAW_URL_EXPERIMENTAL : RAW_URL_STABLE; }
  function getChangelogUrl() { return lsGet(LS.UPDATE_CHANNEL, 'stable') === 'experimental' ? CHANGELOG_URL_EXPERIMENTAL : CHANGELOG_URL_STABLE; }

  // Google Forms — bug report i feedback
  const BUG_FORM_BASE = 'https://docs.google.com/forms/d/e/1FAIpQLSdfddWBtp-0ZiMP5u51vaQmNvIg423MyjOzQdMZb6BEyCe0GA/viewform';
  const FEEDBACK_FORM_BASE = 'https://docs.google.com/forms/d/e/1FAIpQLSf4K3JMmR8vhFcs4DL14E91GpEd9YNCNm6uS0afbdm7kSBHpg/viewform';
  const FEEDBACK_FORM_FIELDS = {
    suggestion: 'entry.1001511860',
    type:       'entry.2053499490',
    version:    'entry.1295392049',
    project:    'entry.1925108405',
  };

  const BUG_FORM_FIELDS = {
    version:   'entry.769760752',
    project:   'entry.668506048',
    url:       'entry.1459869471',
    logs:      'entry.1505126804',
    datetime:  'entry.1776456134',
  };

  // Planned features list
  const PLANNED_FEATURES = [
    { priority: 'high', text: 'Panel postępu tagowania — widoczny kafelek z liczbą pozostałych wzmianek, paskiem ukończenia i procentem postępu' },
    { priority: 'high', text: 'Tryb domykania miesiąca — zamknięcie wszystkich projektów jednym kliknięciem z automatycznym oznaczeniem jako ukończone' },
    { priority: 'high', text: 'Czyszczenie tagów plikiem — naprawa funkcji usuwania tagów na podstawie dostarczonego pliku CSV' },
  ];

  function sendToSlack(payload, onSuccess, onError) {
    if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === 'TWOJ_SLACK_WEBHOOK_URL') {
      addLog('⚠ Feedback nie skonfigurowany — brak Slack Webhook URL', 'warn');
      onError('not configured');
      return;
    }
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'POST', url: SLACK_WEBHOOK_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload: function(r) { r.status === 200 ? onSuccess() : onError(r.status); },
        onerror: function() { onError('network'); }
      });
    } else {
      fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function() { onSuccess(); }).catch(function() { onError('fetch'); });
    }
  }

  function openFeedbackForm(suggestion) {
    var project = (state.projectName || '') + (state.projectId ? ' (' + state.projectId + ')' : '');
    var params = [
      FEEDBACK_FORM_FIELDS.suggestion + '=' + encodeURIComponent(suggestion || ''),
      FEEDBACK_FORM_FIELDS.version    + '=' + encodeURIComponent(VERSION),
      FEEDBACK_FORM_FIELDS.project    + '=' + encodeURIComponent(project),
    ].join('&');
    window.open(FEEDBACK_FORM_BASE + '?' + params, '_blank');
  }

  function openBugReportForm(description) {
    var data = buildBugReportData();
    var logs = data.recentLogs.slice(-20).join('\n');
    var project = (data.projectName || '') + (data.projectId ? ' (' + data.projectId + ')' : '');
    var dt = data.localTime || new Date().toLocaleString('pl-PL');
    var params = [
      'entry.378076813'        + '=' + encodeURIComponent(description || ''),
      BUG_FORM_FIELDS.version  + '=' + encodeURIComponent(data.version || VERSION),
      BUG_FORM_FIELDS.project  + '=' + encodeURIComponent(project),
      BUG_FORM_FIELDS.url      + '=' + encodeURIComponent(data.url || window.location.href),
      BUG_FORM_FIELDS.logs     + '=' + encodeURIComponent(logs.substring(0, 2000)),
      BUG_FORM_FIELDS.datetime + '=' + encodeURIComponent(dt),
    ].join('&');
    window.open(BUG_FORM_BASE + '?' + params, '_blank');
  }

  function sendBugReport(description, onDone) {
    const data = buildBugReportData();
    const logsText = data.recentLogs.join('\n');
    const statsText = data.stats
      ? 'Otagowane: ' + data.stats.tagged + ' | Pominięte: ' + data.stats.skipped + ' | Brak matcha: ' + data.stats.noMatch
      : '—';
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: '🐛 B24 Tagger BETA — Bug Report', emoji: true } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Wersja:*\n`' + data.version + '`' },
        { type: 'mrkdwn', text: '*Czas:*\n' + data.localTime },
        { type: 'mrkdwn', text: '*Projekt:*\n' + (data.projectName || '—') + (data.projectId ? ' (`' + data.projectId + '`)' : '') },
        { type: 'mrkdwn', text: '*Status sesji:*\n`' + data.sessionStatus + '`' + (data.testRunMode ? ' (Test Run)' : '') },
        { type: 'mrkdwn', text: '*Token:*\n' + (data.hasToken ? '✅ aktywny' : '❌ brak') },
        { type: 'mrkdwn', text: '*Plik:*\n' + (data.fileName ? '`' + data.fileName + '`' : '—') + (data.fileRows ? ' (' + data.fileRows + ' wierszy)' : '') },
      ]},
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Statystyki:*\n' + statsText },
        { type: 'mrkdwn', text: '*Mapa URL:*\n' + data.urlMapSize + ' wzmianek' },
        { type: 'mrkdwn', text: '*URL:*\n`' + data.url.substring(0, 80) + '`' },
        { type: 'mrkdwn', text: '*Screen:*\n' + data.screen },
      ]},
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*📝 Opis problemu:*\n' + (description || '_(brak opisu)_') } },
      { type: 'section', text: { type: 'mrkdwn', text: '*📋 Ostatnie logi (30):*\n```' + (logsText.substring(0, 2800) || '—') + '```' } },
    ];
    if (data.crashLog) {
      const cl = data.crashLog;
      const sessionInfo = cl.session
        ? 'Status: `' + cl.session.status + '` | Partycja: ' + (cl.session.currentPartitionIdx !== null ? cl.session.currentPartitionIdx + '/' + (cl.session.totalPartitions || '?') : '—') +
          (cl.session.currentPartitionRange ? ' (' + cl.session.currentPartitionRange + ')' : '') +
          '\nTest Run: ' + (cl.session.testRunMode ? 'tak' : 'nie') + ' | Mapa: ' + (cl.urlMapSize || 0) + ' wzmianek'
        : '—';
      blocks.push({ type: 'section', fields: [
        { type: 'mrkdwn', text: '*💥 Typ błędu:*\n`' + (cl.errorType || '—') + '`' },
        { type: 'mrkdwn', text: '*⏱ Czas crashu:*\n' + (cl.localTime || '—') },
        { type: 'mrkdwn', text: '*🔧 Ostatnia akcja:*\n`' + (cl.lastAction || '—') + '`' },
        { type: 'mrkdwn', text: '*🔄 Możliwe wznowienie:*\n' + (cl.recoverable ? '✅ tak' : '❌ nie') },
      ]});
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*📊 Stan sesji przy crashu:*\n' + sessionInfo } });
      if (cl.lastMatchLog) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*🔗 Ostatni wpis match:*\n`' + cl.lastMatchLog.substring(0, 200) + '`' } });
      }
      if (cl.stack) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*📋 Stack trace:*\n```' + cl.stack + '```' } });
      }
    }
    blocks.push({ type: 'divider' });
    sendToSlack({ blocks }, onDone, function(err) { addLog('⚠ Błąd wysyłki Bug Report: ' + err, 'warn'); });
  }

  function sendSuggestion(text, onDone) {
    const payload = { blocks: [
      { type: 'header', text: { type: 'plain_text', text: '💡 B24 Tagger BETA — Suggestion', emoji: true } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Wersja:*\n`' + VERSION + '`' },
        { type: 'mrkdwn', text: '*Czas:*\n' + new Date().toLocaleString('pl-PL') },
        { type: 'mrkdwn', text: '*Projekt:*\n' + (state.projectName || '—') },
      ]},
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*💡 Sugestia:*\n' + (text || '_(brak tekstu)_') } },
      { type: 'divider' },
    ]};
    sendToSlack(payload, onDone, function(err) { addLog('⚠ Błąd wysyłki Suggestion: ' + err, 'warn'); });
  }

  // What's New modal - extended with tabs (Co nowego / Planowane / Feedback)
  function showWhatsNewExtended(forceShow) {
    const seenVersion = lsGet('b24tagger_seen_version', '');
    if (!forceShow && seenVersion === VERSION) return;

    const typeIcon = { new: '✦', fix: '⚒', perf: '⚡', ui: '◈', feat: '✦' };
    const typeColor = { new: '#6c6cff', fix: '#4ade80', perf: '#facc15', ui: '#b0b0cc', feat: '#06b6d4' };

    const labelColorFallback = { ui: '#8b5cf6', fix: '#22c55e', feat: '#06b6d4', new: '#6c6cff', perf: '#facc15' };

    function _buildChangelogHtml(entries) {
      let html = '';
      entries.forEach(function(v, idx) {
        const isLatest = idx === 0;
        const lc = v.labelColor || labelColorFallback[v.label] || '#8b5cf6';
        const normalizedChanges = v.changes.map(function(c) {
          return (typeof c === 'string') ? { type: v.label || 'new', text: c } : c;
        });
        html +=
          '<div style="margin-bottom:' + (idx < entries.length - 1 ? '20' : '0') + 'px;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
              '<span style="font-size:15px;font-weight:700;color:var(--b24t-text);font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;">v' + v.version + '</span>' +
              '<span style="font-size:12px;font-weight:600;background:' + lc + '22;color:' + lc + ';padding:2px 10px;border-radius:99px;">' + v.label + '</span>' +
              '<span style="font-size:11px;color:var(--b24t-text-faint);margin-left:auto;">' + v.date + '</span>' +
            '</div>' +
            '<div style="' + (isLatest ? '' : 'opacity:0.6;') + '">' +
            normalizedChanges.map(function(ch) {
              return '<div style="display:flex;gap:8px;align-items:flex-start;padding:3px 0;">' +
                '<span style="flex-shrink:0;font-size:15px;color:' + (typeColor[ch.type] || '#9090aa') + ';width:18px;text-align:center;line-height:1;">' + (typeIcon[ch.type] || '•') + '</span>' +
                '<span style="font-size:13px;color:var(--b24t-text-muted);line-height:1.6;">' + ch.text + '</span>' +
              '</div>';
            }).join('') +
            '</div>' +
          '</div>' +
          (idx < entries.length - 1 ? '<div style="height:1px;background:var(--b24t-border-sub);margin:0 0 20px 0;"></div>' : '');
      });
      return html;
    }

    // Render with fallback, then update when fetch completes
    let changelogHtml = _buildChangelogHtml(CHANGELOG_FALLBACK);

    // Build planned features HTML
    const prioMeta = {
      ai:     { color: '#a855f7', label: 'AI',     desc: 'AI / flagowa' },
      high:   { color: '#f87171', label: 'Wysoki', desc: 'priorytet wysoki' },
      medium: { color: '#facc15', label: 'Średni', desc: 'priorytet średni' },
      low:    { color: '#4ade80', label: 'Niski',  desc: 'priorytet niski' },
    };
    let plannedHtml =
      '<div style="font-size:13px;font-weight:600;color:var(--b24t-text-muted);margin-bottom:12px;line-height:1.6;">Roadmap — v1.0.0 i nowsze</div>';
    PLANNED_FEATURES.forEach(function(f) {
      const pm = prioMeta[f.priority] || { color: '#6060aa' };
      plannedHtml +=
        '<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--b24t-border-sub);">' +
          '<span style="flex-shrink:0;width:8px;height:8px;border-radius:50%;background:' + pm.color + ';margin-top:5px;"></span>' +
          '<span style="font-size:13px;color:var(--b24t-text-muted);line-height:1.6;flex:1;">' + f.text + '</span>' +
        '</div>';
    });
    plannedHtml +=
      '<div style="padding:10px 0 4px;font-size:12px;color:var(--b24t-text-faint);line-height:1.6;font-style:italic;">' +
        '...i inne funkcje zgłaszane przez użytkowników — masz pomysł lub coś nie działa? Napisz przez formularz Feedback.' +
      '</div>' +
      '<div style="margin-top:14px;padding:14px;background:rgba(168,85,247,0.08);border-radius:8px;border:1px solid rgba(168,85,247,0.25);">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<span style="font-size:14px;">✨</span>' +
          '<span style="font-size:11px;font-weight:600;color:#a855f7;letter-spacing:0.06em;">W PLANACH</span>' +
        '</div>' +
        '<div style="font-size:13px;color:#a855f7;opacity:0.75;line-height:1.6;">Automatyczna klasyfikacja AI — tłumaczenie wzmianek na bieżąco, automatyczna ocena sentymentu i klasyfikacja za pomocą modeli AI.</div>' +
      '</div>';

    const modal = document.createElement('div');
    modal.id = 'b24t-whats-new-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;';

    modal.innerHTML =
      // Outer container - wider, flex column
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:14px;width:520px;max-height:86vh;display:flex;flex-direction:column;box-shadow:var(--b24t-shadow-h);">' +

        // ── HEADER (gradient) ─────────────────────────────────────────────
        '<div style="padding:10px 14px;background:var(--b24t-accent-grad);border-radius:14px 14px 0 0;overflow:hidden;display:flex;align-items:center;flex-shrink:0;gap:10px;">' +
          '<div style="width:32px;height:32px;background:rgba(255,255,255,0.18);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">🚀</div>' +
          '<div style="flex:1;">' +
            '<div style="font-size:14px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.2);">B24 Tagger <span style="font-size:10px;font-weight:600;letter-spacing:0.08em;opacity:0.85;">BETA</span></div>' +
            '<div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:1px;">v' + VERSION + ' · Dziennik zmian</div>' +
          '</div>' +
          '<button id="b24t-wnm-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;cursor:pointer;font-size:15px;line-height:1;padding:2px 7px;border-radius:5px;flex-shrink:0;">\u00d7</button>' +
        '</div>' +
        // ── TABS ──────────────────────────────────────────────────────────
        '<div style="display:flex;background:var(--b24t-bg-elevated);border-bottom:1px solid var(--b24t-border);padding:0 4px;flex-shrink:0;">' +
          '<button class="b24t-wnm-tab" data-tab="news" ' +
            'style="flex:1;background:none;border:none;border-bottom:2px solid var(--b24t-primary);color:var(--b24t-primary);' +
            'font-size:11px;font-weight:600;padding:8px 4px;cursor:pointer;font-family:inherit;' +
            'display:flex;align-items:center;justify-content:center;gap:5px;">📋 Historia zmian</button>' +
          '<button class="b24t-wnm-tab" data-tab="planned" ' +
            'style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:var(--b24t-text-faint);' +
            'font-size:11px;padding:8px 4px;cursor:pointer;font-family:inherit;' +
            'display:flex;align-items:center;justify-content:center;gap:5px;">🗓 Planowane</button>' +
        '</div>' +

        // ── BODY (scrollable) ─────────────────────────────────────────────
        '<div style="overflow-y:auto;flex:1;min-height:0;background:var(--b24t-bg);" id="b24t-wnm-body">' +

          // Tab: Co nowego
          '<div id="b24t-wnm-news" style="padding:20px 24px;">' + changelogHtml + '</div>' +

          // Tab: Planowane
          '<div id="b24t-wnm-planned" style="display:none;padding:20px 24px;">' + plannedHtml + '</div>' +

        '</div>' +

        // ── FOOTER ────────────────────────────────────────────────────────
        '<div style="padding:10px 20px;border-top:1px solid var(--b24t-border);flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
          // Lewa strona: legenda
          '<div id="b24t-wnm-legend" style="display:flex;gap:8px;font-size:11px;color:var(--b24t-text-faint);">' +
            '<span title="Nowa funkcja"><span style="color:#6c6cff;">✦</span> nowe</span>' +
            '<span title="Naprawa błędu"><span style="color:#4ade80;">⚒</span> fix</span>' +
            '<span title="Wydajność"><span style="color:#facc15;">⚡</span> perf</span>' +
            '<span title="Interfejs"><span style="color:#8080aa;">◈</span> UI</span>' +
          '</div>' +
          // Prawa strona: Gotowe
          '<button id="b24t-wnm-ok" ' +
            'style="background:var(--b24t-primary);color:#fff;border:none;border-radius:7px;padding:8px 24px;' +
            'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">Gotowe</button>' +
        '</div>' +

      '</div>';

    document.body.appendChild(modal);

    // Fetch full changelog in background — update news tab if modal still open
    _fetchChangelog(function(entries) {
      const newsEl = document.getElementById('b24t-wnm-news');
      if (newsEl && document.getElementById('b24t-whats-new-modal')) {
        newsEl.innerHTML = _buildChangelogHtml(entries);
      }
    });

    // Tab switching
    const legend = document.getElementById('b24t-wnm-legend');
    modal.querySelectorAll('.b24t-wnm-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        modal.querySelectorAll('.b24t-wnm-tab').forEach(function(b) {
          b.style.borderBottomColor = 'transparent';
          b.style.color = 'var(--b24t-text-faint)';
          b.style.fontWeight = 'normal';
          b.style.fontSize = '13px';
        });
        btn.style.borderBottomColor = 'var(--b24t-primary)';
        btn.style.color = 'var(--b24t-primary)';
        btn.style.fontWeight = '600';
        btn.style.fontSize = '13px';
        ['news','planned'].forEach(function(t) {
          document.getElementById('b24t-wnm-' + t).style.display = btn.dataset.tab === t ? 'block' : 'none';
        });
        if (legend) legend.style.display = btn.dataset.tab === 'news' ? 'flex' : 'none';
      });
    });

    function closeWnm() {
      lsSet('b24tagger_seen_version', VERSION);
      modal.remove();
    }
    document.getElementById('b24t-wnm-close').addEventListener('click', closeWnm);
    document.getElementById('b24t-wnm-ok').addEventListener('click', closeWnm);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeWnm(); });
  }

  function showFeedbackModal() {
    if (document.getElementById('b24t-feedback-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'b24t-feedback-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;animation:b24t-fadein 0.2s ease;';

    modal.innerHTML =
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:14px;width:440px;max-height:86vh;display:flex;flex-direction:column;box-shadow:var(--b24t-shadow-h);animation:b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:10px 14px;background:var(--b24t-accent-grad);border-radius:14px 14px 0 0;display:flex;align-items:center;flex-shrink:0;gap:10px;">' +
          '<div style="width:32px;height:32px;background:rgba(255,255,255,0.18);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">💬</div>' +
          '<div style="flex:1;">' +
            '<div style="font-size:14px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.2);">Feedback</div>' +
            '<div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:1px;">B24 Tagger v' + VERSION + '</div>' +
          '</div>' +
          '<button id="b24t-fb-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;cursor:pointer;font-size:15px;line-height:1;padding:2px 7px;border-radius:5px;flex-shrink:0;">\u00d7</button>' +
        '</div>' +
        '<div style="overflow-y:auto;flex:1;min-height:0;padding:20px 24px;">' +
          '<div style="border:1px solid rgba(248,113,113,0.25);border-radius:10px;background:var(--b24t-bg-elevated);margin-bottom:12px;overflow:hidden;">' +
            '<div style="padding:14px 16px;border-bottom:1px solid rgba(248,113,113,0.15);display:flex;align-items:center;gap:10px;">' +
              '<div style="width:30px;height:30px;background:rgba(248,113,113,0.12);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">🐛</div>' +
              '<div>' +
                '<div style="font-size:13px;font-weight:700;color:#f87171;">Bug Report</div>' +
                '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:1px;">Wersja, projekt, URL i logi wypełniają się automatycznie</div>' +
              '</div>' +
            '</div>' +
            '<div style="padding:12px 16px;">' +
              '<div style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:8px;">Opisz problem:</div>' +
              '<textarea id="b24t-fb-bugs" placeholder="Co się stało? Kiedy wystąpił błąd? Jakie kroki doprowadziły do problemu?" style="width:100%;height:80px;background:var(--b24t-bg-deep);border:1px solid var(--b24t-border);border-radius:6px;color:var(--b24t-text-muted);font-family:inherit;font-size:12px;padding:8px 10px;resize:none;box-sizing:border-box;outline:none;line-height:1.5;"></textarea>' +
              '<button id="b24t-fb-send-bug" style="width:100%;margin-top:8px;background:#f87171;color:#fff;border:none;border-radius:7px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Otwórz formularz Bug Report →</button>' +
            '</div>' +
          '</div>' +
          '<div style="border:1px solid var(--b24t-border);border-radius:10px;background:var(--b24t-bg-elevated);overflow:hidden;">' +
            '<div style="padding:14px 16px;border-bottom:1px solid var(--b24t-border-sub);display:flex;align-items:center;gap:10px;">' +
              '<div style="width:30px;height:30px;background:rgba(108,108,255,0.12);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">💡</div>' +
              '<div>' +
                '<div style="font-size:13px;font-weight:700;color:var(--b24t-primary);">Suggestion</div>' +
                '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:1px;">Pomysł na nową funkcję lub ulepszenie</div>' +
              '</div>' +
            '</div>' +
            '<div style="padding:12px 16px;">' +
              '<div style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:8px;">Twój pomysł:</div>' +
              '<textarea id="b24t-fb-ideas" placeholder="Jaka funkcja by Ci się przydała? Jak powinna działać?" style="width:100%;height:80px;background:var(--b24t-bg-deep);border:1px solid var(--b24t-border);border-radius:6px;color:var(--b24t-text-muted);font-family:inherit;font-size:12px;padding:8px 10px;resize:none;box-sizing:border-box;outline:none;line-height:1.5;"></textarea>' +
              '<button id="b24t-fb-send-suggest" style="width:100%;margin-top:8px;background:var(--b24t-primary);color:#fff;border:none;border-radius:7px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Otwórz formularz Feedback →</button>' +
            '</div>' +
          '</div>' +
          '<div id="b24t-fb-status" style="font-size:11px;min-height:14px;margin-top:10px;text-align:center;"></div>' +
          '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--b24t-border-sub);text-align:center;">' +
            '<button id="b24t-fb-reset-onboarding" style="background:none;border:none;color:var(--b24t-text-faint);font-size:10px;cursor:pointer;font-family:inherit;letter-spacing:0.03em;padding:4px 10px;border-radius:4px;transition:color 0.2s;opacity:0.5;">\u21ba Powtórz onboarding</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    function close() { modal.remove(); }
    document.getElementById('b24t-fb-close').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    document.getElementById('b24t-fb-send-bug').addEventListener('click', function() {
      const statusEl = document.getElementById('b24t-fb-status');
      const bugs = document.getElementById('b24t-fb-bugs').value.trim();
      if (!bugs) { if (statusEl) { statusEl.textContent = '\u26a0 Opisz problem przed wysłaniem'; statusEl.style.color = '#facc15'; } return; }
      openBugReportForm(bugs);
      addLog('\u2713 Formularz Bug Report otwarty w nowej karcie', 'success');
      if (statusEl) { statusEl.textContent = '\u2713 Formularz otwarty — opisz błąd i wyślij!'; statusEl.style.color = '#4ade80'; }
      setTimeout(close, 2000);
    });

    document.getElementById('b24t-fb-send-suggest').addEventListener('click', function() {
      const statusEl = document.getElementById('b24t-fb-status');
      const ideas = document.getElementById('b24t-fb-ideas').value.trim();
      if (!ideas) { if (statusEl) { statusEl.textContent = '\u26a0 Wpisz swój pomysł'; statusEl.style.color = '#facc15'; } return; }
      openFeedbackForm(ideas);
      addLog('\u2713 Formularz Feedback otwarty w nowej karcie', 'success');
      if (statusEl) { statusEl.textContent = '\u2713 Formularz otwarty — opisz pomysł i wyślij!'; statusEl.style.color = '#4ade80'; }
      setTimeout(close, 2000);
    });

    const fbResetOb = document.getElementById('b24t-fb-reset-onboarding');
    if (fbResetOb) {
      fbResetOb.addEventListener('mouseenter', function() { this.style.color = 'var(--b24t-primary)'; this.style.opacity = '1'; });
      fbResetOb.addEventListener('mouseleave', function() { this.style.color = 'var(--b24t-text-faint)'; this.style.opacity = '0.5'; });
      fbResetOb.addEventListener('click', function() {
        close();
        lsSet(LS.SETUP_DONE, false);
        setTimeout(function() { showOnboarding(function() { addLog('\u2713 Onboarding zakończony ponownie.', 'success'); }); }, 300);
      });
    }
  }


  // ───────────────────────────────────────────
  // AUTO UPDATE CHECK
  // ───────────────────────────────────────────

  function compareVersions(a, b) {
    // Returns 1 if a > b, -1 if a < b, 0 if equal
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  function checkForUpdate(manual) {
    const _rawUrl = getRawUrl();
    if (!_rawUrl) return;
    addLog('→ Sprawdzam aktualizacje... (GM: ' + (typeof GM_xmlhttpRequest !== 'undefined' ? 'tak' : 'nie') + ')', 'info');

    function handleResponse(text) {
      const match = text.match(/\/\/ @version\s+([\d.]+)/);
      if (!match) {
        addLog('⚠ Update check: nie znaleziono @version w odpowiedzi (dł: ' + text.length + ')', 'warn');
        return;
      }
      const remoteVersion = match[1];
      addLog('→ Update check: lokalna=' + VERSION + ' zdalna=' + remoteVersion, 'info');
      if (compareVersions(remoteVersion, VERSION) > 0) {
        addLog('✦ Dostępna aktualizacja: v' + remoteVersion, 'success');
        showUpdateBanner(remoteVersion);
      } else if (manual) {
        showUpdateBanner(null);
      }
    }

    // GM_xmlhttpRequest omija CSP Brand24 — działa zarówno w auto jak i manual
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'GET',
        url: _rawUrl + '?_=' + Date.now(),
        headers: {
          'Cache-Control': 'no-cache, no-store',
          'Pragma': 'no-cache',
        },
        onload: function(r) {
          if (r.status === 200) handleResponse(r.responseText);
          else if (manual) addLog('⚠ Sprawdzanie aktualizacji: błąd ' + r.status, 'warn');
        },
        onerror: function() {
          if (manual) addLog('⚠ Nie udało się sprawdzić aktualizacji', 'warn');
        }
      });
    } else {
      // Fallback: fetch (może być blokowany przez CSP)
      fetch(_rawUrl + '?_=' + Date.now())
        .then(function(r) { return r.text(); })
        .then(handleResponse)
        .catch(function() {
          if (manual) addLog('⚠ Nie udało się sprawdzić aktualizacji', 'warn');
        });
    }
  }

  function showUpdateBanner(newVersion) {
    if (document.getElementById('b24t-update-banner')) return;

    // Dodaj animację CSS (raz)
    if (!document.getElementById('b24t-update-style')) {
      const s = document.createElement('style');
      s.id = 'b24t-update-style';
      s.textContent = [
        '@keyframes b24t-slide-in{from{opacity:0;transform:translateX(120%)}to{opacity:1;transform:translateX(0)}}',
        '@keyframes b24t-slide-out{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(120%)}}',
      ].join('');
      document.head.appendChild(s);
    }

    const el = document.createElement('div');
    el.id = 'b24t-update-banner';

    // Prawy górny róg — pod paskiem rozszerzeń (~60px od góry)
    el.style.cssText = [
      'position:fixed',
      'top:60px',
      'right:16px',
      'width:300px',
      'background:var(--b24t-bg)',
      'border:1px solid ' + (newVersion ? 'var(--b24t-primary)' : '#4ade80'),
      'border-radius:12px',
      'padding:16px',
      'box-shadow:var(--b24t-shadow-h)',
      'z-index:2147483646',
      'font-family:Geist,\'Segoe UI\',system-ui,sans-serif',
      'animation:b24t-slide-in 0.35s cubic-bezier(0.34,1.56,0.64,1)',
    ].join(';');

    if (newVersion === null) {
      // Brak aktualizacji — krótki zielony baner
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div style="font-size:22px;">✓</div>' +
          '<div>' +
            '<div style="font-size:13px;font-weight:700;color:#4ade80;">Masz najnowszą wersję</div>' +
            '<div style="font-size:11px;color:var(--b24t-text-faint);margin-top:3px;">B24 Tagger BETA v' + VERSION + '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);
      setTimeout(function() {
        el.style.animation = 'b24t-slide-out 0.25s ease forwards';
        setTimeout(function() { el.remove(); }, 260);
      }, 3000);
      return;
    }

    // Jest aktualizacja — większy baner z przyciskami
    el.innerHTML =
      // Nagłówek
      '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;">' +
        '<div style="width:36px;height:36px;background:var(--b24t-primary-bg);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">✦</div>' +
        '<div style="flex:1;">' +
          '<div style="font-size:14px;font-weight:700;color:var(--b24t-text);letter-spacing:-0.01em;">Dostępna aktualizacja</div>' +
          '<div style="font-size:11px;color:var(--b24t-text-faint);margin-top:3px;">B24 Tagger BETA</div>' +
        '</div>' +
        '<button id="b24t-update-dismiss" style="background:none;border:none;color:var(--b24t-text-faint);cursor:pointer;font-size:18px;line-height:1;padding:2px;flex-shrink:0;">✕</button>' +
      '</div>' +
      // Wersje
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:8px 10px;background:var(--b24t-bg-elevated);border-radius:8px;border:1px solid var(--b24t-border-sub);">' +
        '<span style="font-size:12px;color:var(--b24t-text-faint);font-family:monospace;">v' + VERSION + '</span>' +
        '<span style="font-size:14px;color:var(--b24t-text-faint);">→</span>' +
        '<span style="font-size:13px;font-weight:700;color:var(--b24t-primary);font-family:monospace;">v' + newVersion + '</span>' +
        '<span style="margin-left:auto;font-size:10px;background:var(--b24t-primary-bg);color:var(--b24t-primary);padding:2px 7px;border-radius:99px;">nowa wersja</span>' +
      '</div>' +
      // Przycisk
      '<button id="b24t-update-install" style="width:100%;background:var(--b24t-primary);color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:0.02em;">Zainstaluj aktualizację →</button>';

    document.body.appendChild(el);

    function dismiss() {
      el.style.animation = 'b24t-slide-out 0.25s ease forwards';
      setTimeout(function() { el.remove(); }, 260);
    }

    document.getElementById('b24t-update-install').addEventListener('click', function() {
      // Otwarcie raw .user.js URL — Tampermonkey automatycznie wykrywa i pokazuje ekran aktualizacji
      window.open(getRawUrl(), '_blank');
      dismiss();
    });
    document.getElementById('b24t-update-dismiss').addEventListener('click', dismiss);

    // Auto-ukryj po 20 sekundach
    setTimeout(function() {
      if (document.getElementById('b24t-update-banner')) dismiss();
    }, 20000);
  }



  // Dodatkowe funkcje — modal z checkboxami
  const OPTIONAL_FEATURES = [
    {
      id: 'annotator_tools',
      label: '🛠 Annotators Tab',
      desc: 'Floating panel z narzędziami dla annotatorów: statystyki bieżącego projektu i przegląd wszystkich projektów (REQ VER / TO DELETE).',
    },
  ];

  function loadFeatures() {
    try { return JSON.parse(lsGet(LS.FEATURES, '{}')); } catch(e) { return {}; }
  }

  function saveFeatures(features) {
    lsSet(LS.FEATURES, JSON.stringify(features));
  }

  function applyFeatures() {
    const features = loadFeatures();
    // Pokaż opcję "Wszystkie projekty" w Quick Delete tylko gdy Annotators włączone
    const apLabel = document.getElementById('b24t-del-allprojects-label');
    if (apLabel) apLabel.style.display = features.annotator_tools ? 'flex' : 'none';

    // Annotators Tab — floating panel
    const tab = document.getElementById('b24t-annotator-tab');
    const panel = document.getElementById('b24t-annotator-panel');
    if (features.annotator_tools) {
      if (tab) tab.style.display = 'flex';
      // Show news side tab alongside annotator tab
      var _nst = document.getElementById('b24t-news-side-tab');
      if (_nst) _nst.style.display = 'flex';
      // Prefetch danych w tle — startBgPrefetch sam zarządza tokenem i cyklem
      startBgPrefetch();
    } else {
      if (tab) tab.style.display = 'none';
      if (panel) panel.style.display = 'none';
      var _nst2 = document.getElementById('b24t-news-side-tab');
      if (_nst2) _nst2.style.display = 'none';
    }
  }

  function showFeaturesModal() {
    if (document.getElementById('b24t-features-modal')) return;
    const features = loadFeatures();

    const modal = document.createElement('div');
    modal.id = 'b24t-features-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;backdrop-filter:blur(4px);animation:b24t-fadein 0.2s ease;';

    const _currentChannel = lsGet(LS.UPDATE_CHANNEL, 'stable');
    const channelHtml =
      '<div style="display:flex;gap:8px;">' +
        ['stable', 'experimental'].map(function(ch) {
          const active = _currentChannel === ch;
          const label = ch === 'stable' ? '🔒 Stabilny' : '🔬 Eksperymentalny';
          const desc  = ch === 'stable' ? 'Rekomendowany &mdash; przetestowane wersje' : 'Najnowsze zmiany, może być niestabilny';
          return '<label data-channel="' + ch + '" style="display:flex;flex:1;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid ' +
            (active ? 'var(--b24t-primary)' : 'var(--b24t-border-sub)') +
            ';border-radius:7px;background:' + (active ? 'var(--b24t-primary)18' : 'transparent') + ';cursor:pointer;">' +
            '<input type="radio" name="b24t-channel" value="' + ch + '" ' + (active ? 'checked' : '') +
              ' style="accent-color:var(--b24t-primary);flex-shrink:0;margin-top:2px;">' +
            '<div>' +
              '<div style="font-size:12px;font-weight:600;color:var(--b24t-text);">' + label + '</div>' +
              '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:2px;line-height:1.4;">' + desc + '</div>' +
            '</div>' +
          '</label>';
        }).join('') +
      '</div>';
    let checkboxesHtml = OPTIONAL_FEATURES.map(function(f) {
      const checked = features[f.id] ? 'checked' : '';
      return '<label style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--b24t-border-sub);cursor:pointer;">' +
        '<input type="checkbox" data-feature="' + f.id + '" ' + checked + ' ' +
          'style="margin-top:2px;accent-color:var(--b24t-primary);width:15px;height:15px;flex-shrink:0;cursor:pointer;">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--b24t-text);margin-bottom:4px;">' + f.label + '</div>' +
          '<div style="font-size:11px;color:var(--b24t-text-faint);line-height:1.5;">' + f.desc + '</div>' +
        '</div>' +
      '</label>';
    }).join('');

    const _savedTheme = lsGet(LS.THEME, 'light');
    const _themeTrackClass = 'b24t-slider-track' + (_savedTheme === 'dark' ? ' is-dark' : '');
    const themeRowHtml =
      '<div style="padding:12px 20px;border-bottom:1px solid var(--b24t-border-sub);display:flex;align-items:center;justify-content:space-between;">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--b24t-text);">Motyw interfejsu</div>' +
          '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:2px;">Jasny lub ciemny motyw wtyczki</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:5px;cursor:pointer;" id="b24t-features-theme-wrap">' +
          '<span style="font-size:11px;line-height:1;user-select:none;">☀️</span>' +
          '<div id="b24t-theme-track" class="' + _themeTrackClass + '"><div class="b24t-slider-knob"></div></div>' +
          '<span style="font-size:11px;line-height:1;user-select:none;">🌙</span>' +
        '</div>' +
      '</div>';

    var _naS = _naGetSettings();
    var _naPendCount = lsGet(LS.NA_PENDING, []).length;
    var _naLastPushStr = _naS.lastPush ? (new Date(_naS.lastPush)).toLocaleDateString('pl-PL') : null;
    var _naStatusStr = !_naS.pat ? 'Skonfiguruj GitHub PAT, aby włączyć push.' :
      (_naLastPushStr ? 'Ostatni push: ' + _naLastPushStr + (_naPendCount ? ' · ' + _naPendCount + ' w kolejce' : '') :
      'PAT ustawiony — nie pushowano jeszcze.' + (_naPendCount ? ' · ' + _naPendCount + ' w kolejce' : ''));
    var analyticsHtml =
      '<div style="padding:12px 20px 16px;border-top:1px solid var(--b24t-border-sub);">' +
        '<div style="font-size:11px;font-weight:700;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Analityka</div>' +
        '<label style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:4px 0;margin-bottom:8px;">' +
          '<input type="checkbox" id="b24t-na-enabled" ' + (_naS.enabled ? 'checked' : '') + ' style="accent-color:var(--b24t-primary);width:14px;height:14px;flex-shrink:0;cursor:pointer;">' +
          '<div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--b24t-text);">Zapisuj metryki na GitHub</div>' +
            '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:1px;">Anonimowe metryki skanowania News — wyniki, decyzje annotatorów</div>' +
          '</div>' +
        '</label>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:7px;">' +
          '<span style="font-size:11px;color:var(--b24t-text-muted);flex-shrink:0;min-width:64px;">GitHub PAT:</span>' +
          '<input type="password" id="b24t-na-pat" autocomplete="off" spellcheck="false" placeholder="ghp_..." style="flex:1;padding:5px 8px;border-radius:7px;border:1px solid var(--b24t-border);background:var(--b24t-bg-card);color:var(--b24t-text);font-size:11px;font-family:monospace;">' +
          '<button id="b24t-na-pat-toggle" title="Pokaż/ukryj" style="padding:3px 7px;flex-shrink:0;background:transparent;border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;cursor:pointer;font-size:13px;">👁</button>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
          '<span style="font-size:11px;color:var(--b24t-text-muted);flex-shrink:0;min-width:64px;">Repozytorium:</span>' +
          '<input type="text" id="b24t-na-repo" autocomplete="off" spellcheck="false" placeholder="i24dev/i24_analytics" style="flex:1;padding:5px 8px;border-radius:7px;border:1px solid var(--b24t-border);background:var(--b24t-bg-card);color:var(--b24t-text);font-size:11px;font-family:monospace;">' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;">' +
          '<button id="b24t-na-test" style="font-size:11px;padding:4px 10px;border-radius:7px;border:1px solid var(--b24t-border);background:transparent;color:var(--b24t-text-muted);cursor:pointer;">Testuj połączenie</button>' +
          '<button id="b24t-na-testpush" style="font-size:11px;padding:4px 10px;border-radius:7px;border:1px solid var(--b24t-border);background:transparent;color:var(--b24t-text-muted);cursor:pointer;">Testowy push</button>' +
          '<span id="b24t-na-test-result" style="font-size:10px;"></span>' +
        '</div>' +
        '<div id="b24t-na-status" style="font-size:10px;color:var(--b24t-text-faint);margin-top:6px;">' + _naStatusStr + '</div>' +
      '</div>';

    modal.innerHTML =
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:16px;width:400px;max-height:90vh;overflow-y:auto;box-shadow:var(--b24t-shadow-h);animation:b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:14px 0;background:var(--b24t-accent-grad);border-radius:16px 16px 0 0;display:flex;align-items:center;gap:10px;padding:14px 20px;">' +
          '<span style="font-size:18px;">⚙</span>' +
          '<div style="flex:1;">' +
            '<div style="font-size:13px;font-weight:700;color:#fff;">Dodatkowe funkcje</div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.7);margin-top:2px;">Włącz lub wyłącz opcjonalne funkcje wtyczki</div>' +
          '</div>' +
          '<button id="b24t-features-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:2px 8px;border-radius:5px;">✕</button>' +
        '</div>' +
        themeRowHtml +
        '<div style="padding:4px 20px 0;">' + checkboxesHtml + '</div>' +
        '<div style="padding:12px 20px 4px;border-top:1px solid var(--b24t-border-sub);">' +
          '<div style="font-size:11px;font-weight:700;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Kanał aktualizacji</div>' +
          channelHtml +
        '</div>' +
        '<div style="padding:12px 20px 16px;border-top:1px solid var(--b24t-border-sub);">' +
          '<div style="font-size:11px;font-weight:700;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Ustawienia AI</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">' +
            '<span style="font-size:11px;color:var(--b24t-text-muted);flex-shrink:0;min-width:64px;">Klucz API:</span>' +
            '<input type="text" id="b24t-ai-api-key" autocomplete="off" spellcheck="false" placeholder="sk-ant-api03-..." style="flex:1;padding:5px 8px;border-radius:7px;border:1px solid var(--b24t-border);background:var(--b24t-bg-card);color:var(--b24t-text);font-size:11px;font-family:monospace;">' +
            '<button id="b24t-ai-key-toggle" title="Pokaż/ukryj" style="padding:3px 7px;flex-shrink:0;background:transparent;border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;cursor:pointer;font-size:13px;">👁</button>' +
          '</div>' +
          '<div style="height:1px;background:var(--b24t-border-sub);margin:4px 0 10px;"></div>' +
          '<div style="font-size:10px;font-weight:700;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:7px;">News</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:7px;">' +
            '<span style="font-size:11px;color:var(--b24t-text-muted);flex-shrink:0;min-width:64px;">Model:</span>' +
            '<select id="b24t-ai-model-news" style="flex:1;padding:5px 8px;border-radius:7px;border:1px solid var(--b24t-border);background:#fff;color:#333;font-size:11px;font-family:inherit;color-scheme:light;">' +
              '<option value="claude-haiku-4-5-20251001">Haiku 4.5 — szybki, tani</option>' +
              '<option value="claude-sonnet-4-6">Sonnet 4.6 — mocniejszy</option>' +
            '</select>' +
          '</div>' +
          '<label style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:4px 0;margin-bottom:4px;">' +
            '<input type="checkbox" id="b24t-ai-news-enabled" style="accent-color:var(--b24t-primary);width:14px;height:14px;flex-shrink:0;cursor:pointer;">' +
            '<div>' +
              '<div style="font-size:12px;font-weight:600;color:var(--b24t-text);">AI scoring w module News</div>' +
              '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:1px;">Automatyczna ocena artyku\u0142\u00f3w przez Claude</div>' +
            '</div>' +
          '</label>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
            '<span style="font-size:11px;color:var(--b24t-text-muted);flex-shrink:0;min-width:64px;">Prompt:</span>' +
            '<select id="b24t-ai-news-prompt" style="flex:1;padding:5px 8px;border-radius:7px;border:1px solid var(--b24t-border);background:#fff;color:#333;font-size:11px;font-family:inherit;color-scheme:light;">' +
              '<option value="">\u2014 wybierz z biblioteki \u2014</option>' +
            '</select>' +
          '</div>' +
          '<div style="height:1px;background:var(--b24t-border-sub);margin:8px 0 10px;"></div>' +
          '<div style="font-size:10px;font-weight:700;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:7px;">Tagowanie</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">' +
            '<span style="font-size:11px;color:var(--b24t-text-muted);flex-shrink:0;min-width:64px;">Model:</span>' +
            '<select id="b24t-ai-model-tagging" style="flex:1;padding:5px 8px;border-radius:7px;border:1px solid var(--b24t-border);background:#fff;color:#333;font-size:11px;font-family:inherit;color-scheme:light;">' +
              '<option value="claude-haiku-4-5-20251001">Haiku 4.5 — szybki, tani</option>' +
              '<option value="claude-sonnet-4-6">Sonnet 4.6 — mocniejszy</option>' +
            '</select>' +
          '</div>' +
          '<button id="b24t-ai-open-prompts" style="width:100%;box-sizing:border-box;padding:7px 12px;background:transparent;border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:8px;cursor:pointer;font-family:inherit;font-size:11px;display:flex;align-items:center;justify-content:space-between;">📚 Biblioteka promptów<span style="font-size:10px;opacity:0.6;">→</span></button>' +
        '</div>' +
        analyticsHtml +
        '<div style="padding:14px 20px;border-top:1px solid var(--b24t-border-sub);text-align:right;">' +
          '<button id="b24t-features-save" style="background:var(--b24t-accent-grad);color:#fff;border:none;border-radius:8px;padding:9px 24px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 2px 8px var(--b24t-primary-glow);transition:opacity 0.15s;">Zapisz</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    function close() { modal.remove(); }

    document.getElementById('b24t-features-close').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    // AI Settings wiring
    (function() {
      var s = _aiGetSettings();
      var apiKeyInput = document.getElementById('b24t-ai-api-key');
      var newsModelSelect = document.getElementById('b24t-ai-model-news');
      var taggingModelSelect = document.getElementById('b24t-ai-model-tagging');
      var newsEnabledCb = document.getElementById('b24t-ai-news-enabled');
      var newsPromptSelect = document.getElementById('b24t-ai-news-prompt');

      if (apiKeyInput) apiKeyInput.value = s.apiKey || '';
      if (newsModelSelect) newsModelSelect.value = (s.news && s.news.model) || 'claude-haiku-4-5-20251001';
      if (taggingModelSelect) taggingModelSelect.value = (s.tagging && s.tagging.model) || 'claude-haiku-4-5-20251001';
      if (newsEnabledCb) newsEnabledCb.checked = !!(s.news && s.news.enabled);
      if (newsPromptSelect && s.prompts) {
        s.prompts.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name || p.id;
          newsPromptSelect.appendChild(opt);
        });
        newsPromptSelect.value = (s.news && s.news.activePromptId) || '';
      }

      if (apiKeyInput) {
        apiKeyInput.addEventListener('change', function() {
          var cfg = _aiGetSettings(); cfg.apiKey = apiKeyInput.value.trim(); _aiSaveSettings(cfg);
        });
      }
      var keyToggle = document.getElementById('b24t-ai-key-toggle');
      if (keyToggle && apiKeyInput) {
        keyToggle.addEventListener('click', function() {
          apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
        });
      }
      if (newsModelSelect) {
        newsModelSelect.addEventListener('change', function() {
          var cfg = _aiGetSettings();
          if (!cfg.news) cfg.news = {};
          cfg.news.model = newsModelSelect.value; _aiSaveSettings(cfg);
        });
      }
      if (taggingModelSelect) {
        taggingModelSelect.addEventListener('change', function() {
          var cfg = _aiGetSettings();
          if (!cfg.tagging) cfg.tagging = {};
          cfg.tagging.model = taggingModelSelect.value; _aiSaveSettings(cfg);
        });
      }
      if (newsEnabledCb) {
        newsEnabledCb.addEventListener('change', function() {
          var cfg = _aiGetSettings();
          if (!cfg.news) cfg.news = {};
          cfg.news.enabled = newsEnabledCb.checked; _aiSaveSettings(cfg);
        });
      }
      if (newsPromptSelect) {
        newsPromptSelect.addEventListener('change', function() {
          var cfg = _aiGetSettings();
          if (!cfg.news) cfg.news = {};
          cfg.news.activePromptId = newsPromptSelect.value || null;
          _aiSaveSettings(cfg);
        });
      }
      var openPromptsBtn = document.getElementById('b24t-ai-open-prompts');
      if (openPromptsBtn) openPromptsBtn.addEventListener('click', function() { _showPromptLibraryModal(); });
    })();

    // Analytics wiring
    (function() {
      var naEnabledCb  = document.getElementById('b24t-na-enabled');
      var naPatInput   = document.getElementById('b24t-na-pat');
      var naPatToggle  = document.getElementById('b24t-na-pat-toggle');
      var naRepoInput  = document.getElementById('b24t-na-repo');
      var naStatusEl   = document.getElementById('b24t-na-status');
      var naS = _naGetSettings();
      if (naPatInput)  naPatInput.value  = naS.pat  || '';
      if (naRepoInput) naRepoInput.value = naS.repo || 'i24dev/i24_analytics';
      if (naEnabledCb) {
        naEnabledCb.addEventListener('change', function() {
          var cfg = _naGetSettings(); cfg.enabled = naEnabledCb.checked; _naSaveSettings(cfg);
        });
      }
      if (naPatInput) {
        naPatInput.addEventListener('change', function() {
          var cfg = _naGetSettings(); cfg.pat = naPatInput.value.trim(); _naSaveSettings(cfg);
          if (naStatusEl) naStatusEl.textContent = cfg.pat ? 'PAT ustawiony — nie pushowano jeszcze.' : 'Skonfiguruj GitHub PAT, aby włączyć push.';
        });
      }
      if (naPatToggle && naPatInput) {
        naPatToggle.addEventListener('click', function() {
          naPatInput.type = naPatInput.type === 'password' ? 'text' : 'password';
        });
      }
      if (naRepoInput) {
        naRepoInput.addEventListener('change', function() {
          var cfg = _naGetSettings();
          cfg.repo = naRepoInput.value.trim() || 'i24dev/i24_analytics';
          _naSaveSettings(cfg);
        });
      }
      var naTestBtn    = document.getElementById('b24t-na-test');
      var naTestResult = document.getElementById('b24t-na-test-result');
      if (naTestBtn) {
        naTestBtn.addEventListener('click', function() {
          var pat  = (naPatInput  ? naPatInput.value.trim()  : '') || _naGetSettings().pat  || '';
          var repo = (naRepoInput ? naRepoInput.value.trim() : '') || _naGetSettings().repo || 'i24dev/i24_analytics';
          if (!pat) { if (naTestResult) { naTestResult.textContent = '✗ Brak PAT'; naTestResult.style.color = '#f87171'; } return; }
          if (naTestBtn) { naTestBtn.disabled = true; naTestBtn.textContent = '⏳ Sprawdzam…'; }
          if (naTestResult) { naTestResult.textContent = ''; }
          GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.github.com/repos/' + repo,
            headers: { 'Authorization': 'token ' + pat, 'Accept': 'application/vnd.github.v3+json' },
            onload: function(r) {
              naTestBtn.disabled = false; naTestBtn.textContent = 'Testuj połączenie';
              if (r.status === 200) {
                try {
                  var data = JSON.parse(r.responseText);
                  var canPush = data.permissions && (data.permissions.push || data.permissions.admin);
                  if (canPush) {
                    naTestResult.textContent = '✓ OK — dostęp do zapisu';
                    naTestResult.style.color = '#22c55e';
                  } else {
                    naTestResult.textContent = '⚠ Repo znalezione, brak uprawnień do zapisu';
                    naTestResult.style.color = '#fb923c';
                  }
                } catch(e) { naTestResult.textContent = '✓ OK — połączenie działa'; naTestResult.style.color = '#22c55e'; }
              } else if (r.status === 401) {
                naTestResult.textContent = '✗ Błąd 401 — zły PAT'; naTestResult.style.color = '#f87171';
              } else if (r.status === 404) {
                naTestResult.textContent = '✗ Błąd 404 — nie znaleziono repo'; naTestResult.style.color = '#f87171';
              } else {
                naTestResult.textContent = '✗ Błąd ' + r.status; naTestResult.style.color = '#f87171';
              }
            },
            onerror: function() {
              naTestBtn.disabled = false; naTestBtn.textContent = 'Testuj połączenie';
              naTestResult.textContent = '✗ Brak połączenia'; naTestResult.style.color = '#f87171';
            }
          });
        });
      }
      var naTestPushBtn = document.getElementById('b24t-na-testpush');
      if (naTestPushBtn) {
        naTestPushBtn.addEventListener('click', function() {
          var pat  = (naPatInput  ? naPatInput.value.trim()  : '') || _naGetSettings().pat  || '';
          var repo = (naRepoInput ? naRepoInput.value.trim() : '') || _naGetSettings().repo || 'i24dev/i24_analytics';
          if (!pat) { if (naTestResult) { naTestResult.textContent = '✗ Brak PAT'; naTestResult.style.color = '#f87171'; } return; }
          naTestPushBtn.disabled = true; naTestPushBtn.textContent = '⏳ Wysyłam…';
          if (naTestResult) naTestResult.textContent = '';
          _naTestPush(pat, repo, function(result, repoOrStatus) {
            naTestPushBtn.disabled = false; naTestPushBtn.textContent = 'Testowy push';
            if (result === 'ok') {
              naTestResult.textContent = '✓ Plik zapisany: ' + repoOrStatus + '/Tagger/statistics/_test_push.json';
              naTestResult.style.color = '#22c55e';
            } else if (result === 'nopat') {
              naTestResult.textContent = '✗ Brak PAT'; naTestResult.style.color = '#f87171';
            } else {
              naTestResult.textContent = '✗ Błąd ' + (repoOrStatus || ''); naTestResult.style.color = '#f87171';
            }
          });
        });
      }
    })();

    document.getElementById('b24t-theme-track')?.addEventListener('click', function() {
      const current = document.documentElement.getAttribute('data-b24t-theme') || 'light';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });

    document.getElementById('b24t-features-save').addEventListener('click', function() {
      const newFeatures = {};
      modal.querySelectorAll('input[data-feature]').forEach(function(cb) {
        newFeatures[cb.dataset.feature] = cb.checked;
      });
      saveFeatures(newFeatures);
      const selectedChannel = (modal.querySelector('input[name="b24t-channel"]:checked') || {}).value || 'stable';
      lsSet(LS.UPDATE_CHANNEL, selectedChannel);
      applyFeatures();
      close();
      addLog('\u2713 Ustawienia zapisane (kanał: ' + selectedChannel + ')', 'success');
    });
  }


  // ───────────────────────────────────────────
  // TAG STATS — WSZYSTKIE PROJEKTY
  // ───────────────────────────────────────────

  // Pobiera z localStorage listę znanych projektów
  function getKnownProjects() {
    const projects = lsGet(LS.PROJECTS, {});
    // Użyj tagów z aktualnego state.tags jako fallback
    const globalReqVerId   = state.tags && state.tags['REQUIRES_VERIFICATION'];
    const globalToDeleteId = state.tags && state.tags['TO_DELETE'];
    var allProjects = Object.entries(projects).map(function([id, p]) {
      const reqVerId   = (p.tagIds && p.tagIds['REQUIRES_VERIFICATION']) || globalReqVerId;
      const toDeleteId = (p.tagIds && p.tagIds['TO_DELETE'])             || globalToDeleteId;
      return {
        id: parseInt(id),
        name: _pnResolve(parseInt(id)),
        reqVerId,
        toDeleteId,
      };
    }).filter(function(p) {
      return p.reqVerId && p.toDeleteId;
    });
    // Filtruj do wybranej grupy jeśli user ją wybrał w panelu cross-delete
    var groupSel = document.getElementById('b24t-ap-group-sel');
    if (groupSel && groupSel.value) {
      var groups = getGroups();
      var selectedGroup = groups.find(function(g) { return g.id === groupSel.value; });
      if (selectedGroup) {
        allProjects = allProjects.filter(function(p) { return selectedGroup.projectIds.includes(p.id); });
      }
    }
    return allProjects;
  }

  // Pobiera wszystkie strony wzmianek projektu równolegle (10x) i zlicza po tagach
  async function fetchProjectTagCounts(projectId, reqVerId, toDeleteId, dateFrom, dateTo, onProgress) {
    const bf = {
      va: 1, rt: [], se: [], vi: null, gr: [], sq: '', do: '', au: '',
      lem: false, ctr: [], nctr: false, is: [0, 10], tp: null, anom: '',
      lang: [], nlang: false, aue: null, htg: null, mt: false, mtri: null, cxs: []
    };
    const gql = `query getMentions($projectId:Int!,$dateRange:DateRangeInput!,$filters:MentionFilterInput,$page:Int,$order:Int){
      getMentions(projectId:$projectId,dateRange:$dateRange,filters:$filters,page:$page,order:$order){
        count results{id tags{id title}}
      }
    }`;

    const doPage = function(page) {
      return origFetch('/api/graphql', {
        method: 'POST', credentials: 'same-origin',
        headers: { ...state.tokenHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationName: 'getMentions',
          variables: { projectId, dateRange: { from: dateFrom, to: dateTo }, filters: bf, page, order: 0 },
          query: gql
        })
      }).then(function(r) { return r.json(); });
    };

    // Krok 1: pobierz count i pierwszą stronę
    const first = await doPage(1);
    const total = first?.data?.getMentions?.count || 0;
    if (total === 0) return { total: 0, reqVer: 0, toDelete: 0 };

    const totalPages = Math.ceil(total / 60);
    let reqVer = 0, toDelete = 0;

    // Zlicz tagi z pierwszej strony
    (first?.data?.getMentions?.results || []).forEach(function(m) {
      m.tags?.forEach(function(t) {
        if (t.id === reqVerId) reqVer++;
        if (t.id === toDeleteId) toDelete++;
      });
    });

    // Krok 2: pobierz pozostałe strony równolegle (batche po 10)
    const remainingPages = [];
    for (let p = 2; p <= totalPages; p++) remainingPages.push(p);

    for (let i = 0; i < remainingPages.length; i += 10) {
      const batch = remainingPages.slice(i, i + 10);
      if (onProgress) onProgress(1 + i, totalPages);
      const results = await Promise.all(batch.map(function(p) { return doPage(p); }));
      results.forEach(function(d) {
        (d?.data?.getMentions?.results || []).forEach(function(m) {
          m.tags?.forEach(function(t) {
            if (t.id === reqVerId) reqVer++;
            if (t.id === toDeleteId) toDelete++;
          });
        });
      });
    }

    return { total, reqVer, toDelete };
  }

  // Renderuje tabelę statystyk tagów
  function renderTagStats(el, projectStats, dateFrom, dateTo) {
    // Filtruj tylko projekty z reqVer > 0 lub toDelete > 0
    const filtered = projectStats.filter(function(p) {
      return p.reqVer > 0 || p.toDelete > 0;
    }).sort(function(a, b) {
      // Sortuj po reqVer malejąco
      return (b.reqVer + b.toDelete) - (a.reqVer + a.toDelete);
    });

    if (filtered.length === 0) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:#4ade80;font-size:12px;">✓ Wszystkie projekty oczyśczone!</div>';
      return;
    }

    var rows = filtered.map(function(p) {
      var reqColor = p.reqVer > 0 ? '#facc15' : '#444466';
      var delColor = p.toDelete > 0 ? '#f87171' : '#444466';
      return '<tr>' +
        '<td style="padding:7px 10px;font-size:11px;color:#c0c0e0;border-bottom:1px solid var(--b24t-border-sub);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + p.name + '">' + p.name + '</td>' +
        '<td style="padding:7px 10px;font-size:13px;font-weight:700;color:' + reqColor + ';text-align:center;border-bottom:1px solid var(--b24t-border-sub);">' + (p.reqVer || '—') + '</td>' +
        '<td style="padding:7px 10px;font-size:13px;font-weight:700;color:' + delColor + ';text-align:center;border-bottom:1px solid var(--b24t-border-sub);">' + (p.toDelete || '—') + '</td>' +
      '</tr>';
    }).join('');

    el.innerHTML =
      '<div style="padding:10px 12px 0;">' +
        '<div style="font-size:9px;color:var(--b24t-text-faint);margin-bottom:8px;">' + dateFrom + ' – ' + dateTo + '</div>' +
        '<table style="width:100%;border-collapse:collapse;">' +
          '<thead>' +
            '<tr>' +
              '<th style="padding:5px 10px;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--b24t-text-faint);text-align:left;border-bottom:1px solid #2a2a35;">Projekt</th>' +
              '<th style="padding:5px 10px;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#facc15;text-align:center;border-bottom:1px solid #2a2a35;">REQ VER</th>' +
              '<th style="padding:5px 10px;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#f87171;text-align:center;border-bottom:1px solid #2a2a35;">TO DELETE</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>';
  }

  // ───────────────────────────────────────────
  // DASHBOARD ANNOTATORA
  // ───────────────────────────────────────────

  // Pobiera statystyki dla bieżącego miesiąca (lub poprzedniego jeśli dzień 1-2)
  async function fetchDashboardStats() {
    if (!state.tokenHeaders) throw new Error('TOKEN_NOT_READY');
    if (!state.projectId) throw new Error('Brak projektu');

    const now = new Date();
    const day = now.getDate();
    let dateFrom, dateTo, label;

    // Dzień 1-2 — pokaż poprzedni miesiąc
    if (day <= 2) {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      dateFrom = prev.toISOString().split('T')[0];
      dateTo   = last.toISOString().split('T')[0];
      label    = prev.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
    } else {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      dateTo   = now.toISOString().split('T')[0];
      label    = now.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
    }

    const baseFilters = {
      va: 1, se: [], vi: null, gr: [], sq: '', lem: false, ctr: [], nctr: false,
      is: [0, 10], tp: null, anom: '', lang: [], nlang: false, aue: null,
      htg: null, mt: false, mtri: null, cxs: [], rt: []
    };

    const GQL_COUNT = 'query getMentions($projectId:Int!,$dateRange:DateRangeInput!,$filters:MentionFilterInput,$page:Int,$order:Int){getMentions(projectId:$projectId,dateRange:$dateRange,filters:$filters,page:$page,order:$order){count}}';
    const GQL_TAGS  = 'query getMentions($projectId:Int!,$dateRange:DateRangeInput!,$filters:MentionFilterInput,$page:Int,$order:Int){getMentions(projectId:$projectId,dateRange:$dateRange,filters:$filters,page:$page,order:$order){count results{id tags{id}}}}';
    const PER_PAGE  = 60;

    const doQ = function(gql, page) {
      return origFetch('/api/graphql', {
        method: 'POST', credentials: 'same-origin',
        headers: { ...state.tokenHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationName: 'getMentions',
          variables: { projectId: state.projectId, dateRange: { from: dateFrom, to: dateTo }, filters: baseFilters, page: page, order: 0 },
          query: gql
        })
      }).then(function(r) { return r.json(); });
    };

    // Krok 1: pobierz łączną liczbę wzmianek
    const countRes = await doQ(GQL_COUNT, 1);
    const total = countRes?.data?.getMentions?.count || 0;
    if (total === 0) {
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      return { total: 0, tagged: 0, untagged: 0, pct: 0, dateFrom, dateTo, label, daysLeft: lastDay - day, day };
    }

    // Krok 2: binary search — znajdź granicę nieotagowane/otagowane
    // Wzmianki są posortowane: nieotagowane najpierw, otagowane na końcu
    // Szukamy pierwszej strony gdzie pojawiają się otagowane
    const totalPages = Math.ceil(total / PER_PAGE);

    async function hasTaggedOnPage(page) {
      const res = await doQ(GQL_TAGS, page);
      const results = res?.data?.getMentions?.results || [];
      return results.some(function(m) { return m.tags && m.tags.length > 0; });
    }

    async function countUntaggedOnPage(page) {
      const res = await doQ(GQL_TAGS, page);
      const results = res?.data?.getMentions?.results || [];
      return results.filter(function(m) { return !m.tags || m.tags.length === 0; }).length;
    }

    // Sprawdź czy strona 1 ma otagowane — jeśli tak, wszystkie są otagowane
    const page1Tagged = await hasTaggedOnPage(1);
    let untaggedCount = 0;

    if (page1Tagged) {
      // Strona 1 ma otagowane — sprawdź czy jest też nieotagowanych (granica na str 1)
      const untaggedOnP1 = await countUntaggedOnPage(1);
      untaggedCount = untaggedOnP1;
    } else {
      // Binary search: szukaj pierwszej strony z otagowanymi
      let lo = 1, hi = totalPages;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const tagged = await hasTaggedOnPage(mid);
        if (tagged) hi = mid;
        else lo = mid + 1;
      }
      // lo = pierwsza strona z otagowanymi
      // Strony 1..(lo-1) = w pełni nieotagowane
      // Strona lo = mieszana
      const fullUntaggedPages = lo - 1;
      const mixedUntagged = await countUntaggedOnPage(lo);
      untaggedCount = fullUntaggedPages * PER_PAGE + mixedUntagged;
    }

    const tagged   = total - untaggedCount;
    const pct      = total > 0 ? Math.round((tagged / total) * 100) : 0;
    const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = lastDay - day;

    return { total, tagged, untagged: untaggedCount, pct, dateFrom, dateTo, label, daysLeft, day };
  }

  // Renderuj dashboard w elemencie
  function renderDashboard(el, stats) {
    const { total, tagged, untagged, pct, label, daysLeft, day } = stats;
    const isLastMonth = day <= 2;

    el.innerHTML =
      '<div style="padding:14px 16px;">' +
        // Nagłówek
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
          '<div style="font-size:11px;font-weight:700;color:#a0a0cc;letter-spacing:0.05em;text-transform:uppercase;">Dashboard Annotatora</div>' +
          (isLastMonth
            ? '<div style="font-size:9px;background:#facc1522;color:#facc15;padding:2px 6px;border-radius:99px;">poprzedni miesiąc</div>'
            : '<div style="font-size:9px;color:var(--b24t-text-faint);">' + daysLeft + ' dni do końca miesiąca</div>'
          ) +
        '</div>' +
        // Miesiąc
        '<div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:10px;">' + label + ' · ' + stats.dateFrom + ' – ' + stats.dateTo + '</div>' +
        // Progress bar
        '<div style="background:var(--b24t-bg-input);border-radius:99px;height:6px;margin-bottom:12px;overflow:hidden;">' +
          '<div style="height:100%;border-radius:99px;background:' + (pct === 100 ? '#4ade80' : '#6c6cff') + ';width:' + pct + '%;transition:width 0.4s ease;"></div>' +
        '</div>' +
        // Statystyki — 3 kafelki
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
          _dashTile('Wszystkie', total, '#7878aa') +
          _dashTile('Otagowane', tagged, '#4ade80') +
          _dashTile('Pozostałe', untagged, untagged === 0 ? '#4ade80' : '#f87171') +
        '</div>' +
        // Procent ukończenia
        '<div style="margin-top:10px;text-align:center;font-size:11px;color:' + (pct === 100 ? '#4ade80' : '#7878aa') + ';">' +
          (pct === 100 ? '✓ Gotowe!' : pct + '% ukończone') +
        '</div>' +
      '</div>';
  }

  function _dashTile(label, value, color) {
    return '<div style="background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:8px;padding:8px;text-align:center;box-shadow:inset 0 1px 0 rgba(255,255,255,0.10);transition:background 0.3s,border-color 0.3s;">' +
      '<div style="font-size:16px;font-weight:700;color:' + color + ';">' + (value ?? '—') + '</div>' +
      '<div style="font-size:9px;color:var(--b24t-text-faint);margin-top:2px;">' + label + '</div>' +
    '</div>';
  }

  // ───────────────────────────────────────────
  // ANNOTATOR TOOLS — FLOATING PANEL
  // ───────────────────────────────────────────

  var annotatorData = { project: null, tagstats: null };

  // ── Background prefetch cache ──────────────────────────────────────────────
  // Przechowuje dane niezależnie od DOM — render jest natychmiastowy gdy cache gorący.
  // bgCache.tagstats    = { results, dates, ts }         (Annotators Tab → zakładka Tagi)
  // bgCache.project     = { total,... , ts }             (Annotators Tab → zakładka Projekt)
  // bgCache.allProjects = { [tagId]: { results, ts } }   (cross-delete panel)
  var bgCache = { tagstats: null, project: null, allProjects: {}, overallStats: null };
  var bgPrefetchStarted = false;
  var BG_CACHE_TTL = 5 * 60 * 1000; // 5 minut — po tym czasie re-fetch w tle
  var _overallStatsInFlight = false; // guard: blokuje rownolegле wywolania loadOverallStats

  function _bgCacheFresh(entry) {
    return entry && entry.ts && (Date.now() - entry.ts < BG_CACHE_TTL);
  }

  // Cicha wersja loadAnnotatorTagStats — tylko wypełnia bgCache, nie dotyka DOM
  async function _bgFetchTagstats() {
    if (!state.tokenHeaders) return;
    var projects = getKnownProjects();
    if (!projects.length) return;
    var dates = getAnnotatorDates();
    addLog('📅 Zakres: ' + dates.label + ' (' + dates.dateFrom + ' → ' + dates.dateTo + ')', 'info');
    addLog('⟳ [BG] prefetch tagstats (' + projects.length + ' projektów)...', 'info');
    var results = [];
    for (var i = 0; i < projects.length; i += BG_CONCURRENCY) {
      var chunk = projects.slice(i, i + BG_CONCURRENCY);
      var chunkResults = await Promise.all(chunk.map(async function(p) {
        try {
          var reqPage = await getMentions(p.id, dates.dateFrom, dates.dateTo, [p.reqVerId],   1, { silent: true });
          var delPage = await getMentions(p.id, dates.dateFrom, dates.dateTo, [p.toDeleteId], 1, { silent: true });
          var reqVer   = reqPage.count  || 0;
          var toDelete = delPage.count  || 0;
          if (reqVer > 0 || toDelete > 0) {
            return { name: p.name, id: p.id, reqVer: reqVer, toDelete: toDelete };
          }
        } catch(e) {}
        return null;
      }));
      results.push.apply(results, chunkResults.filter(Boolean));
    }
    bgCache.tagstats = { results: results, dates: dates, ts: Date.now() };
    // Jeśli annotatorData.tagstats jest null (panel nie był otwarty) — wypełnij też go
    if (!annotatorData.tagstats) annotatorData.tagstats = bgCache.tagstats;
    return bgCache.tagstats;
  }

  // Cicha wersja fetch danych dla cross-delete — per tagId
  async function _bgFetchAllProjects(tagId) {
    if (!state.tokenHeaders || !tagId) return;
    var projects = getKnownProjects();
    if (!projects.length) return;
    // Użyj tej samej logiki dat co reszta narzędzi annotatorskich
    var dates = getAnnotatorDates();
    var dateFrom = dates.dateFrom;
    var dateTo   = dates.dateTo;
    var tagName = Object.entries(state.tags || {}).find(function(e){ return e[1] === tagId; })?.[0] || String(tagId);
    addLog('⟳ [BG] prefetch allProjects[' + tagName + '] (' + projects.length + ' projektów)...', 'info');
    var results = [];
    for (var i = 0; i < projects.length; i += BG_CONCURRENCY) {
      var chunk = projects.slice(i, i + BG_CONCURRENCY);
      var chunkResults = await Promise.all(chunk.map(async function(p) {
        try {
          var page  = await getMentions(p.id, dateFrom, dateTo, [tagId], 1);
          var count = page.count || 0;
          p._tagCount = count;
          p._dateFrom = dateFrom;
          p._dateTo   = dateTo;
          return count > 0 ? { p: p, count: count } : null;
        } catch(e) {
          addLog('✕ [DIAG] getMentions(' + p.id + '/' + tagName + '): ' + e.message, 'diag');
          return { p: p, count: -1, error: e.message };
        }
      }));
      results.push.apply(results, chunkResults.filter(Boolean));
    }
    bgCache.allProjects[tagId] = { results: results, ts: Date.now() };
    var withData = results.filter(function(r){ return r.count > 0; });
    if (withData.length) {
      addLog('✓ [BG] allProjects[' + tagName + ']: ' + withData.length + ' projektów z tagiem', 'success');
    }
    return bgCache.allProjects[tagId];
  }

  // Master scheduler — odpala się raz gdy annotator_tools włączony i token gotowy
  async function startBgPrefetch() {
    if (bgPrefetchStarted) return;
    bgPrefetchStarted = true;

    // Poczekaj na token (max 15s)
    if (!state.tokenHeaders) {
      await new Promise(function(resolve) {
        var check = setInterval(function() { if (state.tokenHeaders) { clearInterval(check); resolve(); } }, 500);
        setTimeout(function() { clearInterval(check); resolve(); }, 15000);
      });
    }
    if (!state.tokenHeaders) {
      addLog('[DIAG] startBgPrefetch: token niedostępny po 15s — prefetch przerwany', 'diag');
      return;
    }

    // Pierwsze ładowanie w tle
    try { await _bgFetchTagstats(); } catch(e) {}

    // Prefetch cross-delete dla aktualnie wybranego tagu (jeśli jest)
    try {
      var tagId = parseInt(document.getElementById('b24t-del-tag')?.value);
      if (tagId) await _bgFetchAllProjects(tagId);
    } catch(e) {}

    // Diagnoza startowa — po pierwszym prefetch
    setTimeout(function() { runDiagChecks(); }, 500);

    // Cykliczne odświeżanie co BG_CACHE_TTL
    setInterval(async function() {
      if (!state.tokenHeaders) return;
      try { await _bgFetchTagstats(); } catch(e) {}
      // Re-fetch dla aktualnie wybranego tagu jeśli cross-delete otwarty
      try {
        var tagId = parseInt(document.getElementById('b24t-del-tag')?.value);
        if (tagId) await _bgFetchAllProjects(tagId);
      } catch(e) {}
    }, BG_CACHE_TTL);
  }
  // ──────────────────────────────────────────────────────────────────────────

  function buildAnnotatorPanel() {
    if (document.getElementById('b24t-annotator-panel')) return;

    const currentTheme = document.documentElement.getAttribute('data-b24t-theme') || 'light';

    // Trigger tab (strzałka po prawej)
    var tab = document.createElement('div');
    tab.id = 'b24t-annotator-tab';
    tab.setAttribute('data-b24t-theme', currentTheme);
    tab.style.cssText = 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483640;border-right:none;border-radius:10px 0 0 10px;padding:18px 13px;cursor:pointer;display:none;flex-direction:column;align-items:center;gap:7px;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;letter-spacing:0.04em;user-select:none;transition:transform 0.2s,box-shadow 0.2s,background 0.3s,border-color 0.3s,color 0.3s;';
    // inline colors that adapt via JS (CSS vars not available in inline style)
    tab.innerHTML = '<span style="writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:.08em;font-size:13px;font-weight:600;">Annotators Tab</span><span style="font-size:18px;line-height:1;">‹</span>';
    tab.title = 'Otwórz Annotators';
    tab.addEventListener('click', function() { openAnnotatorPanel(); });
    document.body.appendChild(tab);

    // Floating panel
    var panel = document.createElement('div');
    panel.id = 'b24t-annotator-panel';
    panel.setAttribute('data-b24t-theme', currentTheme);
    panel.style.cssText = 'position:fixed;right:12px;top:80px;width:420px;height:auto;max-height:calc(100vh - 100px);z-index:2147483641;border-radius:14px;display:none;flex-direction:column;overflow:hidden;animation:b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;font-size:15px;';

    panel.innerHTML =
      // Header with gradient
      '<div id="b24t-ann-header" style="display:flex;align-items:center;padding:12px 16px;background:var(--b24t-accent-grad);cursor:move;user-select:none;position:relative;overflow:hidden;">' +
        '<span style="font-size:15px;font-weight:700;flex:1;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.2);">🛠 Annotators Tab</span>' +
        '' +
        '<button id="b24t-ann-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:2px 8px;border-radius:5px;transition:background 0.15s;">×</button>' +
      '</div>' +
      // Tabs — liquid glass, identyczny styl jak główny panel
      '<div style="display:flex;align-items:center;gap:5px;padding:6px 10px;background:var(--b24t-bg-deep);border-bottom:1px solid var(--b24t-border-sub);">' +
        '<button class="b24t-tab b24t-ann-tab b24t-tab-active" data-ann-tab="project">📊 Projekt</button>' +
        '<button class="b24t-tab b24t-ann-tab" data-ann-tab="tagstats">🏷 Tagi</button>' +
        '<button class="b24t-tab b24t-ann-tab" data-ann-tab="groups">🗂 Grupy</button>' +
        '<button class="b24t-tab b24t-ann-tab" data-ann-tab="overall">📈 Overall</button>' +
      '</div>' +
      // Project tab
      '<div id="b24t-ann-tab-project" class="b24t-ann-content" style="display:block;background:var(--b24t-bg);flex:1;overflow-y:auto;min-height:0;">' +
        '<div id="b24t-ann-project-content" style="padding:16px;font-size:14px;color:var(--b24t-text-faint);">↻ Ładowanie...</div>' +
      '</div>' +
      // Tags tab
      '<div id="b24t-ann-tab-tagstats" class="b24t-ann-content" style="display:none;background:var(--b24t-bg);flex:1;overflow-y:auto;min-height:0;">' +
        '<div id="b24t-ann-tagstats-content" style="padding:16px;font-size:14px;color:var(--b24t-text-faint);">↻ Ładowanie...</div>' +
      '</div>' +
      // Groups tab
      '<div id="b24t-ann-tab-groups" class="b24t-ann-content" style="display:none;background:var(--b24t-bg);flex:1;overflow-y:auto;min-height:0;">' +
        '<div id="b24t-ann-tab-groups-content"></div>' +
      '</div>' +
      // Overall Stats tab
      '<div id="b24t-ann-tab-overall" class="b24t-ann-content" style="display:none;background:var(--b24t-bg);flex:1;overflow-y:auto;min-height:0;flex-direction:column;">' +
        '<div id="b24t-ann-tab-overall-content" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>' +
      '</div>';

    // Apply panel border/shadow via attribute (CSS vars pick it up)
    panel.style.border = '1px solid var(--b24t-border)';
    panel.style.boxShadow = 'var(--b24t-shadow-h)';
    panel.style.background = 'var(--b24t-bg)';
    panel.style.color = 'var(--b24t-text)';

    document.body.appendChild(panel);

    // Dopasuj startowy rozmiar annotator panelu do ekranu (jeśli brak zapisanego)
    if (!lsGet(LS.UI_ANN_SIZE)) {
      if (_getScreenProfile() === 'compact') {
        panel.style.width = Math.min(380, Math.round(window.innerWidth * 0.50)) + 'px';
      }
    }
    // Resize annotator panel — wszystkie krawędzie
    setupResize(panel, LS.UI_ANN_SIZE, {
      minW: 300, maxW: Math.min(640, Math.round(window.innerWidth * 0.80)),
      minH: 240, maxH: Math.round(window.innerHeight * 0.85),
      useMaxHeight: false
    });

    // Style tab trigger to match theme
    function styleTab() {
      var isDark = (document.documentElement.getAttribute('data-b24t-theme') === 'dark');
      tab.style.background = isDark ? '#1a1a28' : '#f0f7ff';
      tab.style.border = isDark ? '1px solid #2a2a35' : '1px solid #93c5fd';
      tab.style.color = isDark ? '#9090cc' : '#1d6fe8';
      tab.style.boxShadow = isDark ? '-3px 0 12px rgba(0,0,0,0.5)' : '-3px 0 16px rgba(29,111,232,0.18)';
    }
    styleTab();
    // Watch for theme changes
    var themeTrack = document.getElementById('b24t-theme-track');
    if (themeTrack) {
      themeTrack.addEventListener('click', function() { setTimeout(styleTab, 50); });
    }

    // Tab switching — liquid glass używa b24t-tab-active class jak główny panel
    panel.querySelectorAll('.b24t-ann-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tabName = btn.dataset.annTab;
        panel.querySelectorAll('.b24t-ann-tab').forEach(function(b) {
          b.classList.remove('b24t-tab-active');
        });
        btn.classList.add('b24t-tab-active');
        panel.querySelectorAll('.b24t-ann-content').forEach(function(el) { el.style.display = 'none'; });
        var content = document.getElementById('b24t-ann-tab-' + tabName);
        if (content) { content.style.display = 'flex'; content.style.animation = 'b24t-fadein 0.2s ease'; }
        // Jeśli bgCache gorący — renderuj od razu, potem cichy refetch
        if (tabName === 'tagstats') {
          var tsEl = document.getElementById('b24t-ann-tagstats-content');
          if (_bgCacheFresh(bgCache.tagstats) && tsEl) {
            annotatorData.tagstats = bgCache.tagstats;
            renderAnnotatorTagStats(tsEl, bgCache.tagstats);
            // Cichy background refresh
            _bgFetchTagstats().then(function(fresh) {
              if (fresh && tsEl) renderAnnotatorTagStats(tsEl, fresh);
            }).catch(function(e){ addLog('[BG] tagstats refresh error: ' + e.message, 'warn'); });
          } else if (!annotatorData.tagstats) {
            loadAnnotatorTagStats();
          }
        }
        if (tabName === 'groups') {
          renderGroupsTab();
        }
        if (tabName === 'overall') {
          renderOverallStatsTab();
        }
      });
    });

    // Close
    document.getElementById('b24t-ann-close').addEventListener('click', function() {
      panel.style.display = 'none';
      var t = document.getElementById('b24t-annotator-tab');
      if (t) t.style.display = 'flex';
      // News panels are independent — do NOT close them here
    });

    // Drag
    var hdr = document.getElementById('b24t-ann-header');
    var dragging = false, sx, sy, sl, st;
    hdr.addEventListener('mousedown', function(e) {
      if (e.target.id === 'b24t-ann-close') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      _bringToFront(panel);
      var r = panel.getBoundingClientRect(); sl = r.left; st = r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var newLeft = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  sl + e.clientX - sx));
      var newTop  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, st + e.clientY - sy));
      panel.style.left  = newLeft + 'px';
      panel.style.top   = newTop  + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', function() { dragging = false; });
  }

  function openAnnotatorPanel() {
    var panel = document.getElementById('b24t-annotator-panel');
    var tab   = document.getElementById('b24t-annotator-tab');
    if (!panel) return;
    // Re-trigger slide-in animation
    panel.style.animation = 'none';
    panel.offsetHeight; // reflow
    panel.style.animation = 'b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1)';
    panel.style.height = 'auto';
    panel.style.maxHeight = 'calc(100vh - 100px)';
    panel.style.display = 'flex';
    if (tab) tab.style.display = 'none';
    if (!annotatorData.project)  loadAnnotatorProject();
    // Tagstats — jeśli bgCache gorący renderuj od razu bez spinnera
    var tsEl = document.getElementById('b24t-ann-tagstats-content');
    if (_bgCacheFresh(bgCache.tagstats) && tsEl) {
      annotatorData.tagstats = bgCache.tagstats;
      renderAnnotatorTagStats(tsEl, bgCache.tagstats);
      _bgFetchTagstats().then(function(fresh) {
        if (fresh && tsEl) renderAnnotatorTagStats(tsEl, fresh);
      }).catch(function(e){ addLog('[BG] tagstats refresh error: ' + e.message, 'warn'); });
    } else if (!annotatorData.tagstats) {
      loadAnnotatorTagStats();
    }
    // Grupy i Overall — inicjalizuj zawsze przy otwarciu (lekka operacja, tylko render z danych)
    renderGroupsTab();
    renderOverallStatsTab();
  }

  // Formatuje lokalną datę jako YYYY-MM-DD (bez UTC shift)
  function _localDateStr(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function getAnnotatorDates() {
    var now = new Date(), day = now.getDate();
    var dateFrom, dateTo, label, daysLeft;
    if (day <= 2) {
      var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var last = new Date(now.getFullYear(), now.getMonth(), 0);
      dateFrom = _localDateStr(prev);
      dateTo   = _localDateStr(last);
      label = prev.toLocaleString('pl-PL', { month: 'long', year: 'numeric' }); daysLeft = 0;
    } else {
      dateFrom = _localDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
      dateTo   = _localDateStr(now);
      label = now.toLocaleString('pl-PL', { month: 'long', year: 'numeric' });
      daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - day;
    }
    return { dateFrom, dateTo, label, daysLeft, day };
  }

  async function loadAnnotatorProject() {
    var el = document.getElementById('b24t-ann-project-content');
    if (!el) return;
    if (!state.tokenHeaders || !state.projectId) {
      addLog('⚠ [zakładka Projekt] token lub projekt nie gotowy', 'warn');
      el.innerHTML = '<div style="color:#f87171;font-size:11px;">⚠ Token lub projekt nie gotowy — odśwież stronę</div>'; return;
    }
    addLog('→ [zakładka Projekt] ' + (state.projectName || 'projekt') + ': pobieranie danych...', 'info');
    el.innerHTML = '<div style="color:var(--b24t-text-faint);font-size:11px;text-align:center;padding:8px 0;">↻ Pobieranie...</div>';
    try {
      var dates = getAnnotatorDates();
      var bf = { va:1,rt:[],se:[],vi:null,gr:[],sq:'',do:'',au:'',lem:false,ctr:[],nctr:false,is:[0,10],tp:null,anom:'',lang:[],nlang:false,aue:null,htg:null,mt:false,mtri:null,cxs:[] };
      var gql = 'query getMentions($projectId:Int!,$dateRange:DateRangeInput!,$filters:MentionFilterInput,$page:Int,$order:Int){getMentions(projectId:$projectId,dateRange:$dateRange,filters:$filters,page:$page,order:$order){count results{id tags{id}}}}';
      var doPage = function(p) {
        return origFetch('/api/graphql', { method:'POST', credentials:'same-origin',
          headers:{...state.tokenHeaders,'Content-Type':'application/json'},
          body: JSON.stringify({ operationName:'getMentions', variables:{ projectId:state.projectId, dateRange:{from:dates.dateFrom,to:dates.dateTo}, filters:bf, page:p, order:0 }, query:gql })
        }).then(function(r){ return r.json(); });
      };
      var first = await doPage(1);
      var total = first?.data?.getMentions?.count || 0;
      var totalPages = Math.ceil(total / 60);
      var untagged = 0, reqVer = 0, toDelete = 0;
      var reqVerId = state.tags['REQUIRES_VERIFICATION'], toDeleteId = state.tags['TO_DELETE'];
      var proc = function(results) {
        (results || []).forEach(function(m) {
          var ids = (m.tags || []).map(function(t){ return t.id; });
          if (!ids.length) { untagged++; return; }
          if (reqVerId   && ids.includes(reqVerId))   reqVer++;
          if (toDeleteId && ids.includes(toDeleteId)) toDelete++;
        });
      };
      proc(first?.data?.getMentions?.results);
      var pages = []; for (var p = 2; p <= totalPages; p++) pages.push(p);
      for (var i = 0; i < pages.length; i += 10) {
        var batch = pages.slice(i, i+10);
        var res = await Promise.all(batch.map(function(pp){ return doPage(pp); }));
        res.forEach(function(d){ proc(d?.data?.getMentions?.results); });
      }
      var tagged = total - untagged;
      var pct = total > 0 ? Math.round((tagged/total)*100) : 0;
      annotatorData.project = { total, untagged, tagged, reqVer, toDelete, pct, dates };
      addLog('✓ [zakładka Projekt] ' + (state.projectName || 'projekt') + ': ALL:' + total + ' REQ:' + reqVer + ' DEL:' + toDelete + ' (' + pct + '% otagowane)', 'success');
      renderAnnotatorProject(el, annotatorData.project);
    } catch(e) {
      addLog('✕ [zakładka Projekt] błąd: ' + e.message, 'error');
      el.innerHTML = '<div style="color:#f87171;font-size:11px;">⚠ ' + e.message + '</div>';
    }
  }

  function renderAnnotatorProject(el, d) {
    var pc = d.pct === 100 ? 'var(--b24t-ok)' : 'var(--b24t-primary)';
    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
        '<div style="font-size:11px;color:var(--b24t-text-faint);">' + d.dates.label +
          (d.dates.daysLeft > 0 ? ' <span style="color:var(--b24t-warn);">· ' + d.dates.daysLeft + ' dni</span>' : '') + '</div>' +
        '<button id="b24t-ann-project-refresh" title="Odśwież" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:4px 8px;font-size:13px;cursor:pointer;flex-shrink:0;transition:transform 0.1s,background 0.15s;">&#8635;</button>' +
      '</div>' +
      '<div style="background:var(--b24t-bg-input);border-radius:99px;height:5px;margin-bottom:12px;overflow:hidden;">' +
        '<div style="height:100%;border-radius:99px;background:var(--b24t-accent-grad);width:' + d.pct + '%;transition:width 0.5s ease;"></div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">' +
        _annTile('Wszystkie', d.total, 'var(--b24t-text-muted)') +
        _annTile('Nieotagowane', d.untagged, d.untagged===0 ? 'var(--b24t-ok)' : 'var(--b24t-err)') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
        _annTile('REQ VER', d.reqVer, d.reqVer===0 ? 'var(--b24t-text-faint)' : 'var(--b24t-warn)') +
        _annTile('TO DELETE', d.toDelete, d.toDelete===0 ? 'var(--b24t-text-faint)' : 'var(--b24t-err)') +
      '</div>' +
      '<div style="margin-top:10px;text-align:center;font-size:12px;font-weight:700;color:' + pc + ';">' + (d.pct===100 ? '✓ Gotowe!' : d.pct+'% otagowane') + '</div>';
    var rb = el.querySelector('#b24t-ann-project-refresh');
    if (rb) rb.addEventListener('click', function() { annotatorData.project = null; loadAnnotatorProject(); });
  }

  function _annTile(label, value, color) {
    return '<div style="background:var(--b24t-section-grad-d);border:1px solid var(--b24t-border-strong);border-radius:8px;padding:10px;text-align:center;transition:background 0.3s,border-color 0.3s;box-shadow:inset 0 1px 0 rgba(255,255,255,0.10);">' +
      '<div style="font-size:22px;font-weight:800;color:' + color + ';line-height:1.2;">' + (value !== undefined ? value : '—') + '</div>' +
      '<div style="font-size:11px;color:var(--b24t-text-meta);margin-top:4px;text-transform:uppercase;letter-spacing:0.07em;font-weight:600;">' + label + '</div></div>';
  }

  async function loadAnnotatorTagStats() {
    var el = document.getElementById('b24t-ann-tagstats-content');
    if (!el) return;
    if (!state.tokenHeaders) {
      addLog('⚠ [zakładka Tagi] token nie gotowy', 'warn');
      el.innerHTML = '<div style="color:#f87171;font-size:11px;">⚠ Token nie gotowy</div>'; return;
    }
    var projects = getKnownProjects();
    if (!projects.length) {
      addLog('⚠ [zakładka Tagi] 0 projektów — odwiedź projekty z włączoną wtyczką', 'warn');
      el.innerHTML = '<div style="font-size:11px;color:var(--b24t-text-faint);">Brak projektów. Odwiedź każdy projekt raz.</div>'; return;
    }

    // ── Jeśli cache gorący — renderuj od razu bez spinnera ──
    if (_bgCacheFresh(bgCache.tagstats)) {
      var age = Math.round((Date.now() - bgCache.tagstats.ts) / 1000);
      var ageStr = age < 60 ? age + 's' : Math.round(age/60) + 'm ' + (age%60) + 's';
      addLog('[CACHE] tagstats: gorący (' + ageStr + ' temu), renderuję od razu', 'info');
      annotatorData.tagstats = bgCache.tagstats;
      renderAnnotatorTagStats(el, bgCache.tagstats);
      // Cichy background refresh — nie resetuj DOM
      _bgFetchTagstats().then(function(fresh) {
        if (fresh) renderAnnotatorTagStats(el, fresh);
      }).catch(function(e){ addLog('[BG] tagstats refresh error: ' + e.message, 'warn'); });
      return;
    }

    addLog('→ [zakładka Tagi] pobieranie danych (' + projects.length + ' projektów)...', 'info');

    // ── Cache zimny — pokaż spinner, pobierz, renderuj ──
    var dates = getAnnotatorDates();

    el.innerHTML =
      '<div style="padding:20px 0;text-align:center;">' +
        '<div style="font-size:22px;animation:b24t-spin 1s linear infinite;display:inline-block;">↻</div>' +
        '<div id="b24t-ann-ts-counter" style="font-size:10px;color:var(--b24t-text-faint);margin-top:6px;">0 / ' + projects.length + '</div>' +
      '</div>';

    if (!document.getElementById('b24t-spin-style')) {
      var s = document.createElement('style');
      s.id = 'b24t-spin-style';
      s.textContent = '@keyframes b24t-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }

    var results = [];
    var done = 0;
    await Promise.all(projects.map(function(p) {
      return Promise.all([
        getMentions(p.id, dates.dateFrom, dates.dateTo, [p.reqVerId],   1).catch(function(){ return { count: 0 }; }),
        getMentions(p.id, dates.dateFrom, dates.dateTo, [p.toDeleteId], 1).catch(function(){ return { count: 0 }; }),
      ]).then(function(pages) {
        done++;
        var counter = document.getElementById('b24t-ann-ts-counter');
        if (counter) counter.textContent = done + ' / ' + projects.length;
        var reqVer   = (pages[0].count) || 0;
        var toDelete = (pages[1].count) || 0;
        if (reqVer > 0 || toDelete > 0) {
          results.push({ name: p.name, id: p.id, reqVer: reqVer, toDelete: toDelete });
        }
      });
    }));

    bgCache.tagstats = { results: results, dates: dates, ts: Date.now() };
    annotatorData.tagstats = bgCache.tagstats;
    addLog('✓ [zakładka Tagi] załadowano dane (' + projects.length + ' projektów, ' + results.length + ' z tagami)', 'success');
    renderAnnotatorTagStats(el, bgCache.tagstats);
  }

  function renderAnnotatorTagStats(el, d) {
    var filtered = (d.results||[]).filter(function(p){ return p.reqVer>0||p.toDelete>0; })
      .sort(function(a,b){ return (b.reqVer+b.toDelete)-(a.reqVer+a.toDelete); });
    if (!filtered.length) {
      el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 8px;">' +
          '<div style="font-size:11px;color:var(--b24t-text-faint);">' + (d.dates ? d.dates.dateFrom + ' – ' + d.dates.dateTo : '') + '</div>' +
          '<button id="b24t-ann-tagstats-refresh" title="Odśwież" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:4px 8px;font-size:13px;cursor:pointer;flex-shrink:0;transition:transform 0.1s,background 0.15s;">&#8635;</button>' +
        '</div>' +
        '<div style="text-align:center;color:var(--b24t-ok);font-size:13px;padding:12px 0;font-weight:600;">✓ Wszystkie projekty czyste!</div>';
      var rb = el.querySelector('#b24t-ann-tagstats-refresh');
      if (rb) rb.addEventListener('click', function() { annotatorData.tagstats = null; bgCache.tagstats = null; loadAnnotatorTagStats(); });
      return;
    }
    var rows = filtered.map(function(p) {
      return '<tr>' +
        '<td style="padding:6px 10px;font-size:12px;color:var(--b24t-text);border-bottom:1px solid var(--b24t-border-sub);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + p.name + '">' + p.name + '</td>' +
        '<td style="padding:6px 8px;font-size:13px;font-weight:700;color:' + (p.reqVer>0?'var(--b24t-warn)':'var(--b24t-text-faint)') + ';text-align:center;border-bottom:1px solid var(--b24t-border-sub);">' + (p.reqVer||'—') + '</td>' +
        '<td style="padding:6px 8px;font-size:13px;font-weight:700;color:' + (p.toDelete>0?'var(--b24t-err)':'var(--b24t-text-faint)') + ';text-align:center;border-bottom:1px solid var(--b24t-border-sub);">' + (p.toDelete||'—') + '</td>' +
      '</tr>';
    }).join('');
    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 8px;">' +
        '<div style="font-size:11px;color:var(--b24t-text-faint);">' + d.dates.dateFrom + ' – ' + d.dates.dateTo + '</div>' +
        '<button id="b24t-ann-tagstats-refresh" title="Odśwież" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:4px 8px;font-size:13px;cursor:pointer;flex-shrink:0;transition:transform 0.1s,background 0.15s;">&#8635;</button>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
        '<thead><tr>' +
          '<th style="padding:5px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--b24t-text-faint);text-align:left;border-bottom:1px solid var(--b24t-border);">Projekt</th>' +
          '<th style="padding:5px 8px;font-size:10px;font-weight:700;color:var(--b24t-warn);text-align:center;border-bottom:1px solid var(--b24t-border);">REQ</th>' +
          '<th style="padding:5px 8px;font-size:10px;font-weight:700;color:var(--b24t-err);text-align:center;border-bottom:1px solid var(--b24t-border);">DEL</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
    var rb = el.querySelector('#b24t-ann-tagstats-refresh');
    if (rb) rb.addEventListener('click', function() { annotatorData.tagstats = null; bgCache.tagstats = null; loadAnnotatorTagStats(); });
  }

  // ───────────────────────────────────────────
  // PARALLEL FETCH HELPER - used by all multi-page collection flows
  // ───────────────────────────────────────────

  const FETCH_CONCURRENCY = 10;

  // Collect all mention IDs across all pages using parallel batches
  // Works for both getMentions (by tag) and getMentionsWithFilters (by current view)
  async function fetchAllIds(fetchPageFn, onProgress) {
    // Page 1 to get total
    const first = await fetchPageFn(1);
    const pageSize = first.results.length || state.pageSize || 60;
    const totalPages = Math.ceil(first.count / pageSize);
    const allIds = first.results.map(m => m.id);
    if (onProgress) onProgress(1, totalPages, allIds.length, first.count);
    if (totalPages <= 1) return allIds;

    // Remaining pages in parallel batches
    const remaining = Array.from({length: totalPages - 1}, (_, i) => i + 2);
    for (let i = 0; i < remaining.length; i += FETCH_CONCURRENCY) {
      const batch = remaining.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map(p => fetchPageFn(p)));
      results.forEach(r => r.results.forEach(m => allIds.push(m.id)));
      const fetched = 1 + Math.min(i + FETCH_CONCURRENCY, remaining.length);
      if (onProgress) onProgress(fetched, totalPages, allIds.length, first.count);
      if (i + FETCH_CONCURRENCY < remaining.length) await sleep(100);
    }
    return allIds;
  }

  // ───────────────────────────────────────────
  // DELETE MODE

  // Auto-delete prefs key for current project + mapping combo
  function getAutoDeletePrefKey() {
    if (!state.projectId || !state.mapping) return null;
    const irrelevantEntry = Object.entries(state.mapping).find(([, m]) => m.type === 'irrelevant');
    if (!irrelevantEntry) return null;
    return `${state.projectId}_${irrelevantEntry[1].tagId}`;
  }

  // Check if auto-delete is saved for current config
  function getAutoDeletePref() {
    const key = getAutoDeletePrefKey();
    if (!key) return false;
    const prefs = lsGet(LS.DELETE_AUTO, {});
    return prefs[key] || false;
  }

  function setAutoDeletePref(val) {
    const key = getAutoDeletePrefKey();
    if (!key) return;
    const prefs = lsGet(LS.DELETE_AUTO, {});
    prefs[key] = val;
    lsSet(LS.DELETE_AUTO, prefs);
  }

  // Build Delete tab HTML

  // Show/update auto-delete section when mapping changes
  function updateAutoDeleteSection() {
    const section = document.getElementById('b24t-auto-delete-section');
    if (!section) return;

    const hasIrrelevant = Object.values(state.mapping).some(m => m.type === 'irrelevant');
    section.style.display = hasIrrelevant ? 'block' : 'none';

    if (!hasIrrelevant) return;

    // Populate tag dropdown
    const autoSel = document.getElementById('b24t-auto-delete-tag');
    if (autoSel) {
      autoSel.innerHTML = '<option value="">— wybierz —</option>' +
        Object.entries(state.mapping)
          .filter(([, m]) => m.type === 'irrelevant')
          .map(([, m]) => `<option value="${m.tagId}">${m.tagName}</option>`)
          .join('');
    }

    // Restore saved preference if matches current config
    if (getAutoDeletePref()) {
      const cb = document.getElementById('b24t-auto-delete-cb');
      const saveCb = document.getElementById('b24t-auto-delete-save-cb');
      if (cb) cb.checked = true;
      if (saveCb) { saveCb.checked = true; saveCb.closest('#b24t-auto-delete-save-row').style.display = 'block'; }
      state.autoDeleteEnabled = true;
    }
  }



  // ───────────────────────────────────────────
  // DELETE ENGINE
  // ───────────────────────────────────────────

  // Single mention delete via GraphQL
  async function deleteMention(mentionId) {
    if (state.testRunMode) {
      addLog(`[TEST] deleteMention: ${mentionId}`, 'info');
      return { success: true };
    }
    const data = await gqlRetry('deleteMention', { id: mentionId }, `mutation deleteMention($id: IntString!) {
      deleteMention(id: $id)
    }`);
    return { success: true };
  }

  // Show one-time delete warning - returns true if user confirmed
  async function confirmDeleteWarning() {
    if (lsGet(LS.DELETE_CONFIRMED)) return true;
    return new Promise(resolve => {
      const modal = document.createElement('div');
      modal.className = 'b24t-modal-overlay';
      modal.innerHTML = `
        <div class="b24t-modal" style="width:360px;">
          <div class="b24t-modal-title" style="color:#f87171;">⚠ Operacja nieodwracalna</div>
          <div class="b24t-modal-text">
            Usuwanie wzmianek przez wtyczkę jest <strong style="color:#f87171;">PERMANENTNE</strong>
            i nie można go cofnąć.<br><br>
            Wzmianki znikną z projektu Brand24 na zawsze
            i nie będzie możliwości ich przywrócenia.<br><br>
            Czy rozumiesz ryzyko i chcesz kontynuować?
          </div>
          <div class="b24t-modal-actions">
            <button data-action="cancel" class="b24t-btn-secondary">Anuluj</button>
            <button data-action="confirm" class="b24t-btn-danger" style="flex:1.5;">
              Rozumiem — kontynuuj
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          document.body.removeChild(modal);
          if (btn.dataset.action === 'confirm') {
            lsSet(LS.DELETE_CONFIRMED, true);
            resolve(true);
          } else {
            resolve(false);
          }
        });
      });
    });
  }

  // Modal ostrzeżenia przed zmianą batch size delete — pokazuje się tylko raz
  function _showDeleteBatchWarning() {
    return new Promise(function(resolve) {
      var modal = document.createElement('div');
      modal.className = 'b24t-modal-overlay';
      modal.innerHTML = `
        <div class="b24t-modal" style="width:380px;">
          <div class="b24t-modal-title" style="color:#f87171;">⚠ Zaawansowane ustawienie — przeczytaj</div>
          <div class="b24t-modal-text" style="line-height:1.7;">
            <strong style="color:#f87171;">Zwiększenie batch size przyspiesza usuwanie</strong>,
            ale proporcjonalnie zwiększa ryzyko pomyłki.<br><br>
            Przy batch = 10 usuwanych jest 10 wzmianek na raz.
            Przy batch = 100 — już 100. Błąd ludzki (zły tag, zły zakres dat)
            przy większym batchu oznacza <strong>więcej nieodwracalnie usuniętych wzmianek</strong>
            zanim zdążysz zatrzymać operację.<br><br>
            <strong>Twórca wtyczki nie ponosi odpowiedzialności</strong>
            za skutki działań użytkownika z niestandardowymi ustawieniami.<br><br>
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:7px;padding:10px;">
              <input type="checkbox" id="b24t-delbatch-cb" style="margin-top:2px;flex-shrink:0;accent-color:#f87171;">
              <span style="font-size:12px;">Rozumiem ryzyko i biorę pełną odpowiedzialność za swoje działania</span>
            </label>
          </div>
          <div class="b24t-modal-actions">
            <button data-action="cancel" class="b24t-btn-secondary">Anuluj</button>
            <button data-action="confirm" class="b24t-btn-danger" id="b24t-delbatch-confirm" disabled style="flex:1.5;">
              Rozumiem — odblokuj
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      var cb  = modal.querySelector('#b24t-delbatch-cb');
      var btn = modal.querySelector('#b24t-delbatch-confirm');
      cb.addEventListener('change', function() { btn.disabled = !cb.checked; });
      modal.querySelectorAll('button').forEach(function(b) {
        b.addEventListener('click', function() {
          document.body.removeChild(modal);
          resolve(b.dataset.action === 'confirm' && cb.checked);
        });
      });
    });
  }

  // Core delete function: collect all mention IDs with given tag in date range, then delete
  async function runDeleteByTag(tagId, tagName, dateFrom, dateTo, onProgress, projectId) {
    const pid = projectId || state.projectId;
    addLog(`→ Usuwanie wzmianek z tagiem "${tagName}" (${dateFrom} → ${dateTo}) [proj:${pid}]`, 'warn');

    // Collect IDs in parallel
    const allIds = await fetchAllIds(
      p => getMentions(pid, dateFrom, dateTo, [tagId], p),
      (cur, total, count) => onProgress && onProgress('collect', cur, total, count)
    );

    if (!allIds.length) {
      addLog(`ℹ Brak wzmianek z tagiem "${tagName}" w zakresie dat — nic do usunięcia.`, 'info');
      return 0;
    }

    addLog(`→ Znaleziono ${allIds.length} wzmianek do usunięcia`, 'warn');

    // Delete in parallel batches (_deleteBatch, domyślnie DEL_BATCH_DEFAULT)
    const BATCH = _deleteBatch;
    let deleted = 0;
    for (let i = 0; i < allIds.length; i += BATCH) {
      if (state.status === 'paused') break;
      const chunk = allIds.slice(i, i + BATCH);
      await Promise.all(chunk.map(id => deleteMention(id)));
      deleted += chunk.length;
      if (onProgress) onProgress('delete', deleted, allIds.length);
      if (deleted % 25 === 0 || deleted === allIds.length) {
        addLog(`→ Usunięto ${deleted}/${allIds.length}...`, 'info');
      }
    }

    addLog(`✓ Usunięto ${deleted} wzmianek z tagiem "${tagName}"`, 'success');
    return deleted;
  }

  // Auto-delete after file tagging run - called from main flow
  async function runAutoDeleteAfterTagging(tagId, tagName, dateFrom, dateTo) {
    if (!tagId || !dateFrom || !dateTo) return;
    addLog(`→ Auto-Delete: "${tagName}" (${dateFrom} → ${dateTo})`, 'warn');

    const setStatus = (msg) => {
      const el = document.getElementById('b24t-autodelete-status');
      if (el) el.textContent = msg;
    };

    try {
      const deleted = await runDeleteByTag(tagId, tagName, dateFrom, dateTo, (phase, cur, total) => {
        if (phase === 'collect') setStatus(`Zbieram: str. ${cur}/${total}...`);
        else setStatus(`Usuwam: ${cur}/${total}...`);
      });
      setStatus(`✓ Usunięto ${deleted} wzmianek`);
    } catch (e) {
      addLog(`✕ Auto-Delete błąd: ${e.message}`, 'error');
      setStatus(`✕ Błąd: ${e.message}`);
    }
  }

  // ───────────────────────────────────────────
  // QUICK DELETE TAB
  // ───────────────────────────────────────────

  // ─── LOG PANEL (pełnoekranowy widok loga) ─────────────────────────

  // Dodaje wpis do panelu loga jeśli jest otwarty (wywoływane z addLog)
  function _syncLogPanel(entry) {
    var panel = document.getElementById('b24t-log-panel');
    if (!panel || panel.style.display === 'none') return;
    _appendLogPanelEntry(panel, entry);
    var body = document.getElementById('b24t-logp-body');
    if (body) body.scrollTop = body.scrollHeight;
    _applyLogPanelFilter(panel);
  }

  function _appendLogPanelEntry(panel, entry) {
    var body = document.getElementById('b24t-logp-body');
    if (!body) return;
    var colors = { info: 'var(--b24t-text-muted)', success: 'var(--b24t-ok)', warn: 'var(--b24t-warn)', error: 'var(--b24t-err)' };
    var msgColor = colors[entry.type] || 'var(--b24t-text-muted)';
    var msgHtml = entry.message;
    var row = document.createElement('div');
    row.dataset.logType = entry.type;
    row.style.cssText = 'display:flex;gap:8px;padding:2px 0;border-bottom:1px solid var(--b24t-border-sub);font-size:12px;line-height:1.5;';
    row.innerHTML =
      '<span style="color:var(--b24t-text-faint);flex-shrink:0;font-size:11px;">' + entry.time + '</span>' +
      '<span style="color:var(--b24t-text-faint);flex-shrink:0;font-size:10px;padding-top:2px;min-width:42px;">[' + entry.type.toUpperCase() + ']</span>' +
      '<span style="color:' + msgColor + ';flex:1;word-break:break-word;">' + msgHtml + '</span>';
    body.appendChild(row);
  }

  function _applyLogPanelFilter(panel) {
    if (!panel) return;
    var body = document.getElementById('b24t-logp-body');
    if (!body) return;
    var active = {};
    panel.querySelectorAll('.b24t-logp-filter').forEach(function(cb) {
      active[cb.dataset.type] = cb.checked;
    });
    Array.from(body.children).forEach(function(row) {
      var t = row.dataset.logType;
      row.style.display = (active[t] !== false) ? '' : 'none';
    });
  }

  function buildLogPanel() {
    if (document.getElementById('b24t-log-panel')) return;
    var el = document.createElement('div');
    el.id = 'b24t-log-panel';
    el.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'width:720px', 'max-width:95vw', 'height:520px', 'max-height:90vh',
      'background:var(--b24t-bg)', 'border:1px solid var(--b24t-border)',
      'border-radius:12px', 'box-shadow:0 16px 48px rgba(0,0,0,0.6)',
      'z-index:2147483647', 'display:none', 'flex-direction:column',
      'font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif',
      'color:var(--b24t-text)',
      'overflow:hidden', 'resize:both',
    ].join(';');

    el.innerHTML =
      // Header z gradientem
      '<div id="b24t-logp-header" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--b24t-bg-deep);flex-shrink:0;cursor:move;user-select:none;border-bottom:1px solid var(--b24t-border);">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-size:14px;font-weight:700;color:var(--b24t-text);">📋 Log sesji</span>' +
          '<span id="b24t-logp-count" style="font-size:10px;color:var(--b24t-text-faint);background:var(--b24t-bg-elevated);border-radius:99px;padding:1px 7px;"></span>' +
        '</div>' +
        '<button id="b24t-logp-close" style="background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);color:var(--b24t-text);border-radius:5px;padding:2px 10px;cursor:pointer;font-size:15px;line-height:1;">×</button>' +
      '</div>' +
      // Toolbar — filtry + przyciski
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--b24t-bg-elevated);border-bottom:1px solid var(--b24t-border-sub);flex-shrink:0;flex-wrap:wrap;">' +
        '<span style="font-size:10px;color:var(--b24t-text-faint);margin-right:2px;">Filtr:</span>' +
        _logpFilterChk('info',    '#9ca3af', 'info')    +
        _logpFilterChk('success', '#4ade80', 'success') +
        _logpFilterChk('warn',    '#fbbf24', 'warn')    +
        _logpFilterChk('error',   '#f87171', 'error')   +
        _logpFilterChk('diag',    '#f87171', 'diag')    +
        '<div style="flex:1;"></div>' +
        '<button id="b24t-logp-copy" style="background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">📋 Kopiuj</button>' +
        '<button id="b24t-logp-csv" style="background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">⬇ CSV</button>' +
      '</div>' +
      // Treść loga
      '<div id="b24t-logp-body" style="flex:1;overflow-y:auto;padding:8px 16px;background:var(--b24t-bg-deep);">' +
      '</div>';

    document.body.appendChild(el);

    // Wypełnij istniejącymi wpisami
    (state.logs || []).forEach(function(entry) { _appendLogPanelEntry(el, entry); });
    var countEl = el.querySelector('#b24t-logp-count');
    if (countEl) countEl.textContent = (state.logs || []).length + ' wpisów';

    // Event: zamknij
    el.querySelector('#b24t-logp-close').addEventListener('click', function() {
      el.style.display = 'none';
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && el.style.display !== 'none') { el.style.display = 'none'; e.stopPropagation(); }
    });

    // Event: filtry
    el.querySelectorAll('.b24t-logp-filter').forEach(function(cb) {
      cb.addEventListener('change', function() { _applyLogPanelFilter(el); });
    });

    // Event: kopiuj
    el.querySelector('#b24t-logp-copy').addEventListener('click', function() {
      var text = (state.logs || []).map(function(l) {
        return '[' + l.time + '] [' + l.type.toUpperCase() + '] ' + l.message;
      }).join('\n');
      navigator.clipboard.writeText(text).then(function() {
        var btn = el.querySelector('#b24t-logp-copy');
        if (btn) { btn.textContent = '✓ Skopiowano'; setTimeout(function() { btn.textContent = '📋 Kopiuj'; }, 1500); }
      }).catch(function() {});
    });

    // Event: eksport CSV
    el.querySelector('#b24t-logp-csv').addEventListener('click', function() {
      exportReport();
    });

    // Drag
    var hdr = el.querySelector('#b24t-logp-header');
    var dragging = false, sx, sy, ex, ey;
    hdr.addEventListener('mousedown', function(e) {
      if (e.target.id === 'b24t-logp-close') return;
      dragging = true;
      var r = el.getBoundingClientRect();
      ex = r.left; ey = r.top;
      sx = e.clientX; sy = e.clientY;
      el.style.transform = 'none';
      el.style.left = ex + 'px'; el.style.top = ey + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      el.style.left = (ex + e.clientX - sx) + 'px';
      el.style.top  = (ey + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', function() { dragging = false; });
  }

  function _logpFilterChk(type, color, label) {
    return '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;color:' + color + ';">' +
      '<input type="checkbox" class="b24t-logp-filter" data-type="' + type + '" checked style="accent-color:' + color + ';cursor:pointer;">' +
      label + '</label>';
  }

  function openLogPanel() {
    buildLogPanel();
    var el = document.getElementById('b24t-log-panel');
    if (!el) return;
    // Odśwież zawartość
    var body = el.querySelector('#b24t-logp-body');
    if (body) {
      body.innerHTML = '';
      (state.logs || []).forEach(function(entry) { _appendLogPanelEntry(el, entry); });
      body.scrollTop = body.scrollHeight;
    }
    var countEl = el.querySelector('#b24t-logp-count');
    if (countEl) countEl.textContent = (state.logs || []).length + ' wpisów';
    el.style.display = 'flex';
    el.style.left = '50%'; el.style.top = '50%';
    el.style.transform = 'translate(-50%,-50%)';
    _applyLogPanelFilter(el);
  }

  // ─── SYSTEM DIAGNOSTYCZNY ─────────────────────────────────────────

  var DIAG_CHECKS = [
    {
      id: 'project_names',
      name: 'Nazwy projektów',
      check: function() {
        var projects = lsGet(LS.PROJECTS, {});
        Object.entries(projects).forEach(function(entry) {
          var pid = parseInt(entry[0]);
          var resolved = _pnResolve(pid);
          if (/^Projekt\s+\d+$/.test(resolved) || /^ID:\d+$/.test(resolved)) {
            addLog('[DIAG] Projekt ID:' + pid + ' — brak nazwy w PROJECT_NAMES (odwiedź stronę projektu)', 'diag');
          }
        });
      }
    },
    {
      id: 'dates_range',
      name: 'Zakres dat',
      check: function() {
        var dates = getAnnotatorDates();
        if (!dates) return;
        var from = new Date(dates.dateFrom), to = new Date(dates.dateTo);
        if (from > to) {
          addLog('[DIAG] Daty podejrzane: dateFrom > dateTo (' + dates.dateFrom + ' → ' + dates.dateTo + ')', 'diag');
        }
        var threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        if (from < threeMonthsAgo) {
          addLog('[DIAG] Daty podejrzane: dateFrom sprzed 3+ miesięcy (' + dates.dateFrom + ')', 'diag');
        }
      }
    },
    {
      id: 'token',
      name: 'Token',
      check: function() {
        // Sprawdzamy tylko jeśli jesteśmy na stronie projektu i token powinien być gotowy
        if (!state.projectId) return;
        if (!state.tokenHeaders) {
          addLog('[DIAG] Brak tokenu — operacje API będą przerywane', 'diag');
        }
      }
    },
    {
      id: 'known_projects',
      name: 'Znane projekty',
      check: function() {
        var projects = lsGet(LS.PROJECTS, {});
        if (!Object.keys(projects).length) {
          addLog('[DIAG] getKnownProjects: 0 projektów — czy odwiedziłeś projekty z włączoną wtyczką?', 'diag');
        }
      }
    },
    {
      id: 'group_projects',
      name: 'Projekty w grupach',
      check: function() {
        var groups = getGroups();
        var projects = lsGet(LS.PROJECTS, {});
        var knownIds = Object.keys(projects).map(Number);
        groups.forEach(function(g) {
          (g.projectIds || []).forEach(function(pid) {
            if (!knownIds.includes(pid)) {
              addLog('[DIAG] Grupa "' + g.name + '": projekt ID:' + pid + ' nieznany (brak w LS.PROJECTS)', 'diag');
            }
          });
        });
      }
    },
    {
      id: 'cache_group_mismatch',
      name: 'Cache: zgodność grupy',
      check: function() {
        if (!bgCache.overallStats) return;
        var cfg = getStatsConfig();
        if (cfg.selectedGroupId && bgCache.overallStats.groupId !== cfg.selectedGroupId) {
          addLog('[DIAG] Cache: overallStats dla innej grupy — wymagane odświeżenie', 'diag');
        }
      }
    },
  ];

  function runDiagChecks(checkIds) {
    // checkIds = null → wszystkie; lub tablica ID do uruchomienia
    var toRun = checkIds
      ? DIAG_CHECKS.filter(function(c) { return checkIds.includes(c.id); })
      : DIAG_CHECKS;
    toRun.forEach(function(c) {
      try { c.check(); } catch(e) {
        addLog('[DIAG] Błąd check "' + c.name + '": ' + e.message, 'diag');
      }
    });
  }

  // ─── ALL-PROJECTS DELETE SIDE PANEL ───────────────────────────────

  // Wysuwa się z prawej krawędzi przy zaznaczeniu "Wszystkie projekty"
  // Oblicz pozycję bocznego panelu na podstawie aktualnej pozycji głównego panelu
  function _positionXProjectPanel(el) {
    const main = document.getElementById('b24t-panel');
    if (!main) return;
    const r = main.getBoundingClientRect();
    const panelW = 280;
    const vw = window.innerWidth;
    // Wysuń z prawej krawędzi panelu głównego
    // Jeśli jest za mało miejsca po prawej — wysuń po lewej
    const spaceRight = vw - r.right;
    if (spaceRight >= panelW + 8) {
      el.style.left   = (r.right + 6) + 'px';
      el.style.right  = 'auto';
    } else {
      el.style.right  = (vw - r.left + 6) + 'px';
      el.style.left   = 'auto';
    }
    // Wyrównaj góra do panelu głównego, NIE rozciągaj do dołu — panel ma auto height
    el.style.top    = r.top + 'px';
    el.style.bottom = 'auto';
    el.style.height = 'auto';
    el.style.maxHeight = (window.innerHeight - r.top - 16) + 'px';
  }

  function buildAllProjectsPanel() {
    if (document.getElementById('b24t-del-allprojects-panel')) return;
    const el = document.createElement('div');
    el.id = 'b24t-del-allprojects-panel';
    el.style.cssText = [
      'position:fixed',
      'width:280px',
      'background:var(--b24t-bg)',
      'border:1px solid var(--b24t-border)',
      'border-radius:12px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.3)',
      'z-index:2147483646',
      'display:none',
      'flex-direction:column',
      'font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif',
      'overflow:hidden',
      'animation:b24t-slidein 0.28s cubic-bezier(0.34,1.56,0.64,1)',
    ].join(';');
    _positionXProjectPanel(el);
    el.innerHTML =
      // Header — czerwony gradient (to jest funkcja delete)
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:linear-gradient(135deg,#dc2626,#b91c1c);flex-shrink:0;">' +
        '<div>' +
          '<div style="font-size:12px;font-weight:700;color:#fff;">🌐 Wszystkie projekty</div>' +
          '<div style="font-size:10px;color:rgba(255,255,255,0.75);margin-top:1px;">TO_DELETE we wszystkich projektach</div>' +
        '</div>' +
        '<button id="b24t-ap-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:14px;line-height:1;">×</button>' +
      '</div>' +
      // Subheader — wybrany tag
      '<div id="b24t-ap-tag-name" style="padding:8px 14px;background:var(--b24t-bg-elevated);border-bottom:1px solid var(--b24t-border);font-size:11px;font-weight:600;color:var(--b24t-text-muted);flex-shrink:0;">Wybierz tag, aby załadować dane</div>' +
      // Group filter — widoczny tylko gdy istnieją grupy
      '<div id="b24t-ap-group-filter" style="display:none;padding:6px 10px;background:var(--b24t-bg-deep);border-bottom:1px solid var(--b24t-border-sub);">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span style="font-size:10px;color:var(--b24t-text-faint);flex-shrink:0;">Zakres:</span>' +
          '<select id="b24t-ap-group-sel" style="flex:1;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text);border-radius:5px;font-size:11px;padding:4px 6px;font-family:inherit;cursor:pointer;">' +
            '<option value="">Wszystkie projekty</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      // Lista projektów
      '<div id="b24t-ap-list" style="flex:1;overflow-y:auto;">' +
        '<div style="padding:16px;text-align:center;font-size:12px;color:var(--b24t-text-faint);">—</div>' +
      '</div>' +
      // Footer — łącznie + przycisk
      '<div style="padding:10px 14px;border-top:1px solid var(--b24t-border);background:var(--b24t-bg-elevated);flex-shrink:0;">' +
        '<div id="b24t-ap-total" style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:8px;"></div>' +
        '<button id="b24t-ap-delete-all" style="width:100%;padding:8px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;display:none;transition:opacity 0.15s;">' +
          '🗑 Usuń z wszystkich projektów' +
        '</button>' +
      '</div>';
    document.body.appendChild(el);

    // Repositionuj gdy główny panel jest przesuwany lub okno zmienione
    const reposition = () => _positionXProjectPanel(el);
    window.addEventListener('resize', reposition);
    // Obserwuj zmiany pozycji głównego panelu (drag)
    const mainPanel = document.getElementById('b24t-panel');
    if (mainPanel) {
      new MutationObserver(reposition).observe(mainPanel, { attributes: true, attributeFilter: ['style'] });
    }

    // Group filter — wypełnij opcjami i pokaż jeśli grupy istnieją
    (function() {
      var groups = getGroups();
      var filterEl = document.getElementById('b24t-ap-group-filter');
      var groupSel = document.getElementById('b24t-ap-group-sel');
      if (filterEl && groupSel && groups.length) {
        filterEl.style.display = 'block';
        groups.forEach(function(g) {
          var opt = document.createElement('option');
          opt.value = g.id;
          opt.textContent = g.name + ' (' + g.projectIds.length + ' proj.)';
          groupSel.appendChild(opt);
        });
        groupSel.addEventListener('change', function() {
          var gName = groupSel.options[groupSel.selectedIndex]?.text || 'wszystkie projekty';
          addLog('🗂 [Cross-delete] wybrano zakres: ' + gName, 'info');
          // Po zmianie grupy wymuś odświeżenie listy projektów
          bgCache.allProjects = {};
          refreshAllProjectsPanel();
        });
      }
    })();

    // Close button
    document.getElementById('b24t-ap-close').addEventListener('click', () => {
      el.style.display = 'none';
      // Odznacz radio i wróć do "view"
      const viewRadio = document.querySelector('input[name="b24t-del-scope"][value="view"]');
      if (viewRadio) { viewRadio.checked = true; viewRadio.dispatchEvent(new Event('change')); }
    });

    // Delete all button
    document.getElementById('b24t-ap-delete-all').addEventListener('click', async () => {
      const tagId = parseInt(document.getElementById('b24t-del-tag')?.value);
      if (!tagId) return;
      const tagName = Object.entries(state.tags).find(([,id]) => id === tagId)?.[0] || String(tagId);
      const confirmed = await confirmDeleteWarning();
      if (!confirmed) return;
      const cached = bgCache.allProjects[tagId];
      const results = (cached && cached.results || []).filter(function(r) { return r.count > 0; });
      if (!results.length) { addLog('Brak projektów z tym tagiem. Otwórz panel "Wszystkie projekty" i poczekaj na załadowanie danych.', 'warn'); return; }
      const total = results.reduce(function(s, r) { return s + r.count; }, 0);
      if (!confirm(`Usunąć ${total} wzmianek z tagiem "${tagName}" ze wszystkich ${results.length} projektów?

To jest NIEODWRACALNE.`)) return;
      const btn = document.getElementById('b24t-ap-delete-all');
      const statusEl = document.getElementById('b24t-del-status');
      const progressEl = document.getElementById('b24t-del-progress');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Usuwam...'; }
      if (progressEl) progressEl.classList.add('b24t-bar-active');
      _getBarDel().reset();
      let doneProjects = 0;
      for (const r of results) {
        const p = r.p;
        addLog(`→ Usuwam "${tagName}" z projektu ${p.name} (${r.count} wzmianek)...`, 'info');
        if (statusEl) statusEl.textContent = `${p.name}: zbieram...`;
        await runDeleteByTag(tagId, tagName, p._dateFrom, p._dateTo, (phase, cur, tot) => {
          if (btn) btn.textContent = `⏳ ${p.name}: ${phase === 'collect' ? 'zbieram' : cur + '/' + tot}`;
          if (statusEl) statusEl.textContent = `${p.name}: ${phase === 'collect' ? 'zbieram str. ' + cur : cur + '/' + tot}`;
        }, p.id);
        doneProjects++;
        _getBarDel().set(Math.round(doneProjects / results.length * 100));
        addLog(`✓ ${p.name}: gotowe`, 'success');
      }
      if (btn) { btn.disabled = false; btn.textContent = '🗑 Usuń z wszystkich projektów'; }
      if (progressEl) progressEl.classList.remove('b24t-bar-active');
      _getBarDel().set(100);
      if (statusEl) { statusEl.textContent = '✓ Usunięto ze wszystkich projektów'; statusEl.style.color = '#4ade80'; }
      addLog('✅ Usuwanie ze wszystkich projektów zakończone.', 'success');
      // Invaliduj cache — dane się zmieniły
      bgCache.allProjects = {};
      bgCache.tagstats = null;
      annotatorData.tagstats = null;
      refreshAllProjectsPanel();
    });
  }

  // Render pomocniczy — używany przez refreshAllProjectsPanel z danych cache lub świeżych
  function _renderAllProjectsList(results, tagName) {
    const list    = document.getElementById('b24t-ap-list');
    const totalEl = document.getElementById('b24t-ap-total');
    const delBtn  = document.getElementById('b24t-ap-delete-all');
    if (!list) return;

    const withData   = results.filter(function(r) { return r.count > 0; });
    const withErrors = results.filter(function(r) { return r.count < 0; });
    const totalCount = results.reduce(function(s, r) { return s + Math.max(0, r.count); }, 0);

    if (totalEl) {
      totalEl.innerHTML = totalCount > 0
        ? '<span style="color:var(--b24t-err);font-weight:700;">Łącznie: ' + totalCount + ' wzmianek</span>'
        : '<span>Brak wzmianek z tagiem \u201e' + tagName + '"</span>';
    }
    if (delBtn) delBtn.style.display = totalCount > 0 ? 'block' : 'none';

    if (!withData.length && !withErrors.length) {
      list.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:var(--b24t-text-faint);">Brak wzmianek z tym tagiem w żadnym projekcie</div>';
    } else {
      list.innerHTML = [...withData, ...withErrors].map(function(r) {
        var p = r.p, count = r.count, error = r.error;
        var errored = count < 0;
        return '<div style="padding:10px 14px;border-bottom:1px solid var(--b24t-border-sub);">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:2px;">' +
            '<span style="font-size:12px;font-weight:600;color:var(--b24t-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + p.name + '">' + p.name + '</span>' +
            (errored
              ? '<span style="font-size:10px;color:var(--b24t-err);flex-shrink:0;">błąd</span>'
              : '<span style="font-size:13px;font-weight:700;flex-shrink:0;color:var(--b24t-err);">' + count + '</span>'
            ) +
          '</div>' +
          (errored
            ? '<div style="font-size:10px;color:var(--b24t-err);">' + (error || 'błąd zapytania') + '</div>'
            : '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">' +
                '<div style="font-size:10px;color:var(--b24t-text-faint);">zakres: ' + (p._dateFrom || '?') + ' \u2192 ' + (p._dateTo || '?') + '</div>' +
                '<button class="b24t-ap-del-single" ' +
                  'data-pid="' + p.id + '" ' +
                  'data-pname="' + p.name.replace(/"/g, '&quot;') + '" ' +
                  'data-datefrom="' + (p._dateFrom || '') + '" ' +
                  'data-dateto="' + (p._dateTo || '') + '" ' +
                  'data-count="' + count + '" ' +
                  'style="font-size:10px;padding:3px 8px;background:#3a1515;border:1px solid #7a2a2a;color:#f87171;border-radius:5px;cursor:pointer;flex-shrink:0;transition:background 0.15s;">🗑 Usuń</button>' +
              '</div>'
          ) +
        '</div>';
      }).join('');

      // Wire per-project delete buttons
      list.querySelectorAll('.b24t-ap-del-single').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var tagId = parseInt(document.getElementById('b24t-del-tag')?.value);
          if (!tagId) return;
          var tagName = Object.entries(state.tags).find(function(e){ return e[1] === tagId; })?.[0] || String(tagId);
          var pid      = parseInt(btn.dataset.pid);
          var pname    = btn.dataset.pname;
          var dateFrom = btn.dataset.datefrom;
          var dateTo   = btn.dataset.dateto;
          var count    = parseInt(btn.dataset.count) || '?';

          if (!dateFrom || !dateTo) {
            alert('Brak zakresu dat dla projektu "' + pname + '". Odwiedź zakładkę Mentions tego projektu i odśwież panel.');
            return;
          }

          var confirmed = await confirmDeleteWarning();
          if (!confirmed) return;
          if (!confirm('Usunąć ' + count + ' wzmianek z tagiem "' + tagName + '" z projektu "' + pname + '"?\n\nTo jest NIEODWRACALNE.')) return;

          btn.disabled = true;
          btn.textContent = '⏳';
          var rowStatus = document.createElement('div');
          rowStatus.style.cssText = 'font-size:10px;color:#9090bb;margin-top:4px;';
          rowStatus.textContent = 'Usuwam...';
          btn.closest('div[style*="border-bottom"]').appendChild(rowStatus);

          try {
            var deleted = await runDeleteByTag(tagId, tagName, dateFrom, dateTo, function(phase, cur, tot) {
              rowStatus.textContent = phase === 'collect' ? 'Zbieram: ' + cur + '/' + tot + '...' : 'Usunięto ' + cur + '/' + tot;
            }, pid);
            btn.textContent = '✓ ' + deleted;
            btn.style.background = '#153015';
            btn.style.borderColor = '#2a7a2a';
            btn.style.color = '#4ade80';
            rowStatus.textContent = '✓ Gotowe';
            rowStatus.style.color = '#4ade80';
            // Invalidate cache
            bgCache.allProjects = {};
            bgCache.tagstats = null;
            annotatorData.tagstats = null;
          } catch(e) {
            btn.disabled = false;
            btn.textContent = '🗑 Usuń';
            rowStatus.textContent = '✕ ' + e.message;
            rowStatus.style.color = '#f87171';
          }
        });
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GROUPS — zarządzanie grupami projektów (v0.10.0)
  // ─────────────────────────────────────────────────────────────────────────────

  function getGroups() {
    return lsGet(LS.GROUPS, []);
  }

  function saveGroups(groups) {
    lsSet(LS.GROUPS, groups);
  }

  function generateGroupId() {
    return 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function getKnownProjectsList() {
    var projects = lsGet(LS.PROJECTS, {});
    return Object.entries(projects).map(function(entry) {
      var pid = parseInt(entry[0]);
      return { id: pid, name: _pnResolve(pid) };
    }).filter(function(p) { return p.id > 0; })
      .sort(function(a, b) { return a.name.localeCompare(b.name); });
  }

  function renderGroupsTab() {
    var el = document.getElementById('b24t-ann-tab-groups-content');
    if (!el) return;
    var groups = getGroups();
    var knownProjects = getKnownProjectsList();
    var html = '';
    if (!groups.length) {
      html = '<div style="padding:20px 16px;text-align:center;">' +
        '<div style="font-size:28px;margin-bottom:10px;">📂</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--b24t-text);margin-bottom:6px;">Brak grup projektów</div>' +
        '<div style="font-size:12px;color:var(--b24t-text-faint);line-height:1.6;margin-bottom:14px;">Grupuj projekty aby używać ich<br>w cross-delete i Overall Stats.</div>' +
        '<button id="b24t-grp-add-first" style="background:var(--b24t-accent-grad);color:#fff;border:none;border-radius:8px;padding:9px 20px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;">+ Utwórz grupę</button>' +
      '</div>';
    } else {
      html = '<div style="padding:10px 12px 4px;display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-size:11px;color:var(--b24t-text-faint);">' + groups.length + ' ' + (groups.length === 1 ? 'grupa' : 'grup') + '</span>' +
        '<button id="b24t-grp-add-btn" style="background:var(--b24t-accent-grad);color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;">+ Nowa</button>' +
      '</div>';
      groups.forEach(function(g) {
        var projNames = g.projectIds.map(function(pid) {
          var p = knownProjects.find(function(kp) { return kp.id === pid; });
          return p ? p.name : ('ID:' + pid);
        });
        html += '<div class="b24t-grp-card" data-gid="' + g.id + '" style="margin:6px 12px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:10px;overflow:hidden;">' +
          '<div style="display:flex;align-items:center;padding:10px 12px;gap:8px;">' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:13px;font-weight:700;color:var(--b24t-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + g.name + '</div>' +
              '<div style="font-size:11px;color:var(--b24t-text-faint);margin-top:2px;">' + g.projectIds.length + ' projektów</div>' +
            '</div>' +
            '<button class="b24t-grp-edit" data-gid="' + g.id + '" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:4px 9px;font-size:11px;font-family:inherit;cursor:pointer;">✏</button>' +
            '<button class="b24t-grp-delete" data-gid="' + g.id + '" style="background:var(--b24t-err-bg);border:1px solid color-mix(in srgb,var(--b24t-err) 30%,transparent);color:var(--b24t-err);border-radius:6px;padding:4px 9px;font-size:11px;font-family:inherit;cursor:pointer;">✕</button>' +
          '</div>' +
          (projNames.length ? '<div style="padding:0 12px 10px;display:flex;flex-wrap:wrap;gap:4px;">' +
            projNames.map(function(n) { return '<span style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);border-radius:99px;padding:2px 8px;font-size:10px;color:var(--b24t-text-muted);">' + n + '</span>'; }).join('') +
          '</div>' : '') +
        '</div>';
      });
    }
    el.innerHTML = html;
    wireGroupsTab(el, knownProjects);
  }

  function wireGroupsTab(el, knownProjects) {
    var addFirst = el.querySelector('#b24t-grp-add-first');
    var addBtn   = el.querySelector('#b24t-grp-add-btn');
    if (addFirst) addFirst.addEventListener('click', function() { showGroupEditor(null, knownProjects); });
    if (addBtn)   addBtn.addEventListener('click',   function() { showGroupEditor(null, knownProjects); });
    el.querySelectorAll('.b24t-grp-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var gid = btn.dataset.gid;
        var groups = getGroups();
        var group = groups.find(function(g) { return g.id === gid; });
        if (group) showGroupEditor(group, knownProjects);
      });
    });
    el.querySelectorAll('.b24t-grp-delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var gid = btn.dataset.gid;
        var groups = getGroups();
        var group = groups.find(function(g) { return g.id === gid; });
        if (!group) return;
        if (!confirm('Usunac grupe "' + group.name + '"?')) return;
        saveGroups(groups.filter(function(g) { return g.id !== gid; }));
        bgCache.overallStats = null;
        renderGroupsTab();
        renderOverallStatsTab();
      });
    });
  }

  function showGroupEditor(existingGroup, knownProjects) {
    var isNew = !existingGroup;
    var currentGroup = existingGroup ? JSON.parse(JSON.stringify(existingGroup)) : { id: generateGroupId(), name: '', projectIds: [], relevantTagId: null };
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483648;display:flex;align-items:center;justify-content:center;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;';
    var projCheckboxes = knownProjects.length ? knownProjects.map(function(p) {
      var checked = currentGroup.projectIds.includes(p.id);
      return '<label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;cursor:pointer;background:' + (checked ? 'var(--b24t-primary-bg)' : 'var(--b24t-bg-input)') + ';border:1px solid ' + (checked ? 'color-mix(in srgb,var(--b24t-primary) 40%,transparent)' : 'var(--b24t-border)') + ';transition:background 0.15s,border-color 0.15s;">' +
        '<input type="checkbox" data-pid="' + p.id + '"' + (checked ? ' checked' : '') + ' style="accent-color:var(--b24t-primary);width:14px;height:14px;cursor:pointer;">' +
        '<span style="font-size:12px;color:var(--b24t-text);">' + p.name + '</span>' +
      '</label>';
    }).join('') : '<div style="font-size:12px;color:var(--b24t-text-faint);padding:10px 0;line-height:1.6;">Brak zaladowanych projektow.<br>Wejdz w widok Mentions kazdego projektu.</div>';
    overlay.innerHTML =
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:14px;width:360px;max-height:85vh;display:flex;flex-direction:column;box-shadow:var(--b24t-shadow-h);animation:b24t-slidein 0.25s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:14px 16px;background:var(--b24t-accent-grad);border-radius:14px 14px 0 0;display:flex;align-items:center;gap:10px;">' +
          '<span style="font-size:14px;font-weight:700;color:#fff;flex:1;">' + (isNew ? '+ Nowa grupa' : 'Edytuj grupe') + '</span>' +
          '<button id="b24t-grped-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;border-radius:5px;padding:2px 8px;font-size:16px;cursor:pointer;">x</button>' +
        '</div>' +
        '<div style="overflow-y:auto;flex:1;padding:16px;">' +
          '<div style="margin-bottom:14px;">' +
            '<div style="font-size:11px;font-weight:600;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Nazwa grupy</div>' +
            '<input id="b24t-grped-name" type="text" value="' + (currentGroup.name || '') + '" placeholder="np. TR Markets" maxlength="40" style="width:100%;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text);border-radius:7px;padding:8px 10px;font-size:13px;font-family:inherit;box-sizing:border-box;outline:none;transition:border-color 0.15s;">' +
          '</div>' +
          '<div style="margin-bottom:14px;">' +
            '<div style="font-size:11px;font-weight:600;color:var(--b24t-text-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Projekty w grupie</div>' +
            '<div id="b24t-grped-projects" style="display:flex;flex-direction:column;gap:5px;">' + projCheckboxes + '</div>' +
          '</div>' +
          '<div id="b24t-grped-status" style="font-size:11px;color:var(--b24t-err);min-height:16px;margin-bottom:4px;"></div>' +
        '</div>' +
        '<div style="padding:12px 16px;border-top:1px solid var(--b24t-border);display:flex;gap:8px;">' +
          '<button id="b24t-grped-cancel" style="flex:1;background:var(--b24t-bg-input);color:var(--b24t-text-muted);border:1px solid var(--b24t-border);border-radius:8px;padding:9px;font-size:13px;font-family:inherit;cursor:pointer;">Anuluj</button>' +
          '<button id="b24t-grped-save" style="flex:2;background:var(--b24t-accent-grad);color:#fff;border:none;border-radius:8px;padding:9px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;">' + (isNew ? 'Utworz grupe' : 'Zapisz zmiany') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelectorAll('#b24t-grped-projects label').forEach(function(label) {
      var cb = label.querySelector('input[type=checkbox]');
      cb.addEventListener('change', function() {
        label.style.background = cb.checked ? 'var(--b24t-primary-bg)' : 'var(--b24t-bg-input)';
        label.style.borderColor = cb.checked ? 'color-mix(in srgb,var(--b24t-primary) 40%,transparent)' : 'var(--b24t-border)';
      });
    });
    function close() { overlay.remove(); }
    overlay.querySelector('#b24t-grped-close').addEventListener('click', close);
    overlay.querySelector('#b24t-grped-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    var nameInput = overlay.querySelector('#b24t-grped-name');
    nameInput.focus();
    nameInput.addEventListener('focus', function() { nameInput.style.borderColor = 'var(--b24t-primary)'; });
    nameInput.addEventListener('blur',  function() { nameInput.style.borderColor = 'var(--b24t-border)'; });
    overlay.querySelector('#b24t-grped-save').addEventListener('click', function() {
      var name = nameInput.value.trim();
      var statusEl = overlay.querySelector('#b24t-grped-status');
      if (!name) { statusEl.textContent = 'Podaj nazwe grupy.'; return; }
      var selectedPids = [];
      overlay.querySelectorAll('#b24t-grped-projects input[type=checkbox]:checked').forEach(function(cb) {
        selectedPids.push(parseInt(cb.dataset.pid));
      });
      if (!selectedPids.length) { statusEl.textContent = 'Wybierz co najmniej jeden projekt.'; return; }
      currentGroup.name = name;
      currentGroup.projectIds = selectedPids;
      var groups = getGroups();
      if (isNew) {
        groups.push(currentGroup);
      } else {
        var idx = groups.findIndex(function(g) { return g.id === currentGroup.id; });
        if (idx >= 0) groups[idx] = currentGroup; else groups.push(currentGroup);
      }
      saveGroups(groups);
      bgCache.overallStats = null;
      close();
      renderGroupsTab();
      renderOverallStatsTab();
    });
  }

  function getMcCompletedPids(monthKey, groupId) {
    var done = lsGet(LS.MONTH_CLOSE_DONE, {});
    return done[monthKey + '|' + groupId] || [];
  }
  function setMcCompletedPids(monthKey, groupId, pids) {
    var done = lsGet(LS.MONTH_CLOSE_DONE, {});
    done[monthKey + '|' + groupId] = pids;
    lsSet(LS.MONTH_CLOSE_DONE, done);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // OVERALL STATS (v0.10.0)
  // ─────────────────────────────────────────────────────────────────────────────

  function getStatsConfig() { return lsGet(LS.STATS_CFG, {}); }
  function saveStatsConfig(cfg) { lsSet(LS.STATS_CFG, cfg); }

  function setGroupRelevantTagId(groupId, tagId) {
    var groups = getGroups();
    var g = groups.find(function(g) { return g.id === groupId; });
    if (g) { g.relevantTagId = tagId; saveGroups(groups); }
  }

  async function _fetchOverallStats(group, onProgress) {
    var projects = lsGet(LS.PROJECTS, {});
    // Użyj tej samej logiki dat co zakładka Projekt — current month, wyjątek dla 1-2 dnia
    var dates = getAnnotatorDates();
    var dateFrom = dates.dateFrom;
    var dateTo   = dates.dateTo;
    var results = [];
    if (onProgress) {
      onProgress(group.projectIds.map(function(pid) {
        return { pid: pid, name: _pnResolve(pid) || ('ID:' + pid), loading: true };
      }), dateFrom, dateTo, dates.label);
    }
    // Pobieranie projektów batchami (STATS_FETCH_CONCURRENCY równocześnie)
    for (var bi = 0; bi < group.projectIds.length; bi += STATS_FETCH_CONCURRENCY) {
      var batchPids = group.projectIds.slice(bi, bi + STATS_FETCH_CONCURRENCY);
      var batchResults = await Promise.all(batchPids.map(function(pid) {
        var pData = projects[pid];
        if (!pData) {
          addLog('[DIAG] _fetchOverallStats: projekt ID:' + pid + ' nieznany w LS.PROJECTS', 'diag');
          return Promise.resolve({ pid: pid, name: 'ID:' + pid, error: 'projekt nieznany' });
        }
        var name = _pnResolve(pid);
        var tagIds = pData.tagIds || {};
        var reqVerId = null, toDelId = null;
        Object.entries(tagIds).forEach(function(e) {
          if (e[0] === 'REQUIRES_VERIFICATION') reqVerId = e[1];
          if (e[0] === 'TO_DELETE') toDelId = e[1];
        });
        if (!reqVerId) reqVerId = 1154586;
        if (!toDelId)  toDelId  = 1154757;
        var relTagId = group.relevantTagId || null;
        var queries = [
          getMentions(pid, dateFrom, dateTo, [], 1),
          relTagId ? getMentions(pid, dateFrom, dateTo, [relTagId], 1) : Promise.resolve({ count: null }),
          getMentions(pid, dateFrom, dateTo, [reqVerId], 1),
          getMentions(pid, dateFrom, dateTo, [toDelId], 1),
        ];
        return Promise.all(queries).then(function(counts) {
          return { pid: pid, name: name, total: counts[0].count, relevant: counts[1].count, reqVer: counts[2].count, toDelete: counts[3].count, dateFrom: dateFrom, dateTo: dateTo };
        }).catch(function(e) {
          addLog('✕ [DIAG] getMentions(' + pid + '): ' + e.message, 'diag');
          return { pid: pid, name: name, error: e.message };
        });
      }));
      results.push.apply(results, batchResults);
      if (onProgress) {
        onProgress(results.concat(group.projectIds.slice(bi + STATS_FETCH_CONCURRENCY).map(function(p) {
          return { pid: p, name: _pnResolve(p) || ('ID:' + p), loading: true };
        })), dateFrom, dateTo, dates.label);
      }
    }
    return { results: results, dateFrom: dateFrom, dateTo: dateTo, label: dates.label };
  }

  async function _bgFetchOverallStats(group) {
    if (!state.tokenHeaders) return null;
    try {
      var data = await _fetchOverallStats(group);
      bgCache.overallStats = { groupId: group.id, results: data.results, dateFrom: data.dateFrom, dateTo: data.dateTo, label: data.label, ts: Date.now() };
      return bgCache.overallStats;
    } catch(e) { return null; }
  }

  function renderOverallStatsTab() {
    var el = document.getElementById('b24t-ann-tab-overall-content');
    if (!el) return;
    var groups = getGroups();
    if (!groups.length) {
      el.innerHTML = '<div style="padding:24px 16px;text-align:center;">' +
        '<div style="font-size:28px;margin-bottom:10px;">📊</div>' +
        '<div style="font-size:13px;font-weight:600;color:var(--b24t-text);margin-bottom:8px;">Brak grup projektow</div>' +
        '<div style="font-size:12px;color:var(--b24t-text-faint);line-height:1.6;">Aby korzystac z Overall Stats,<br>stworz grupe w zakladce <strong style="color:var(--b24t-primary);">Grupy</strong>.</div>' +
      '</div>';
      return;
    }
    var cfg = getStatsConfig();
    var selectedGroupId = cfg.selectedGroupId || null;
    var selectedGroup = groups.find(function(g) { return g.id === selectedGroupId; }) || null;
    var selectorHtml =
      '<div style="padding:10px 12px;border-bottom:1px solid var(--b24t-border-sub);display:flex;align-items:center;gap:6px;">' +
        '<select id="b24t-overall-group-sel" style="flex:1;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text);border-radius:6px;font-size:12px;padding:5px 8px;font-family:inherit;cursor:pointer;">' +
          '<option value="">— wybierz grupe —</option>' +
          groups.map(function(g) {
            return '<option value="' + g.id + '"' + (g.id === selectedGroupId ? ' selected' : '') + '>' + g.name + ' (' + g.projectIds.length + ' proj.)</option>';
          }).join('') +
        '</select>' +
        '<button id="b24t-overall-settings-btn" title="Ustawienia" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:5px 9px;font-size:13px;cursor:pointer;flex-shrink:0;">&#9881;</button>' +
        '<button id="b24t-overall-refresh-btn" title="Odswiez" style="background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:6px;padding:5px 9px;font-size:13px;cursor:pointer;flex-shrink:0;">&#8635;</button>' +
      '</div>';
    var bodyHtml = selectedGroup
      ? '<div id="b24t-overall-data" style="padding:12px;"></div>'
      : '<div style="padding:24px 16px;text-align:center;"><div style="font-size:24px;margin-bottom:8px;">&#128070;</div><div style="font-size:12px;color:var(--b24t-text-faint);line-height:1.6;">Wybierz grupe projektow<br>aby zobaczyc statystyki.</div></div>';
    el.innerHTML = selectorHtml + bodyHtml;
    if (selectedGroup) {
      var _initDataEl = el.querySelector('#b24t-overall-data');
      if (_initDataEl) {
        var _cacheHot = _bgCacheFresh(bgCache.overallStats) && bgCache.overallStats.groupId === selectedGroup.id;
        var _initResults = _cacheHot
          ? bgCache.overallStats.results
          : selectedGroup.projectIds.map(function(pid) { return { pid: pid, name: _pnResolve(pid) || ('ID:' + pid), loading: true }; });
        renderOverallStatsData(_initDataEl, _initResults, selectedGroup, _cacheHot ? bgCache.overallStats : {});
      }
    }
    var selEl = el.querySelector('#b24t-overall-group-sel');
    selEl.addEventListener('change', function() {
      var gid = selEl.value;
      var gName = selEl.options[selEl.selectedIndex]?.text || '';
      if (gid) addLog('🗂 [Grupy] wybrano grupę "' + gName.replace(/\s*\(\d+.*$/, '') + '" w Overall Stats', 'info');
      var cfg = getStatsConfig();
      cfg.selectedGroupId = gid || null;
      saveStatsConfig(cfg);
      bgCache.overallStats = null;
      renderOverallStatsTab();
      if (gid) loadOverallStats();
    });
    var refreshBtn = el.querySelector('#b24t-overall-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function() { bgCache.overallStats = null; loadOverallStats(); });
    var settingsBtn = el.querySelector('#b24t-overall-settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', function() { showOverallStatsSettings(selectedGroup); });
    if (selectedGroup) loadOverallStats();
  }

  async function loadOverallStats() {
    if (_overallStatsInFlight) return;
    var el = document.getElementById('b24t-ann-tab-overall-content');
    if (!el) return;
    var cfg = getStatsConfig();
    var groups = getGroups();
    var group = groups.find(function(g) { return g.id === cfg.selectedGroupId; });
    if (!group) return;
    var dataEl = el.querySelector('#b24t-overall-data');
    if (!dataEl) return;
    if (_bgCacheFresh(bgCache.overallStats) && bgCache.overallStats.groupId === group.id) {
      var age = Math.round((Date.now() - bgCache.overallStats.ts) / 1000);
      var ageStr = age < 60 ? age + 's' : Math.round(age/60) + 'm ' + (age%60) + 's';
      addLog('[CACHE] overallStats: gorący (' + ageStr + ' temu), renderuję od razu', 'info');
      renderOverallStatsData(dataEl, bgCache.overallStats.results, group, bgCache.overallStats);
      _bgFetchOverallStats(group).then(function(fresh) {
        var _c = document.getElementById('b24t-ann-tab-overall-content');
        var _e = _c && _c.querySelector('#b24t-overall-data');
        if (fresh && _e) renderOverallStatsData(_e, fresh.results, group, fresh);
      }).catch(function(e){ addLog('[BG] overallStats refresh error: ' + e.message, 'warn'); });
      return;
    }
    _overallStatsInFlight = true;
    addLog('📊 [Overall] Pobieranie: ' + group.name + ' (' + group.projectIds.length + ' proj.)', 'info');
    try {
      var fresh = await _fetchOverallStats(group, function(partial, dFrom, dTo, lbl) {
        var _c = document.getElementById('b24t-ann-tab-overall-content');
        var _e = _c && _c.querySelector('#b24t-overall-data');
        if (_e) renderOverallStatsData(_e, partial, group, { dateFrom: dFrom, dateTo: dTo, label: lbl, ts: Date.now() });
      });
      // Auto-domykanie: projekty z Pozostało = 0 w trybie domykania miesiąca
      if (fresh.dateFrom && group.relevantTagId) {
        var _dm = fresh.dateFrom.slice(0, 7);
        var _cm = _localDateStr(new Date()).slice(0, 7);
        if (_cm > _dm) {
          var _mcPids = getMcCompletedPids(_dm, group.id).slice();
          var _mcChanged = false;
          fresh.results.forEach(function(r) {
            if (!r.error && !r.loading && r.total != null && !_mcPids.includes(r.pid)) {
              if (Math.max(0, (r.total || 0) - (r.relevant || 0) - (r.toDelete || 0)) === 0) {
                _mcPids.push(r.pid); _mcChanged = true;
              }
            }
          });
          if (_mcChanged) setMcCompletedPids(_dm, group.id, _mcPids);
        }
      }
      bgCache.overallStats = { groupId: group.id, results: fresh.results, dateFrom: fresh.dateFrom, dateTo: fresh.dateTo, label: fresh.label, ts: Date.now() };
      var _c = document.getElementById('b24t-ann-tab-overall-content');
      var _e = _c && _c.querySelector('#b24t-overall-data');
      if (_e) renderOverallStatsData(_e, fresh.results, group, bgCache.overallStats);
    } finally {
      _overallStatsInFlight = false;
    }
  }

  function _statsCard(label, value, color, bgColor) {
    return '<div style="display:flex;align-items:baseline;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--b24t-border-sub);">' +
      '<span style="font-size:11px;color:var(--b24t-text-faint);">' + label + '</span>' +
      '<span style="font-size:13px;font-weight:600;color:' + color + ';font-variant-numeric:tabular-nums;">' + (value != null ? value : '—') + '</span>' +
    '</div>';
  }

  function renderOverallStatsData(el, results, group, cached) {
    if (!el) return;
    var hasRelevant = group.relevantTagId != null;
    // Okres i tryb domykania miesiąca
    var dateFrom = (cached && cached.dateFrom) || (results[0] && results[0].dateFrom) || '';
    var dateTo   = (cached && cached.dateTo)   || (results[0] && results[0].dateTo)   || '';
    var label    = (cached && cached.label)    || '';
    var dataMonth = dateFrom ? dateFrom.slice(0, 7) : '';
    var curMonth  = _localDateStr(new Date()).slice(0, 7);
    var isMonthClosing = !!(dataMonth && curMonth > dataMonth);
    var completedPids = isMonthClosing ? getMcCompletedPids(dataMonth, group.id) : [];
    // Sumy
    var totalAll = 0, totalRelevant = 0, totalReqVer = 0, totalToDelete = 0;
    results.forEach(function(r) {
      if (!r.error && !r.loading) {
        if (r.total    != null) totalAll      += r.total;
        if (r.relevant != null) totalRelevant += r.relevant;
        if (r.reqVer   != null) totalReqVer   += r.reqVer;
        if (r.toDelete != null) totalToDelete += r.toDelete;
      }
    });
    var totalRemaining = hasRelevant ? Math.max(0, totalAll - totalRelevant - totalToDelete) : null;
    var pct = (hasRelevant && totalAll > 0) ? Math.round((totalRelevant + totalToDelete) / totalAll * 100) : null;
    // Pasek postępu
    var progressHtml = '';
    if (hasRelevant) {
      var pctVal = pct != null ? pct : 0;
      progressHtml =
        '<div style="margin-bottom:10px;padding:10px 12px;background:var(--b24t-bg-elevated);border-radius:8px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
            '<span style="font-size:11px;font-weight:600;color:var(--b24t-text-faint);">Postęp ukończenia</span>' +
            '<span style="font-size:13px;font-weight:800;color:var(--b24t-primary);">' + (pct != null ? pct + '%' : '—') + '</span>' +
          '</div>' +
          '<div style="background:var(--b24t-bg-deep);border-radius:99px;height:7px;overflow:hidden;">' +
            '<div style="width:' + pctVal + '%;height:100%;background:var(--b24t-accent-grad);border-radius:99px;transition:width 0.5s ease;"></div>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:4px;text-align:right;">' + (totalRelevant + totalToDelete) + ' / ' + totalAll + ' otagowanych</div>' +
        '</div>';
    }
    // Baner domykania miesiąca
    var monthClosingHtml = '';
    if (isMonthClosing) {
      var _nonPending = results.filter(function(r) { return !r.loading && !r.error; });
      var _doneCount  = _nonPending.filter(function(r) { return completedPids.includes(r.pid); }).length;
      var _allDone    = results.every(function(r) { return r.error || completedPids.includes(r.pid); }) && _nonPending.length > 0;
      if (_allDone) {
        monthClosingHtml =
          '<div style="margin-bottom:10px;padding:10px 12px;background:var(--b24t-ok-bg);border:1px solid color-mix(in srgb,var(--b24t-ok) 40%,transparent);border-radius:8px;display:flex;align-items:center;gap:10px;">' +
            '<span style="font-size:20px;">✅</span>' +
            '<div>' +
              '<div style="font-size:12px;font-weight:700;color:var(--b24t-ok-text);">Miesiąc domknięty</div>' +
              '<div style="font-size:11px;color:var(--b24t-ok);margin-top:1px;">Wszystkie projekty ukończone</div>' +
            '</div>' +
          '</div>';
      } else {
        monthClosingHtml =
          '<div style="margin-bottom:10px;padding:10px 12px;background:var(--b24t-warn-bg);border:1px solid color-mix(in srgb,var(--b24t-warn) 40%,transparent);border-radius:8px;display:flex;align-items:center;gap:10px;">' +
            '<span style="font-size:20px;">🗓</span>' +
            '<div style="flex:1;">' +
              '<div style="font-size:12px;font-weight:700;color:var(--b24t-warn-text);">Domykanie miesiąca</div>' +
              '<div style="font-size:11px;color:var(--b24t-warn);margin-top:1px;">' + _doneCount + ' z ' + _nonPending.length + ' projektów ukończonych</div>' +
            '</div>' +
            '<button id="b24t-mc-force-close" style="background:var(--b24t-warn);color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;flex-shrink:0;">Zamknij miesiąc</button>' +
          '</div>';
      }
    }
    // Kafelki
    var thREL = '';
    var cards;
    var colCount;
    if (hasRelevant) {
      thREL = '<th style="padding:6px 8px;font-size:10px;color:var(--b24t-ok);text-align:right;font-weight:600;">REL</th>';
      colCount = 4;
      cards =
        '<div style="display:flex;flex-direction:column;margin-bottom:10px;">' +
          _statsCard('Wszystkie',      totalAll,       'var(--b24t-text-muted)', 'var(--b24t-bg-elevated)') +
          _statsCard('Relevantne',     totalRelevant,  'var(--b24t-ok)',         'var(--b24t-ok-bg)') +
          _statsCard('Pozostało',      totalRemaining, 'var(--b24t-primary)',    'var(--b24t-primary-bg)') +
          _statsCard('Do weryfikacji', totalReqVer,    'var(--b24t-warn)',       'var(--b24t-warn-bg)') +
          _statsCard('Do usunięcia',   totalToDelete,  'var(--b24t-err)',        'var(--b24t-err-bg)') +
        '</div>';
    } else {
      colCount = 3;
      cards =
        '<div style="display:flex;flex-direction:column;margin-bottom:10px;">' +
          _statsCard('Wszystkie',      totalAll,      'var(--b24t-text-muted)', 'var(--b24t-bg-elevated)') +
          _statsCard('Do weryfikacji', totalReqVer,   'var(--b24t-warn)',       'var(--b24t-warn-bg)') +
          _statsCard('Do usunięcia',   totalToDelete, 'var(--b24t-err)',        'var(--b24t-err-bg)') +
        '</div>';
    }
    var warnHtml = !hasRelevant
      ? '<div style="margin-bottom:8px;padding:7px 10px;background:var(--b24t-warn-bg);border:1px solid color-mix(in srgb,var(--b24t-warn) 30%,transparent);border-radius:7px;font-size:11px;color:var(--b24t-warn);line-height:1.5;">Ustaw tag Relevantne w ustawieniach (⚙) aby widzieć pełne dane.</div>' : '';
    var tableRows = results.map(function(r) {
      if (isMonthClosing && !r.loading && completedPids.includes(r.pid)) {
        var relTdC = hasRelevant ? '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-ok-text);text-align:right;">' + (r.relevant != null ? r.relevant : '—') + '</td>' : '';
        return '<tr style="border-top:1px solid var(--b24t-border-sub);background:color-mix(in srgb,var(--b24t-ok) 7%,transparent);">' +
          '<td style="padding:6px 8px;font-size:11px;color:var(--b24t-ok);text-decoration:line-through;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + r.name + '">✓ ' + r.name + '</td>' +
          '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-ok-text);text-align:right;">' + (r.total != null ? r.total : '—') + '</td>' +
          relTdC +
          '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-ok-text);text-align:right;">' + (r.reqVer != null ? r.reqVer : '—') + '</td>' +
          '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-ok-text);text-align:right;">' + (r.toDelete != null ? r.toDelete : '—') + '</td>' +
        '</tr>';
      }
      if (r.loading) return '<tr style="border-top:1px solid var(--b24t-border-sub);"><td style="padding:6px 8px;font-size:11px;color:var(--b24t-text);">' + r.name + '</td><td colspan="' + colCount + '" style="padding:6px 8px;font-size:10px;color:var(--b24t-text-faint);text-align:center;">⏳ ładowanie…</td></tr>';
      if (r.error)   return '<tr style="border-top:1px solid var(--b24t-border-sub);"><td style="padding:6px 8px;font-size:11px;color:var(--b24t-text);">' + r.name + '</td><td colspan="' + colCount + '" style="padding:6px 8px;font-size:10px;color:var(--b24t-err);">błąd: ' + r.error + '</td></tr>';
      var relTd = hasRelevant ? '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-ok);text-align:right;">' + (r.relevant != null ? r.relevant : '—') + '</td>' : '';
      return '<tr style="border-top:1px solid var(--b24t-border-sub);">' +
        '<td style="padding:6px 8px;font-size:11px;color:var(--b24t-text);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + r.name + '">' + r.name + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-text-muted);text-align:right;">' + (r.total   != null ? r.total   : '—') + '</td>' +
        relTd +
        '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-warn);text-align:right;">'  + (r.reqVer  != null ? r.reqVer  : '—') + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-err);text-align:right;">'   + (r.toDelete != null ? r.toDelete : '—') + '</td>' +
      '</tr>';
    }).join('');
    var periodHtml = (dateFrom && dateTo)
      ? '<div style="display:flex;align-items:center;gap:6px;padding:6px 0;margin-bottom:8px;border-bottom:1px solid var(--b24t-border-sub);">' +
          '<span style="font-size:11px;color:var(--b24t-text-faint);">📅 Okres:</span>' +
          '<span style="font-size:11px;font-weight:600;color:var(--b24t-text-muted);">' + (label ? label + ' ' : '') + '(' + dateFrom + ' → ' + dateTo + ')</span>' +
        '</div>'
      : '';
    el.innerHTML = periodHtml + progressHtml + monthClosingHtml + warnHtml + cards +
      '<div style="border:1px solid var(--b24t-border);border-radius:8px;overflow:hidden;">' +
        '<table style="width:100%;border-collapse:collapse;">' +
          '<tr style="background:var(--b24t-bg-deep);">' +
            '<th style="padding:6px 8px;font-size:10px;color:var(--b24t-text-faint);text-align:left;font-weight:600;">Projekt</th>' +
            '<th style="padding:6px 8px;font-size:10px;color:var(--b24t-text-faint);text-align:right;font-weight:600;">ALL</th>' +
            thREL +
            '<th style="padding:6px 8px;font-size:10px;color:#d97706;text-align:right;font-weight:600;">REQ</th>' +
            '<th style="padding:6px 8px;font-size:10px;color:#dc2626;text-align:right;font-weight:600;">DEL</th>' +
          '</tr>' +
          tableRows +
        '</table>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:6px;text-align:right;">' + group.name + ' · ' + results.length + ' projektów</div>';
    // Przycisk "Zamknij miesiąc"
    var _mcBtn = el.querySelector('#b24t-mc-force-close');
    if (_mcBtn) {
      _mcBtn.addEventListener('click', function() {
        var allPids = results.filter(function(r) { return !r.error; }).map(function(r) { return r.pid; });
        setMcCompletedPids(dataMonth, group.id, allPids);
        var _c = document.getElementById('b24t-ann-tab-overall-content');
        var _e = _c && _c.querySelector('#b24t-overall-data');
        if (_e) renderOverallStatsData(_e, results, group, cached);
      });
    }
  }

  function showOverallStatsSettings(group) {
    if (!group) return;
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483648;display:flex;align-items:center;justify-content:center;font-family:\'Geist\',\'Segoe UI\',system-ui,-apple-system,sans-serif;';
    var tagOptions = Object.entries(state.tags).map(function(entry) {
      return '<option value="' + entry[1] + '"' + (entry[1] === group.relevantTagId ? ' selected' : '') + '>' + entry[0] + ' (ID: ' + entry[1] + ')</option>';
    }).join('');
    overlay.innerHTML =
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:14px;width:320px;box-shadow:var(--b24t-shadow-h);animation:b24t-slidein 0.25s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:12px 16px;background:var(--b24t-accent-grad);border-radius:14px 14px 0 0;display:flex;align-items:center;gap:10px;">' +
          '<span style="font-size:14px;font-weight:700;color:#fff;flex:1;">&#9881; Ustawienia: ' + group.name + '</span>' +
          '<button id="b24t-os-close" style="background:rgba(255,255,255,0.28);border:1px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,0.3);color:#fff;border-radius:5px;padding:2px 8px;font-size:16px;cursor:pointer;">x</button>' +
        '</div>' +
        '<div style="padding:16px;">' +
          '<div style="font-size:12px;color:var(--b24t-text-muted);margin-bottom:6px;">Tag oznaczajacy <strong>Relevantne</strong>:</div>' +
          '<select id="b24t-os-rel-tag" style="width:100%;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text);border-radius:7px;padding:7px 10px;font-size:12px;font-family:inherit;cursor:pointer;">' +
            '<option value="">— brak —</option>' + tagOptions +
          '</select>' +
          '<div style="margin-top:12px;font-size:11px;color:var(--b24t-text-faint);line-height:1.6;padding:8px 10px;background:var(--b24t-bg-elevated);border-radius:7px;">REQUIRES_VERIFICATION i TO_DELETE sa odczytywane automatycznie.</div>' +
        '</div>' +
        '<div style="padding:10px 16px;border-top:1px solid var(--b24t-border);display:flex;gap:8px;">' +
          '<button id="b24t-os-cancel" style="flex:1;background:var(--b24t-bg-input);color:var(--b24t-text-muted);border:1px solid var(--b24t-border);border-radius:8px;padding:9px;font-size:13px;font-family:inherit;cursor:pointer;">Anuluj</button>' +
          '<button id="b24t-os-save" style="flex:2;background:var(--b24t-accent-grad);color:#fff;border:none;border-radius:8px;padding:9px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;">Zapisz</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    overlay.querySelector('#b24t-os-close').addEventListener('click', close);
    overlay.querySelector('#b24t-os-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
    overlay.querySelector('#b24t-os-save').addEventListener('click', function() {
      var tagId = parseInt(overlay.querySelector('#b24t-os-rel-tag').value) || null;
      setGroupRelevantTagId(group.id, tagId);
      bgCache.overallStats = null;
      close();
      renderOverallStatsTab();
      loadOverallStats();
    });
  }

  async function refreshAllProjectsPanel() {
    buildAllProjectsPanel();
    const el = document.getElementById('b24t-del-allprojects-panel');
    if (el) { el.style.display = 'flex'; _positionXProjectPanel(el); }

    const tagId     = parseInt(document.getElementById('b24t-del-tag')?.value);
    const list      = document.getElementById('b24t-ap-list');
    const tagNameEl = document.getElementById('b24t-ap-tag-name');
    const totalEl   = document.getElementById('b24t-ap-total');
    const delBtn    = document.getElementById('b24t-ap-delete-all');

    if (!tagId) {
      if (list) list.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:var(--b24t-text-faint);">Wybierz tag, aby zobaczyć dane</div>';
      if (tagNameEl) tagNameEl.textContent = 'Wybierz tag, aby załadować dane';
      return;
    }

    const tagName = Object.entries(state.tags).find(([,id]) => id === tagId)?.[0] || String(tagId);
    if (tagNameEl) tagNameEl.textContent = 'Tag: ' + tagName;

    const projects = getKnownProjects();
    if (!projects.length) {
      if (list) list.innerHTML =
        '<div style="padding:16px;font-size:11px;color:var(--b24t-text-faint);line-height:1.6;">' +
        'Brak znanych projektów z tagami <strong>REQUIRES_VERIFICATION</strong> i <strong>TO_DELETE</strong>.<br><br>' +
        'Wejdź w widok Mentions każdego projektu — wtyczka zapamiętuje go automatycznie.' +
        '</div>';
      return;
    }

    // ── Jeśli cache gorący — renderuj od razu ──
    var cached = bgCache.allProjects[tagId];
    if (_bgCacheFresh(cached)) {
      _renderAllProjectsList(cached.results, tagName);
      // Cichy background refresh bez resetowania DOM
      _bgFetchAllProjects(tagId).then(function(fresh) {
        if (fresh) _renderAllProjectsList(fresh.results, tagName);
      }).catch(function(e){ addLog('[BG] allProjects refresh error: ' + e.message, 'warn'); });
      return;
    }

    // ── Cache zimny — spinner + fetch ──
    if (list) list.innerHTML =
      '<div style="padding:20px 0;text-align:center;">' +
        '<div style="font-size:22px;animation:b24t-spin 1s linear infinite;display:inline-block;">↻</div>' +
        '<div id="b24t-ap-spinner-counter" style="font-size:10px;color:var(--b24t-text-faint);margin-top:6px;">0 / ' + projects.length + '</div>' +
      '</div>';
    if (totalEl) totalEl.innerHTML = '';
    if (delBtn) delBtn.style.display = 'none';

    var freshData = await _bgFetchAllProjects(tagId);
    if (freshData) _renderAllProjectsList(freshData.results, tagName);
  }

  function buildDeleteTab() {
    const div = document.createElement('div');
    div.id = 'b24t-delete-tab';
    div.style.display = 'none';
    div.innerHTML = `
      <div class="b24t-section">
        <div class="b24t-section-label" style="color:var(--b24t-err);">Usuń po tagu</div>
        <div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:10px;line-height:1.5;">
          Usuwa wzmianki z wybranym tagiem w aktualnym zakresie dat.
          <strong style="color:var(--b24t-err);">Operacja nieodwracalna.</strong>
        </div>

        <!-- Tag selector -->
        <div class="b24t-section-label" style="margin-bottom:4px;">Tag do usunięcia</div>
        <select class="b24t-select" id="b24t-del-tag" style="width:100%;margin-bottom:8px;">
          <option value="">— wybierz tag —</option>
        </select>

        <!-- Date range info -->
        <div id="b24t-del-dateinfo" style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:8px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:8px 10px;line-height:1.6;">
          Zakres dat z aktualnego widoku Brand24
        </div>

        <!-- Scope -->
        <div class="b24t-section-label" style="margin-bottom:4px;">Zakres dat</div>
        <div class="b24t-radio-group" style="margin-bottom:10px;">
          <label class="b24t-radio">
            <input type="radio" name="b24t-del-scope" value="view" checked>
            <span>Aktualny widok (z URL)</span>
          </label>
          <label class="b24t-radio">
            <input type="radio" name="b24t-del-scope" value="custom">
            <span>Własny zakres</span>
          </label>
          <label class="b24t-radio" id="b24t-del-allprojects-label" style="display:none;flex-direction:column;align-items:flex-start;gap:2px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="radio" name="b24t-del-scope" value="allprojects" style="flex-shrink:0;">
              <span style="color:var(--b24t-warn);font-weight:600;">🌐 Wszystkie projekty</span>
            </div>
            <div style="font-size:10px;color:var(--b24t-text-faint);margin-left:20px;line-height:1.4;">Usuwa wybrany tag ze wszystkich znanych projektów z tagami TO_DELETE i REQUIRES_VERIFICATION</div>
          </label>
        </div>

        <!-- Custom date range (hidden by default) -->
        <div id="b24t-del-custom-dates" style="display:none;margin-bottom:10px;">
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="date" id="b24t-del-date-from" class="b24t-input" style="flex:1;">
            <span style="color:var(--b24t-text-faint);font-size:11px;">→</span>
            <input type="date" id="b24t-del-date-to" class="b24t-input" style="flex:1;">
          </div>
        </div>

        <!-- Progress -->
        <div class="b24t-progress-bar-track" style="margin-bottom:6px;">
          <div id="b24t-del-progress" style="height:100%;background:var(--b24t-err);border-radius:99px;width:0%;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-del-status" style="font-size:10px;color:var(--b24t-text-faint);min-height:14px;flex:1;"></div>
          <div id="b24t-del-timer" style="font-size:11px;color:var(--b24t-text-faint);font-family:'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;margin-left:8px;">00:00</div>
        </div>

        <!-- Run button -->
        <button class="b24t-btn-danger" id="b24t-del-run" style="width:100%;padding:8px;">
          🗑 Usuń wzmianki z tagiem
        </button>

        <div style="font-size:9px;color:var(--b24t-text-faint);text-align:center;margin-top:6px;">
          Ostrzeżenie pojawi się tylko przy pierwszym użyciu
        </div>
      </div>

      <!-- SEPARATOR -->
      <div style="height:1px;background:var(--b24t-border-sub);margin:0 12px;"></div>

      <!-- DELETE CURRENT VIEW -->
      <div class="b24t-section">
        <div class="b24t-section-label" style="color:var(--b24t-err);">Usuń wyświetlane wzmianki</div>
        <div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:10px;line-height:1.5;">
          Usuwa wzmianki aktualnie widoczne w panelu Brand24
          (aktywne filtry, zakres dat, tagi itd.).
          <strong style="color:var(--b24t-err);">Operacja nieodwracalna.</strong>
        </div>

        <!-- Scope -->
        <div class="b24t-radio-group" style="margin-bottom:10px;">
          <label class="b24t-radio">
            <input type="radio" name="b24t-delview-scope" value="current-page" checked>
            <span>Bieżąca strona</span>
          </label>
          <label class="b24t-radio">
            <input type="radio" name="b24t-delview-scope" value="all-pages">
            <span>Wszystkie strony</span>
          </label>
        </div>

        <!-- Current view info -->
        <div id="b24t-delview-info" style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:8px;background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:8px 10px;line-height:1.6;">
          Wczytywanie widoku...
        </div>

        <!-- Progress -->
        <div class="b24t-progress-bar-track" style="margin-bottom:6px;">
          <div id="b24t-delview-progress" style="height:100%;background:var(--b24t-err);border-radius:99px;width:0%;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-delview-status" style="font-size:10px;color:var(--b24t-text-faint);min-height:14px;flex:1;"></div>
          <div id="b24t-delview-timer" style="font-size:11px;color:var(--b24t-text-faint);font-family:'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;margin-left:8px;">00:00</div>
        </div>

        <!-- Run button -->
        <button class="b24t-btn-danger" id="b24t-delview-run" style="width:100%;padding:8px;">
          🗑 Usuń wyświetlane wzmianki
        </button>
      </div>

      <!-- BATCH SIZE -->
      <div class="b24t-section" style="padding:8px 14px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:10px;color:var(--b24t-text-faint);">Równoległy batch delete:</span>
          <input type="number" id="b24t-del-batch-input" min="1" max="1000"
            value="${DEL_BATCH_DEFAULT}"
            title="Ile wzmianek usuwać równocześnie (domyślnie ${DEL_BATCH_DEFAULT}, max 1000)"
            style="width:58px;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text);border-radius:4px;padding:3px 6px;font-size:11px;font-family:inherit;text-align:center;">
          <span style="font-size:10px;color:var(--b24t-text-faint);">/ 1000 max</span>
          <span id="b24t-del-batch-lock" style="font-size:10px;color:var(--b24t-err);cursor:pointer;" title="Kliknij by zmienić">🔒 zablokowane</span>
        </div>
      </div>
    `;
    return div;
  }

  function buildAutoDeleteSection() {
    const div = document.createElement('div');
    div.id = 'b24t-auto-delete-section';
    div.style.display = 'none';
    div.style.marginTop = '10px';
    div.innerHTML = `
      <div style="height:1px;background:var(--b24t-border);margin-bottom:8px;"></div>
      <div class="b24t-section-label" style="color:#f87171;margin-bottom:4px;">Auto-Delete po zakończeniu</div>
      <div class="b24t-checkbox-row" id="b24t-auto-delete-row">
        <input type="checkbox" id="b24t-auto-delete-cb">
        <label for="b24t-auto-delete-cb" style="color:var(--b24t-text-meta);">
          Po zakończeniu usuń wzmianki z tagiem:
          <select class="b24t-select-inline" id="b24t-auto-delete-tag">
            <option value="">— wybierz —</option>
          </select>
        </label>
      </div>
      <div id="b24t-auto-delete-save-row" style="display:none;margin-top:6px;padding-left:20px;">
        <div class="b24t-checkbox-row">
          <input type="checkbox" id="b24t-auto-delete-save-cb">
          <label for="b24t-auto-delete-save-cb" style="font-size:10px;color:var(--b24t-text-faint);">
            Zawsze włączaj na tym projekcie z tym tagiem
          </label>
        </div>
      </div>
    `;

    // Wire event handlers
    const cb = div.querySelector('#b24t-auto-delete-cb');
    const saveCb = div.querySelector('#b24t-auto-delete-save-cb');
    const saveRow = div.querySelector('#b24t-auto-delete-save-row');
    const tagSel = div.querySelector('#b24t-auto-delete-tag');

    if (cb) {
      cb.addEventListener('change', () => {
        state.autoDeleteEnabled = cb.checked;
        state.autoDeleteTagId = cb.checked ? (parseInt(tagSel?.value) || null) : null;
        if (saveRow) saveRow.style.display = cb.checked ? 'block' : 'none';
        if (!cb.checked && saveCb) {
          saveCb.checked = false;
          setAutoDeletePref(false);
        }
      });
    }

    if (tagSel) {
      tagSel.addEventListener('change', () => {
        state.autoDeleteTagId = parseInt(tagSel.value) || null;
        if (saveCb?.checked) setAutoDeletePref(true);
      });
    }

    if (saveCb) {
      saveCb.addEventListener('change', () => {
        setAutoDeletePref(saveCb.checked);
      });
    }

    return div;
  }

  function wireDeleteEvents(panel) {
    const delTab = panel.querySelector('#b24t-delete-tab');
    if (!delTab) return;

    // Batch size input — wiring
    const batchInput = delTab.querySelector('#b24t-del-batch-input');
    const batchLock  = delTab.querySelector('#b24t-del-batch-lock');
    if (batchInput && batchLock) {
      const savedBatch = lsGet(LS.DEL_BATCH);
      const alreadyWarned = lsGet(LS.DEL_BATCH_WARNED);
      if (savedBatch) { _deleteBatch = savedBatch; batchInput.value = savedBatch; }
      // Start locked unless user already accepted warning
      batchInput.readOnly = !alreadyWarned;
      batchInput.style.opacity = alreadyWarned ? '1' : '0.45';
      batchLock.style.display = alreadyWarned ? 'none' : '';

      // Click lock icon OR focus on locked input → show warning
      async function tryUnlock() {
        if (lsGet(LS.DEL_BATCH_WARNED)) { batchInput.readOnly = false; batchInput.style.opacity = '1'; batchLock.style.display = 'none'; return; }
        const accepted = await _showDeleteBatchWarning();
        if (accepted) {
          lsSet(LS.DEL_BATCH_WARNED, true);
          batchInput.readOnly = false;
          batchInput.style.opacity = '1';
          batchLock.style.display = 'none';
          batchInput.focus();
        }
      }
      batchLock.addEventListener('click', tryUnlock);
      batchInput.addEventListener('focus', function() { if (batchInput.readOnly) { batchInput.blur(); tryUnlock(); } });
      batchInput.addEventListener('change', function() {
        const val = Math.max(1, Math.min(1000, parseInt(batchInput.value) || DEL_BATCH_DEFAULT));
        batchInput.value = val;
        _deleteBatch = val;
        lsSet(LS.DEL_BATCH, val);
      });
    }

    // Populate tag dropdown when tab becomes visible
    const updateDelTags = () => {
      const sel = document.getElementById('b24t-del-tag');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">— wybierz tag —</option>' +
        Object.entries(state.tags)
          .map(([name, id]) => `<option value="${id}">${name}</option>`)
          .join('');
      if (current) sel.value = current;
    };

    const updateDelDateInfo = () => {
      const el = document.getElementById('b24t-del-dateinfo');
      if (!el) return;
      const url = new URL(window.location.href);
      const d1 = url.searchParams.get('d1') || '?';
      const d2 = url.searchParams.get('d2') || '?';
      el.innerHTML = `<span style="color:var(--b24t-text-faint);">Zakres:</span> ${d1} → ${d2}`;
    };

    // Scope toggle
    panel.querySelectorAll('input[name="b24t-del-scope"]').forEach(r => {
      r.addEventListener('change', (e) => {
        const val = e.target.value;
        document.getElementById('b24t-del-custom-dates').style.display =
          val === 'custom' ? 'flex' : 'none';
        // Boczny panel "Wszystkie projekty"
        if (val === 'allprojects') {
          refreshAllProjectsPanel();
          // Wyłącz główny przycisk "Usuń" — operacja przez boczny panel
          const runBtn = document.getElementById('b24t-del-run');
          if (runBtn) { runBtn.disabled = true; runBtn.style.opacity = '0.4'; }
        } else {
          const ap = document.getElementById('b24t-del-allprojects-panel');
          if (ap) { ap.style.display = 'none'; }
          const runBtn = document.getElementById('b24t-del-run');
          if (runBtn) { runBtn.disabled = false; runBtn.style.opacity = ''; }
        }
      });
    });

    // Gdy tag się zmienia i allprojects jest aktywny — odśwież boczny panel
    // Dodatkowo: prefetch danych w tle dla nowego tagu (niezależnie od aktywnego scope)
    document.getElementById('b24t-del-tag')?.addEventListener('change', () => {
      const isAllProjects = document.querySelector('input[name="b24t-del-scope"][value="allprojects"]')?.checked;
      if (isAllProjects) refreshAllProjectsPanel();
      // Prefetch w tle dla nowego tagu — dane będą gotowe gdy użytkownik wybierze "Wszystkie projekty"
      const newTagId = parseInt(document.getElementById('b24t-del-tag')?.value);
      if (newTagId && !_bgCacheFresh(bgCache.allProjects[newTagId])) {
        _bgFetchAllProjects(newTagId).catch(function(e){ addLog('[BG] prefetch allProjects error: ' + e.message, 'warn'); });
      }
    });

    // Run delete
    document.getElementById('b24t-del-run')?.addEventListener('click', async () => {
      const tagId = parseInt(document.getElementById('b24t-del-tag')?.value);
      if (!tagId) { alert('Wybierz tag przed usunięciem.'); return; }

      const tagName = Object.entries(state.tags).find(([, id]) => id === tagId)?.[0] || String(tagId);
      const scope = document.querySelector('input[name="b24t-del-scope"]:checked')?.value || 'view';

      let dateFrom, dateTo;
      if (scope === 'view') {
        const url = new URL(window.location.href);
        dateFrom = url.searchParams.get('d1');
        dateTo = url.searchParams.get('d2');
        if (!dateFrom || !dateTo) { alert('Brak zakresu dat w URL. Ustaw zakres dat w panelu Brand24.'); return; }
      } else {
        dateFrom = document.getElementById('b24t-del-date-from')?.value;
        dateTo = document.getElementById('b24t-del-date-to')?.value;
        if (!dateFrom || !dateTo) { alert('Podaj zakres dat.'); return; }
      }

      // One-time warning
      const confirmed = await confirmDeleteWarning();
      if (!confirmed) return;

      // Second confirm with details
      const count = await getMentions(state.projectId, dateFrom, dateTo, [tagId], 1);
      const total = count.count || '?';
      if (!confirm(`Usunąć ${total} wzmianek z tagiem "${tagName}" (${dateFrom} → ${dateTo})?\n\nTo jest NIEODWRACALNE.`)) return;

      const runBtn = document.getElementById('b24t-del-run');
      const statusEl = document.getElementById('b24t-del-status');
      const progressEl = document.getElementById('b24t-del-progress');
      if (runBtn) runBtn.disabled = true;
      if (progressEl) progressEl.classList.add('b24t-bar-active');
      _getBarDel().reset();
      const delTimer = makeTabTimer('b24t-del-timer');
      delTimer.start();

      const setStatus = (msg, cls = '') => {
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = cls === 'error' ? '#f87171' : cls === 'success' ? '#4ade80' : '#9090aa'; }
      };
      const setProgress = (cur, total) => {
        _getBarDel().set(total > 0 ? Math.round(cur / total * 100) : 0);
      };

      try {
        setStatus('Zbieram wzmianki...');
        const allIds = await fetchAllIds(
          p => getMentions(state.projectId, dateFrom, dateTo, [tagId], p),
          (cur, total, count) => setStatus(`Zbieram: ${cur}/${total} stron...`)
        );

        if (!allIds.length) { setStatus('Brak wzmianek do usunięcia.', 'success'); if (runBtn) runBtn.disabled = false; return; }

        setStatus(`Usuwam ${allIds.length} wzmianek...`);
        let deleted = 0;
        const BATCH_QD = _deleteBatch;
        for (let i = 0; i < allIds.length; i += BATCH_QD) {
          const chunk = allIds.slice(i, i + BATCH_QD);
          await Promise.all(chunk.map(id => deleteMention(id)));
          deleted += chunk.length;
          setProgress(deleted, allIds.length);
          if (deleted % BATCH_QD === 0 || deleted === allIds.length) setStatus(`Usunięto ${deleted}/${allIds.length}...`);
        }

        setStatus(`✓ Usunięto ${deleted} wzmianek`, 'success');
        setProgress(1, 1);
        addLog(`✓ Quick Delete: ${deleted} wzmianek (tag "${tagName}")`, 'success');
      } catch (e) {
        setStatus(`✕ Błąd: ${e.message}`, 'error');
        addLog(`✕ Quick Delete błąd: ${e.message}`, 'error');
      } finally {
        delTimer.stop();
        if (progressEl) progressEl.classList.remove('b24t-bar-active');
        if (runBtn) runBtn.disabled = false;
      }
    });

    // Delete current view button
    document.getElementById('b24t-delview-run')?.addEventListener('click', async () => {
      const scope = document.querySelector('input[name="b24t-delview-scope"]:checked')?.value || 'current-page';
      const runBtn = document.getElementById('b24t-delview-run');
      const setStatus = (msg, cls) => {
        const el = document.getElementById('b24t-delview-status');
        if (el) { el.textContent = msg; el.style.color = cls === 'error' ? '#f87171' : cls === 'success' ? '#4ade80' : '#9090aa'; }
      };
      const setProgress = (cur, total) => {
        _getBarDelView().set(total > 0 ? Math.round(cur / total * 100) : 0);
      };

      if (!state.projectId) { alert('Przejdź do projektu Brand24.'); return; }

      const confirmed = await confirmDeleteWarning();
      if (!confirmed) return;

      if (runBtn) runBtn.disabled = true;
      const delviewProgressEl = document.getElementById('b24t-delview-progress');
      _getBarDelView().reset();
      if (delviewProgressEl) delviewProgressEl.classList.add('b24t-bar-active');
      const delviewTimer = makeTabTimer('b24t-delview-timer');
      delviewTimer.start();
      setProgress(0, 1);

      try {
        // Collect IDs using same filters as current Brand24 view
        const view = getCurrentViewFilters();
        if (!view.dateFrom || !view.dateTo) throw new Error('Brak zakresu dat. Ustaw zakres dat w panelu Brand24.');
        const projectId = view.projectId || state.projectId;

        let ids = [];
        if (scope === 'current-page') {
          setStatus('Pobieram wzmianki z bieżącej strony...', 'info');
          const result = await getMentionsWithFilters(projectId, view.dateFrom, view.dateTo, view.filters, view.page);
          ids = result.results.map(m => m.id);
        } else {
          setStatus('Zbieram wzmianki ze wszystkich stron...', 'info');
          ids = await fetchAllIds(
            p => getMentionsWithFilters(projectId, view.dateFrom, view.dateTo, view.filters, p),
            (cur, total) => setStatus(`Zbieram: ${cur}/${total} stron...`, 'info')
          );
        }

        if (!ids.length) { setStatus('Brak wzmianek do usunięcia.', 'success'); if (runBtn) runBtn.disabled = false; return; }

        if (!confirm(`Usunąć PERMANENTNIE ${ids.length} wyświetlanych wzmianek?

Tej operacji nie można cofnąć.`)) {
          setStatus('Anulowano.', 'warn');
          if (runBtn) runBtn.disabled = false;
          return;
        }

        setStatus(`Usuwam ${ids.length} wzmianek...`, 'info');
        let deleted = 0;
        const BATCH_DV = _deleteBatch;
        for (let i = 0; i < ids.length; i += BATCH_DV) {
          const chunk = ids.slice(i, i + BATCH_DV);
          await Promise.all(chunk.map(id => deleteMention(id)));
          deleted += chunk.length;
          setProgress(deleted, ids.length);
          if (deleted % 25 === 0 || deleted === ids.length) setStatus(`Usunięto ${deleted}/${ids.length}...`, 'info');
        }

        setStatus(`✓ Usunięto ${deleted} wzmianek`, 'success');
        setProgress(1, 1);
        addLog(`✓ Delete view: usunięto ${deleted} wzmianek`, 'success');
      } catch (e) {
        setStatus(`✕ Błąd: ${e.message}`, 'error');
        addLog(`✕ Delete view błąd: ${e.message}`, 'error');
      } finally {
        delviewTimer.stop();
        if (delviewProgressEl) delviewProgressEl.classList.remove('b24t-bar-active');
        if (runBtn) runBtn.disabled = false;
      }
    });

    // Refresh when tab shown
    const updateDelViewInfo = () => {
      const el = document.getElementById('b24t-delview-info');
      if (!el) return;
      const view = getCurrentViewFilters();
      if (state.lastMentionsVars) {
        const gr = view.filters?.gr || [];
        const grNames = gr.length
          ? gr.map(id => id === 1 ? 'Untagged' : Object.entries(state.tags).find(([,tid]) => tid === id)?.[0] || `tag:${id}`).join(', ')
          : 'wszystkie';
        el.innerHTML = `<span style="color:var(--b24t-text-faint);">Daty:</span> ${view.dateFrom} → ${view.dateTo}<br>` +
          `<span style="color:var(--b24t-text-faint);">Filtry tagów:</span> ${grNames}`;
      } else {
        el.textContent = 'Poczekaj chwilę — filtry zostaną wykryte automatycznie.';
      }
    };

    const observer = new MutationObserver(() => {
      if (delTab.style.display !== 'none') {
        updateDelTags();
        updateDelDateInfo();
        updateDelViewInfo();
      }
    });
    observer.observe(delTab, { attributes: true, attributeFilter: ['style'] });
  }


  // ───────────────────────────────────────────
  // QUICK TAG MODE
  // ───────────────────────────────────────────

  // Returns current view filters - mirrors exactly what Brand24 is showing
  // Uses last captured organic getMentions variables (includes all active filters)
  // Falls back to URL params if not yet captured
  function getCurrentViewFilters() {
    const url = new URL(window.location.href);
    const p = (k, fallback) => url.searchParams.get(k) ?? fallback;
    const currentPage = parseInt(p('p', '1'));

    // Use captured variables from last organic Brand24 request - most accurate
    if (state.lastMentionsVars) {
      return {
        dateFrom: state.lastMentionsVars.dateRange.from,
        dateTo: state.lastMentionsVars.dateRange.to,
        page: currentPage,
        filters: state.lastMentionsVars.filters,
        projectId: state.lastMentionsVars.projectId,
      };
    }

    // Fallback: reconstruct from URL params (only basic filters available)
    const gr = p('gr', '').split(',').map(Number).filter(Boolean);
    return {
      dateFrom: p('d1', null),
      dateTo: p('d2', null),
      page: currentPage,
      filters: {
        va: parseInt(p('va', '1')),
        rt: [],
        se: [],
        vi: null,
        gr,
        sq: p('sq', ''),
        do: p('do', ''),
        au: p('au', ''),
        lem: false,
        ctr: [],
        nctr: false,
        is: [0, 10],
        tp: null,
        lang: [],
        nlang: false,
      },
    };
  }

  // Collect ALL mention IDs matching current view across all pages
  // Uses exact same filters as Brand24 is currently displaying
  async function collectCurrentViewIds(onProgress) {
    const view = getCurrentViewFilters();
    if (!view.dateFrom || !view.dateTo) throw new Error('Brak zakresu dat. Ustaw zakres dat w panelu Brand24 i spróbuj ponownie.');
    const projectId = view.projectId || state.projectId;
    return fetchAllIds(
      p => getMentionsWithFilters(projectId, view.dateFrom, view.dateTo, view.filters, p),
      onProgress
    );
  }

  // Quick tag: tag all currently visible mentions with chosen tag
  async function runQuickTag(tagId, tagName, scopeMode) {
    const qtStatus = document.getElementById('b24t-qt-status');
    const qtProgress = document.getElementById('b24t-qt-progress');
    const qtBtn = document.getElementById('b24t-qt-run');

    const setStatus = (msg, cls) => {
      if (qtStatus) { qtStatus.textContent = msg; qtStatus.className = `b24t-qt-status b24t-log-${cls}`; }
    };

    const setProgress = (cur, total) => {
      _getBarQt().set(total > 0 ? Math.round(cur / total * 100) : 0);
    };

    if (qtBtn) qtBtn.disabled = true;
    _getBarQt().reset();
    const qtTimer = makeTabTimer('b24t-qt-timer');
    qtTimer.start();
    setStatus('Zbieram wzmianki...', 'info');

    try {
      let ids = [];

      if (scopeMode === 'current-page') {
        // Only current page - uses exact same filters as Brand24 is displaying
        const view = getCurrentViewFilters();
        if (!view.dateFrom || !view.dateTo) throw new Error('Brak zakresu dat. Ustaw zakres dat w panelu Brand24.');
        const projectId = view.projectId || state.projectId;
        const result = await getMentionsWithFilters(projectId, view.dateFrom, view.dateTo, view.filters, view.page);
        ids = result.results.map(m => m.id);
        setStatus(`Znaleziono ${ids.length} wzmianek na tej stronie`, 'info');
      } else {
        // All pages matching current view
        ids = await collectCurrentViewIds((page, totalPages, totalCount) => {
          setStatus(`Strona ${page}/${totalPages} (${ids.length}/${totalCount})`, 'info');
          setProgress(page, totalPages);
        });
        setStatus(`Znaleziono ${ids.length} wzmianek łącznie`, 'info');
      }

      if (!ids.length) {
        setStatus('Brak wzmianek do otagowania.', 'warn');
        if (qtBtn) qtBtn.disabled = false;
        return;
      }

      // Tag in batches — QT_CONCURRENCY batchów równolegle
      setStatus(`Tagowanie ${ids.length} wzmianek → ${tagName}...`, 'info');
      let tagged = 0;
      const qtSlices = [];
      for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) qtSlices.push(ids.slice(i, i + MAX_BATCH_SIZE));
      for (let i = 0; i < qtSlices.length; i += QT_CONCURRENCY) {
        const concSlices = qtSlices.slice(i, i + QT_CONCURRENCY);
        await Promise.all(concSlices.map(slice => bulkTagMentions(slice, tagId)));
        tagged += concSlices.reduce((s, sl) => s + sl.length, 0);
        setProgress(tagged, ids.length);
        setStatus(`Otagowano ${tagged}/${ids.length}...`, 'info');
      }

      setStatus(`✓ Gotowe! Otagowano ${tagged} wzmianek tagiem "${tagName}"`, 'success');
      addLog(`✓ Quick Tag: ${tagged} wzmianek → ${tagName}`, 'success');
      setProgress(1, 1);

    } catch (e) {
      setStatus(`✕ Błąd: ${e.message}`, 'error');
      addLog(`✕ Quick Tag błąd: ${e.message}`, 'error');
    } finally {
      qtTimer.stop();
      if (qtBtn) qtBtn.disabled = false;
    }
  }

  // Build Quick Tag tab HTML
  function buildQuickTagTab() {
    const div = document.createElement('div');
    div.id = 'b24t-quicktag-tab';
    div.style.display = 'none';
    div.innerHTML = `
      <div class="b24t-section">
        <div class="b24t-section-label">Quick Tag</div>
        <div style="font-size:12px;color:var(--b24t-text-muted);margin-bottom:10px;line-height:1.6;">
          Taguje wzmianki widoczne w aktualnym widoku Brand24
          (aktywne filtry, zakres dat, untagged itd.)
        </div>

        <!-- Current view info -->
        <div id="b24t-qt-view-info" style="background:var(--b24t-bg-elevated);border:1px solid var(--b24t-border);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px;color:var(--b24t-text-muted);line-height:1.6;">
          Wczytywanie widoku...
        </div>

        <!-- Tag selector -->
        <div style="font-size:12px;font-weight:700;color:var(--b24t-primary);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">Wybierz tag</div>
        <select class="b24t-select" id="b24t-qt-tag" style="width:100%;margin-bottom:8px;">
          <option value="">— wybierz tag —</option>
        </select>

        <!-- Scope -->
        <div style="font-size:12px;font-weight:700;color:var(--b24t-primary);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:5px;">Zakres</div>
        <div class="b24t-radio-group" style="margin-bottom:10px;">
          <label class="b24t-radio" style="font-size:13px;">
            <input type="radio" name="b24t-qt-scope" value="current-page" checked>
            <span style="font-size:13px;color:var(--b24t-text-muted);">Tylko bieżąca strona</span>
          </label>
          <label class="b24t-radio" style="font-size:13px;">
            <input type="radio" name="b24t-qt-scope" value="all-pages">
            <span style="font-size:13px;color:var(--b24t-text-muted);">Wszystkie strony</span>
          </label>
        </div>

        <!-- Progress bar -->
        <div class="b24t-progress-bar-track" style="margin-bottom:6px;">
          <div id="b24t-qt-progress" style="height:100%;background:var(--b24t-accent-grad);border-radius:99px;width:0%;"></div>
        </div>

        <!-- Status + timer -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-qt-status" class="b24t-qt-status" style="font-size:12px;color:var(--b24t-text-muted);min-height:16px;flex:1;"></div>
          <div id="b24t-qt-timer" style="font-size:13px;color:var(--b24t-text-muted);font-family:'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif;margin-left:8px;font-weight:500;">00:00</div>
        </div>

        <!-- Run button -->
        <button class="b24t-btn-primary" id="b24t-qt-run" style="width:100%;">
          Taguj teraz
        </button>

        <!-- Untag option -->
        <div style="margin-top:8px;text-align:center;">
          <button id="b24t-qt-untag" style="background:none;border:none;font-size:11px;color:var(--b24t-text-faint);cursor:pointer;font-family:inherit;transition:color 0.15s;" onmouseover="this.style.color='var(--b24t-err)'" onmouseout="this.style.color='var(--b24t-text-faint)'">
            Usuń tag z widocznych wzmianek →
          </button>
        </div>
      </div>
    `;
    return div;
  }

  function wireQuickTagEvents(panel) {
    const qtTab = panel.querySelector('#b24t-quicktag-tab');
    if (!qtTab) return;

    // Populate tag dropdown when tab becomes visible
    const updateQtTags = () => {
      const sel = document.getElementById('b24t-qt-tag');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">— wybierz tag —</option>' +
        Object.entries(state.tags)
          .map(([name, id]) => `<option value="${id}">${name}</option>`)
          .join('');
      if (current) sel.value = current;
    };

    // Update view info
    const updateViewInfo = () => {
      const el = document.getElementById('b24t-qt-view-info');
      if (!el) return;
      const url = new URL(window.location.href);
      const d1 = url.searchParams.get('d1') || '?';
      const d2 = url.searchParams.get('d2') || '?';
      const gr = url.searchParams.get('gr') || '';
      const sq = url.searchParams.get('sq') || '';
      const p = url.searchParams.get('p') || '1';

      // Resolve gr to tag names
      const grNames = gr ? gr.split(',').map(id => {
        if (id === '1') return 'Untagged';
        const name = Object.entries(state.tags).find(([, tid]) => tid === parseInt(id))?.[0];
        return name || `tag:${id}`;
      }).join(', ') : 'wszystkie';

      el.innerHTML = `
        <span style="color:var(--b24t-text-faint);">Daty:</span> ${d1} → ${d2}<br>
        <span style="color:var(--b24t-text-faint);">Filtry tagów:</span> ${grNames}<br>
        ${sq ? `<span style="color:var(--b24t-text-faint);">Szukaj:</span> "${sq}"<br>` : ''}
        <span style="color:var(--b24t-text-faint);">Aktualna strona:</span> ${p}
      `;
    };

    // Run button
    document.getElementById('b24t-qt-run')?.addEventListener('click', () => {
      const tagId = parseInt(document.getElementById('b24t-qt-tag')?.value);
      if (!tagId) { alert('Wybierz tag przed tagowaniem.'); return; }
      const tagName = Object.entries(state.tags).find(([, id]) => id === tagId)?.[0] || String(tagId);
      const scope = document.querySelector('input[name="b24t-qt-scope"]:checked')?.value || 'current-page';
      runQuickTag(tagId, tagName, scope);
    });

    // Untag button
    document.getElementById('b24t-qt-untag')?.addEventListener('click', async () => {
      const tagId = parseInt(document.getElementById('b24t-qt-tag')?.value);
      if (!tagId) { alert('Wybierz tag do usunięcia.'); return; }
      const tagName = Object.entries(state.tags).find(([, id]) => id === tagId)?.[0] || String(tagId);
      const scope = document.querySelector('input[name="b24t-qt-scope"]:checked')?.value || 'current-page';

      const qtStatus = document.getElementById('b24t-qt-status');
      const setStatus = (msg, cls) => {
        if (qtStatus) { qtStatus.textContent = msg; qtStatus.className = `b24t-qt-status b24t-log-${cls}`; }
      };

      try {
        setStatus('Zbieram wzmianki...', 'info');
        let ids = [];
        if (scope === 'current-page') {
          const view = getCurrentViewFilters();
          const projectId = view.projectId || state.projectId;
          const result = await getMentionsWithFilters(projectId, view.dateFrom, view.dateTo, view.filters, view.page);
          ids = result.results.map(m => m.id);
        } else {
          ids = await collectCurrentViewIds();
        }
        if (!ids.length) { setStatus('Brak wzmianek.', 'warn'); return; }
        if (!confirm(`Usunąć tag "${tagName}" z ${ids.length} wzmianek?`)) { setStatus('Anulowano.', 'warn'); return; }
        const utSlices = [];
        for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) utSlices.push(ids.slice(i, i + MAX_BATCH_SIZE));
        for (let i = 0; i < utSlices.length; i += QT_CONCURRENCY) {
          await Promise.all(utSlices.slice(i, i + QT_CONCURRENCY).map(slice => bulkUntagMentions(slice, tagId)));
        }
        setStatus(`✓ Usunięto tag "${tagName}" z ${ids.length} wzmianek`, 'success');
        addLog(`✓ Quick Untag: ${ids.length} wzmianek ← ${tagName}`, 'success');
      } catch (e) {
        setStatus(`✕ Błąd: ${e.message}`, 'error');
      }
    });

    // Refresh view info when tab is shown
    const observer = new MutationObserver(() => {
      if (qtTab.style.display !== 'none') {
        updateQtTags();
        updateViewInfo();
      }
    });
    observer.observe(qtTab, { attributes: true, attributeFilter: ['style'] });

    // Also refresh on URL change (Brand24 is SPA)
    let lastUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        if (qtTab.style.display !== 'none') updateViewInfo();
      }
    }, 1000);
  }

  // ───────────────────────────────────────────
  // INIT
  // ───────────────────────────────────────────

  function init() {
    // Only run on Mentions page
    if (!window.location.pathname.includes('/panel/results/')) return;

    // Bootstrap PROJECT_NAMES: przeskanuj LS.PROJECTS i zapisz dobre nazwy do resolvera
    (function() {
      var projects = lsGet(LS.PROJECTS, {});
      Object.entries(projects).forEach(function(entry) {
        var pid = entry[0];
        var pData = entry[1];
        if (pData && typeof pData === 'object' && pData.name) {
          _pnSet(parseInt(pid), pData.name); // _pnSet ignoruje złe nazwy automatycznie
        }
      });
    })();

    injectStyles();
    const panel = buildPanel();

    // Inject Delete tab
    const delTab = buildDeleteTab();
    const delPlaceholder = panel.querySelector('#b24t-delete-tab-placeholder');
    if (delPlaceholder) delPlaceholder.replaceWith(delTab);

    // Inject History tab
    const histTab = buildHistoryTab();
    const histPlaceholder = panel.querySelector('#b24t-history-tab-placeholder');
    if (histPlaceholder) histPlaceholder.replaceWith(histTab);

    // Inject History tab
    // Inject Auto-Delete section into settings
    const autoDelSection = buildAutoDeleteSection();
    const autoDelPlaceholder = panel.querySelector('#b24t-auto-delete-placeholder');
    if (autoDelPlaceholder) autoDelPlaceholder.replaceWith(autoDelSection);

    // Inject Quick Tag tab
    const qtTab = buildQuickTagTab();
    const placeholder = panel.querySelector('#b24t-quicktag-tab-placeholder');
    if (placeholder) placeholder.replaceWith(qtTab);

    document.body.appendChild(panel);

    // ── MAIN PANEL SIDE TAB ──
    (function() {
      var mainTab = document.createElement('div');
      mainTab.id = 'b24t-panel-side-tab';
      mainTab.title = 'Otwórz B24 Tagger';
      mainTab.innerHTML =
        '<span style="writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:.08em;font-size:12px;font-weight:700;">B24 Tagger</span>' +
        '<span style="font-size:17px;line-height:1;">›</span>';
      mainTab.addEventListener('click', function() {
        mainTab.style.removeProperty('display');
        mainTab.style.display = 'none';
        panel.style.removeProperty('display');
        panel.style.display = 'flex';
        var pos = lsGet(LS.UI_POS);
        if (pos && pos.left) { panel.style.left = pos.left; panel.style.top = pos.top; }
        lsSet('b24tagger_panel_hidden', false);
      });
      document.body.appendChild(mainTab);
      // Restore hidden state
      if (lsGet('b24tagger_panel_hidden')) {
        panel.style.display = 'none';
        mainTab.style.display = 'flex';
      } else {
        // Ensure panel is visible if not explicitly hidden
        if (panel.style.display === 'none') panel.style.display = 'flex';
        mainTab.style.display = 'none';
      }
    })();

    // ── NEWS SIDE TAB ──
    (function() {
      var newsSideTab = document.createElement('div');
      newsSideTab.id = 'b24t-news-side-tab';
      newsSideTab.title = 'Otwórz News';
      newsSideTab.innerHTML =
        '<span style="font-size:16px;line-height:1;">&#128240;</span>' +
        '<span style="writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:.07em;font-size:11px;font-weight:700;">News</span>';
      newsSideTab.addEventListener('click', function() {
        // Fully independent — no annotator panel interaction
        if (newsState.panelsOpen) {
          closeNewsPanels();
          newsSideTab.classList.remove('active');
        } else {
          openNewsPanels();
          newsSideTab.classList.add('active');
        }
      });
      newsSideTab.style.display = 'none'; // shown by features.annotator_tools check
      document.body.appendChild(newsSideTab);
    })();

    setupDragging(panel);
    setupCollapse(panel);
    // Dopasuj domyślny rozmiar startowy do rozmiaru ekranu (tylko gdy użytkownik nie ma zapisanego)
    if (!lsGet(LS.UI_SIZE)) {
      if (_getScreenProfile() === 'compact') {
        panel.style.width  = Math.min(380, Math.round(window.innerWidth  * 0.55)) + 'px';
        panel.style.height = Math.min(480, Math.round(window.innerHeight * 0.72)) + 'px';
      }
    }
    setupResize(panel, LS.UI_SIZE, { minW: 300, maxW: Math.min(720, Math.round(window.innerWidth * 0.85)), minH: 300, maxH: Math.round(window.innerHeight * 0.92), useMaxHeight: true });
    wireEvents(panel);
    wireDeleteEvents(panel);
    wireQuickTagEvents(panel);
    wireHistoryTab();

    // Tab switching — DOM refs cached once after panel is in DOM
    const tabEls = {
      main:     document.getElementById('b24t-main-tab'),
      quicktag: document.getElementById('b24t-quicktag-tab'),
      delete:   document.getElementById('b24t-delete-tab'),
      history:  document.getElementById('b24t-history-tab'),
      actions:  document.getElementById('b24t-actions'),
    };
    const tabBtns = panel.querySelectorAll('.b24t-tab');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('b24t-tab-active'));
        btn.classList.add('b24t-tab-active');
        const tab = btn.dataset.tab;
        if (tabEls.main)     tabEls.main.style.display     = tab === 'main'     ? 'block' : 'none';
        if (tabEls.quicktag) tabEls.quicktag.style.display = tab === 'quicktag' ? 'block' : 'none';
        if (tabEls.delete)   tabEls.delete.style.display   = tab === 'delete'   ? 'block' : 'none';
        if (tabEls.history)  tabEls.history.style.display  = tab === 'history'  ? 'block' : 'none';
        if (tabEls.actions)  tabEls.actions.style.display  = tab === 'main'     ? 'flex'  : 'none';
        const activeEl = tabEls[tab];
        if (activeEl) { activeEl.style.animation = 'none'; void activeEl.offsetHeight; activeEl.style.animation = 'b24t-tab-enter 0.18s ease'; }
      });
    });

    // Detect project once page loads
    const tryDetect = setInterval(async () => {
      if (state.tokenHeaders) {
        clearInterval(tryDetect);
        await detectProject();
      }
    }, 500);

    // Also try after 3s even without token
    setTimeout(async () => {
      clearInterval(tryDetect);
      if (!state.projectId) await detectProject();
    }, 3000);

    // First run setup
    if (!lsGet(LS.SETUP_DONE)) {
      setTimeout(() => {
        showOnboarding(() => {
          addLog('✓ Setup zakończony. Możesz zaczynać!', 'success');
        });
      }, 1500);
    }

    addLog(`B24 Tagger BETA v${VERSION} załadowany.`, 'info');

    // Annotator Tools — buduj floating panel
    buildAnnotatorPanel();

    // Zastosuj opcjonalne funkcje
    applyFeatures();

    // Show What's New on version change
    setTimeout(() => showWelcomePanel(), 2000);

    // (checkForUpdate wywołane w głównym scope IIFE — ma dostęp do GM_xmlhttpRequest)
  }

  // Wait for DOM
  function safeInit() {
    try {
      init();
    } catch(e) {
      console.error('[B24 Tagger BETA] Init error:', e);
      // Show minimal error panel
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#2d1010;color:#f87171;border:1px solid #3d1515;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:11px;z-index:2147483647;max-width:320px;';
      errDiv.innerHTML = '<strong>B24 Tagger BETA — Błąd inicjalizacji</strong><br><br>' + e.message + '<br><br><small>' + (e.stack || '').substring(0, 200) + '</small>';
      document.body.appendChild(errDiv);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    setTimeout(safeInit, 500);
  }

  // Sprawdź aktualizacje — wywołane bezpośrednio w scope IIFE gdzie GM jest dostępne
  // Czekamy 6s żeby init() zdążył się wykonać i panel był gotowy
  setTimeout(function() {
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      checkForUpdate(false);
    } else {
      // GM niedostępne — spróbuj przez fetch (może być blokowane przez CSP)
      checkForUpdate(false);
    }
  }, 6000);

})();
