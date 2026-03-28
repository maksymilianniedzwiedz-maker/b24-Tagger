// ==UserScript==
// @name         B24 Tagger BETA
// @namespace    https://brand24.com
// @version      0.11.0
// @description  Wtyczka do ułatwiania pracy w panelu Brand24
// @author       B24 Tagger
// @match        https://app.brand24.com/*
// @match        https://panel.brand24.pl/*
// @updateURL    https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js
// @downloadURL  https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect       hooks.slack.com
// @connect       raw.githubusercontent.com
// @connect       cdn.jsdelivr.net
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────────────────────────
  // CONSTANTS & CONFIG
  // ───────────────────────────────────────────

  const VERSION = '0.11.0';
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
  };
  const MAX_BATCH_SIZE = 500;
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
    logs: [],
    sessionStart: null,
    lastActionTime: null,
    testRunMode: false,
    mapMode: 'untagged',     // untagged | full
    conflictMode: 'ignore',  // ask | ignore | overwrite
    switchViewOnDone: false,
    switchViewTagId: null,
    autoPartition: false,
    partitionLimit: 1000,
  };

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

  function normalizeUrl(url) {
    if (!url) return '';
    return url
      .replace(_RX_PROTO,  '')
      .replace(_RX_TWIT,   'x.com')
      .replace(_RX_STATUS, '/statuses/')
      .replace(_RX_TRAIL,  '')
      .toLowerCase()
      .trim();
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
    const res = await origFetch.apply(this, args);
    return res;
  };

  // ───────────────────────────────────────────
  // GRAPHQL HELPERS
  // ───────────────────────────────────────────

  async function gql(operationName, variables, query) {
    if (!state.tokenHeaders) throw new Error('TOKEN_NOT_READY');
    const res = await origFetch('/api/graphql', {
      method: 'POST',
      credentials: 'same-origin',
      headers: state.tokenHeaders,
      body: JSON.stringify({ operationName, variables, query }),
    });
    if (res.status === 401) throw new Error('GRAPHQL_AUTH_ERROR');
    if (!res.ok) throw new Error(`GRAPHQL_HTTP_ERROR_${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0]?.message || 'GRAPHQL_ERROR');
    return data.data;
  }

  async function gqlRetry(operationName, variables, query, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await gql(operationName, variables, query);
      } catch (e) {
        if (e.message === 'GRAPHQL_AUTH_ERROR') throw e;
        if (i < retries - 1) {
          addLog(`⚠ Retry ${i + 1}/${retries}: ${e.message}`, 'warn');
          await sleep(RETRY_DELAYS[i]);
        } else throw e;
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

  async function getMentions(projectId, dateFrom, dateTo, gr, page) {
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
    }`);
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
    if (data.bulkTagMentions?.message) throw new Error(data.bulkTagMentions.message);
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
    if (data.bulkUntagMentions?.message) throw new Error(data.bulkUntagMentions.message);
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
    const lines = text.trim().split('\n');
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
      const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || [];
      const row = {};
      headers.forEach((h, i) => {
        row[h] = (vals[i] || '').trim().replace(/^"|"$/g, '');
      });
      return row;
    });
  }

  function parseJSON(text) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }

  function autoDetectColumns(rows) {
    if (!rows.length) return {};
    const headers = Object.keys(rows[0]);
    const detected = {};

    // Assessment column FIRST - detect before date to avoid false matches
    // Krok 1: szukaj po dokładnej nazwie kolumny (najwyższy priorytet)
    const ASSESSMENT_NAMES = ['assessment', 'label', 'ocena', 'flag', 'classification', 'klasa', 'class'];
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
        // Wartości assessment to typowo słowa uppercase (RELEVANT, IRRELEVANT etc.)
        const looksLikeAssessment = [...vals].some(v => /^[A-Z_]{3,}$/.test(v));
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
      if (['created_date', 'date', 'createddate', 'crawled_date', 'creation_date'].includes(h.toLowerCase())) return true;
      return rows.slice(0, 5).some(r => /\d{4}-\d{2}-\d{2}/.test(String(r[h] || '')));
    });
    if (dateCol) detected.date = dateCol;

    // URL column - exclude already detected columns
    const urlCol = headers.find(h => {
      if (h === assessmentCol || h === dateCol) return false;
      if (['url', 'link', 'source_url'].includes(h.toLowerCase())) return true;
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

    return detected;
  }

  function processFileData(rows, colMap) {
    const assessments = {};
    let noAssessment = 0;
    let minDate = null, maxDate = null;

    rows.forEach(row => {
      const assessment = colMap.assessment ? (row[colMap.assessment] || '').trim() : '';
      if (!assessment) { noAssessment++; return; }
      assessments[assessment] = (assessments[assessment] || 0) + 1;

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
    const CONCURRENCY = 10; // parallel requests per batch

    updateProgress('map', 0, '?');
    addLog(`→ Budowanie mapy URL (${untaggedOnly ? 'Untagged' : 'pełny zakres'}) [${CONCURRENCY}x równolegle]`, 'info');

    // Step 1: fetch page 1 to get total count and pageSize
    const first = await getMentions(state.projectId, dateFrom, dateTo, gr, 1);
    if (!state.pageSize && first.results.length > 0) state.pageSize = first.results.length;
    const pageSize = state.pageSize || 60;
    const totalPages = Math.ceil(first.count / pageSize);

    first.results.forEach(m => {
      const matchUrl = m.url || m.openUrl;
      if (matchUrl) map[normalizeUrl(matchUrl)] = { id: m.id, existingTags: m.tags || [] };
    });
    updateProgress('map', 1, totalPages);

    if (totalPages <= 1) {
      addLog(`✓ Mapa zbudowana: ${Object.keys(map).length} wzmianek (1 strona)`, 'success');
      return map;
    }

    // Step 2: fetch remaining pages in parallel batches
    const remaining = Array.from({length: totalPages - 1}, (_, i) => i + 2);
    let fetched = 1;

    for (let i = 0; i < remaining.length; i += CONCURRENCY) {
      if (state.status !== 'running') break;
      const batch = remaining.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(p => getMentions(state.projectId, dateFrom, dateTo, gr, p))
      );
      results.forEach(result => {
        result.results.forEach(m => {
          const matchUrl = m.url || m.openUrl;
          if (matchUrl) map[normalizeUrl(matchUrl)] = { id: m.id, existingTags: m.tags || [] };
        });
      });
      fetched += batch.length;
      updateProgress('map', fetched, totalPages);
      addLog(`→ Mapa: ${fetched}/${totalPages} stron (${Object.keys(map).length} wzmianek)`, 'info');
      if (i + CONCURRENCY < remaining.length) await sleep(100);
    }

    addLog(`✓ Mapa zbudowana: ${Object.keys(map).length} wzmianek w ${totalPages} stronach`, 'success');
    return map;
  }


  // ───────────────────────────────────────────
  // MAIN TAGGING FLOW
  // ───────────────────────────────────────────

  async function runTagging(partition) {
    const { dateFrom, dateTo, rows } = partition;

    // Build URL map
    state.urlMap = await buildUrlMap(dateFrom, dateTo, state.mapMode === 'untagged');

    // Build batches
    const batches = {};          // tagId → [snowflakeIds]
    const overwriteBatches = {}; // {oldTagId_newTagId} → {oldIds, newIds}
    const skipped = [];
    const conflicts = [];

    rows.forEach(row => {
      const urlRaw = row[state.file.colMap.url] || '';
      const assessment = (row[state.file.colMap.assessment] || '').trim().toUpperCase();
      const normalizedUrl = normalizeUrl(urlRaw);
      // Szukaj w mapie: dokładne dopasowanie, potem fuzzy (obcięte ID)
      let entry = state.urlMap[normalizedUrl];
      if (!entry) {
        const keys = Object.keys(state.urlMap);
        const fuzzyKey = keys.find(k => urlsMatch(normalizedUrl, k));
        if (fuzzyKey) entry = state.urlMap[fuzzyKey];
      }

      if (!assessment) {
        skipped.push({ row, reason: 'NO_ASSESSMENT' });
        return;
      }

      const mapping = state.mapping[assessment];
      if (!mapping) {
        skipped.push({ row, reason: 'NO_MAPPING', assessment });
        return;
      }

      if (!entry) {
        skipped.push({ row, reason: 'NO_MATCH', url: urlRaw });
        state.stats.noMatch++;
        return;
      }

      // Check conflicts
      const existingTagIds = entry.existingTags.map(t => t.id);
      const hasConflict = existingTagIds.length > 0 && !existingTagIds.includes(mapping.tagId);
      const alreadyTagged = existingTagIds.includes(mapping.tagId);

      if (alreadyTagged) {
        skipped.push({ row, reason: 'ALREADY_TAGGED', tagId: mapping.tagId });
        return;
      }

      if (hasConflict) {
        if (state.conflictMode === 'ignore') {
          skipped.push({ row, reason: 'CONFLICT_IGNORED', existingTags: entry.existingTags });
          state.stats.conflicts++;
          return;
        } else if (state.conflictMode === 'overwrite') {
          const oldTagId = existingTagIds[0];
          const key = `${oldTagId}_${mapping.tagId}`;
          if (!overwriteBatches[key]) overwriteBatches[key] = { oldTagId, newTagId: mapping.tagId, ids: [] };
          overwriteBatches[key].ids.push(entry.id);
          return;
        } else {
          // 'ask' mode
          conflicts.push({ row, entry, mapping });
          return;
        }
      }

      if (!batches[mapping.tagId]) batches[mapping.tagId] = [];
      batches[mapping.tagId].push(entry.id);
    });

    // Handle 'ask' conflicts
    for (const conflict of conflicts) {
      const decision = await showConflictDialog(conflict);
      if (decision === 'tag') {
        if (!batches[conflict.mapping.tagId]) batches[conflict.mapping.tagId] = [];
        batches[conflict.mapping.tagId].push(conflict.entry.id);
      } else if (decision === 'overwrite') {
        const oldTagId = conflict.entry.existingTags[0]?.id;
        if (oldTagId) await bulkUntagMentions([conflict.entry.id], oldTagId);
        if (!batches[conflict.mapping.tagId]) batches[conflict.mapping.tagId] = [];
        batches[conflict.mapping.tagId].push(conflict.entry.id);
      }
      // 'skip' - do nothing
    }

    // Log skipped
    skipped.forEach(s => {
      if (s.reason === 'NO_MATCH') {
        const urlVal = s.row[state.file.colMap.url] || '';
        const normVal = normalizeUrl(urlVal);
        addLog(`⚠ Brak matcha: url="${urlVal.substring(0, 60)}" | norm="${normVal.substring(0, 50)}"`, 'warn');
      }
    });

    // Execute overwrite batches
    for (const [, batch] of Object.entries(overwriteBatches)) {
      for (let i = 0; i < batch.ids.length; i += MAX_BATCH_SIZE) {
        const slice = batch.ids.slice(i, i + MAX_BATCH_SIZE);
        addLog(`→ Odtagowuję ${slice.length} wzmianek (tag ${batch.oldTagId})`, 'info');
        await bulkUntagMentions(slice, batch.oldTagId);
        if (!batches[batch.newTagId]) batches[batch.newTagId] = [];
        batches[batch.newTagId].push(...slice);
      }
    }

    // Execute tag batches
    const tagIds = Object.keys(batches);
    let batchNum = 0;
    for (const tagId of tagIds) {
      const ids = batches[tagId];
      const tagName = Object.entries(state.tags).find(([, id]) => id === parseInt(tagId))?.[0] || tagId;
      for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
        batchNum++;
        const slice = ids.slice(i, i + MAX_BATCH_SIZE);
        updateProgress('tag', batchNum, tagIds.length);
        addLog(`→ bulkTag: ${slice.length} → ${tagName}`, 'info');
        await bulkTagMentions(slice, parseInt(tagId));
        state.stats.tagged += slice.length;
        updateStatsUI();
        await sleep(200);
      }
    }

    state.stats.skipped += skipped.length;
    addLog(`✓ Partycja zakończona: ${state.stats.tagged} otagowane, ${state.stats.skipped} pominięte`, 'success');
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
    updateStatusUI();
    startSessionTimer();

    // Set Brand24 date filter
    const dateFrom = state.file.meta.minDate;
    const dateTo = state.file.meta.maxDate;
    if (dateFrom && dateTo) {
      const currentUrl = window.location.href;
      if (!currentUrl.includes(`d1=${dateFrom}`) || !currentUrl.includes(`d2=${dateTo}`)) {
        addLog(`→ Ustawiam zakres dat: ${dateFrom} → ${dateTo}`, 'info');
        navigateToDateRange(dateFrom, dateTo);
        await sleep(2000);
      }
    }

    // Activate Untagged filter
    addLog('→ Aktywuję filtr Untagged', 'info');
    activateUntaggedFilter();
    await sleep(1500);

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
    if (untaggedChip) untaggedChip.click();
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
    const userMessages = {
      'GRAPHQL_AUTH_ERROR':    'Sesja Brand24 wygasła. Zaloguj się ponownie i kliknij "Wznów".',
      'TOKEN_NOT_READY':       'Token autoryzacji nie jest gotowy. Odśwież stronę Brand24 i spróbuj ponownie.',
      'GRAPHQL_HTTP_ERROR_500':'Błąd serwera Brand24 (500). Spróbuj ponownie za chwilę.',
      'GRAPHQL_HTTP_ERROR_503':'Brand24 tymczasowo niedostępny. Spróbuj za kilka minut.',
      'NETWORK_ERROR':         'Problem z połączeniem internetowym. Sprawdź sieć i spróbuj ponownie.',
    };
    const userMsg = userMessages[error.message] ||
      (error.message.includes('network') || error.message.includes('fetch')
        ? 'Problem z połączeniem internetowym. Sprawdź sieć i spróbuj ponownie.'
        : 'Nieznany błąd. Wyślij Bug Report z poziomu Changelog & Feedback.');

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
    state.status = 'error';
    updateStatusUI();
    addLog(`✕ Błąd: ${error.message}`, 'error');
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
    // typ 'diag' — prefiks [DIAG] w #f87171, reszta normalnym kolorem error
    if (type === 'diag') {
      const diagMatch = message.match(/^(\[DIAG\]\s*)(.*)/s);
      if (diagMatch) {
        div.innerHTML = `<span class="b24t-log-time">${time}</span><span class="b24t-log-msg"><span class="b24t-log-diag-prefix">${diagMatch[1]}</span>${diagMatch[2]}</span><span class="b24t-log-elapsed"></span>`;
      } else {
        div.innerHTML = `<span class="b24t-log-time">${time}</span><span class="b24t-log-msg"><span class="b24t-log-diag-prefix">[DIAG] </span>${message}</span><span class="b24t-log-elapsed"></span>`;
      }
    } else {
      div.innerHTML = `<span class="b24t-log-time">${time}</span><span class="b24t-log-msg">${message}</span><span class="b24t-log-elapsed"></span>`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;

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
      el.textContent = found ? '●' : '●';
    }
    const sub = document.getElementById('b24t-token-status-sub');
    if (sub) {
      sub.textContent = found ? '● Token: aktywny' : '● Token: oczekuję...';
      sub.style.color = found ? '#4ade80' : '#facc15';
    }
  }

  function updateStatusUI() {
    const el = document.getElementById('b24t-status-badge');
    if (!el) return;
    const map = {
      idle: ['Idle', 'badge-idle'],
      running: ['Running', 'badge-running'],
      paused: ['Paused', 'badge-paused'],
      error: ['Error', 'badge-error'],
      done: ['Done', 'badge-done'],
    };
    const [text, cls] = map[state.status] || ['Idle', 'badge-idle'];
    el.textContent = text;
    el.className = `b24t-badge ${cls}`;

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
    if (els.tagged) els.tagged.textContent = state.stats.tagged;
    if (els.skipped) els.skipped.textContent = state.stats.skipped + state.stats.noMatch;

    // Remaining = total file rows - tagged - skipped
    const total = state.file?.rows?.length || 0;
    const done = state.stats.tagged + state.stats.skipped + state.stats.noMatch;
    if (els.remaining) els.remaining.textContent = Math.max(0, total - done);
  }

  function updateProgress(phase, current, total) {
    const label = document.getElementById('b24t-progress-label');
    const bar = document.getElementById('b24t-progress-bar');
    if (!label || !bar) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    label.textContent = phase === 'map'
      ? `Budowanie mapy: ${current}/${total}`
      : `Tagowanie: batch ${current}/${total}`;
    bar.style.width = `${pct}%`;
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
    content.innerHTML = `
      <h3>Raport sesji</h3>
      <div class="b24t-report-row"><span>Otagowano:</span><strong>${state.stats.tagged}</strong></div>
      <div class="b24t-report-row"><span>Pominięto:</span><strong>${state.stats.skipped}</strong></div>
      <div class="b24t-report-row"><span>Brak matcha:</span><strong>${state.stats.noMatch}</strong></div>
      <div class="b24t-report-row"><span>Konflikty:</span><strong>${state.stats.conflicts}</strong></div>
      <div class="b24t-report-row"><span>Czas sesji:</span><strong>${mins}m ${secs}s</strong></div>
      <button onclick="window.B24Tagger.exportReport()" class="b24t-btn-secondary">Eksportuj CSV</button>
      <button onclick="document.getElementById('b24t-report-modal').style.display='none'" class="b24t-btn-primary">Zamknij</button>
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
    debug: {
      getState: () => JSON.parse(JSON.stringify({ ...state, urlMap: `[${Object.keys(state.urlMap).length} entries]`, logs: `[${state.logs.length} entries]` })),
      getLogs: () => state.logs,
      getCrashLog: () => lsGet(LS.CRASHLOG),
      getUrlMap: () => ({ size: Object.keys(state.urlMap).length, sample: Object.entries(state.urlMap).slice(0, 3) }),
      testGraphQL: async () => { try { await getNotifications(); return 'OK'; } catch (e) { return `FAIL: ${e.message}`; } },
      retryLastAction: () => { if (state.status === 'paused' || state.status === 'error') { state.status = 'running'; updateStatusUI(); startRun(); } },
      forceStop: () => { state.status = 'idle'; updateStatusUI(); stopHealthCheck(); addLog('⏹ Awaryjne zatrzymanie.', 'warn'); },
      clearCheckpoint: () => { clearCheckpoint(); addLog('🗑 Checkpoint wyczyszczony.', 'info'); },
      getToken: () => state.tokenHeaders,
      checkForUpdate: (manual) => checkForUpdate(manual),
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

  // ───────────────────────────────────────────
  // UI - STYLES
  // ───────────────────────────────────────────

  function injectStyles() {
    // Wczytaj Inter z Google Fonts (jeśli jeszcze nie ma)
    if (!document.getElementById('b24t-inter-font')) {
      const link = document.createElement('link');
      link.id = 'b24t-inter-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap';
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

        --b24t-primary:     #7c6fff;
        --b24t-primary-h:   #a090ff;
        --b24t-primary-glow: rgba(124,111,255,0.28);
        --b24t-primary-bg:  rgba(124,111,255,0.12);

        --b24t-accent-grad: linear-gradient(135deg, #6c5fff 0%, #9b6bff 50%, #c060ff 100%);
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
        --b24t-shadow-h:    0 12px 40px rgba(0,0,0,0.8), 0 0 20px rgba(124,111,255,0.08), 0 0 0 1px rgba(255,255,255,0.06);
        --b24t-shadow-drag: 0 20px 60px rgba(0,0,0,0.9), 0 0 30px rgba(124,111,255,0.12);

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

      /* ── MAIN PANEL ── */
      #b24t-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 440px;
        background: var(--b24t-panel-grad);
        border: 1px solid var(--b24t-border);
        border-radius: 14px;
        font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 13px;
        color: var(--b24t-text);
        z-index: 2147483647;
        box-shadow: var(--b24t-shadow);
        user-select: none;
        overflow: hidden;
        transition: box-shadow 0.25s ease, background 0.3s ease, border-color 0.3s ease, color 0.3s ease;
        animation: b24t-slidein 0.35s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      #b24t-panel:hover { box-shadow: var(--b24t-shadow-h); }
      #b24t-panel.b24t-resizing { opacity: 0.97; box-shadow: var(--b24t-shadow-drag); transition: none !important; }
      #b24t-panel.b24t-resizing * { pointer-events: none !important; user-select: none !important; }
      #b24t-panel.dragging { opacity: 0.94; box-shadow: var(--b24t-shadow-drag); cursor: grabbing; }


      /* ── TOPBAR ── */
      #b24t-topbar {
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
        flex-shrink: 0;
        text-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      .b24t-version { font-size: 10px; color: rgba(255,255,255,0.65); margin-left: 4px; }
      #b24t-topbar-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }

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
        font-size: 9px;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 99px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .badge-idle    { background: var(--b24t-badge-idle-bg);  color: var(--b24t-badge-idle-fg); }
      .badge-running { background: var(--b24t-badge-run-bg);   color: var(--b24t-badge-run-fg); animation: b24t-pulse-ring 1.5s infinite; }
      .badge-paused  { background: var(--b24t-badge-pause-bg); color: var(--b24t-badge-pause-fg); }
      .badge-error   { background: var(--b24t-badge-err-bg);   color: var(--b24t-badge-err-fg); }
      .badge-done    { background: var(--b24t-badge-done-bg);  color: var(--b24t-badge-done-fg); }

      /* ── ICON BUTTONS (in topbar) ── */
      .b24t-icon-btn {
        background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.2);
        color: rgba(255,255,255,0.85);
        cursor: pointer; padding: 3px 6px; border-radius: 5px;
        font-size: 13px; line-height: 1;
        transition: background 0.15s, color 0.15s, transform 0.1s;
      }
      .b24t-icon-btn:hover { background: rgba(255,255,255,0.25); color: #fff; transform: scale(1.05); }
      .b24t-icon-btn:active { transform: scale(0.95); }

      /* ── TOKEN STATUS BAR ── */
      #b24t-meta-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 5px 14px;
        background: var(--b24t-bg-deep);
        border-bottom: 2px solid var(--b24t-border);
        font-size: 11px;
        transition: background 0.3s, border-color 0.3s;
      }
      .b24t-token-ok      { color: var(--b24t-ok); font-weight: 600; }
      .b24t-token-pending { color: var(--b24t-warn); }
      .b24t-token-error   { color: var(--b24t-err); }
      #b24t-session-timer { color: var(--b24t-text-meta); font-size: 11px; font-weight: 500; }

      /* ── SUBBAR ── */
      #b24t-subbar {
        background: var(--b24t-bg-deep) !important;
        border-bottom: 1px solid var(--b24t-border-sub) !important;
        transition: background 0.3s, border-color 0.3s;
      }
      #b24t-subbar .b24t-icon-btn {
        background: var(--b24t-primary-bg) !important;
        border: 1px solid color-mix(in srgb, var(--b24t-primary) 30%, transparent) !important;
        color: var(--b24t-primary) !important;
      }
      #b24t-subbar .b24t-icon-btn:hover { background: var(--b24t-primary-bg) !important; filter: brightness(1.2); }
      /* Fix hardcoded dark colors on subbar buttons */
      #b24t-btn-changelog { color: var(--b24t-primary) !important; border-color: color-mix(in srgb, var(--b24t-primary) 25%, transparent) !important; }
      #b24t-btn-check-update { color: var(--b24t-text-faint) !important; border-color: var(--b24t-border) !important; }
      #b24t-session-timer-sub { color: var(--b24t-text-faint) !important; }

      /* ── BODY ── */
      #b24t-body { overflow-y: auto; max-height: 72vh; background: var(--b24t-panel-grad); transition: background 0.3s; }
      #b24t-body::-webkit-scrollbar { width: 3px; }
      #b24t-body::-webkit-scrollbar-track { background: transparent; }
      #b24t-body::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); border-radius: 99px; }

      /* ── SECTIONS ── */
      .b24t-section {
        padding: 12px 14px;
        border-bottom: 2px solid var(--b24t-border);
        transition: border-color 0.3s, background 0.3s;
        animation: b24t-fadein 0.25s ease;
        position: relative;
      }
      /* Alternating section backgrounds for visual rhythm */
      .b24t-section:nth-child(odd)  { background: var(--b24t-section-grad-a); }
      .b24t-section:nth-child(even) { background: var(--b24t-section-grad-b); }
      /* Section left accent stripe */
      .b24t-section::before {
        content: '';
        position: absolute; left: 0; top: 6px; bottom: 6px;
        width: 3px; border-radius: 0 3px 3px 0;
        background: var(--b24t-accent-grad);
        opacity: 0.5;
      }
      .b24t-section-label {
        font-size: 10px; font-weight: 700; color: var(--b24t-text-label);
        text-transform: uppercase; letter-spacing: 0.14em;
        margin-bottom: 10px;
      }
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
      .b24t-file-zone:hover { border-color: var(--b24t-primary); background: var(--b24t-primary-bg); transform: translateY(-1px); }
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
        height: 5px; background: var(--b24t-bg-input); border-radius: 99px;
        overflow: hidden; margin: 8px 0 4px;
        transition: background 0.3s;
        border: 1px solid var(--b24t-border-sub);
      }
      #b24t-progress-bar {
        height: 100%;
        background: var(--b24t-accent-grad);
        border-radius: 99px; width: 0%;
        transition: width 0.4s cubic-bezier(0.4,0,0.2,1);
      }
      #b24t-progress-label { font-size: 12px; color: var(--b24t-text); font-weight: 500; }
      #b24t-progress-action { font-size: 11px; color: var(--b24t-text-meta); margin-top: 2px; }

      /* ── STATS ── */
      .b24t-stats-grid {
        display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;
      }
      .b24t-stat-card {
        background: var(--b24t-section-grad-d); border: 1px solid var(--b24t-border);
        border-radius: 8px; padding: 8px 10px;
        transition: background 0.3s, border-color 0.3s, transform 0.15s;
        position: relative; overflow: hidden;
      }
      .b24t-stat-card::after {
        content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px;
        background: var(--b24t-accent-grad); opacity: 0.4;
      }
      .b24t-stat-card:hover { transform: translateY(-2px); border-color: var(--b24t-border-strong); }
      .b24t-stat-label { font-size: 11px; color: var(--b24t-text-meta); margin-bottom: 3px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
      .b24t-stat-value { font-size: 20px; font-weight: 800; color: var(--b24t-text); }
      .b24t-stat-value.ok   { color: var(--b24t-ok); }
      .b24t-stat-value.warn { color: var(--b24t-warn); }

      /* ── LOG ── */
      #b24t-log {
        height: 120px; overflow-y: auto;
        font-size: 12px; line-height: 1.6;
        background: var(--b24t-bg-section-c);
        transition: background 0.3s;
        border-radius: 6px;
      }
      #b24t-log::-webkit-scrollbar { width: 3px; }
      #b24t-log::-webkit-scrollbar-thumb { background: var(--b24t-scrollbar); border-radius: 99px; }
      .b24t-log-entry { display: flex; gap: 6px; padding: 1px 0; animation: b24t-fadein 0.15s ease; }
      .b24t-log-time    { color: var(--b24t-text-faint); flex-shrink: 0; }
      .b24t-log-msg     { color: var(--b24t-text-muted); flex: 1; }
      .b24t-log-elapsed { color: var(--b24t-text-faint); font-size: 10px; flex-shrink: 0; }
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
        display: flex; gap: 6px; padding: 10px 14px;
        background: var(--b24t-section-grad-c);
        border-top: 2px solid var(--b24t-border);
        transition: background 0.3s, border-color 0.3s;
      }
      .b24t-btn-primary {
        flex: 1; background: var(--b24t-accent-grad); color: #fff;
        border: none; border-radius: 7px; padding: 9px 0;
        font-size: 12px; font-weight: 700; cursor: pointer;
        font-family: inherit;
        transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
        box-shadow: 0 2px 8px var(--b24t-primary-glow);
        letter-spacing: 0.02em;
      }
      .b24t-btn-primary:hover { opacity: 0.88; box-shadow: 0 4px 16px var(--b24t-primary-glow); transform: translateY(-1px); }
      .b24t-btn-primary:active { transform: scale(0.97); }
      .b24t-btn-primary:disabled { background: var(--b24t-bg-input); color: var(--b24t-text-faint); box-shadow: none; cursor: not-allowed; }
      .b24t-btn-secondary {
        flex: 1; background: var(--b24t-section-grad-d); color: var(--b24t-text);
        border: 1px solid var(--b24t-border); border-radius: 7px; padding: 9px 0;
        font-size: 12px; cursor: pointer; font-family: inherit; font-weight: 500;
        transition: background 0.15s, transform 0.1s, border-color 0.15s;
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
      .b24t-btn-warn {
        background: var(--b24t-warn-bg); color: var(--b24t-warn-text);
        border: 1px solid color-mix(in srgb, var(--b24t-warn) 30%, transparent); border-radius: 7px; padding: 6px 12px;
        font-size: 11px; cursor: pointer; font-family: inherit; font-weight: 600;
        transition: filter 0.15s;
      }
      .b24t-btn-warn:hover { filter: brightness(0.9); }

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
        transform: translateY(-1px);
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
      #b24t-panel.collapsed #b24t-tabs { display: none; }
      #b24t-panel.collapsed #b24t-body,
      #b24t-panel.collapsed #b24t-actions,
      #b24t-panel.collapsed #b24t-meta-bar { display: none; }

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
        font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        box-shadow: var(--b24t-shadow-h);
        animation: b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);
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
        font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        box-shadow: var(--b24t-shadow-h);
        animation: b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);
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
        z-index: 2147483647; font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        backdrop-filter: blur(6px);
      }
      .b24t-setup-card {
        background: var(--b24t-bg); border: 1px solid var(--b24t-border);
        border-radius: 18px; width: 480px; max-height: 90vh;
        overflow-y: auto; padding: 28px;
        box-shadow: var(--b24t-shadow-h);
        animation: b24t-slidein 0.4s cubic-bezier(0.34,1.56,0.64,1);
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
        font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
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
        animation: b24t-help-pulse 2s ease-in-out infinite;
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
        background: #1a1a2e;
        border: 1px solid rgba(108,108,255,0.4);
        border-radius: 10px;
        padding: 10px 14px;
        font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 11px;
        color: #b0b0c8;
        line-height: 1.6;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        pointer-events: none;
        animation: b24t-slidein 0.2s cubic-bezier(0.34,1.56,0.64,1);
      }
      .b24t-help-tip strong { color: #e2e2e8; display: block; margin-bottom: 4px; font-size: 12px; }
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
        font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
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
    `;
    document.head.appendChild(style);
  }

  // ───────────────────────────────────────────
  // UI - HTML
  // ───────────────────────────────────────────

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'b24t-panel';

    panel.innerHTML = `
      <!-- TOPBAR -->
      <div id="b24t-topbar">
        <span class="b24t-logo">B24 Tagger <span style="font-size:10px;opacity:0.8;letter-spacing:0.08em;">BETA</span></span>
        <span class="b24t-version">v${VERSION}</span>
        <div id="b24t-topbar-right">
          <span id="b24t-status-badge" class="b24t-badge badge-idle">Idle</span>
          <div id="b24t-theme-toggle" title="Przełącz jasny/ciemny motyw">
            <span class="b24t-toggle-icon">☀️</span>
            <div class="b24t-slider-track" id="b24t-theme-track">
              <div class="b24t-slider-knob"></div>
            </div>
            <span class="b24t-toggle-icon">🌙</span>
          </div>
          <button class="b24t-icon-btn" id="b24t-btn-features" title="Dodatkowe funkcje" style="font-size:14px;">⚙</button>
          <button class="b24t-icon-btn" id="b24t-btn-help" title="Pomoc">?</button>
          <button class="b24t-icon-btn" id="b24t-btn-collapse" title="Zwiń/Rozwiń">▼</button>
        </div>
      </div>

      <!-- META BAR -->
      <div id="b24t-meta-bar">
        <span id="b24t-token-status" class="b24t-token-pending" title="Status tokenu API">●</span>
        <span id="b24t-session-timer">00:00:00</span>
      </div>

      <!-- TABS -->
      <!-- SUBBAR: changelog + session timer -->
      <div id="b24t-subbar" style="display:flex;align-items:center;justify-content:space-between;padding:4px 12px;background:var(--b24t-bg-deep);border-bottom:1px solid var(--b24t-border-sub);">
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="b24t-icon-btn" id="b24t-btn-changelog" title="Changelog & Feedback" style="font-size:11px;letter-spacing:0.02em;color:#6c6cff;padding:3px 9px;border:1px solid #6c6cff33;border-radius:4px;">📋 Changelog & Feedback</button>
          <button class="b24t-icon-btn" id="b24t-btn-check-update" title="Sprawdź aktualizacje" style="font-size:11px;color:var(--b24t-text-faint);padding:3px 9px;border:1px solid #2a2a35;border-radius:4px;">↑ Sprawdź aktualizacje</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div id="b24t-token-status-sub" style="font-size:10px;"></div>
          <div id="b24t-session-timer-sub" style="font-size:11px;color:var(--b24t-text-faint);font-family:'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;"></div>
        </div>
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
          <div class="b24t-file-zone" id="b24t-file-zone">
            <span class="b24t-file-icon">📄</span>
            <div>
              <div class="b24t-file-name" id="b24t-file-name">Kliknij aby wgrać plik...</div>
              <div class="b24t-file-meta" id="b24t-file-meta">CSV, JSON lub XLSX</div>
            </div>
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
          <div id="b24t-mapping-rows"></div>
          <button class="b24t-add-tag-btn" id="b24t-create-tag-btn">+ Utwórz nowy tag w Brand24</button>
        </div>

        <!-- USTAWIENIA -->
        <div class="b24t-section" id="b24t-settings-section" style="display:none">
          <div class="b24t-section-label">Ustawienia</div>

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

        <!-- POSTĘP -->
        <div class="b24t-section" id="b24t-progress-section">
          <div class="b24t-section-label">Postęp</div>
          <div id="b24t-progress-label" style="font-size:12px;color:var(--b24t-text-meta);">Gotowy do startu</div>
          <div class="b24t-progress-bar-track"><div id="b24t-progress-bar"></div></div>
          <div id="b24t-progress-action" style="font-size:10px;color:var(--b24t-text-faint);"></div>
        </div>

        <!-- STATYSTYKI -->
        <div class="b24t-section">
          <div class="b24t-section-label">Statystyki sesji</div>
          <div class="b24t-stats-grid">
            <div class="b24t-stat-card">
              <div class="b24t-stat-label">Otagowano</div>
              <div class="b24t-stat-value ok" id="b24t-stat-tagged">0</div>
            </div>
            <div class="b24t-stat-card">
              <div class="b24t-stat-label">Pominięto</div>
              <div class="b24t-stat-value warn" id="b24t-stat-skipped" style="cursor:pointer" title="Kliknij aby zobaczyć listę">0</div>
            </div>
            <div class="b24t-stat-card">
              <div class="b24t-stat-label">Pozostało</div>
              <div class="b24t-stat-value" id="b24t-stat-remaining">0</div>
            </div>
          </div>
        </div>

        <!-- LOG -->
        <div class="b24t-section">
          <div class="b24t-section-label">
            Log
            <button class="b24t-log-clear" id="b24t-log-clear">wyczyść</button>
            <button class="b24t-log-expand" id="b24t-log-expand" title="Pełny widok loga">⛶</button>
          </div>
          <div id="b24t-log"></div>
        </div>

      </div><!-- /b24t-main-tab -->

      <!-- DELETE TAB (injected by JS) -->
      <div id="b24t-delete-tab-placeholder"></div>

      <!-- QUICK TAG TAB (injected by JS) -->
      <div id="b24t-quicktag-tab-placeholder"></div>

      <!-- HISTORY TAB (injected by JS) -->
      <div id="b24t-history-tab-placeholder"></div>

      <!-- Annotator Tools: floating panel, no inline tabs -->
      <!-- Annotator Tools: moved to floating panel -->

      </div><!-- /body -->

      <!-- ACTION BAR -->
      <div id="b24t-actions" style="flex-direction:column;gap:6px;">
        <div style="display:flex;gap:6px;width:100%;">
          <button class="b24t-btn-primary" id="b24t-btn-start" style="flex:2;">▶ Start</button>
          <button class="b24t-btn-secondary" id="b24t-btn-preview" title="Match Preview — sprawdź dopasowanie bez tagowania" style="flex:1;font-size:12px;">Match</button>
          <button class="b24t-btn-secondary" id="b24t-btn-audit" title="Audit Mode — porównaj bez tagowania" style="flex:1;font-size:12px;color:var(--b24t-primary);">Audit</button>
        </div>
        <div style="display:flex;gap:6px;width:100%;">
          <button class="b24t-btn-secondary" id="b24t-btn-pause" disabled style="flex:1;">⏸ Pauza</button>
          <button class="b24t-btn-danger" id="b24t-btn-stop" style="flex:1;">⏹ Stop</button>
          <button class="b24t-btn-secondary" id="b24t-btn-export" title="Eksport raportu CSV" style="flex:0 0 36px;">↓</button>
        </div>
      </div>

      <!-- REPORT MODAL -->
      <div id="b24t-report-modal">
        <div class="b24t-report-content"></div>
      </div>
    `;

    return panel;
  }

  // ───────────────────────────────────────────
  // UI - DRAGGING & COLLAPSING
  // ───────────────────────────────────────────


  // ───────────────────────────────────────────
  // RESIZE — Windows-style resize dla obu paneli
  // ───────────────────────────────────────────

  const RESIZE_HANDLE_SIZE = 8; // px strefa klikania krawędzi

  function setupResize(panel, lsKey, opts) {
    opts = opts || {};
    var minW = opts.minW || 360;
    var maxW = opts.maxW || 720;
    var minH = opts.minH || 300;
    var maxH = opts.maxH || Math.round(window.innerHeight * 0.92);

    // Przywróć zapisany rozmiar
    var saved = lsGet(lsKey);
    if (saved) {
      if (saved.width)  panel.style.width  = Math.min(maxW, Math.max(minW, saved.width))  + 'px';
      if (saved.height) panel.style.maxHeight = Math.min(maxH, Math.max(minH, saved.height)) + 'px';
    }

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

      // Dla main panelu: maxHeight kontroluje ciało, nie panel sam
      if (opts.useMaxHeight) {
        panel.style.maxHeight = newH + 'px';
        var body = panel.querySelector('#b24t-body');
        if (body) {
          // maxHeight panelu minus stałe elementy (topbar ~40 + metabar ~28 + subbar ~34 + tabs ~40 + actions ~56 ≈ 198px)
          var fixedPx = 198;
          body.style.maxHeight = Math.max(80, newH - fixedPx) + 'px';
        }
      } else {
        panel.style.height = newH + 'px';
      }

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
    });
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
  }

  function setupCollapse(panel) {
    const btn = panel.querySelector('#b24t-btn-collapse');
    const collapsed = lsGet(LS.UI_COLLAPSED, false);
    if (collapsed) panel.classList.add('collapsed');
    btn.textContent = collapsed ? '▲' : '▼';

    btn.addEventListener('click', () => {
      const isCollapsed = panel.classList.toggle('collapsed');
      btn.textContent = isCollapsed ? '▲' : '▼';
      lsSet(LS.UI_COLLAPSED, isCollapsed);
    });
  }

  // ───────────────────────────────────────────
  // UI - EVENT WIRING
  // ───────────────────────────────────────────

  function wireEvents(panel) {
    // File upload
    const fileZone = panel.querySelector('#b24t-file-zone');
    const fileInput = panel.querySelector('#b24t-file-input');
    fileZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFileUpload(e.target.files[0]));

    // Drag & drop on file zone
    fileZone.addEventListener('dragover', (e) => { e.preventDefault(); fileZone.style.borderColor = '#6c6cff'; });
    fileZone.addEventListener('dragleave', () => { fileZone.style.borderColor = ''; });
    fileZone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileZone.style.borderColor = '';
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

    // Changelog / What's New
    panel.querySelector('#b24t-btn-changelog')?.addEventListener('click', () => showWhatsNewExtended(true));

    // Dodatkowe funkcje
    panel.querySelector('#b24t-btn-features')?.addEventListener('click', () => showFeaturesModal());

    // ── DARK/LIGHT THEME TOGGLE ──
    (function() {
      const track = document.getElementById('b24t-theme-track');
      if (!track) return;
      const savedTheme = lsGet(LS.THEME, 'light');
      function applyTheme(theme) {
        document.documentElement.setAttribute('data-b24t-theme', theme);
        if (theme === 'dark') track.classList.add('is-dark');
        else track.classList.remove('is-dark');
        lsSet(LS.THEME, theme);
        // Also restyle annotator panel to match
        const ap = document.getElementById('b24t-annotator-panel');
        const at = document.getElementById('b24t-annotator-tab');
        if (ap) ap.setAttribute('data-b24t-theme', theme);
        if (at) at.setAttribute('data-b24t-theme', theme);
      }
      applyTheme(savedTheme);
      track.addEventListener('click', function() {
        const current = document.documentElement.getAttribute('data-b24t-theme') || 'light';
        applyTheme(current === 'light' ? 'dark' : 'light');
      });
    })();

    // Annotator Tools: wired in buildAnnotatorPanel()

    // Sprawdź aktualizacje ręcznie
    panel.querySelector('#b24t-btn-check-update')?.addEventListener('click', () => {
      const btn = document.getElementById('b24t-btn-check-update');
      if (btn) { btn.textContent = '↻ Sprawdzam...'; btn.style.color = '#7878aa'; }
      checkForUpdate(true);
      setTimeout(() => {
        if (btn) { btn.textContent = '↑ Sprawdź aktualizacje'; btn.style.color = '#555577'; }
      }, 3000);
    });

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
        (meta.noAssessment > 0 ? ` · ${meta.noAssessment} bez labela ℹ` : '');

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
        document.getElementById('b24t-partition-section').style.display = 'block';
        document.getElementById('b24t-partition-info').textContent =
          `${partitions.length} partycji · max ${state.partitionLimit} wzmianek/partycja`;
      }

      // Show mapping section
      document.getElementById('b24t-mapping-section').style.display = 'block';
      document.getElementById('b24t-settings-section').style.display = 'block';

      // Check for saved schema
      const savedSchema = findMatchingSchema(Object.keys(meta.assessments));
      if (savedSchema) {
        addLog(`💡 Znaleziono pasujący schemat z ${savedSchema.usedAt}. Sprawdź mapowanie!`, 'warn');
      }

      renderMappingRows(meta.assessments, savedSchema);
      updateStatsUI();
      addLog(`✓ Plik załadowany: ${meta.totalRows} wierszy, ${Object.keys(meta.assessments).length} typów labelek`, 'success');
      addLog(`→ Wykryte kolumny: url="${colMap.url || 'BRAK!'}" | assessment="${colMap.assessment || 'BRAK!'}" | date="${colMap.date || 'BRAK!'}"`, 'info');
      if (!colMap.url) addLog('✕ BŁĄD: Nie wykryto kolumny URL! Matching nie zadziała.', 'error');

    } catch (e) {
      addLog(`✕ Błąd pliku: ${e.message}`, 'error');
      alert(`Błąd wczytywania pliku: ${e.message}`);
    }
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
          <div class="b24t-map-label">(bez labela)</div>
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
  }

  // ───────────────────────────────────────────
  // INIT RUN
  // ───────────────────────────────────────────

  async function initRun() {
    if (!state.file) { showError('Najpierw wgraj plik z wzmiankami.'); return; }
    if (!Object.keys(state.mapping).length) { showError('Skonfiguruj mapowanie labelek.'); return; }
    if (!state.projectId) { showError('Przejdź do zakładki Mentions projektu Brand24.'); return; }

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
    startSessionTimer();
    startHealthCheck();

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
      closeX.style.cssText = 'position:absolute;top:5px;right:8px;background:none;border:none;color:#555577;cursor:pointer;font-size:14px;line-height:1;padding:0;';
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
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #111118;
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
      background: #111118;
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
      color: #eeeef4;
      margin-bottom: 8px; line-height: 1.3;
    }
    .ob-bubble-body {
      font-size: 12px; color: #a0a0c0;
      line-height: 1.7; margin-bottom: 14px;
    }
    .ob-bubble-body strong { color: #eeeef4; }
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
      background: rgba(255,255,255,0.05); color: #7878aa;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
      padding: 8px 14px; font-size: 12px;
      font-family: inherit; cursor: pointer;
      transition: background 0.15s;
    }
    .ob-btn-back:hover { background: rgba(255,255,255,0.1); }
    .ob-step-counter { font-size: 10px; color: #444466; letter-spacing: 0.05em; }

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
        Panel możesz <strong>przeciągać</strong> chwytając za header! 🖱️`,
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
        <span class="ob-tag">📄 Plik</span> — główny tryb: wgraj plik CSV/JSON z labelkami i otaguj setki wzmianek automatycznie<br>
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
        Wtyczka pobiera wzmianki dokładnie z tego samego widoku który masz otwarty i masowo je taguje. Idealne do szybkich operacji! ⚡`,
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
        <strong>Test Run</strong> — symulacja bez zapisu — sprawdź dopasowanie zanim ruszysz na poważnie!<br><br>
        Zawsze zacznij od <strong>Test Run</strong> przy nowym pliku! ✅`,
      tail: 'top',
    },
    // 12 — Funkcje opcjonalne (⚙)
    {
      target: '#b24t-btn-features',
      title: '⚙️ Funkcje opcjonalne',
      body: `Przycisk ⚙ otwiera panel z funkcjami, które możesz włączyć na żądanie.<br><br>
        Każda z nich ma <strong>własny mini-tutorial</strong>, który pojawi się automatycznie przy pierwszym włączeniu — więc nie musisz znać szczegółów z góry! 🎯<br><br>
        Odkrywaj funkcje w swoim tempie.`,
      tail: 'bottom',
    },
    // 13 — Tryb pomocy (?)
    {
      target: '#b24t-btn-help',
      title: '❓ Tryb pomocy',
      body: `Ten przycisk uruchamia <strong>interaktywny tryb pomocy</strong>.<br><br>
        Panel zostanie "wyszarzony", a Ty możesz <strong>klikać na dowolne elementy</strong> interfejsu żeby dowiedzieć się co robią — każdy element ma swój opis.<br><br>
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
        <span class="ob-tag">💬 Feedback</span> — bugi i sugestie prosto do autora<br><br>
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
        2️⃣ Wgraj plik JSON z labelkami<br>
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
    panel.setAttribute('data-ob-locked', '1');
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
        panel.removeAttribute('data-ob-locked');
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
        desc: 'Możesz przeciągać panel trzymając za ten obszar. Zawiera: status sesji, przełącznik motywu, przyciski funkcji opcjonalnych, pomocy i zwijania.',
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
        desc: 'Otwiera modal z funkcjami które możesz włączyć — np. Annotators Tab. Każda funkcja ma własny tutorial.',
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
        desc: '"Changelog & Feedback" otwiera dziennik zmian i zakładkę feedbacku. "Sprawdź aktualizacje" ręcznie wyzwala sprawdzenie nowej wersji.',
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
          selector: '.b24t-stats-grid',
          title: 'Kafelki statystyk',
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
          desc: 'Bieżąca strona — tylko 60 wzmianek z aktualnej strony. Wszystkie strony — iteruje przez cały widok (może potrwać dłużej).',
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
          desc: 'Aktualny widok — daty z URL Brand24. Własny zakres — ręczne daty. 🌐 Wszystkie projekty — usuwa tag ze wszystkich znanych projektów (wymaga Annotators Tab).',
        },
        {
          selector: '#b24t-del-run',
          title: '🗑 Usuń wzmianki z tagiem',
          desc: 'Uruchamia masowe usuwanie. Przy pierwszym użyciu pojawi się ostrzeżenie. Operacja nieodwracalna.',
        },
        {
          selector: '#b24t-delview-info',
          title: 'Usuń wyświetlane wzmianki',
          desc: 'Usuwa wzmianki aktualnie widoczne w panelu Brand24 — niezależnie od tagu. Działa z aktywnymi filtrami i zakresem dat.',
        },
        {
          selector: '#b24t-delview-run',
          title: '🗑 Usuń wyświetlane wzmianki',
          desc: 'Usuwa wszystko co jest widoczne w aktualnym widoku Brand24. Operacja nieodwracalna.',
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
        desc: 'Przegląd wszystkich projektów — ile wzmianek ma tagi REQUIRES_VERIFICATION i TO_DELETE. Ładuje się w tle.',
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
        desc: 'REQ = liczba wzmianek z tagiem REQUIRES_VERIFICATION, DEL = z tagiem TO_DELETE. Pokazuje tylko projekty gdzie coś jest do przetworzenia.',
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
        '<span style="color:#4ade80;">✓ ' + preview.matched + ' matched</span>' +
        '<span style="color:#f87171;">✗ ' + preview.unmatched + ' brak</span>' +
        (preview.noAssessment ? '<span style="color:var(--b24t-text-faint);">~ ' + preview.noAssessment + ' bez labelki</span>' : '') +
      '</div>' +
      '<div style="height:4px;background:var(--b24t-bg-input);border-radius:99px;overflow:hidden;margin-bottom:6px;">' +
        '<div style="height:100%;width:' + preview.pct + '%;background:' + color + ';border-radius:99px;transition:width 0.4s;"></div>' +
      '</div>' +
      (preview.unmatched > 0
        ? '<button id="b24t-preview-btn" style="font-size:10px;color:var(--b24t-text-faint);background:none;border:none;cursor:pointer;padding:0;">Pokaż niezmatched (' + Math.min(preview.unmatched, 50) + ') \u25be</button>' +
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
      btn.textContent = 'Pokaż niezmatched (' + Math.min(preview.unmatched, 50) + ') ' + (show ? '\u25b4' : '\u25be');
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
      if (confirm('Wyczyścić historię sesji?')) {
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
    if (noAssessment > 0)   warnings.push({ type: 'info', msg: noAssessment + ' wierszy bez labelki — zostaną pominięte' });
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
    if (!warnings.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = warnings.map(function(w) {
      return '<div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--b24t-border-sub);">' +
        '<span style="flex-shrink:0;' + (w.type === 'warn' ? 'color:#facc15;' : 'color:var(--b24t-text-faint);') + '">' + (w.type === 'warn' ? '⚠' : 'ℹ') + '</span>' +
        '<span style="font-size:10px;color:#9090bb;">' + w.msg + '</span></div>';
    }).join('');
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
          '<span style="color:#f87171;">✗ ma: ' + e.actual + '</span> <span style="color:#4ade80;">\u2192 powinien: ' + e.expected + '</span></div>';
      });
    }
    content.innerHTML =
      '<h3 style="color:#6c6cff;font-size:14px;margin-bottom:16px;">🔍 Raport Audit Mode</h3>' +
      '<div class="b24t-report-row"><span>✓ Prawidłowo otagowane</span><strong style="color:#4ade80;">' + result.alreadyTagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>⚠ Nieztagowane</span><strong style="color:#facc15;">' + result.untagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>✗ Błędny tag</span><strong style="color:#f87171;">' + result.taggedWrong.length + '</strong></div>' +
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
  // CHANGELOG - historia wersji
  // ───────────────────────────────────────────

  const CHANGELOG = [
    {
      version: '0.11.0',
      date: '2026-03-28',
      label: 'Nowość',
      labelColor: '#6c6cff',
      changes: [
        { type: 'new', text: 'Rozbudowany log — więcej wpisów o procesach:\\n* zakres dat, cache hit/miss, prefetch w tle\\n* per-projekt postęp w Overall Stats i zakładce Tagi\\n* komunikaty o błędach API' },
        { type: 'new', text: 'Pełnoekranowy widok loga — przycisk ⛶ przy sekcji Log otwiera panel 720×520px z filtrami, kopiowaniem i eksportem CSV' },
        { type: 'new', text: 'System diagnostyczny — automatyczne wykrywanie anomalii (brak nazw projektów, błędne daty, nieznane projekty w grupach, błędy API) widoczne w logu jako [DIAG]' },
      ]
    },
    {
      version: '0.10.3',
      date: '2026-03-28',
      label: 'Fix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Nazwy projektów — trwały resolver: wtyczka teraz zapamiętuje poprawne nazwy niezależnie od tego kiedy tytuł strony był gotowy; naprawia wyświetlanie ID zamiast nazwy we wszystkich miejscach' },
      ]
    },
    {
      version: '0.10.2',
      date: '2026-03-28',
      label: 'Fix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Daty we wszystkich narzędziach annotatorskich:\n* naprawiono błędny zakres (np. 28 luty – 28 marca zamiast 1 marca – dziś)\n* poprawiono konwersję dat — nie ma już przesunięcia UTC' },
        { type: 'fix', text: 'Nazwy projektów w zakładce Grupy i panelu "Wszystkie projekty" — naprawiono wyświetlanie ID zamiast nazwy' },
      ]
    },
    {
      version: '0.10.1',
      date: '2026-03-28',
      label: 'Fix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Overall Stats:\n* naprawiono brakujący kafelek "Wszystkie wzmianki"\n* dodano informację o okresie danych (bieżący miesiąc, wyjątek 1-2 dnia)\n* naprawiono wyświetlanie nazw projektów (pokazywało ID zamiast nazwy)' },
      ]
    },
    {
      version: '0.10.0',
      date: '2026-03-28',
      label: 'Nowość',
      labelColor: '#6c6cff',
      changes: [
        { type: 'new', text: 'Annotators Tab — nowe zakładki:\n* Grupy — tworzenie i zarządzanie grupami projektów\n* Overall Stats — sumaryczne statystyki across projektów dla wybranej grupy' },
        { type: 'new', text: 'Grupy projektów: integracja z panelem "Wszystkie projekty" — można ograniczyć cross-delete do wybranej grupy' },
        { type: 'new', text: 'Overall Stats: konfigurowalne per-grupa ustawienie tagu "Relevantne", spinner gdy cache zimny, natychmiastowy render z cache' },
      ]
    },
    {
      version: '0.9.14',
      date: '2026-03-28',
      label: 'Fix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Annotators Tab: zakładka Tagi i otwarcie panelu korzystają teraz z cache — dane pojawiają się natychmiast bez ręcznego odświeżania' },
      ],
    },
    {
      version: '0.9.13',
      date: '2026-03-28',
      label: 'Perf',
      labelColor: '#34d399',
      changes: [
        { type: 'new', text: 'Background prefetch: dane dla Annotators Tab i cross-delete ładują się w tle zaraz po włączeniu wtyczki — otwarcie panelu jest natychmiastowe' },
        { type: 'perf', text: 'Cross-delete: panel "Wszystkie projekty" renderuje się od razu z cache (bez spinnera) jeśli dane mają mniej niż 5 minut' },
        { type: 'perf', text: 'Automatyczne odświeżanie cache co 5 minut w tle — dane są zawsze aktualne bez ręcznej akcji' },
      ],
    },
    {
      version: '0.9.12',
      date: '2026-03-28',
      label: 'Help mode',
      labelColor: '#6c6cff',
      changes: [
        { type: 'new', text: 'Tryb pomocy: strefy dla zakładek Quick Tag, Quick Delete i Historia — każda zakładka ma własny zestaw opisów' },
        { type: 'new', text: 'Tryb pomocy: jeśli Annotators Tab jest włączony — auto-otwiera się przy starcie trybu pomocy i pokazuje swoje strefy' },
        { type: 'ui',  text: 'Trigger Annotators Tab (schowany po prawej): jaśniejszy kolor i tło w light mode — lepiej widoczny' },
      ],
    },
    {
      version: '0.9.11',
      date: '2026-03-28',
      label: 'Design',
      labelColor: '#34d399',
      changes: [
        { type: 'ui',  text: 'Light mode: gradient niebieski→zielony (kolory Brand24) w headerze i tle panelu' },
        { type: 'ui',  text: 'Tryb pomocy (?): podświetlone strefy z pulsującą obramówką, delikatne przyciemnienie zamiast blur' },
        { type: 'fix', text: 'Tryb pomocy: usunięty duplikujący natywny tooltip przeglądarki przy strefach' },
        { type: 'fix', text: 'Tryb pomocy: getHelpZones() przeniesiona do IIFE — fix scope (analogiczny bug jak toggleHelpMode)' },
        { type: 'new', text: 'Tryb pomocy: dodane strefy dla kafelków statystyk, paska postępu i logu zdarzeń' },
      ],
    },
    {
      version: '0.9.10',
      date: '2026-03-28',
      label: 'Hotfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Tryb pomocy (?) działa poprawnie — overlay i strefy widoczne nad panelem, tooltopy po kliknięciu elementu' },
      ],
    },
    {
      version: '0.9.9',
      date: '2026-03-28',
      label: 'Hotfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Przycisk ? (tryb pomocy) w końcu działa — był martwy od zawsze z powodu błędu zakresu JS' },
      ],
    },
    {
      version: '0.9.8',
      date: '2026-03-28',
      label: 'UX',
      labelColor: '#60a5fa',
      changes: [
        { type: 'ui',  text: 'Annotators Tab: zakładki 📊 Projekt / 🏷 Tagi w stylu liquid glass — identyczne z głównymi zakładkami panelu' },
        { type: 'ux',  text: 'Annotators Tab → Tagi: spinner podczas ładowania zamiast skeleton per projekt — lista pojawia się dopiero po załadowaniu wszystkich danych' },
        { type: 'ux',  text: 'Cross-project delete panel: spinner podczas ładowania zamiast skeleton per projekt' },
        { type: 'fix', text: 'Cross-project delete panel: nie rozciąga się do dołu ekranu — teraz dopasowuje się do zawartości (height:auto)' },
      ],
    },
    {
      version: '0.9.7',
      date: '2026-03-28',
      label: 'Hotfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Stała VERSION w kodzie nie była aktualizowana przy deploy — panel pokazywał 0.9.4 zamiast aktualnej wersji, a checkForUpdate() krzyczał o update na samego siebie' },
      ],
    },
    {
      version: '0.9.6',
      date: '2026-03-28',
      label: 'Polish UI',
      labelColor: '#a78bfa',
      changes: [
        { type: 'ui',  text: 'Changelog & Feedback: ikona ✦ → 🚀 w headerze modalu' },
        { type: 'fix', text: 'Changelog & Feedback: light mode fix — modal zawsze ciemny (hardkodowane kolory, brak var(--b24t-*))' },
        { type: 'ui',  text: 'Planowane: legenda priorytetów (kolorowe kółka z opisem) zamiast emoji flag' },
        { type: 'ui',  text: 'Dev Patch Notes: prefiksy kategorii [PERF/FIX/UX/UI/RENAME/DATA...] z kolorowymi badge\'ami + legenda w stopce' },
        { type: 'fix', text: 'PLANNED_FEATURES: usunięto Wieloprojektowość i Szybkie filtry; "Bulk rename / merge" → "Bulk rename tagów"' },
      ],
    },
    {
      version: '0.9.5',
      date: '2026-03-28',
      label: 'Wydajność',
      labelColor: '#34d399',
      changes: [
        { type: 'fix', text: 'Annotators Tab → Tagi: ładuje się błyskawicznie (2 requesty per projekt zamiast setek)' },
        { type: 'ui',  text: 'Tagi: projekty bez wzmianek nie wyświetlają się — lista tylko z tym co istotne' },
        { type: 'ui',  text: 'Cross-project delete: lista projektów zawiera tylko te z wzmiankami' },
        { type: 'ui',  text: 'Zmiana nazwy: "Narzędzia Annotatora" → "Annotators Tab" wszędzie w UI' },
        { type: 'new', text: 'Planowane: Overall Stats w Annotators Tab + grupowanie projektów po kategoriach' },
      ],
    },
    {
      version: '0.9.4',
      date: '2026-03-28',
      label: 'Hotfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Crash przy starcie: features.includes is not a function — features jest obiektem, nie tablicą' },
      ],
    },
    {
      version: '0.9.3',
      date: '2026-03-28',
      label: 'Nowość',
      labelColor: '#f87171',
      changes: [
        { type: 'new', text: 'Cross-project delete — usuń tag ze wszystkich projektów jednocześnie (wymaga Annotators Tab)' },
        { type: 'fix', text: 'Panel boczny wysuwa się obok głównego panelu, nie z krawędzi ekranu' },
        { type: 'fix', text: 'runDeleteByTag: poprawny projectId przy operacjach cross-project' },
      ],
    },
    {
      version: '0.9.2',
      date: '2026-03-28',
      label: 'Poprawki',
      labelColor: '#facc15',
      changes: [
        { type: 'ui',  text: 'Annotators Tab — pełna nazwa triggera, szerszy padding' },
        { type: 'fix', text: 'DEV patch notes uzupełnione od 0.6.0 — każde wdrożenie ma teraz wpis' },
        { type: 'fix', text: 'Zasada wersjonowania: 0.x.0 = nowa sesja, 0.x.y = kolejny deploy w tej samej' },
      ],
    },
    {
      version: '0.9.1',
      date: '2026-03-28',
      label: 'Onboarding fix',
      labelColor: '#6c6cff',
      changes: [
        { type: 'fix', text: 'Panel wyśrodkowany na czas onboardingu' },
        { type: 'new', text: 'Onboarding: szczegółowy krok o Bug Report (co jest wysyłane)' },
        { type: 'new', text: 'Onboarding: krok Co nowego & Planowane' },
      ],
    },
    {
      version: '0.9.0',
      date: '2026-03-27',
      label: 'Optymalizacja',
      labelColor: '#facc15',
      changes: [
        { type: 'perf', text: 'Usunięto 15 zduplikowanych definicji funkcji (~378 linii)', priority: 'high' },
        { type: 'fix',  text: 'Usunięto zduplikowane bloki HTML w buildPanel (file-validation, column-override, match-preview)', priority: 'high' },
        { type: 'fix',  text: 'Usunięto podwójne wywołania saveSessionToHistory() i playDoneSound() w startRun', priority: 'high' },
        { type: 'fix',  text: 'Usunięto martwą funkcję parseXLSX (zastąpiona przez parseXLSXFile)', priority: 'medium' },
        { type: 'fix',  text: 'Usunięto zbędny wrapper fetchMentionsPage (bezpośrednie wywołania getMentions)', priority: 'medium' },
        { type: 'perf', text: 'Pre-kompilacja regexów w normalizeUrl (wywoływana tysiące razy per sesja)', priority: 'medium' },
        { type: 'perf', text: 'Cache referencji DOM w przełączniku zakładek (querySelector tylko raz)', priority: 'medium' },
        { type: 'fix',  text: 'Usunięto martwe zmienne: state.auditMode, state.columnOverride, titleEl, prioColor', priority: 'low' },
        { type: 'ui',   text: 'Skrócono separatory w kodzie (bez wpływu na działanie)', priority: 'low' },
      ],
    },
    {
      version: '0.8.0',
      date: '2026-03-27',
      label: 'UX Update',
      labelColor: '#2563eb',
      changes: [
        { type: 'new', text: 'New onboarding experience' },
        { type: 'new', text: 'Help mode (? button)' },
        { type: 'ui',  text: 'Switched font to Inter' },
        { type: 'ui',  text: 'Light mode color improvements' },
        { type: 'ui',  text: 'Annotator tab enlarged' },
        { type: 'fix', text: 'Light mode element blending fixed' },
      ]
    },
    {
      version: '0.7.0',
      date: '2026-03-27',
      label: 'Redesign',
      labelColor: '#1e7d3a',
      changes: [
        { type: 'ui', text: 'Light mode & dark mode visual overhaul' },
        { type: 'ui', text: 'Annotator panel enlarged (420px, 15px font)' },
        { type: 'fix', text: 'Subbar color fix for light mode' },
      ]
    },
    {
      version: '0.6.0',
      date: '2026-03-27',
      label: 'Redesign',
      labelColor: '#5B4FFF',
      changes: [
        { type: 'new', text: 'Light mode default with Brand24 palette' },
        { type: 'new', text: 'Dark mode toggle (☀️/🌙)' },
        { type: 'new', text: 'CSS custom properties design system' },
        { type: 'ui',  text: 'Micro-animations throughout' },
      ]
    },
    {
      version: '0.5.13',
      date: '2026-03-27',
      label: 'Nowość',
      labelColor: '#4ade80',
      changes: [
        { type: 'new', text: 'Narzędzia Annotatora: floating panel z kartami 📊 Projekt i 🏷 Tagi' },
        { type: 'new', text: 'Panel wysuwany strzałką po prawej stronie ekranu, zamykany przez ×, przeciągany' },
        { type: 'new', text: 'Dane ładują się automatycznie w tle po włączeniu funkcji w ⚙' },
        { type: 'new', text: 'Dokładne liczenie nieotagowanych — pełne skanowanie stron, nie binary search' },
        { type: 'change', text: 'Dashboard Annotatora i Statystyki tagów połączone w jedno narzędzie' },
      ]
    },
    {
      version: '0.5.12',
      date: '2026-03-27',
      label: 'Nowość',
      labelColor: '#4ade80',
      changes: [
        { type: 'new', text: 'Statystyki tagów — zakładka 🏷 Tagi: tabela wszystkich projektów z liczbą wzmianek REQUIRES_VERIFICATION i TO_DELETE' },
        { type: 'new', text: 'Dane ładowane w tle bez przeładowania strony, z podglądem postępu per projekt' },
        { type: 'new', text: 'Widoczne tylko projekty które mają coś do zrobienia (reqVer > 0 lub toDelete > 0)' },
      ]
    },
    {
      version: '0.5.11',
      date: '2026-03-27',
      label: 'Stabilność',
      labelColor: '#facc15',
      changes: [
        { type: 'fix', text: 'Zwiększono retry dla bulkTagMentions do 5 prób — Brand24 API losowo failuje z Internal server error' },
        { type: 'fix', text: 'Opóźnienia retry wydłużone: 2s, 4s, 8s, 12s, 20s' },
      ]
    },
    {
      version: '0.5.10',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Internal server error przy tagowaniu — MAX_BATCH_SIZE zmniejszony z 1000 do 200' },
        { type: 'fix', text: 'Obcięte ID TikTok/Twitter w XLSX — raw:false zapobiega utracie cyfr przez Number precision' },
        { type: 'fix', text: 'Fuzzy matching URL — dopasowuje wzmianki gdy ID w pliku jest obcięte o kilka cyfr' },
      ]
    },
    {
      version: '0.5.9',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono podwójne wykonanie Match Preview i Audit Mode przy każdym kliknięciu' },
        { type: 'fix', text: 'Naprawiono podwójne wywołanie wireHistoryTab()' },
      ]
    },
    {
      version: '0.5.8',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono wykrywanie nazwy projektu — retry co 500ms przez max 10s zamiast jednorazowego retry po 2s' },
      ]
    },
    {
      version: '0.5.7',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono auto-detekcję kolumny assessment — nie mylona już z kolumną source/platform' },
      ]
    },
    {
      version: '0.5.6',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono Dashboard Annotatora — pojawiał się między logiem a przyciskami' },
        { type: 'fix', text: 'Naprawiono wczytywanie XLSX — błąd sandboxu Tampermonkey' },
      ]
    },
    {
      version: '0.5.5',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono wczytywanie XLSX — błąd z sandboxem Tampermonkey' },
      ]
    },
    {
      version: '0.5.4',
      date: '2026-03-27',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono wczytywanie plików XLSX — błąd "Cannot read properties of undefined"' },
      ]
    },
    {
      version: '0.5.3',
      date: '2026-03-27',
      label: 'Bezpieczeństwo',
      labelColor: '#f87171',
      changes: [
        { type: 'fix',  text: 'Naprawiono błędną nazwę projektu w panelu (pokazywało "Brand24" zamiast nazwy projektu)' },
        { type: 'new',  text: 'Potwierdzenie wymagane przy operacjach na 200+ wzmiankowach' },
        { type: 'ui',   text: 'Powiększono czcionki w całym panelu' },
      ]
    },
    {
      version: '0.5.2',
      date: '2026-03-26',
      label: 'Dashboard',
      labelColor: '#6c6cff',
      changes: [
        { type: 'fix',  text: 'Dashboard: naprawiono zliczanie nieotagowanych wzmianek' },
        { type: 'perf', text: 'Dashboard: binary search — ~7 requestów zamiast iteracji przez wszystkie strony' },
      ]
    },
    {
      version: '0.5.1',
      date: '2026-03-26',
      label: 'Dashboard',
      labelColor: '#6c6cff',
      changes: [
        { type: 'new', text: 'Przycisk ⚙ — panel dodatkowych funkcji z checkboxami' },
        { type: 'new', text: 'Dashboard Annotatora — licznik wzmianek bieżącego miesiąca, postęp, dni do końca' },
        { type: 'new', text: 'Automatyczna logika dat: dzień 1-2 pokazuje poprzedni miesiąc' },
      ]
    },
    {
      version: '0.5.0',
      date: '2026-03-25',
      label: 'Test',
      labelColor: '#facc15',
      changes: [
        { type: 'ui', text: 'Test powiadomienia o aktualizacji' },
      ]
    },
    {
      version: '0.4.7',
      date: '2026-03-25',
      label: 'Test',
      labelColor: '#facc15',
      changes: [
        { type: 'ui', text: 'Test powiadomienia o aktualizacji' },
      ]
    },
    {
      version: '0.4.6',
      date: '2026-03-25',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono auto-sprawdzanie aktualizacji — dodano brakujące uprawnienie @connect' },
      ]
    },
    {
      version: '0.4.5',
      date: '2026-03-25',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono auto-sprawdzanie aktualizacji — checkForUpdate dodane do debug bridge' },
      ]
    },
    {
      version: '0.4.4',
      date: '2026-03-25',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono sprawdzanie aktualizacji — GM_xmlhttpRequest działa poprawnie' },
      ]
    },
    {
      version: '0.4.3',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#4ade80',
      changes: [
        { type: 'fix', text: 'Przycisk Zainstaluj otwiera ekran aktualizacji Tampermonkey bezpośrednio' },
      ]
    },
    {
      version: '0.4.2',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#4ade80',
      changes: [
        { type: 'fix',  text: 'Naprawiono auto-sprawdzanie aktualizacji przy załadowaniu strony' },
        { type: 'ui',   text: 'Popup aktualizacji w prawym górnym rogu, większy, wchodzi z prawej' },
        { type: 'ui',   text: 'Zmieniono nazwę przycisku na "Sprawdź aktualizacje"' },
      ]
    },
    {
      version: '0.4.1',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#4ade80',
      changes: [
        { type: 'fix', text: 'Naprawiono sprawdzanie aktualizacji — używa fetch zamiast GM_xmlhttpRequest' },
        { type: 'new', text: 'Przycisk "↑ Aktualizacje" w subbarze — ręczne sprawdzenie' },
        { type: 'ui',  text: 'Baner "Masz najnowszą wersję" przy ręcznym sprawdzeniu' },
      ]
    },
    {
      version: '0.4.0',
      date: '2026-03-25',
      label: 'Test update',
      labelColor: '#facc15',
      changes: [
        { type: 'ui', text: 'Test powiadomienia o aktualizacji' },
      ]
    },
    {
      version: '0.3.9',
      date: '2026-03-25',
      label: 'Auto-update',
      labelColor: '#6c6cff',
      changes: [
        { type: 'new', text: 'Powiadomienie o dostępnej aktualizacji — baner z przyciskiem Zainstaluj' },
        { type: 'new', text: 'Sprawdzanie wersji w tle raz na godzinę (GitHub raw file)' },
      ]
    },
    {
      version: '0.3.8',
      date: '2026-03-25',
      label: 'GitHub ready',
      labelColor: '#4ade80',
      changes: [
        { type: 'fix', text: 'Webhook URL wyciągnięty do konfiguracji — plik bezpieczny do publikacji na GitHub' },
        { type: 'new', text: 'Auto-update przez Tampermonkey (@updateURL / @downloadURL)' },
      ]
    },
    {
      version: '0.3.7',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#4ade80',
      changes: [
        { type: 'fix',  text: 'Rozbudowano crash log o pełne dane diagnostyczne' },
        { type: 'fix',  text: 'Bug Report na Slack zawiera teraz szczegółowy stan sesji przy crashu' },
      ]
    },
    {
      version: '0.3.7',
      date: '2026-03-25',
      label: 'Diagnostyka',
      labelColor: '#f87171',
      changes: [
        { type: 'new', text: 'Rozbudowany crash log — zapisuje snapshot logu sesji, stan partycji, dane pliku i stack trace w momencie błędu' },
        { type: 'new', text: 'Przycisk "Wyślij Bug Report" bezpośrednio w bannerze błędu' },
        { type: 'ui',  text: 'Czytelniejszy widok szczegółów crashu — podzielony na sekcje' },
      ]
    },
    {
      version: '0.3.6',
      date: '2026-03-25',
      label: 'Bug Report',
      labelColor: '#f87171',
      changes: [
        { type: 'new', text: 'Bug Report — wysyła opis błędu razem z pełnymi logami, statusem sesji i danymi diagnostycznymi' },
        { type: 'new', text: 'Suggestions — osobny tryb dla pomysłów i sugestii funkcji' },
        { type: 'ui',  text: 'Zakładka Feedback przebudowana — przełącznik Bug Report / Suggestion' },
        { type: 'perf', text: 'Log sesji przechowuje ostatnie 500 wpisów w pamięci (poprzednio brak limitu)' },
      ]
    },
    {
      version: '0.3.5',
      date: '2026-03-25',
      label: 'UI Redesign',
      labelColor: '#6c6cff',
      changes: [
        { type: 'ui', text: 'Poszerzono panel do 440px' },
        { type: 'ui', text: 'Przycisk Changelog & Feedback przeniesiony do subbara pod topbarem' },
        { type: 'ui', text: 'Action bar przebudowany na dwa rzędy (Start/Match/Audit + Pauza/Stop/Eksport)' },
        { type: 'ui', text: 'Zakładki z ikonami (📄⚡🗑📋) dla lepszej czytelności' },
        { type: 'ui', text: 'Timer i status tokenu zsynchronizowane z subbar' },
        { type: 'ui', text: 'Modal Changelog poszerzony do 520px, dwa pola Feedback obok siebie (grid), zakładki z ikonami' },
      ]
    },
    {
      version: '0.3.4',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#f87171',
      changes: [
        { type: 'ui', text: 'Zmieniono schemat wersjonowania na format beta (0.x.x)' },
        { type: 'ui', text: 'Zmieniono przycisk ZMIANY na Changelog & Feedback' },
        { type: 'ui', text: 'Usunięto odwołania do wewnętrznych narzędzi i projektów' },
      ]
    },
    {
      version: '0.3.3',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono błąd TOKEN_NOT_READY przy ładowaniu wtyczki' },
        { type: 'ui',  text: 'Uproszczono opisy w dzienniku zmian' },
        { type: 'ui',  text: 'Dodano link do pełnych notatek wydania w zakładce Feedback' },
        { type: 'ui',  text: 'Zaktualizowano onboarding o nowe funkcje' },
      ]
    },
    {
      version: '0.3.2',
      date: '2026-03-25',
      label: 'Bugfix',
      labelColor: '#f87171',
      changes: [
        { type: 'fix', text: 'Naprawiono błąd TOKEN_NOT_READY przy ładowaniu wtyczki' },
      ]
    },
    {
      version: '0.3.1',
      date: '2026-03-25',
      label: 'Poprawki',
      labelColor: '#4ade80',
      changes: [
        { type: 'ui',  text: 'Ulepszono formularz feedbacku' },
        { type: 'ui',  text: 'Zaktualizowano priorytety w liście planowanych funkcji' },
      ]
    },
    {
      version: '0.3.0',
      date: '2026-03-25',
      label: 'Feedback & Planowane',
      labelColor: '#facc15',
      changes: [
        { type: 'new', text: 'Nowy modal z dziennikiem zmian, planowanymi funkcjami i feedbackiem' },
        { type: 'new', text: 'Sekcja z planowanymi funkcjami i ich priorytetami' },
        { type: 'new', text: 'Formularz feedbacku — wiadomości trafiają bezpośrednio do zespołu' },
        { type: 'ui',  text: 'Przycisk szybkiego dostępu do dziennika zmian w panelu' },
      ]
    },
    {
      version: '0.2.0',
      date: '2026-03-25',
      label: 'Nowe funkcje',
      labelColor: '#6c6cff',
      changes: [
        { type: 'new', text: 'Match Preview — podgląd dopasowania pliku przed startem' },
        { type: 'new', text: 'Ręczne mapowanie kolumn pliku' },
        { type: 'new', text: 'Historia sesji — zakładka z poprzednimi sesjami' },
        { type: 'new', text: 'Walidacja pliku przed tagowaniem' },
        { type: 'new', text: 'Audit Mode — porównanie pliku z Brand24 bez tagowania' },
        { type: 'new', text: 'Opcjonalny dźwięk po zakończeniu sesji' },
        { type: 'new', text: 'Licznik wzmianek przy każdym tagu w mapowaniu' },
        { type: 'fix', text: 'Naprawiono matchowanie URL wzmianek' },
        { type: 'fix', text: 'Naprawiono auto-detekcję kolumn w pliku' },
        { type: 'perf', text: 'Znacznie przyspieszone pobieranie danych (10x równolegle)' },
        { type: 'ui', text: 'Timery w Quick Tag i Quick Delete' },
      ]
    },
    {
      version: '0.1.0',
      date: '2026-03-24',
      label: 'Wydanie pierwsze',
      labelColor: '#4ade80',
      changes: [
        { type: 'new', text: 'Tagowanie wzmianek na podstawie pliku CSV/JSON/XLSX' },
        { type: 'new', text: 'Quick Tag — tagowanie aktualnego widoku Brand24 bez pliku' },
        { type: 'new', text: 'Quick Delete — usuwanie wzmianek po tagu lub aktualnym widoku' },
        { type: 'new', text: 'Auto-Delete po zakończeniu tagowania' },
        { type: 'new', text: 'System partycji dla dużych plików (>1000 wzmianek)' },
        { type: 'new', text: 'Pamięć mapowań per projekt (schematy)' },
        { type: 'new', text: 'Crash log z czytelnymi komunikatami i opcją wznowienia' },
        { type: 'new', text: 'Debug bridge window.B24Tagger.debug.*' },
        { type: 'new', text: 'Obsługa app.brand24.com i panel.brand24.pl' },
        { type: 'new', text: 'Przeciągalny, zwijany panel z zapamiętywaniem pozycji' },
      ]
    },
  ];


  // ───────────────────────────────────────────
  // WHAT'S NEW - modal i przycisk
  // ───────────────────────────────────────────

  function showWhatsNew(forceShow) { showWhatsNewExtended(forceShow); }


  // ───────────────────────────────────────────
  // FEEDBACK & PLANNED FEATURES
  // ───────────────────────────────────────────

  // ───────────────────────────────────────────
  // KONFIGURACJA — uzupełnij przed użyciem
  // ───────────────────────────────────────────
  // Slack Webhook URL — jak go zdobyć: https://api.slack.com/apps → Incoming Webhooks
  const SLACK_WEBHOOK_URL = 'TWOJ_SLACK_WEBHOOK_URL';
  const RAW_URL = 'https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js';

  // Planned features list
  const PLANNED_FEATURES = [
    { priority: 'ai',     text: 'Dostęp do AI API — tłumaczenie wzmianek na bieżąco, automatyczna klasyfikacja, tryb tworzenia customowych klasyfikatorów (do automatycznej klasyfikacji) i inne...', next: false },
    { priority: 'high',   text: 'Podgląd wzmianki on-hover — najedź na URL w logu żeby zobaczyć treść i autora', next: false },
    { priority: 'medium', text: 'Bulk rename tagów — masowa zmiana nazwy tagu w projekcie', next: false },
    { priority: 'medium', text: 'System diagnostyczny: rozszerzenie DIAG_CHECKS o kolejne patterny — zbieranie przykładów i przypadków brzegowych', next: false },
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

  // Legacy wrapper
  function sendFeedbackToSlack(bugs, ideas, version, projectName) {
    if (bugs) sendBugReport(bugs, function() {});
    if (ideas) sendSuggestion(ideas, function() {});
  }

  // Feedback modal
  function showFeedbackModal() {
    let selectedRating = 0;

    const modal = document.createElement('div');
    modal.id = 'b24t-feedback-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;';

    modal.innerHTML =
      '<div style="background:#0f0f13;border:1px solid #2a2a35;border-radius:14px;width:440px;box-shadow:0 20px 60px rgba(0,0,0,0.8);">' +
        '<div style="padding:20px 20px 16px;border-bottom:1px solid var(--b24t-border-sub);">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<div style="width:32px;height:32px;background:#facc1522;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;">💬</div>' +
            '<div>' +
              '<div style="font-size:14px;font-weight:700;color:#e2e2e8;">Prześlij feedback</div>' +
              '<div style="font-size:10px;color:var(--b24t-text-faint);margin-top:2px;">Trafia bezpośrednio na kanał Slack zespołu</div>' +
            '</div>' +
            '<button id="b24t-fb-close" style="margin-left:auto;background:none;border:none;color:#444455;cursor:pointer;font-size:18px;line-height:1;padding:4px;">\u00d7</button>' +
          '</div>' +
        '</div>' +
        '<div style="padding:20px;">' +
          // Stars
          '<div style="margin-bottom:16px;">' +
            '<div style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:8px;">Ogólna ocena wtyczki:</div>' +
            '<div id="b24t-fb-stars" style="display:flex;gap:6px;">' +
              [1,2,3,4,5].map(function(i) {
                return '<span data-val="' + i + '" style="font-size:24px;cursor:pointer;color:#1e1e28;transition:color 0.1s;">★</span>';
              }).join('') +
            '</div>' +
          '</div>' +
          // Textarea
          '<div style="margin-bottom:16px;">' +
            '<div style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:6px;">Komentarz / sugestia / błąd (opcjonalnie):</div>' +
            '<textarea id="b24t-fb-text" placeholder="Co działa dobrze? Co można poprawić? Jakiś bug?" ' +
              'style="width:100%;height:90px;background:#141419;border:1px solid #2a2a35;border-radius:6px;color:#c0c0e0;' +
              'font-family:inherit;font-size:11px;padding:8px 10px;resize:none;box-sizing:border-box;outline:none;line-height:1.5;">' +
            '</textarea>' +
          '</div>' +
          // Status
          '<div id="b24t-fb-status" style="font-size:10px;color:var(--b24t-text-faint);min-height:14px;margin-bottom:12px;"></div>' +
          // Buttons
          '<div style="display:flex;gap:8px;">' +
            '<button id="b24t-fb-cancel" style="flex:1;background:#1a1a22;color:var(--b24t-text-meta);border:1px solid #2a2a35;border-radius:6px;padding:8px;font-size:12px;cursor:pointer;font-family:inherit;">Anuluj</button>' +
            '<button id="b24t-fb-send" style="flex:2;background:#6c6cff;color:#fff;border:none;border-radius:6px;padding:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Wyślij feedback</button>' +
          '</div>' +
          // Ukryty reset onboardingu — dyskretny, na samym dole
          '<div style="margin-top:20px;padding-top:14px;border-top:1px solid #1a1a28;text-align:center;">' +
            '<button id="b24t-fb-reset-onboarding" style="background:none;border:none;color:#333348;font-size:10px;cursor:pointer;font-family:inherit;letter-spacing:0.02em;transition:color 0.2s;padding:4px 8px;border-radius:4px;">' +
              '↺ Powtórz onboarding' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    // Stars interaction
    const starsEl = document.getElementById('b24t-fb-stars');
    const stars = starsEl.querySelectorAll('span');
    function updateStars(val) {
      stars.forEach(function(s, i) {
        s.style.color = i < val ? '#facc15' : '#1e1e28';
      });
    }
    stars.forEach(function(s) {
      s.addEventListener('mouseover', function() { updateStars(parseInt(s.dataset.val)); });
      s.addEventListener('mouseout',  function() { updateStars(selectedRating); });
      s.addEventListener('click',     function() {
        selectedRating = parseInt(s.dataset.val);
        updateStars(selectedRating);
      });
    });

    function closeModal() { modal.remove(); }

    document.getElementById('b24t-fb-close').addEventListener('click', closeModal);
    document.getElementById('b24t-fb-cancel').addEventListener('click', closeModal);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });

    // Reset onboarding — dyskretny przycisk na dole Feedback
    var resetObBtn = document.getElementById('b24t-fb-reset-onboarding');
    if (resetObBtn) {
      resetObBtn.addEventListener('mouseenter', function() { this.style.color = '#6c6cff'; });
      resetObBtn.addEventListener('mouseleave', function() { this.style.color = '#333348'; });
      resetObBtn.addEventListener('click', function() {
        closeModal();
        lsSet(LS.SETUP_DONE, false);
        setTimeout(function() {
          showOnboarding(function() {
            addLog('✓ Onboarding zakończony ponownie.', 'success');
          });
        }, 300);
      });
    }

    document.getElementById('b24t-fb-send').addEventListener('click', function() {
      const text = document.getElementById('b24t-fb-text').value.trim();
      const statusEl = document.getElementById('b24t-fb-status');
      if (!selectedRating) {
        statusEl.textContent = '⚠ Wybierz ocenę (kliknij gwiazdki)';
        statusEl.style.color = '#facc15';
        return;
      }
      statusEl.textContent = '→ Wysyłam...';
      statusEl.style.color = '#7878aa';
      document.getElementById('b24t-fb-send').disabled = true;
      sendFeedbackToSlack(text, selectedRating, VERSION, state.projectName || '—');
      setTimeout(function() { closeModal(); }, 1200);
    });
  }


  function showDevNotes() {
    // Kategorie: [PERF] [FIX] [UX] [UI] [RENAME] [DATA] [HOTFIX] [REFACTOR] [ARCH]
    const catColor = {
      'PERF':    '#facc15',
      'FIX':     '#4ade80',
      'HOTFIX':  '#f87171',
      'UX':      '#60a5fa',
      'UI':      '#a78bfa',
      'RENAME':  '#94a3b8',
      'DATA':    '#34d399',
      'REFACTOR':'#fb923c',
      'ARCH':    '#e879f9',
    };

    function renderNote(n) {
      // Wyciągnij prefix [KAT] jeśli istnieje
      const m = n.match(/^\[([A-Z]+)\]\s*/);
      if (m) {
        const cat = m[1];
        const color = catColor[cat] || '#9090cc';
        const rest = n.slice(m[0].length);
        return '<div style="display:flex;gap:8px;align-items:flex-start;padding:3px 0;">' +
          '<span style="flex-shrink:0;font-size:9px;font-weight:700;font-family:\'JetBrains Mono\',\'Fira Code\',monospace;color:' + color + ';background:' + color + '18;border:1px solid ' + color + '30;padding:1px 5px;border-radius:3px;margin-top:2px;white-space:nowrap;letter-spacing:0.04em;">' + cat + '</span>' +
          '<span style="font-size:11px;color:#c0c0d8;line-height:1.6;font-family:\'Inter\',\'Segoe UI\',system-ui,sans-serif;">' + rest + '</span>' +
        '</div>';
      }
      return '<div style="display:flex;gap:8px;align-items:flex-start;padding:2px 0;">' +
        '<span style="flex-shrink:0;color:#3a3a55;font-size:10px;margin-top:3px;">›</span>' +
        '<span style="font-size:11px;color:#8080aa;line-height:1.6;font-family:\'Inter\',\'Segoe UI\',system-ui,sans-serif;">' + n + '</span>' +
      '</div>';
    }

    let html = '<div style="font-size:10px;color:#4a4a66;margin-bottom:16px;font-family:\'Inter\',sans-serif;">Szczegółowe informacje techniczne o zmianach w kodzie. Dostępne od v0.3.4.</div>';

    DEV_CHANGELOG.forEach(function(v, idx) {
      html +=
        '<div style="margin-bottom:' + (idx < DEV_CHANGELOG.length - 1 ? '16' : '0') + 'px;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
            '<span style="font-size:12px;font-weight:700;color:#e2e2e8;font-family:\'Inter\',\'Segoe UI\',system-ui,sans-serif;">v' + v.version + '</span>' +
            '<span style="font-size:10px;color:#3a3a55;">' + v.date + '</span>' +
          '</div>' +
          v.notes.map(renderNote).join('') +
        '</div>' +
        (idx < DEV_CHANGELOG.length - 1 ? '<div style="height:1px;background:#1a1a22;margin:0 0 16px 0;"></div>' : '');
    });

    const modal = document.createElement('div');
    modal.id = 'b24t-devnotes-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483648;font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;';
    modal.innerHTML =
      '<div style="background:#0a0a0d;border:1px solid #2a2a35;border-radius:14px;width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.9);">' +
        '<div style="padding:16px 20px;border-bottom:1px solid #1e1e28;flex-shrink:0;display:flex;align-items:center;gap:10px;">' +
          '<span style="font-size:16px;">🔧</span>' +
          '<div>' +
            '<div style="font-size:13px;font-weight:700;color:#e2e2e8;">Dev Patch Notes</div>' +
            '<div style="font-size:10px;color:#3a3a55;margin-top:2px;">Szczegóły techniczne zmian w kodzie · B24 Tagger BETA</div>' +
          '</div>' +
          '<button id="b24t-devnotes-close" style="margin-left:auto;background:none;border:none;color:#444455;cursor:pointer;font-size:18px;line-height:1;">\u00d7</button>' +
        '</div>' +
        '<div style="overflow-y:auto;flex:1;padding:20px;">' + html + '</div>' +
        '<div style="padding:12px 20px;border-top:1px solid #1a1a22;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            Object.entries(catColor).map(function(e) {
              return '<span style="font-size:9px;font-family:\'JetBrains Mono\',\'Fira Code\',monospace;color:' + e[1] + ';background:' + e[1] + '18;border:1px solid ' + e[1] + '30;padding:1px 5px;border-radius:3px;">' + e[0] + '</span>';
            }).join('') +
          '</div>' +
          '<button id="b24t-devnotes-ok" style="background:#2a2a35;color:#8080aa;border:none;border-radius:6px;padding:7px 20px;font-size:12px;cursor:pointer;font-family:inherit;flex-shrink:0;">Zamknij</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    function close() { modal.remove(); }
    document.getElementById('b24t-devnotes-close').addEventListener('click', close);
    document.getElementById('b24t-devnotes-ok').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
  }

  // What's New modal - extended with tabs (Co nowego / Planowane / Feedback)
  function showWhatsNewExtended(forceShow) {
    const seenVersion = lsGet('b24tagger_seen_version', '');
    if (!forceShow && seenVersion === VERSION) return;

    const typeIcon = { new: '✦', fix: '⚒', perf: '⚡', ui: '◈' };
    const typeColor = { new: '#6c6cff', fix: '#4ade80', perf: '#facc15', ui: '#b0b0cc' };
    const prioLabel = { ai: '🟣', high: '🔴', medium: '🟡', low: '🟢' };

    // Build changelog HTML
    let changelogHtml = '';
    CHANGELOG.forEach(function(v, idx) {
      const isLatest = idx === 0;
      changelogHtml +=
        '<div style="margin-bottom:' + (idx < CHANGELOG.length - 1 ? '20' : '0') + 'px;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
            '<span style="font-size:15px;font-weight:700;color:#e2e2e8;font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;">v' + v.version + '</span>' +
            '<span style="font-size:12px;font-weight:600;background:' + v.labelColor + '22;color:' + v.labelColor + ';padding:2px 10px;border-radius:99px;">' + v.label + '</span>' +
            '<span style="font-size:11px;color:#3a3a55;margin-left:auto;">' + v.date + '</span>' +
          '</div>' +
          '<div style="' + (isLatest ? '' : 'opacity:0.6;') + '">' +
          v.changes.map(function(ch) {
            return '<div style="display:flex;gap:8px;align-items:flex-start;padding:3px 0;">' +
              '<span style="flex-shrink:0;font-size:15px;color:' + (typeColor[ch.type] || '#9090aa') + ';width:18px;text-align:center;line-height:1;">' + (typeIcon[ch.type] || '•') + '</span>' +
              '<span style="font-size:13px;color:#a0a0cc;line-height:1.6;">' + ch.text + '</span>' +
            '</div>';
          }).join('') +
          '</div>' +
        '</div>' +
        (idx < CHANGELOG.length - 1 ? '<div style="height:1px;background:#1e1e28;margin:0 0 20px 0;"></div>' : '');
    });

    // Build planned features HTML
    const prioMeta = {
      ai:     { color: '#a855f7', label: 'AI',     desc: 'AI / flagowa' },
      high:   { color: '#f87171', label: 'Wysoki', desc: 'priorytet wysoki' },
      medium: { color: '#facc15', label: 'Średni', desc: 'priorytet średni' },
      low:    { color: '#4ade80', label: 'Niski',  desc: 'priorytet niski' },
    };
    let plannedHtml =
      '<div style="font-size:12px;color:#4a4a66;margin-bottom:12px;line-height:1.6;">Lista funkcji planowanych w przyszłych wersjach. Masz pomysł? Skorzystaj z zakładki Feedback!</div>' +
      // Legenda priorytetów
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding:8px 10px;background:#0d0d16;border-radius:7px;border:1px solid #1e1e2e;">' +
        Object.entries(prioMeta).map(function(e) {
          return '<span style="display:flex;align-items:center;gap:4px;font-size:11px;color:#8080aa;">' +
            '<span style="width:8px;height:8px;border-radius:50%;background:' + e[1].color + ';flex-shrink:0;"></span>' +
            e[1].label +
          '</span>';
        }).join('') +
      '</div>';
    PLANNED_FEATURES.forEach(function(f) {
      const pm = prioMeta[f.priority] || { color: '#6060aa' };
      plannedHtml +=
        '<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid #1a1a22;">' +
          '<span style="flex-shrink:0;width:8px;height:8px;border-radius:50%;background:' + pm.color + ';margin-top:5px;"></span>' +
          '<span style="font-size:13px;color:#a0a0cc;line-height:1.6;flex:1;">' + f.text + '</span>' +
          (f.next ? '<span style="flex-shrink:0;font-size:11px;background:#6c6cff22;color:#6c6cff;padding:2px 8px;border-radius:99px;white-space:nowrap;">następna wersja</span>' : '') +
        '</div>';
    });

    const modal = document.createElement('div');
    modal.id = 'b24t-whats-new-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;';

    modal.innerHTML =
      // Outer container - wider, flex column
      '<div style="background:#0f0f13;border:1px solid #2a2a35;border-radius:14px;width:520px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.85);">' +

        // ── HEADER ────────────────────────────────────────────────────────
        '<div style="padding:16px 20px 0;flex-shrink:0;border-bottom:1px solid #1e1e28;">' +
          // Title row
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
            '<div style="width:36px;height:36px;background:#6c6cff22;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🚀</div>' +
            '<div style="flex:1;">' +
              '<div style="font-size:16px;font-weight:700;color:#e2e2e8;letter-spacing:-0.01em;">B24 Tagger <span style="font-size:11px;color:#6c6cff;letter-spacing:0.08em;font-weight:600;">BETA</span></div>' +
              '<div style="font-size:12px;color:#3a3a55;margin-top:3px;">v' + VERSION + ' · Dziennik zmian</div>' +
            '</div>' +
            '<button id="b24t-wnm-close" style="background:none;border:none;color:#444455;cursor:pointer;font-size:22px;line-height:1;padding:4px;border-radius:6px;transition:color 0.15s;">\u00d7</button>' +
          '</div>' +
          // Tabs row - 3 tabs, ikon + label
          '<div style="display:flex;gap:2px;">' +
            '<button class="b24t-wnm-tab" data-tab="news" ' +
              'style="flex:1;background:none;border:none;border-bottom:2px solid #6c6cff;color:#6c6cff;' +
              'font-size:11px;font-weight:600;padding:8px 4px;cursor:pointer;font-family:inherit;' +
              'display:flex;align-items:center;justify-content:center;gap:5px;">📰 Co nowego</button>' +
            '<button class="b24t-wnm-tab" data-tab="planned" ' +
              'style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#4a4a66;' +
              'font-size:11px;padding:8px 4px;cursor:pointer;font-family:inherit;' +
              'display:flex;align-items:center;justify-content:center;gap:5px;">🗓 Planowane</button>' +
            '<button class="b24t-wnm-tab" data-tab="feedback" ' +
              'style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#4a4a66;' +
              'font-size:11px;padding:8px 4px;cursor:pointer;font-family:inherit;' +
              'display:flex;align-items:center;justify-content:center;gap:5px;">💬 Feedback</button>' +
          '</div>' +
        '</div>' +

        // ── BODY (scrollable) ─────────────────────────────────────────────
        '<div style="overflow-y:auto;flex:1;min-height:0;" id="b24t-wnm-body">' +

          // Tab: Co nowego
          '<div id="b24t-wnm-news" style="padding:20px 24px;">' + changelogHtml + '</div>' +

          // Tab: Planowane
          '<div id="b24t-wnm-planned" style="display:none;padding:20px 24px;">' + plannedHtml + '</div>' +

          // Tab: Feedback - dwa tryby: Bug Report i Suggestions
          '<div id="b24t-wnm-feedback" style="display:none;padding:20px 24px;">' +

            // Przełącznik trybu
            '<div style="display:flex;gap:6px;margin-bottom:20px;">' +
              '<button id="b24t-fb-mode-bug" class="b24t-fb-mode-btn" data-mode="bug" ' +
                'style="flex:1;padding:9px;border:2px solid #f87171;border-radius:8px;background:#f8717118;' +
                'color:#f87171;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;">🐛 Bug Report</button>' +
              '<button id="b24t-fb-mode-suggest" class="b24t-fb-mode-btn" data-mode="suggest" ' +
                'style="flex:1;padding:9px;border:2px solid #2a2a35;border-radius:8px;background:none;' +
                'color:#4a4a66;font-family:inherit;font-size:12px;cursor:pointer;">💡 Suggestion</button>' +
            '</div>' +

            // Bug Report panel
            '<div id="b24t-fb-bug-panel">' +
              '<div style="font-size:11px;color:#666699;margin-bottom:12px;padding:8px 10px;background:#141419;border-radius:6px;border-left:3px solid #f87171;line-height:1.6;">' +
                '📊 Do raportu zostanie automatycznie dołączone: wersja, projekt, status sesji, ostatnie 30 wpisów logu oraz crash log (jeśli istnieje).' +
              '</div>' +
              '<div style="font-size:12px;color:#f87171;margin-bottom:6px;font-weight:600;">Opisz problem:</div>' +
              '<textarea id="b24t-wnm-fb-bugs" placeholder="Co się stało? Kiedy wystąpił błąd? Jakie kroki doprowadziły do problemu?" ' +
                'style="width:100%;height:100px;background:#141419;border:1px solid #2a2a35;border-radius:6px;color:#c0c0e0;' +
                'font-family:inherit;font-size:12px;padding:10px;resize:none;box-sizing:border-box;outline:none;line-height:1.5;">' +
              '</textarea>' +
            '</div>' +

            // Suggestion panel (hidden by default)
            '<div id="b24t-fb-suggest-panel" style="display:none;">' +
              '<div style="font-size:11px;color:#666699;margin-bottom:12px;padding:8px 10px;background:#141419;border-radius:6px;border-left:3px solid #6c6cff;line-height:1.6;">' +
                '💡 Masz pomysł na nową funkcję lub ulepszenie? Opisz go tutaj — każdy głos się liczy!' +
              '</div>' +
              '<div style="font-size:12px;color:#6c6cff;margin-bottom:6px;font-weight:600;">Twój pomysł:</div>' +
              '<textarea id="b24t-wnm-fb-ideas" placeholder="Jaka funkcja by Ci się przydała? Jak powinno to działać?" ' +
                'style="width:100%;height:100px;background:#141419;border:1px solid #2a2a35;border-radius:6px;color:#c0c0e0;' +
                'font-family:inherit;font-size:12px;padding:10px;resize:none;box-sizing:border-box;outline:none;line-height:1.5;">' +
              '</textarea>' +
            '</div>' +

            '<div id="b24t-wnm-fb-status" style="font-size:12px;min-height:16px;margin:10px 0;"></div>' +
            '<button id="b24t-wnm-fb-send" ' +
              'style="width:100%;background:#f87171;color:#fff;border:none;border-radius:8px;padding:10px;' +
              'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:0.02em;">Wyślij Bug Report →</button>' +
            '<div style="margin-top:22px;padding-top:14px;border-top:1px solid #1c1c2a;text-align:center;">' +
              '<button id="b24t-wnm-reset-onboarding" style="background:none;border:none;color:#2a2a42;font-size:10px;cursor:pointer;font-family:inherit;letter-spacing:0.03em;padding:4px 10px;border-radius:4px;transition:color 0.2s;">↺ Powtórz onboarding</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // ── FOOTER ────────────────────────────────────────────────────────
        '<div style="padding:10px 20px;border-top:1px solid #1a1a22;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
          // Lewa strona: legenda + devnotes
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
            '<div id="b24t-wnm-legend" style="display:flex;gap:8px;font-size:11px;color:#3a3a55;">' +
              '<span title="Nowa funkcja"><span style="color:#6c6cff;">✦</span> nowe</span>' +
              '<span title="Naprawa błędu"><span style="color:#4ade80;">⚒</span> fix</span>' +
              '<span title="Wydajność"><span style="color:#facc15;">⚡</span> perf</span>' +
              '<span title="Interfejs"><span style="color:#8080aa;">◈</span> UI</span>' +
            '</div>' +
            '<button id="b24t-wnm-devnotes-btn" ' +
              'style="font-size:11px;color:#3a3a55;background:none;border:1px solid #2a2a35;border-radius:4px;' +
              'padding:4px 9px;cursor:pointer;font-family:inherit;white-space:nowrap;' +
              'transition:color 0.15s,border-color 0.15s;">🔧 Dev patch notes</button>' +
          '</div>' +
          // Prawa strona: Gotowe
          '<button id="b24t-wnm-ok" ' +
            'style="background:#6c6cff;color:#fff;border:none;border-radius:7px;padding:8px 24px;' +
            'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">Gotowe</button>' +
        '</div>' +

      '</div>';

    document.body.appendChild(modal);

    // Tab switching
    modal.querySelectorAll('.b24t-wnm-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        modal.querySelectorAll('.b24t-wnm-tab').forEach(function(b) {
          b.style.borderBottomColor = 'transparent';
          b.style.color = '#555588';
          b.style.fontWeight = 'normal';
          b.style.fontSize = '13px';
        });
        btn.style.borderBottomColor = '#6c6cff';
        btn.style.color = '#6c6cff';
        btn.style.fontWeight = '600';
        btn.style.fontSize = '13px';
        ['news','planned','feedback'].forEach(function(t) {
          document.getElementById('b24t-wnm-' + t).style.display = btn.dataset.tab === t ? 'block' : 'none';
        });
        // Toggle legend visibility
        const legend = document.getElementById('b24t-wnm-legend');
        if (legend) legend.style.display = btn.dataset.tab === 'news' ? 'flex' : 'none';
      });
    });

    // Feedback mode switcher
    var fbMode = 'bug';
    modal.querySelectorAll('.b24t-fb-mode-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        fbMode = btn.dataset.mode;
        modal.querySelectorAll('.b24t-fb-mode-btn').forEach(function(b) {
          const isBug = b.dataset.mode === 'bug';
          const isActive = b.dataset.mode === fbMode;
          b.style.borderColor = isActive ? (isBug ? '#f87171' : '#6c6cff') : '#2a2a35';
          b.style.background = isActive ? (isBug ? '#f8717118' : '#6c6cff18') : 'none';
          b.style.color = isActive ? (isBug ? '#f87171' : '#6c6cff') : '#555588';
          b.style.fontWeight = isActive ? '600' : 'normal';
        });
        const bugPanel = document.getElementById('b24t-fb-bug-panel');
        const sugPanel = document.getElementById('b24t-fb-suggest-panel');
        const sendBtn = document.getElementById('b24t-wnm-fb-send');
        if (bugPanel) bugPanel.style.display = fbMode === 'bug' ? 'block' : 'none';
        if (sugPanel) sugPanel.style.display = fbMode === 'suggest' ? 'block' : 'none';
        if (sendBtn) {
          sendBtn.textContent = fbMode === 'bug' ? 'Wyślij Bug Report →' : 'Wyślij Suggestion →';
          sendBtn.style.background = fbMode === 'bug' ? '#f87171' : '#6c6cff';
        }
      });
    });

    // Send button
    document.getElementById('b24t-wnm-fb-send')?.addEventListener('click', function() {
      const statusEl = document.getElementById('b24t-wnm-fb-status');
      const sendBtn = document.getElementById('b24t-wnm-fb-send');
      if (fbMode === 'bug') {
        const bugs = document.getElementById('b24t-wnm-fb-bugs')?.value.trim() || '';
        if (!bugs) {
          if (statusEl) { statusEl.textContent = '⚠ Opisz problem przed wysłaniem'; statusEl.style.color = '#facc15'; }
          return;
        }
        if (statusEl) { statusEl.textContent = '→ Wysyłam bug report z logami...'; statusEl.style.color = '#7878aa'; }
        if (sendBtn) sendBtn.disabled = true;
        sendBugReport(bugs, function() {
          addLog('✓ Bug Report wysłany — dziękujemy!', 'success');
          if (statusEl) { statusEl.textContent = '✓ Wysłano z pełnymi logami. Dziękujemy!'; statusEl.style.color = '#4ade80'; }
          setTimeout(function() { closeWnm(); }, 1800);
        });
      } else {
        const ideas = document.getElementById('b24t-wnm-fb-ideas')?.value.trim() || '';
        if (!ideas) {
          if (statusEl) { statusEl.textContent = '⚠ Wpisz swój pomysł'; statusEl.style.color = '#facc15'; }
          return;
        }
        if (statusEl) { statusEl.textContent = '→ Wysyłam...'; statusEl.style.color = '#7878aa'; }
        if (sendBtn) sendBtn.disabled = true;
        sendSuggestion(ideas, function() {
          addLog('✓ Suggestion wysłany — dziękujemy!', 'success');
          if (statusEl) { statusEl.textContent = '✓ Wysłano! Dziękujemy za pomysł.'; statusEl.style.color = '#4ade80'; }
          setTimeout(function() { closeWnm(); }, 1500);
        });
      }
    });

    // Dev patch notes button
    document.getElementById('b24t-wnm-devnotes-btn')?.addEventListener('click', function() {
      showDevNotes();
    });

    function closeWnm() {
      lsSet('b24tagger_seen_version', VERSION);
      modal.remove();
    }
    document.getElementById('b24t-wnm-close').addEventListener('click', closeWnm);
    document.getElementById('b24t-wnm-ok').addEventListener('click', closeWnm);

    // Reset onboarding - dyskretny przycisk na dole zakładki Feedback
    var wnmResetOb = document.getElementById('b24t-wnm-reset-onboarding');
    if (wnmResetOb) {
      wnmResetOb.addEventListener('mouseenter', function() { this.style.color = '#6c6cff'; });
      wnmResetOb.addEventListener('mouseleave', function() { this.style.color = '#2a2a42'; });
      wnmResetOb.addEventListener('click', function() {
        closeWnm();
        lsSet(LS.SETUP_DONE, false);
        setTimeout(function() {
          showOnboarding(function() { addLog('✓ Onboarding zakończony ponownie.', 'success'); });
        }, 300);
      });
    }
    modal.addEventListener('click', function(e) { if (e.target === modal) closeWnm(); });
  }


  // ───────────────────────────────────────────
  // DEV_CHANGELOG - szczegółowe patch notes dla programistów (od v0.3.4)
  // ───────────────────────────────────────────

  const DEV_CHANGELOG = [
    {
      version: '0.11.0',
      date: '2026-03-28',
      notes: [
        '[NEW]  addLog(): obsługa typu "diag" — prefiks [DIAG] renderowany w #f87171, reszta kolorem error; typ dodany do CSS (.b24t-log-diag)',
        '[NEW]  addLog(): wywołuje _syncLogPanel(entry) przy każdym wpisie — live-update pełnoekranowego panelu loga gdy jest otwarty',
        '[NEW]  buildLogPanel() / openLogPanel() — floating panel #b24t-log-panel (720×520px, fixed centered, resizable); wypełniony z state.logs',
        '[NEW]  buildLogPanel(): filtry per-typ (info/success/warn/error/diag), przycisk "Kopiuj do schowka", przycisk "Eksportuj CSV" (→ exportReport())',
        '[NEW]  buildLogPanel(): drag przez header, zamykanie przez × lub Escape',
        '[NEW]  _syncLogPanel(entry): appends entry do #b24t-logp-body + scroll + _applyLogPanelFilter()',
        '[NEW]  _appendLogPanelEntry() / _applyLogPanelFilter() / _logpFilterChk() — helpery panelu loga',
        '[NEW]  Przycisk ⛶ (#b24t-log-expand) w sekcji Log → openLogPanel(); CSS .b24t-log-expand',
        '[NEW]  DIAG_CHECKS: tablica 6 checków diagnostycznych: project_names, dates_range, token, known_projects, group_projects, cache_group_mismatch',
        '[NEW]  runDiagChecks(checkIds?) — iteruje DIAG_CHECKS, wywołuje check(), łapie błędy; checkIds=null → wszystkie',
        '[NEW]  startBgPrefetch(): runDiagChecks() po pierwszym prefetch (setTimeout 500ms); log [DIAG] gdy token niedostępny po 15s',
        '[LOG]  loadAnnotatorProject(): logi start/sukces (ALL/REQ/DEL/pct)/błąd',
        '[LOG]  loadAnnotatorTagStats(): log cache hit z wiekiem, log start z liczbą projektów, log sukcesu',
        '[LOG]  _bgFetchTagstats(): log start prefetch',
        '[LOG]  _bgFetchAllProjects(): log start prefetch + sukces z liczbą projektów; [DIAG] przy błędzie getMentions',
        '[LOG]  _fetchOverallStats(): log start + per-projekt ALL/REQ/DEL; [DIAG] przy nieznanym projekcie lub błędzie API',
        '[LOG]  loadOverallStats(): log cache hit z wiekiem',
        '[LOG]  getAnnotatorDates(): log zakresu dat (📅)',
        '[LOG]  groupSel change (cross-delete): log wybranego zakresu',
        '[LOG]  overall-group-sel change: log wybranej grupy',
        '[ARCH] DIAG_CHECKS rozszerzalne — dodanie nowego checku = push do tablicy, brak zmian w reszcie kodu',
      ]
    },
    {
      version: '0.10.3',
      date: '2026-03-28',
      notes: [
        '[NEW]  LS.PROJECT_NAMES = b24tagger_project_names — trwały słownik {projectId: name} niezależny od LS.PROJECTS',
        '[NEW]  _pnGet(projectId) — odczyt nazwy z PROJECT_NAMES',
        '[NEW]  _pnSet(projectId, name) — zapis nazwy do PROJECT_NAMES; ignoruje fallbacki (Brand24, Project N, Projekt N, <3 znaki)',
        '[NEW]  _pnResolve(projectId) — priorytet: PROJECT_NAMES > state.projectName (gdy bieżący) > LS.PROJECTS.name > Projekt N',
        '[FIX]  detectProject(): updateName() wywołuje _pnSet(projectId, t) po poprawnej detekcji tytułu (retry też)',
        '[FIX]  detectProject(): _pnSet(projectId, state.projectName) po getTags() — drugi punkt zapisu',
        '[ARCH] init(): bootstrap — skanuje LS.PROJECTS i wywołuje _pnSet dla każdego projektu z dobrą nazwą',
        '[REFACTOR] getKnownProjects(): name = _pnResolve(parseInt(id)) — cały ręczny fallback usunięty',
        '[REFACTOR] getKnownProjectsList(): name = _pnResolve(pid)',
        '[REFACTOR] _fetchOverallStats(): name = _pnResolve(pid)',
        '[DESIGN] _pnSet jest idempotentna — wielokrotne wywołania z tą samą nazwą nie powodują zbędnych zapisów (early return gdy wartość niezmieniona)',
      ]
    },
    {
      version: '0.10.2',
      date: '2026-03-28',
      notes: [
        '[FIX]  _localDateStr(d): nowy helper — formatuje lokalną datę jako YYYY-MM-DD bez UTC shift (d.getFullYear/Month/Date zamiast toISOString)',
        '[FIX]  getAnnotatorDates(): używa _localDateStr() zamiast toISOString().split(T)[0] — eliminuje błąd -1 dnia w strefach UTC+',
        '[FIX]  _bgFetchAllProjects(): dateFrom/dateTo przez getAnnotatorDates() zamiast hardcoded rok-temu; p._dateFrom/p._dateTo = realny zakres zapytania',
        '[FIX]  loadAnnotatorTagStats(): inline date logic zastąpiona wywołaniem getAnnotatorDates()',
        '[FIX]  getKnownProjects(): poprawiona ekstrakcja name — fallback do state.projectName gdy id pasuje, potem Projekt N',
        '[FIX]  getKnownProjectsList(): analogiczny fix ekstrakcji name',
      ]
    },
    {
      version: '0.10.1',
      date: '2026-03-28',
      notes: [
        '[FIX]  _fetchOverallStats: usunięto _getDefaultDateFrom/To() — używa getAnnotatorDates() (current month, wyjątek 1-2 dnia miesiąca)',
        '[FIX]  _fetchOverallStats: dodano query getMentions(pid, dateFrom, dateTo, [], 1) jako counts[0] → total all mentions',
        '[FIX]  _bgFetchOverallStats: cache teraz przechowuje dateFrom, dateTo, label obok results',
        '[FIX]  renderOverallStatsData: sygnatura zmieniona na (el, results, group, cached); 4. argument cached zawiera dateFrom/dateTo/label',
        '[FIX]  renderOverallStatsData: kafelek "Wszystkie" (totalAll) zawsze pierwsza karta; grid 3 lub 4 kolumny',
        '[FIX]  renderOverallStatsData: periodHtml — wiersz z ikoną 📅 i zakresem dat nad kartami',
        '[FIX]  renderOverallStatsData: tabela dodaje kolumnę ALL przed REL',
        '[FIX]  getKnownProjectsList: dodano filter(p.id > 0) i poprawioną ekstrakcję name z obiektu LS.PROJECTS',
        '[FIX]  Wszystkie wywołania renderOverallStatsData zaktualizowane o 4. argument (cached lub fresh)',
      ]
    },
    {
      version: '0.10.0',
      date: '2026-03-28',
      notes: [
        '[NEW]  LS.GROUPS = b24tagger_groups: [{id, name, projectIds, relevantTagId}] — grupy projektów per user',
        '[NEW]  LS.STATS_CFG = b24tagger_stats_config: {selectedGroupId} — zapamiętana wybrana grupa w Overall Stats',
        '[NEW]  bgCache.overallStats = {groupId, results, ts} — cache danych Overall Stats (TTL 5min, analogiczny do bgCache.tagstats)',
        '[NEW]  getGroups() / saveGroups() / generateGroupId() — CRUD helpers dla grup',
        '[NEW]  getKnownProjectsList() — lista {id,name} ze wszystkich LS.PROJECTS (bez filtrowania reqVer/toDel)',
        '[NEW]  renderGroupsTab() / wireGroupsTab() — render zakładki Grupy; lista grup z kartami, przycisk + Nowa',
        '[NEW]  showGroupEditor(existingGroup, knownProjects) — modal edytora grupy; checkboxy projektów z live styling',
        '[NEW]  renderOverallStatsTab() — render zakładki Overall Stats; selektor grupy + selektor wariant bez grupy',
        '[NEW]  loadOverallStats() — cache-first load: render z bgCache jeśli gorący + cichy refetch; spinner gdy zimny',
        '[NEW]  _bgFetchOverallStats(group) — cichy fetch overall stats, wypełnia bgCache.overallStats',
        '[NEW]  _fetchOverallStats(group) — 3x getMentions per projekt (relevant/reqVer/toDel), Promise.all, iteracja serial po projektach',
        '[NEW]  renderOverallStatsData(el, results, group) — karty sumaryczne (1-3 kolumny) + tabela per-projekt',
        '[NEW]  _statsCard(label, value, color, bgColor) — helper karty sumarycznej',
        '[NEW]  showOverallStatsSettings(group) — modal ustawień Overall Stats; selektor tagu relevantne per-grupa',
        '[NEW]  setGroupRelevantTagId(groupId, tagId) — zapisuje relevantTagId w grupie w LS.GROUPS',
        '[NEW]  Annotators Tab HTML: dodano zakładki "Grupy" (data-ann-tab=groups) i "Overall" (data-ann-tab=overall)',
        '[NEW]  openAnnotatorPanel(): wywołuje renderGroupsTab() + renderOverallStatsTab() przy każdym otwarciu',
        '[NEW]  Tab click handler: obsługa tabName===groups → renderGroupsTab(); tabName===overall → renderOverallStatsTab()',
        '[NEW]  buildAllProjectsPanel(): group filter dropdown #b24t-ap-group-sel — widoczny tylko gdy grupy istnieją',
        '[ARCH] getKnownProjects(): dodano filtrowanie do wybranej grupy gdy #b24t-ap-group-sel ma wartość',
        '[DATA] _fetchOverallStats: reqVerId/toDelId odczytywane z LS.PROJECTS[pid].tagIds, fallback do stałych 1154586/1154757',
        '[SCOPE] Wszystkie nowe funkcje wewnątrz IIFE (2 spacje wcięcia) — bez scope bug',
      ]
    },
    {
      version: '0.9.14',
      date: '2026-03-28',
      notes: [
        '[FIX]  openAnnotatorPanel(): nie korzystał z bgCache.tagstats — sprawdzał tylko annotatorData.tagstats (null po zamknięciu panelu) i odpalał pełne ładowanie ze spinnerem. Teraz: jeśli bgCache gorący → renderAnnotatorTagStats() od razu + cichy refetch w tle.',
        '[FIX]  Tab click (data-ann-tab="tagstats"): identyczny bug — sprawdzał annotatorData.tagstats zamiast bgCache. Naprawione analogicznie: _bgCacheFresh(bgCache.tagstats) → render natychmiastowy, fallback do loadAnnotatorTagStats() tylko gdy cache zimny.',
        '[ROOT CAUSE] bgCache.tagstats był wypełniany przez startBgPrefetch() poprawnie, ale openAnnotatorPanel() i tab click omijały go — renderały puste dane i wymagały ręcznego ↺. Teraz wszystkie ścieżki wejścia do zakładki Tagi sprawdzają bgCache jako pierwsze.',
      ],
    },
    {
      version: '0.9.13',
      date: '2026-03-28',
      notes: [
        '[PERF] Background prefetch cache (bgCache): nowa warstwa cache niezależna od DOM. bgCache.tagstats = {results, dates, ts}, bgCache.allProjects[tagId] = {results, ts}. TTL: 5 minut (BG_CACHE_TTL = 5*60*1000). _bgCacheFresh(entry) sprawdza czy ts < TTL.',
        '[PERF] _bgFetchTagstats(): cicha wersja loadAnnotatorTagStats — wypełnia bgCache.tagstats bez dotykania DOM. Identyczna logika fetch (2× getMentions per projekt). Efekt uboczny: jeśli annotatorData.tagstats=null → wypełnia też go.',
        '[PERF] _bgFetchAllProjects(tagId): cicha wersja fetch dla cross-delete panel — wypełnia bgCache.allProjects[tagId]. Deleguje do _renderAllProjectsList po zakończeniu.',
        '[ARCH] startBgPrefetch(): master scheduler zastępujący loadAnnotatorDataBackground. Odpala się raz gdy annotator_tools włączony. Czeka na token (max 15s), fetches tagstats + aktualny tagId, potem setInterval co BG_CACHE_TTL.',
        '[ARCH] loadAnnotatorDataBackground(): uproszczona — deleguje do startBgPrefetch() zamiast samodzielnie czekać na token. Tylko loadAnnotatorProject() zostaje sekwencyjny (lekki).',
        '[UX]  loadAnnotatorTagStats(): jeśli bgCache.tagstats gorący → renderAnnotatorTagStats() od razu (0ms spinner), potem cichy refetch w tle który nadpisuje DOM po zakończeniu. Spinner tylko gdy cache zimny.',
        '[ARCH] _renderAllProjectsList(results, tagName): wyodrębniony render cross-delete panelu. Używany przez refreshAllProjectsPanel z danych cache lub świeżych — eliminuje duplikację kodu.',
        '[UX]  refreshAllProjectsPanel(): jeśli bgCache.allProjects[tagId] gorący → _renderAllProjectsList() od razu, potem cichy refetch. Spinner tylko gdy cache zimny (pierwsze otwarcie lub po TTL).',
        '[UX]  wireDeleteEvents b24t-del-tag change: prefetch _bgFetchAllProjects(tagId) w tle przy zmianie tagu — niezależnie czy scope=allprojects. Gdy użytkownik wybierze "Wszystkie projekty" dane są już gotowe.',
        '[DATA] Cache invalidacja po operacjach: delete-all w buildAllProjectsPanel → bgCache.allProjects={}, bgCache.tagstats=null, annotatorData.tagstats=null przed refreshAllProjectsPanel(). Przycisk ↺ tagstats → bgCache.tagstats=null (force re-fetch).',
        '[ARCH] applyFeatures(): setTimeout(loadAnnotatorDataBackground, 1500) zastąpiony startBgPrefetch() — brak sztucznego opóźnienia, scheduler sam zarządza czekaniem na token.',
      ],
    },
    {
      version: '0.9.12',
      date: '2026-03-28',
      notes: [
        '[UI]    styleTab() w buildAnnotatorPanel(): light mode background #ffffff→#f0f7ff, border #c8cde0→#93c5fd, color #2563eb→#1d6fe8 (spójne z nowym gradientem). Trigger bardziej widoczny gdy panel schowany.',
        '[ARCH]  getHelpZones() przepisana na getHelpZones(activeTab, includeAnnotators). Podział: common (zawsze), byTab[main/quicktag/delete/history] (per zakładka), annotators (jeśli otwarty). Łącznie ~35 stref.',
        '[UX]    enterHelpMode(): wykrywa aktywną zakładkę przez .b24t-tab.b24t-tab-active[data-tab]. Jeśli features.annotator_tools && annPanel.display=none → openAnnotatorPanel(), zapisuje helpAnnotatorOpened=1 w dataset.',
        '[UX]    enterHelpMode(): obniża z-index obu paneli (main=500, ann=501). Tworzy dwa overlaye: #b24t-help-panel-overlay i #b24t-help-ann-overlay. Strefy dla Annotators Tab dostają z-index 2147483520 identycznie jak reszta.',
        '[UX]    exitHelpMode(): przywraca z-index obu paneli z dataset.prevZIndex. Jeśli helpAnnotatorOpened=1 → ukrywa annPanel + pokazuje trigger. Usuwa oba overlaye.',
      ]
    },
    {
      version: '0.9.11',
      date: '2026-03-28',
      notes: [
        '[UI]    Light mode --b24t-accent-grad: #2563eb→#1d4ed8→#1e40af → #1d6fe8→#0ea875→#16a34a (Brand24 blue→green). Kolory dopasowane do screenshota z UI Brand24.',
        '[UI]    Light mode --b24t-panel-grad: biały→niebieskawa → f0f7ff→f0fdf6→ecfdf5 (bardzo subtelny zielonkawy odcień). Cienie zaktualizowane do mieszanki blue+green.',
        '[UI]    Help mode overlay: usunięty backdrop-filter:blur — zastąpiony rgba(0,0,0,0.30) bez blur. Panel był nieczytelny przez zbyt mocny blur.',
        '[UI]    Help mode .b24t-help-zone: zmienione z przezroczystych na widoczne od razu (border 2px solid rgba(108,108,255,0.55), bg rgba(6%)). Animacja b24t-help-pulse — pulsujący border co 2s.',
        '[UI]    Help mode .b24t-help-zone:hover: wyłącza animację pulse, intensywniejsze podświetlenie.',
        '[FIX]   enterHelpMode(): usunięto zone.title — przeglądarka renderowała natywny tooltip (prostokąt z białą ramką) który nakrywał bąbel z tym samym tekstem.',
        '[FIX]   getHelpZones() przeniesione DO wnętrza IIFE (ten sam scope bug co toggleHelpMode w v0.9.9).',
        '[NEW]   getHelpZones(): dodano strefy .b24t-stats-grid, #b24t-progress-bar, #b24t-log, #b24t-btn-help. Łącznie 16 stref (było 12).',
      ]
    },
    {
      version: '0.9.10',
      date: '2026-03-28',
      notes: [
        '[HOTFIX] #b24t-panel ma z-index:2147483647 (CSS max). Overlay (2147483490), strefy (2147483495) i close (2147483498) — wszystkie niżej → renderowały się POD panelem.',
        '[FIX]    enterHelpMode(): panel.style.zIndex obniżony do 2147483500 na czas help mode (zapisany w panel.dataset.prevZIndex). Hierarchia: panel=2147483500 < overlay=2147483510 < strefy=2147483520 < close=2147483530 < tooltip=2147483540.',
        '[FIX]    exitHelpMode(): panel.style.zIndex przywracany z dataset.prevZIndex (lub 2147483647 domyślnie).',
        '[FIX]    CSS z-indexy w injectStyles() zaktualizowane do nowej hierarchii (były: overlay=490, strefy=495, close=498, tip=647).',
      ]
    },
    {
      version: '0.9.9',
      date: '2026-03-28',
      notes: [
        '[HOTFIX] toggleHelpMode(), enterHelpMode(), exitHelpMode(), showHelpTip(), hideHelpTip() oraz zmienne helpModeActive/helpZoneElements/helpTipElement/helpStickyTip były zadeklarowane POZA IIFE (bez wcięcia, na poziomie modułu). Tampermonkey z grantem GM_xmlhttpRequest opakowuje kod w sandbox — let/function poza IIFE nie są widoczne wewnątrz niej jako globalne. Efekt: addEventListener(\'click\', toggleHelpMode) rejestrował undefined → cichy błąd → przycisk ? nigdy nie reagował.',
        '[HOTFIX] Naprawka: przeniesiono cały blok (zmienne + 5 funkcji) DO wnętrza IIFE z prawidłowym wcięciem 2 spacji. Zakres rozwiązany.',
        '[HOTFIX] CSS help mode (.b24t-help-zone, #b24t-help-panel-overlay, .b24t-help-tip, #b24t-help-close) był wyłącznie w injectOnboardingStyles() — wywoływanej tylko przez showOnboarding(). Jeśli użytkownik nie przeszedł onboardingu w sesji, tryb pomocy działał bez styli. Przeniesiono CSS do injectStyles() — zawsze dostępne od init().',
      ]
    },
    {
      version: '0.9.8',
      date: '2026-03-28',
      notes: [
        '[UI]    buildAnnotatorPanel(): zakładki .b24t-ann-tab zmienione z inline-styled border-bottom na klasy .b24t-tab + .b24t-tab-active — CSS liquid glass z głównego panelu działa automatycznie.',
        '[UI]    buildAnnotatorPanel(): container zakładek zmieniony z border-bottom:2px na gap:5px + padding jak #b24t-tabs w głównym panelu.',
        '[UX]    buildAnnotatorPanel() tab switching: stary kod manipulował borderBottomColor/color/fontWeight inline. Nowy: classList.remove/add("b24t-tab-active") — spójne z głównym panelem.',
        '[UX]    loadAnnotatorTagStats(): skeleton per projekt zastąpiony spinnerem (b24t-spin animation) + licznik "X / N". Projekty z count=0 nie trafiają do results w ogóle. Render finalny po zakończeniu wszystkich requestów.',
        '[UX]    refreshAllProjectsPanel(): skeleton per projekt zastąpiony spinnerem + licznik. Tylko projekty z count > 0 trafiają do results — eliminuje iterację po wynikach z filtrowaniem.',
        '[FIX]   _positionXProjectPanel(): usunięto hardkodowane height:(window.innerHeight - r.top - 8)px które rozciągało panel do dołu ekranu. Teraz height:auto, maxHeight:(window.innerHeight - r.top - 16)px.',
      ]
    },
    {
      version: '0.9.7',
      date: '2026-03-28',
      notes: [
        '[HOTFIX] const VERSION zsynchronizowana z @version nagłówka: była \'0.9.4\', powinna być \'0.9.6\' (a teraz \'0.9.7\'). Root cause: przy deplojach 0.9.5 i 0.9.6 aktualizowany był tylko @version w userscript header, ale nie stała VERSION w ciele IIFE. Panel używa VERSION do wyświetlania numeru wersji, checkForUpdate() do compareVersions() — stąd fałszywy alert o dostępnej aktualizacji.',
        '[PROCESS] Zasada: każdy bump @version = zmiana const VERSION na tę samą wartość. Obie muszą być zawsze zsynchronizowane.',
      ]
    },
    {
      version: '0.9.6',
      date: '2026-03-28',
      notes: [
        '[UI]     showWhatsNewExtended(): header icon ✦ → 🚀 (div z emoji, nie SVG).',
        '[FIX]    showWhatsNewExtended(): wszystkie var(--b24t-*) zastąpione hardkodowanymi hex — modal renderuje się w body bez dostępu do CSS vars głównego panelu, co powodowało transparent/inherit w light mode.',
        '[UI]     showWhatsNewExtended(): prioLabel (emoji flagi) → prioMeta ({ color, label }). Planowane: kolorowe kółka (8px circle) zamiast emoji. Legenda priorytetów jako pasek nad listą (background:#0d0d16).',
        '[UI]     showDevNotes(): przepisany render — funkcja renderNote() parsuje prefix [KAT] i renderuje kolorowy badge monospace. Kategorie: PERF/FIX/HOTFIX/UX/UI/RENAME/DATA/REFACTOR/ARCH z osobnymi kolorami.',
        '[UI]     showDevNotes(): legenda kategorii w stopce modalu (Object.entries(catColor) → badge\'y). Modal poszerzony do 560px.',
        '[DATA]   DEV_CHANGELOG v0.9.5 notes przepisane na format [KAT] prefix — czytelne dla programistów.',
        '[DATA]   PLANNED_FEATURES: usunięto "Wieloprojektowość" (low), "Szybkie filtry w Quick Tag" (high). Zmieniono "Bulk rename / merge tagów" → "Bulk rename tagów". Pozostało 5 wpisów.',
      ]
    },
    {
      version: '0.9.5',
      date: '2026-03-28',
      notes: [
        '[PERF] loadAnnotatorTagStats(): fetchProjectTagCounts() zastąpiony 2× getMentions(tagId, page=1) per projekt — pobierał wcześniej count z nagłówka zamiast iterować strony. Wzorzec identyczny jak refreshAllProjectsPanel().',
        '[PERF] loadAnnotatorTagStats(): redukcja requestów z ~100+ per projekt do 2 per projekt (1× reqVerId, 1× toDeleteId). Przy 8 projektach: ~800 requestów → 16.',
        '[UX]  loadAnnotatorTagStats(): skeleton loader per projekt (div[data-pid]). Każdy wiersz przechodzi live: "ładuję…" → "↻" → wartości REQ/DEL. Projekty z REQ=0 i DEL=0 chowane natychmiast (display:none).',
        '[UX]  loadAnnotatorTagStats(): licznik postępu "X / N" w #b24t-ann-skel-summary aktualizowany po każdej iteracji. Render finalny nadpisuje skeleton — tylko projekty z count > 0, posortowane malejąco.',
        '[UX]  refreshAllProjectsPanel(): render finalny filtruje wyłącznie count > 0 (withData) + błędy (withErrors). Wiersze "brak wzmianek z tym tagiem" całkowicie usunięte z DOM.',
        '[RENAME] "Narzędzia Annotatora" → "Annotators Tab": OPTIONAL_FEATURES[annotator_tools].label, header panelu (#b24t-ann-header span), komentarz w applyFeatures(), opis w onboardingu (krok z ? button).',
        '[DATA] PLANNED_FEATURES: +2 wpisy: "Annotators Tab — Overall Stats" (medium, next:true), "Grupowanie projektów" (medium, next:false).',
        '[DATA] PLANNED_FEATURES: usunięto "Wieloprojektowość", "Szybkie filtry w Quick Tag". "Bulk rename / merge tagów" → "Bulk rename tagów". Legenda priorytetów dodana do UI sekcji Planowane.',
      ]
    },
    {
      version: '0.9.4',
      date: '2026-03-28',
      notes: [
        'HOTFIX: applyFeatures() — features.includes("annotator_tools") crashował bo features = {} (obiekt), nie [] (tablica)',
        'Poprawka: features.includes(...) → features.annotator_tools (spójne z resztą kodu który używa features.xxx)',
        'Crash w applyFeatures() blokował całe init() po budowie panelu — stąd ? button, Zapisz i Annotators Tab nie działały',
        'loadFeatures() zwraca {} z JSON.parse(lsGet(LS.FEATURES, "{}")), nie tablicę — features.annotator_tools = true/false',
      ]
    },
    {
      version: '0.9.3',
      date: '2026-03-28',
      notes: [
        'buildAllProjectsPanel(): przepisany — panel pozycjonowany obok #b24t-panel (getBoundingClientRect()), nie przy krawędzi ekranu',
        '_positionXProjectPanel(el): nowy helper — oblicza left/right na podstawie pozycji głównego panelu, wyrównuje góra/dół',
        'MutationObserver na style głównego panelu → repositionuje boczny panel przy drag',
        'window resize → _positionXProjectPanel rebind',
        'refreshAllProjectsPanel(): skeleton loader per projekt, count z getMentions[tagId], zakres dat z createdDate wyników',
        'runDeleteByTag(): nowy parametr projectId (6. argument) — bez tego cross-project używało state.projectId (bug)',
        'buildAllProjectsPanel delete-all: potwierdza z łączną liczbą wzmianek, przekazuje p.id do runDeleteByTag',
        'wireDeleteEvents: scope allprojects → blokuje główny przycisk Usuń, tag change → refresh panelu gdy allprojects aktywny',
        'HTML radio "Wszystkie projekty": dodano opis pod spodem (wymaga REQUIRES_VERIFICATION + TO_DELETE)',
        'getKnownProjects(): filtruje projekty które mają reqVerId i toDeleteId — to jest warunek wyświetlenia opcji',
        'applyFeatures(): pokazuje radio allprojects tylko gdy annotator_tools włączone',
      ]
    },
    {
      version: '0.9.2',
      date: '2026-03-28',
      notes: [
        'Nowa zasada wersjonowania: nowa rozmowa = nowy minor (0.x.0), kolejne deploye w tej samej rozmowie = patch (0.x.y)',
        'DEV_CHANGELOG: dodano brakujące wpisy od 0.6.0 do 0.9.2 + logika auto-wypełniania (zasada: każde wdrożenie = wpis)',
        'Annotators Tab: zmiana nazwy triggera z "Narzędzia" / "Annotators" na pełne "Annotators Tab" + poszerzony padding',
        'CHANGELOG: skrócono opisy starszych wersji (0.6.0, 0.7.0, 0.8.0) — pełne opisy zostają w DEV_CHANGELOG',
      ]
    },
    {
      version: '0.9.1',
      date: '2026-03-28',
      notes: [
        'Onboarding: panel blokowany w centrum ekranu (nie prawy-dolny róg) podczas całego toru',
        'Onboarding: krok 14 rozbity na dwa — "Co nowego & Planowane" + "Bug Report — co jest wysyłane?"',
        'Onboarding: szczegółowy opis danych wysyłanych z Bug Reportem (wersja, projekt, 30 log lines, crash log, brak treści wzmianek)',
        'Onboarding: krok resize przenumerowany na 16, krok drag na 17, finał na 18',
        'Changelog 0.8.0, 0.7.0, 0.6.0: skrócono wpisy w CHANGELOG (pełne zostają w DEV_CHANGELOG)',
        'Tab trigger: "Narzędzia" → "Annotators" (etap przejściowy)',
      ]
    },
    {
      version: '0.9.0',
      date: '2026-03-28',
      notes: [
        'Optymalizacja kodu: usunięto 15 zduplikowanych definicji funkcji (378 linii)',
        'Fix: duplicate saveSessionToHistory() + playDoneSound() w startRun — wywoływane 2x z rzędu',
        'Fix: zduplikowane HTML bloki w buildPanel (file-validation, column-override, match-preview)',
        'Fix: zduplikowany event listener na #b24t-col-override-toggle',
        'Fix: usunięto martwy stub parseXLSX (zastąpiony przez parseXLSXFile)',
        'Fix: usunięto zbędny wrapper fetchMentionsPage (bezpośrednie wywołania getMentions)',
        'Perf: normalizeUrl — regex kompilowany raz (const _RX_*), wywoływana tysiące razy per sesja',
        'Perf: tab switching — DOM refs cachowane raz w tabEls{} zamiast getElementById przy każdym kliknięciu',
        'Fix: usunięto martwe zmienne state.auditMode, state.columnOverride, titleEl, prioColor',
        'Fix: onboarding z-index — overlay 2147483640, spotlight 2147483644, bubble 2147483647 (nad panelem)',
        'Fix: positionBubble przepisany — sprawdza spaceAbove/Below/Left/Right, brak edge case z dziubkiem do (0,0)',
        'Fix: blokada drag + resize podczas onboardingu (data-ob-locked atrybut)',
        'Onboarding: panel snapuje się do centrum ekranu na czas toru',
        'Onboarding: dodano kroki resize panelu i drag (przeciąganie)',
        'Tabs: przeprojektowane na pill/liquid glass style (border-radius:20px, gradient, inset shadow)',
        'Quick Tag: naprawiono rozmiary czcionek (10px→12-13px) i kolory (--b24t-text-muted zamiast hardkodowanych)',
      ]
    },
    {
      version: '0.8.0',
      date: '2026-03-27',
      notes: [
        'showOnboarding() — 18-krokowy dynamiczny tour z dymkami, spotlight i strzałką',
        'injectOnboardingStyles() — pełny zestaw CSS: overlay, spotlight (box-shadow cutout), bubble, dots, nav',
        'getOnboardingSteps() — tablica 18 kroków z target selector, tail hint i treścią',
        'positionBubble() — inteligentne pozycjonowanie: sprawdza miejsce góra/dół/lewo/prawo, responsive bw',
        'positionSpotlight() — animowany highlight elementu z pulse outline',
        'Onboarding blokuje panel (data-ob-locked) i snapuje do centrum ekranu',
        'Reset onboardingu: Changelog → Feedback → przycisk "↺ Powtórz onboarding"',
        'toggleHelpMode() / enterHelpMode() / exitHelpMode() — tryb pomocy (przycisk ?)',
        'Strefy klikania w help mode na document.body poziomie (nie wewnątrz panelu — overflow:hidden)',
        '#b24t-help-panel-overlay, .b24t-help-zone, .b24t-help-tip — fixed positioning',
        'setupResize() — Windows-style resize wszystkich krawędzi i rogów, min/max, localStorage',
        'Inter font lazy-load z Google Fonts (wagi 300-800) w injectStyles()',
        'Light mode: primary #2563eb (niebieski Brand24), wysoki kontrast WCAG AA+',
        'Dark mode: trójkolorowy gradient indygo→fiolet→magneta',
        'Annotator tab trigger: padding 18px 11px, font-weight:600, font-size:14px',
      ]
    },
    {
      version: '0.7.1',
      date: '2026-03-27',
      notes: [
        'Wyczyszczono sekcję PLANNED_FEATURES — usunięto zrealizowane funkcje',
        'Zaktualizowano opis AI API w planowanych',
      ]
    },
    {
      version: '0.7.0',
      date: '2026-03-27',
      notes: [
        'Pełny redesign UI: light mode Brand24 z gradientowym panelem, dark mode z trójkolorowym gradientem',
        'Annotator panel powiększony: 300→420px szerokość, 13→15px czcionka',
        'Nowe zmienne CSS: --b24t-text-label, --b24t-text-meta',
        'Subbar naprawiony: hardkodowane ciemne kolory → CSS variables',
        'Kafelki annotatora: liczby 16px/700 → 22px/800, etykiety pogrubione',
        'Topbar: efekt świetlny (radial gradient), stat-karty z paskiem akcentowym',
        'Sekcje z 2px obramowaniami i wyraźnym kontrastem',
      ]
    },
    {
      version: '0.6.0',
      date: '2026-03-27',
      notes: [
        'Light mode jako domyślny: schemat Brand24 (biały + gradient indygo #5B4FFF→#7C3AED)',
        'Dark mode: przełącznik slider ☀️/🌙 w topbarze, zapamiętywany w localStorage',
        'CSS Custom Properties — pełny design system przez --b24t-* variables',
        'Micro-animacje: b24t-slidein, b24t-fadein, b24t-pulse-ring, b24t-shimmer',
        'Narzędzia Annotatora: czcionki ujednolicone do 13px',
        'Wszystkie modale zaktualizowane do nowego design systemu',
        'document.documentElement.setAttribute("data-b24t-theme", theme) — zmiana motywu',
      ]
    },
    {
      version: '0.5.12',
      date: '2026-03-27',
      notes: [
        'Nowa funkcja opcjonalna: tagstats (id) — zakładka 🏷 Tagi',
        'getKnownProjects() — odczytuje projekty z LS.PROJECTS, filtruje te z reqVerId i toDeleteId',
        'fetchProjectTagCounts(projectId, reqVerId, toDeleteId, dateFrom, dateTo) — pobiera wszystkie strony 10x równolegle, zlicza tagi po id',
        'renderTagStats(el, projectStats, dateFrom, dateTo) — tabela z filtrem (tylko projekty z reqVer>0 || toDelete>0), sortowanie po sumie malejąco',
        'refreshTagStats() — loader z postępem "i/n — NazwaProjektu", sekwencyjnie per projekt (parallel między stronami, serial między projektami)',
        'rt filter Brand24 API zwraca Internal server error — obejście przez pobieranie wszystkich stron i zliczanie tagów po id',
        'UWAGA: wymaga że projekty były wcześniej odwiedzone z taggerem (dane w LS.PROJECTS)',
      ]
    },
    {
      version: '0.5.10',
      date: '2026-03-27',
      notes: [
        'Bug 1: Brand24 bulkTagMentions zwraca Internal server error przy 840 IDs — limit empiryczny ~200',
        'Fix 1: MAX_BATCH_SIZE 1000→200, partycje tagowane po max 200 IDs per request',
        'Bug 2: XLSX sheet_to_json z raw:true konwertuje 19-cyfrowe ID na float (Number.MAX_SAFE_INTEGER = 2^53-1 ≈ 9×10^15), obcinając ostatnie cyfry',
        'Fix 2: raw:false wymusza stringi dla wszystkich komórek, daty normalizowane osobno',
        'Bug 3: urlMap[normalizedUrl] nie znajdowało obciętych URL',
        'Fix 3: urlsMatch() — jeśli shorter jest prefiksem longer i len>=15 → match; wired jako fallback po exact lookup',
      ]
    },
    {
      version: '0.5.9',
      date: '2026-03-27',
      notes: [
        'Bug: w wireEvents() btn-preview i btn-audit miały addEventListener wywoływane dwa razy — drugi blok był pozostałością po refactorze',
        'Bug: wireHistoryTab() wywoływane dwa razy w init sequence (linie 6088-6089)',
        'Fix: usunięto drugi blok listenerów dla preview/audit/col-override-toggle w wireEvents()',
        'Fix: usunięto drugi wireHistoryTab() z init sequence',
      ]
    },
    {
      version: '0.5.8',
      date: '2026-03-27',
      notes: [
        'Bug: setTimeout 2s nie wystarczał dla KOTON_TR — Brand24 ustawia tytuł wolniej',
        'Fix: setInterval co 500ms, max 20 prób (10s łącznie), clearInterval gdy nazwa znaleziona lub limit wyczerpany',
      ]
    },
    {
      version: '0.5.7',
      date: '2026-03-27',
      notes: [
        'Root cause: heurystyka isLikelyLabel (vals.size <= 15) pasowała do kolumny source (twitter/tiktok/instagram = ~5-8 wartości)',
        'Fix krok 1: priorytet dla dokładnych nazw kolumn (assessment, label, ocena, flag, classification)',
        'Fix krok 2: heurystyka wyklucza SOURCE_NAMES i wymaga looksLikeAssessment (/^[A-Z_]{3,}$/ — uppercase słowa)',
        'Zaostrzono próg: vals.size <= 10 i rows.length > vals.size * 5 (było 15 i *3)',
      ]
    },
    {
      version: '0.5.6',
      date: '2026-03-27',
      notes: [
        'Bug: applyFeatures() ustawiało display:"" (pusty) zamiast "block" — dashboard był widoczny zawsze po włączeniu features.dashboard',
        'Fix: applyFeatures() zarządza tylko przyciskiem zakładki (b24t-tab-dashboard), nie contentem',
        'Fix: tab switcher sprawdza features.dashboard przed pokazaniem dashEl',
        'Dashboard content (b24t-dashboard-tab) domyślnie display:none w HTML — pokazywany tylko przez tab switcher gdy tab=dashboard',
      ]
    },
    {
      version: '0.5.5',
      date: '2026-03-27',
      notes: [
        'Root cause: Tampermonkey sandbox ma własny obiekt window odizolowany od strony; window.XLSX w scope TM ≠ unsafeWindow.XLSX gdzie SheetJS faktycznie jest załadowany',
        'readWithSheetJS(): używa _XLSX = unsafeWindow.XLSX || window.XLSX zamiast window.XLSX bezpośrednio',
        'parseXLSXFile(): sprawdza _win.XLSX (unsafeWindow) zamiast window.XLSX',
        'Dodano guard: if (!_XLSX || typeof _XLSX.read !== "function") reject() z czytelnym komunikatem',
      ]
    },
    {
      version: '0.5.4',
      date: '2026-03-27',
      notes: [
        'Root cause: CSP Brand24 blokował dynamiczne ładowanie SheetJS przez script tag z cdn.jsdelivr.net',
        'Fix: GM_xmlhttpRequest pobiera SheetJS poza CSP, następnie eval przez new Function w unsafeWindow scope',
        'Dodano @connect cdn.jsdelivr.net do nagłówka',
        'Fallback na script tag zachowany dla środowisk bez GM_xmlhttpRequest',
      ]
    },
    {
      version: '0.5.3',
      date: '2026-03-27',
      notes: [
        'Bug fix: detectProject() — document.title był "Brand24" gdy strona ładowała się asynchronicznie; dodano retry po 2s i walidację tytułu (isFallbackTitle)',
        'Potwierdzenie: window.confirm() przy state.file.rows.length >= 200 i testRunMode=false — blokuje start sesji',
        'Czcionki: base panel 13px (bez zmian), tab 12→13px, log 11→12px, section-label 11→12px, map-label 12→13px, progress-label 10→12px, i inne +1-2px',
      ]
    },
    {
      version: '0.5.2',
      date: '2026-03-26',
      notes: [
        'Root cause: va:0/va:1 nie filtruje po tagach — va:0=wszystkie+usunięte, va:1=standardowy widok',
        'Odkrycie: wzmianki posortowane nieotagowane→otagowane, co umożliwia binary search',
        'fetchDashboardStats(): krok 1 = count query, krok 2 = binary search hasTaggedOnPage()',
        'Binary search: lo/hi na totalPages, porównanie przez hasTaggedOnPage(mid)',
        'Granica lo-1 pełnych stron × PER_PAGE(60) + countUntaggedOnPage(lo) = untaggedCount',
        'Edge case: strona 1 ma otagowane (wszystkie tagowane) — countUntaggedOnPage(1)',
        '~7 requestów zamiast iterowania wszystkich 79 stron (4711 wzmianek)',
      ]
    },
    {
      version: '0.5.1',
      date: '2026-03-26',
      notes: [
        'Nowa stała LS.FEATURES = b24tagger_features — JSON obiekt z flagami włączonych funkcji',
        'OPTIONAL_FEATURES[] — tablica definicji opcjonalnych funkcji (id, label, desc)',
        'loadFeatures() / saveFeatures() / applyFeatures() — odczyt, zapis, zastosowanie flag',
        'showFeaturesModal() — modal z checkboxami, zapis przez przycisk Zapisz',
        'fetchDashboardStats() — dwa query: va:0 (nieotagowane) i va:1 (wszystkie), logika dat 1-2 dnia miesiąca',
        'renderDashboard(el, stats) — 3 kafelki (wszystkie/otagowane/pozostałe) + progress bar + % ukończenia',
        'refreshDashboard() — loader + fetchDashboardStats + renderDashboard',
        'Tab "📊 Dash" — domyślnie display:none, odkrywany przez applyFeatures gdy feature.dashboard=true',
        'applyFeatures() wywołane w init() przed showWhatsNewExtended',
      ]
    },
    {
      version: '0.4.6',
      date: '2026-03-25',
      notes: [
        'Root cause fix: brakował @connect raw.githubusercontent.com w nagłówku — Tampermonkey blokował GM_xmlhttpRequest do tej domeny',
        'Dodano // @connect raw.githubusercontent.com obok hooks.slack.com',
      ]
    },
    {
      version: '0.4.5',
      date: '2026-03-25',
      notes: [
        'checkForUpdate dodane do window.B24Tagger.debug.checkForUpdate() — teraz dostępne przez bridge',
        'Dodano log diagnostyczny w checkForUpdate: pokazuje czy GM_xmlhttpRequest jest dostępne',
        'setTimeout w głównym scope zwiększony do 6000ms żeby init() zdążył się wykonać',
      ]
    },
    {
      version: '0.4.4',
      date: '2026-03-25',
      notes: [
        'Root cause fix: checkForUpdate przeniesione z init() do głównego scope IIFE',
        'GM_xmlhttpRequest jest dostępne tylko w głównym scope skryptu Tampermonkey, nie w init() wywoływanym przez unsafeWindow',
        'setTimeout(checkForUpdate, 5000) teraz w głównym scope — GM_xmlhttpRequest dostępne',
        'Przycisk manualny już działał bo wireEvents jest wywoływane przez buildPanel() w głównym scope',
      ]
    },
    {
      version: '0.4.3',
      date: '2026-03-25',
      notes: [
        'Przycisk Zainstaluj: zmiana z blob URL na RAW_URL — Tampermonkey rozpoznaje .user.js i pokazuje ekran Update jednym kliknięciem',
      ]
    },
    {
      version: '0.4.2',
      date: '2026-03-25',
      notes: [
        'Root cause auto-check: fetch() blokowany przez CSP Brand24 dla raw.githubusercontent.com',
        'Fix: checkForUpdate używa GM_xmlhttpRequest (omija CSP) z fallbackiem na fetch',
        'showUpdateBanner: position zmieniony z bottom/center na top:60px/right:16px',
        'Animacja: slide-in/slide-out z prawej (translateX) zamiast slide-up od dołu',
        'Baner aktualizacji: 300px szerokości, nagłówek z wersją, przycisk Zainstaluj full-width',
        'Baner "najnowsza wersja": auto-dismiss po 3s ze slide-out',
        'Baner aktualizacji: auto-dismiss po 20s',
      ]
    },
    {
      version: '0.4.1',
      date: '2026-03-25',
      notes: [
        'checkForUpdate(): GM_xmlhttpRequest → fetch() — raw.githubusercontent.com ma otwarty CORS (Access-Control-Allow-Origin: *)',
        'checkForUpdate(manual=true): przy braku aktualizacji pokazuje zielony baner "Masz najnowszą wersję" przez 3s',
        'Nowy przycisk #b24t-btn-check-update w subbarze, podczas sprawdzania zmienia label na "↻ Sprawdzam..."',
        'showUpdateBanner(null): obsługa przypadku brak aktualizacji przy manual check',
      ]
    },
    {
      version: '0.3.9',
      date: '2026-03-25',
      notes: [
        'Nowa stała RAW_URL — wskazuje na raw plik wtyczki na GitHubie',
        'checkForUpdate(): GM_xmlhttpRequest do GitHub raw URL, parsuje @version z nagłówka, throttle 1h przez localStorage b24tagger_update_check',
        'compareVersions(a, b): porównanie semantycznych wersji jako tablice liczb',
        'showUpdateBanner(newVersion): fixed baner na dole ekranu, animacja slide-up, auto-ukrycie po 15s',
        'Przycisk Zainstaluj otwiera blob URL na GitHubie — Tampermonkey wykrywa .user.js i oferuje instalację',
        'checkForUpdate wywołane setTimeout 5000ms po init (po showWhatsNewExtended)',
      ]
    },
    {
      version: '0.3.8',
      date: '2026-03-25',
      notes: [
        'SLACK_WEBHOOK_URL wyciągnięty z hardkodu — placeholder "TWOJ_SLACK_WEBHOOK_URL"',
        'sendToSlack() — early return z komunikatem gdy URL nie skonfigurowany',
        'Dodano @updateURL i @downloadURL wskazujące na raw GitHub URL',
        'Plik gotowy do publikacji w publicznym repo bez secret scanning error',
      ]
    },
    {
      version: '0.3.7',
      date: '2026-03-25',
      notes: [
        'buildBugReportData(): crashLog section rozbudowany — używa pełnego obiektu z saveCrashLog zamiast tylko message+stack(500)',
        'Nowe pola w crashLog sekcji Bug Report: errorType, lastAction, session (status/partycja/zakres dat), stats, file, urlMapSize, lastMatchLog, recoverable, userMessage',
        'sendBugReport(): crash section w Slack Blocks podzielona na: fields (typ błędu, czas, ostatnia akcja, recoverable), stan sesji, last match log, stack trace',
        'saveCrashLog() — bez zmian (była już rozbudowana w poprzedniej iteracji)',
      ]
    },
    {
      version: '0.3.7',
      date: '2026-03-25',
      notes: [
        'saveCrashLog() rozbudowany o: version, timestamp ISO + localTime, url, session{status,projectId/Name,testRunMode,mapMode,hasToken,currentPartitionIdx,totalPartitions,currentPartitionRange}, stats{tagged,skipped,noMatch,conflicts,deleted}, file{name,rows,colMap}, urlMapSize, lastMatchLogEntry, logSnapshot (ostatnie 50 wpisów), browser',
        'showCrashBanner() przebudowany: msg pokazuje errorType + czas + userMessage, detail formatuje czytelny tekst z sekcjami (CRASH REPORT / SESJA / STATYSTYKI / PLIK / STACK TRACE / LOGI)',
        'showCrashBanner() dodaje dynamicznie przycisk "🐛 Wyślij Bug Report" który wywołuje sendBugReport() z auto-opisem',
        'buildBugReportData() zaktualizowany — crashLog section używa nowych pól zamiast starych (message/time/stack)',
        'userMessages w saveCrashLog: dodano NETWORK_ERROR, poprawiono fallback z includes(network|fetch)',
      ]
    },
    {
      version: '0.3.6',
      date: '2026-03-25',
      notes: [
        'Nowa funkcja buildBugReportData() — zbiera: version, timestamp, url, projectId/Name, sessionStatus, hasToken, testRunMode, mapMode, stats, fileName, fileRows, urlMapSize, partitions, sessionStart, recentLogs (ostatnie 30), crashLog, browser, screen',
        'Nowa funkcja sendToSlack(payload, onSuccess, onError) — shared helper dla GM_xmlhttpRequest + fetch fallback',
        'Nowa funkcja sendBugReport(description, onDone) — Slack Blocks API z 3 sekcjami fields + opis + logi + crash log',
        'Nowa funkcja sendSuggestion(text, onDone) — prosty payload bez danych technicznych',
        'sendFeedbackToSlack() zachowana jako legacy wrapper delegujący do sendBugReport/sendSuggestion',
        'addLog() rozszerzony o parametr extra i limit 500 wpisów w state.logs',
        'Feedback tab: przełącznik Bug Report / Suggestion (fbMode state), dynamiczny kolor send button',
        'Bug panel: info box z listą dołączanych danych, textarea z placeholderem diagnostycznym',
        'Suggest panel: ukryty domyślnie, odsłaniany przez mode switcher',
        'Tab switching w modal: aktualizacja font-size przy toggle zakładki',
      ]
    },
    {
      version: '0.3.5',
      date: '2026-03-25',
      notes: [
        'Panel width: 380px → 440px',
        'Nowy element #b24t-subbar między topbarem a zakładkami: zawiera przycisk Changelog & Feedback, token status i timer',
        'Przycisk #b24t-btn-changelog przeniesiony z topbara do subbara',
        'Token label (#b24t-token-label) ukryty w topbarze (display:none), status tylko przez subbara #b24t-token-status-sub',
        'updateTokenUI() + startSessionTimer() — dodano sync do elementów w subbar',
        'Action bar: flex-direction:column z dwoma rzędami div, zamiast jednej płaskiej listy przycisków',
        'Rząd 1: Start (flex:2), Match (flex:1), Audit (flex:1)',
        'Rząd 2: Pauza (flex:1), Stop (flex:1), Eksport (flex:0 0 36px)',
        'Zakładki: dodano ikony emoji przed nazwami, font-size 11px → 10px',
        'Modal changelog: width 440px → 520px, max-height 84vh → 86vh',
        'Feedback tab: layout zmieniony z flex-column na CSS grid (2 kolumny) dla pól bugs/ideas',
        'Zakładki modalu z ikonami: 📰 Co nowego, 🗓 Planowane, 💬 Feedback',
        'Dev notes modal: width 480px → 520px',
        'Legenda w footerze zmniejszona (9px), devnotes btn przemianowany na "Dev patch notes"',
      ]
    },
    {
      version: '0.3.4',
      date: '2026-03-25',
      notes: [
        'Retroaktywna zmiana schematu wersjonowania: 1.x.x → 0.x.x (beta prefix)',
        'Zmiana @name na "B24 Tagger BETA" we wszystkich miejscach w UI i metadanych',
        'Przycisk "ZMIANY" → "Changelog & Feedback" w topbarze panelu',
        'Usunięcie wszystkich odwołań do wewnętrznych projektów (GOLEM, Insights24) z kodu i UI',
        '@namespace zmieniony na https://brand24.com',
        '@author zmieniony na "B24 Tagger"',
      ]
    },
    {
      version: '0.3.3',
      date: '2026-03-25',
      notes: [
        'CHANGELOG: uproszczenie wszystkich opisów do wersji ogólnikowych dla użytkownika końcowego',
        'Dodanie DEV patch notes jako osobnego systemu dla programistów',
        'Przycisk "Pełne patch notes" przeniesiony do zakładki "Co nowego"',
        'Onboarding rozszerzony z 5 do 6 kroków — dodano kroki o narzędziach (Match Preview, Audit, Quick Tag/Delete) oraz historii i feedbacku',
        'Zaktualizowano format pliku w onboardingu — auto-detekcja kolumn, opcjonalne pola',
      ]
    },
    {
      version: '0.3.2',
      date: '2026-03-25',
      notes: [
        'KRYTYCZNY FIX: zmiana @run-at z document-idle na document-start — wtyczka nie startowała po zmianie @grant',
        'Dodano @grant unsafeWindow — interceptor fetch patchuje teraz unsafeWindow.fetch zamiast window.fetch sandboxu Tampermonkey',
        'window.B24Tagger przypisywane również do _win.B24Tagger (unsafeWindow) dla dostępu ze strony',
        'Root cause TOKEN_NOT_READY: Tampermonkey z @grant GM_xmlhttpRequest izoluje window fetch od strony',
      ]
    },
    {
      version: '0.3.1',
      date: '2026-03-25',
      notes: [
        'Formularz feedbacku: zastąpiono jedno pole tekstowe dwoma osobnymi (bugs + ideas)',
        'Usunięto system oceny gwiazdkowej z formularza feedbacku',
        'sendFeedbackToSlack: zmiana sygnatury z (text, rating) na (bugs, ideas) — payload Slack podzielony na dwie sekcje',
        'Walidacja formularza: wymagane przynajmniej jedno z dwóch pól (poprzednio: wymagana ocena)',
        'Aktualizacja priorytetów PLANNED_FEATURES: podgląd on-hover + szybkie filtry → high, wieloprojektowość → low',
      ]
    },
    {
      version: '0.3.0',
      date: '2026-03-25',
      notes: [
        'Nowa funkcja: showWhatsNewExtended() z 3 zakładkami (Co nowego / Planowane / Feedback)',
        'Stara showWhatsNew() zastąpiona delegatem do showWhatsNewExtended()',
        'Dodano stałą SLACK_WEBHOOK_URL i PLANNED_FEATURES[]',
        'sendFeedbackToSlack(): wysyłka przez GM_xmlhttpRequest (bypass CSP) z fallbackiem na fetch',
        'Slack payload: Blocks API z sekcjami ocena/wersja/projekt/czas/wiadomość',
        'Dodano @grant GM_xmlhttpRequest i @connect hooks.slack.com do nagłówka',
        'Przycisk "Changelog & Feedback" (wcześniej "ZMIANY") w topbarze — kolor #6c6cff',
        'CSS: #b24t-btn-changelog z hover state i wyróżnionym kolorem',
        'showWhatsNew wywołane setTimeout 2000ms po init (jednorazowo per wersja)',
        'Klucz localStorage b24tagger_seen_version do śledzenia widzianej wersji',
      ]
    },
  ];


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
    if (!RAW_URL) return;
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
        url: RAW_URL + '?_=' + Date.now(),
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
      fetch(RAW_URL + '?_=' + Date.now())
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
      'background:#0f0f13',
      'border:1px solid ' + (newVersion ? '#6c6cff' : '#4ade80'),
      'border-radius:12px',
      'padding:16px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
      'z-index:2147483646',
      'font-family:monospace',
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
        '<div style="width:36px;height:36px;background:#6c6cff22;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">✦</div>' +
        '<div style="flex:1;">' +
          '<div style="font-size:14px;font-weight:700;color:#e2e2e8;letter-spacing:-0.01em;">Dostępna aktualizacja</div>' +
          '<div style="font-size:11px;color:var(--b24t-text-faint);margin-top:3px;">B24 Tagger BETA</div>' +
        '</div>' +
        '<button id="b24t-update-dismiss" style="background:none;border:none;color:#444455;cursor:pointer;font-size:18px;line-height:1;padding:2px;flex-shrink:0;">✕</button>' +
      '</div>' +
      // Wersje
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:8px 10px;background:#141419;border-radius:8px;">' +
        '<span style="font-size:12px;color:var(--b24t-text-faint);font-family:monospace;">v' + VERSION + '</span>' +
        '<span style="font-size:14px;color:var(--b24t-text-faint);">→</span>' +
        '<span style="font-size:13px;font-weight:700;color:#6c6cff;font-family:monospace;">v' + newVersion + '</span>' +
        '<span style="margin-left:auto;font-size:10px;background:#6c6cff22;color:#6c6cff;padding:2px 7px;border-radius:99px;">nowa wersja</span>' +
      '</div>' +
      // Przycisk
      '<button id="b24t-update-install" style="width:100%;background:#6c6cff;color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:monospace;letter-spacing:0.02em;">Zainstaluj aktualizację →</button>';

    document.body.appendChild(el);

    function dismiss() {
      el.style.animation = 'b24t-slide-out 0.25s ease forwards';
      setTimeout(function() { el.remove(); }, 260);
    }

    document.getElementById('b24t-update-install').addEventListener('click', function() {
      // Otwarcie raw .user.js URL — Tampermonkey automatycznie wykrywa i pokazuje ekran aktualizacji
      window.open(RAW_URL, '_blank');
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
      // Prefetch danych w tle — startBgPrefetch sam zarządza tokenem i cyklem
      startBgPrefetch();
    } else {
      if (tab) tab.style.display = 'none';
      if (panel) panel.style.display = 'none';
    }
  }

  function showFeaturesModal() {
    if (document.getElementById('b24t-features-modal')) return;
    const features = loadFeatures();

    const modal = document.createElement('div');
    modal.id = 'b24t-features-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;backdrop-filter:blur(4px);animation:b24t-fadein 0.2s ease;';

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

    modal.innerHTML =
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:16px;width:400px;box-shadow:var(--b24t-shadow-h);animation:b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:14px 0;background:var(--b24t-accent-grad);border-radius:16px 16px 0 0;display:flex;align-items:center;gap:10px;padding:14px 20px;">' +
          '<span style="font-size:18px;">⚙</span>' +
          '<div style="flex:1;">' +
            '<div style="font-size:13px;font-weight:700;color:#fff;">Dodatkowe funkcje</div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,0.7);margin-top:2px;">Włącz lub wyłącz opcjonalne funkcje wtyczki</div>' +
          '</div>' +
          '<button id="b24t-features-close" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:2px 8px;border-radius:5px;">✕</button>' +
        '</div>' +
        '<div style="padding:4px 20px 0;">' + checkboxesHtml + '</div>' +
        '<div style="padding:14px 20px;border-top:1px solid var(--b24t-border-sub);text-align:right;">' +
          '<button id="b24t-features-save" style="background:var(--b24t-accent-grad);color:#fff;border:none;border-radius:8px;padding:9px 24px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 2px 8px var(--b24t-primary-glow);transition:opacity 0.15s;">Zapisz</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    function close() { modal.remove(); }

    document.getElementById('b24t-features-close').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    document.getElementById('b24t-features-save').addEventListener('click', function() {
      const newFeatures = {};
      modal.querySelectorAll('input[data-feature]').forEach(function(cb) {
        newFeatures[cb.dataset.feature] = cb.checked;
      });
      saveFeatures(newFeatures);
      applyFeatures();
      close();
      addLog('✓ Ustawienia funkcji zapisane', 'success');
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

  // Odśwież dane tag stats
  async function refreshTagStats() {
    const el = document.getElementById('b24t-tagstats-content');
    if (!el) return;
    if (!state.tokenHeaders) {
      el.innerHTML = '<div style="padding:14px;font-size:11px;color:#f87171;">⚠ Token nie gotowy — odśwież stronę</div>';
      return;
    }

    const projects = getKnownProjects();
    if (projects.length === 0) {
      el.innerHTML = '<div style="padding:14px;font-size:11px;color:var(--b24t-text-faint);">Brak zapisanych projektów. Odwiedź każdy projekt raz żeby go zarejestrować.</div>';
      return;
    }

    // Daty — bieżący miesiąc (lub poprzedni na 1-2 dzień) — przez getAnnotatorDates (lokalne daty, bez UTC shift)
    var _annDates = getAnnotatorDates();
    var dateFrom = _annDates.dateFrom;
    var dateTo   = _annDates.dateTo;

    // Pokaż loader z postępem
    el.innerHTML = '<div style="padding:20px;text-align:center;">' +
      '<div style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:8px;">↻ Pobieram dane ze wszystkich projektów...</div>' +
      '<div id="b24t-tagstats-progress" style="font-size:10px;color:var(--b24t-text-faint);">0/' + projects.length + ' projektów</div>' +
    '</div>';

    const results = [];
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const progressEl = document.getElementById('b24t-tagstats-progress');
      if (progressEl) progressEl.textContent = (i + 1) + '/' + projects.length + ' — ' + p.name;
      try {
        const counts = await fetchProjectTagCounts(p.id, p.reqVerId, p.toDeleteId, dateFrom, dateTo, null);
        results.push({ name: p.name, id: p.id, ...counts });
      } catch(e) {
        results.push({ name: p.name, id: p.id, total: 0, reqVer: 0, toDelete: 0, error: e.message });
      }
    }

    renderTagStats(el, results, dateFrom, dateTo);
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
    return '<div style="background:#141419;border-radius:8px;padding:8px;text-align:center;">' +
      '<div style="font-size:16px;font-weight:700;color:' + color + ';">' + (value ?? '—') + '</div>' +
      '<div style="font-size:9px;color:var(--b24t-text-faint);margin-top:2px;">' + label + '</div>' +
    '</div>';
  }

  // Odśwież dane dashboardu i wyrenderuj
  async function refreshDashboard() {
    const el = document.getElementById('b24t-dashboard-content');
    if (!el) return;

    // Pokaż loader
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--b24t-text-faint);font-size:11px;">↻ Ładowanie...</div>';

    try {
      const stats = await fetchDashboardStats();
      renderDashboard(el, stats);
    } catch(e) {
      el.innerHTML = '<div style="padding:14px;font-size:10px;color:#f87171;">⚠ ' + e.message + '</div>';
    }
  }

  // ───────────────────────────────────────────
  // ANNOTATOR TOOLS — FLOATING PANEL
  // ───────────────────────────────────────────

  var annotatorDataLoaded = false;
  var annotatorData = { project: null, tagstats: null };

  // ── Background prefetch cache ──────────────────────────────────────────────
  // Przechowuje dane niezależnie od DOM — render jest natychmiastowy gdy cache gorący.
  // bgCache.tagstats    = { results, dates, ts }         (Annotators Tab → zakładka Tagi)
  // bgCache.project     = { total,... , ts }             (Annotators Tab → zakładka Projekt)
  // bgCache.allProjects = { [tagId]: { results, ts } }   (cross-delete panel)
  var bgCache = { tagstats: null, project: null, allProjects: {}, overallStats: null };
  var bgPrefetchStarted = false;
  var BG_CACHE_TTL = 5 * 60 * 1000; // 5 minut — po tym czasie re-fetch w tle

  function _bgCacheFresh(entry) {
    return entry && entry.ts && (Date.now() - entry.ts < BG_CACHE_TTL);
  }

  // Cicha wersja loadAnnotatorTagStats — tylko wypełnia bgCache, nie dotyka DOM
  async function _bgFetchTagstats() {
    if (!state.tokenHeaders) return;
    var projects = getKnownProjects();
    if (!projects.length) return;
    var dates = getAnnotatorDates();
    addLog('⟳ [BG] prefetch tagstats (' + projects.length + ' projektów)...', 'info');
    var results = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      try {
        var reqPage = await getMentions(p.id, dates.dateFrom, dates.dateTo, [p.reqVerId],   1);
        var delPage = await getMentions(p.id, dates.dateFrom, dates.dateTo, [p.toDeleteId], 1);
        var reqVer   = reqPage.count  || 0;
        var toDelete = delPage.count  || 0;
        if (reqVer > 0 || toDelete > 0) {
          results.push({ name: p.name, id: p.id, reqVer: reqVer, toDelete: toDelete });
        }
      } catch(e) {}
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
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      try {
        var page  = await getMentions(p.id, dateFrom, dateTo, [tagId], 1);
        var count = page.count || 0;
        p._tagCount = count;
        p._dateFrom = dateFrom;
        p._dateTo   = dateTo;
        if (count > 0) {
          results.push({ p: p, count: count });
        }
      } catch(e) {
        results.push({ p: p, count: -1, error: e.message });
        addLog('✕ [DIAG] getMentions(' + p.id + '/' + tagName + '): ' + e.message, 'diag');
      }
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
    tab.style.cssText = 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483640;border-right:none;border-radius:10px 0 0 10px;padding:18px 13px;cursor:pointer;display:none;flex-direction:column;align-items:center;gap:7px;font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;font-size:14px;font-weight:600;letter-spacing:0.04em;user-select:none;transition:transform 0.2s,box-shadow 0.2s,background 0.3s,border-color 0.3s,color 0.3s;';
    // inline colors that adapt via JS (CSS vars not available in inline style)
    tab.innerHTML = '<span style="writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:.08em;font-size:13px;font-weight:600;">Annotators Tab</span><span style="font-size:18px;line-height:1;">‹</span>';
    tab.title = 'Otwórz Annotators';
    tab.addEventListener('click', function() { openAnnotatorPanel(); });
    document.body.appendChild(tab);

    // Floating panel
    var panel = document.createElement('div');
    panel.id = 'b24t-annotator-panel';
    panel.setAttribute('data-b24t-theme', currentTheme);
    panel.style.cssText = 'position:fixed;right:12px;top:80px;width:420px;z-index:2147483641;border-radius:14px;display:none;overflow:hidden;animation:b24t-slidein 0.3s cubic-bezier(0.34,1.56,0.64,1);font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif;font-size:15px;';

    panel.innerHTML =
      // Header with gradient
      '<div id="b24t-ann-header" style="display:flex;align-items:center;padding:12px 16px;background:var(--b24t-accent-grad);cursor:move;user-select:none;position:relative;overflow:hidden;">' +
        '<span style="font-size:15px;font-weight:700;flex:1;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.2);">🛠 Annotators Tab</span>' +
        '<button id="b24t-ann-close" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:2px 8px;border-radius:5px;transition:background 0.15s;">×</button>' +
      '</div>' +
      // Tabs — liquid glass, identyczny styl jak główny panel
      '<div style="display:flex;align-items:center;gap:5px;padding:6px 10px;background:var(--b24t-bg-deep);border-bottom:1px solid var(--b24t-border-sub);">' +
        '<button class="b24t-tab b24t-ann-tab b24t-tab-active" data-ann-tab="project">📊 Projekt</button>' +
        '<button class="b24t-tab b24t-ann-tab" data-ann-tab="tagstats">🏷 Tagi</button>' +
        '<button class="b24t-tab b24t-ann-tab" data-ann-tab="groups">🗂 Grupy</button>' +
        '<button class="b24t-tab b24t-ann-tab" data-ann-tab="overall">📈 Overall</button>' +
      '</div>' +
      // Project tab
      '<div id="b24t-ann-tab-project" class="b24t-ann-content" style="display:block;background:var(--b24t-bg);">' +
        '<div id="b24t-ann-project-content" style="padding:16px;font-size:14px;color:var(--b24t-text-faint);">↻ Ładowanie...</div>' +
        '<div style="padding:0 16px 14px;"><button id="b24t-ann-project-refresh" style="width:100%;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:7px;padding:9px;font-size:13px;font-family:inherit;cursor:pointer;transition:background 0.15s,transform 0.1s;">↻ Odśwież</button></div>' +
      '</div>' +
      // Tags tab
      '<div id="b24t-ann-tab-tagstats" class="b24t-ann-content" style="display:none;background:var(--b24t-bg);">' +
        '<div id="b24t-ann-tagstats-content" style="padding:16px;font-size:14px;color:var(--b24t-text-faint);">↻ Ładowanie...</div>' +
        '<div style="padding:0 16px 14px;"><button id="b24t-ann-tagstats-refresh" style="width:100%;background:var(--b24t-bg-input);border:1px solid var(--b24t-border);color:var(--b24t-text-muted);border-radius:7px;padding:9px;font-size:13px;font-family:inherit;cursor:pointer;transition:background 0.15s,transform 0.1s;">↻ Odśwież</button></div>' +
      '</div>' +
      // Groups tab
      '<div id="b24t-ann-tab-groups" class="b24t-ann-content" style="display:none;background:var(--b24t-bg);overflow-y:auto;">' +
        '<div id="b24t-ann-tab-groups-content"></div>' +
      '</div>' +
      // Overall Stats tab
      '<div id="b24t-ann-tab-overall" class="b24t-ann-content" style="display:none;background:var(--b24t-bg);">' +
        '<div id="b24t-ann-tab-overall-content"></div>' +
      '</div>';

    // Apply panel border/shadow via attribute (CSS vars pick it up)
    panel.style.border = '1px solid var(--b24t-border)';
    panel.style.boxShadow = 'var(--b24t-shadow-h)';
    panel.style.background = 'var(--b24t-bg)';
    panel.style.color = 'var(--b24t-text)';

    document.body.appendChild(panel);

    // Resize annotator panel — wszystkie krawędzie
    setupResize(panel, LS.UI_ANN_SIZE, {
      minW: 320, maxW: 640,
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
        if (content) { content.style.display = 'block'; content.style.animation = 'b24t-fadein 0.2s ease'; }
        // Jeśli bgCache gorący — renderuj od razu, potem cichy refetch
        if (tabName === 'tagstats') {
          var tsEl = document.getElementById('b24t-ann-tagstats-content');
          if (_bgCacheFresh(bgCache.tagstats) && tsEl) {
            annotatorData.tagstats = bgCache.tagstats;
            renderAnnotatorTagStats(tsEl, bgCache.tagstats);
            // Cichy background refresh
            _bgFetchTagstats().then(function(fresh) {
              if (fresh && tsEl) renderAnnotatorTagStats(tsEl, fresh);
            }).catch(function(){});
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

    // Refresh button hover
    ['b24t-ann-project-refresh','b24t-ann-tagstats-refresh'].forEach(function(id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('mouseenter', function() { btn.style.transform = 'translateY(-1px)'; });
      btn.addEventListener('mouseleave', function() { btn.style.transform = ''; });
    });

    // Close
    document.getElementById('b24t-ann-close').addEventListener('click', function() {
      panel.style.display = 'none';
      var t = document.getElementById('b24t-annotator-tab');
      if (t) t.style.display = 'flex';
    });

    // Refresh
    document.getElementById('b24t-ann-project-refresh').addEventListener('click', function() {
      annotatorData.project = null; loadAnnotatorProject();
    });
    document.getElementById('b24t-ann-tagstats-refresh').addEventListener('click', function() {
      annotatorData.tagstats = null; bgCache.tagstats = null; loadAnnotatorTagStats();
    });

    // Drag
    var hdr = document.getElementById('b24t-ann-header');
    var dragging = false, sx, sy, sl, st;
    hdr.addEventListener('mousedown', function(e) {
      if (e.target.id === 'b24t-ann-close') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect(); sl = r.left; st = r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      panel.style.left = (sl + e.clientX - sx) + 'px';
      panel.style.top  = (st + e.clientY - sy) + 'px';
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
    panel.style.display = 'block';
    if (tab) tab.style.display = 'none';
    if (!annotatorData.project)  loadAnnotatorProject();
    // Tagstats — jeśli bgCache gorący renderuj od razu bez spinnera
    var tsEl = document.getElementById('b24t-ann-tagstats-content');
    if (_bgCacheFresh(bgCache.tagstats) && tsEl) {
      annotatorData.tagstats = bgCache.tagstats;
      renderAnnotatorTagStats(tsEl, bgCache.tagstats);
      _bgFetchTagstats().then(function(fresh) {
        if (fresh && tsEl) renderAnnotatorTagStats(tsEl, fresh);
      }).catch(function(){});
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
    addLog('📅 Zakres: ' + label + ' (' + dateFrom + ' → ' + dateTo + ')', 'info');
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
      '<div style="font-size:11px;color:var(--b24t-text-faint);margin-bottom:8px;">' + d.dates.label +
        (d.dates.daysLeft > 0 ? ' <span style="color:var(--b24t-warn);">· ' + d.dates.daysLeft + ' dni</span>' : '') + '</div>' +
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
  }

  function _annTile(label, value, color) {
    return '<div style="background:var(--b24t-section-grad-d);border:1px solid var(--b24t-border-strong);border-radius:8px;padding:10px;text-align:center;transition:background 0.3s,border-color 0.3s;">' +
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
      }).catch(function(){});
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
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      var counter = document.getElementById('b24t-ann-ts-counter');
      if (counter) counter.textContent = (i + 1) + ' / ' + projects.length;
      try {
        var reqPage  = await getMentions(p.id, dates.dateFrom, dates.dateTo, [p.reqVerId],   1);
        var delPage  = await getMentions(p.id, dates.dateFrom, dates.dateTo, [p.toDeleteId], 1);
        var reqVer   = reqPage.count  || 0;
        var toDelete = delPage.count  || 0;
        if (reqVer > 0 || toDelete > 0) {
          results.push({ name: p.name, id: p.id, reqVer: reqVer, toDelete: toDelete });
        }
      } catch(e) {}
    }

    bgCache.tagstats = { results: results, dates: dates, ts: Date.now() };
    annotatorData.tagstats = bgCache.tagstats;
    addLog('✓ [zakładka Tagi] załadowano dane (' + projects.length + ' projektów, ' + results.length + ' z tagami)', 'success');
    renderAnnotatorTagStats(el, bgCache.tagstats);
  }

  function renderAnnotatorTagStats(el, d) {
    var filtered = (d.results||[]).filter(function(p){ return p.reqVer>0||p.toDelete>0; })
      .sort(function(a,b){ return (b.reqVer+b.toDelete)-(a.reqVer+a.toDelete); });
    if (!filtered.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--b24t-ok);font-size:13px;padding:12px 0;font-weight:600;">✓ Wszystkie projekty czyste!</div>';
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
      '<div style="font-size:11px;color:var(--b24t-text-faint);padding:6px 0 8px;">' + d.dates.dateFrom + ' – ' + d.dates.dateTo + '</div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
        '<thead><tr>' +
          '<th style="padding:5px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--b24t-text-faint);text-align:left;border-bottom:1px solid var(--b24t-border);">Projekt</th>' +
          '<th style="padding:5px 8px;font-size:10px;font-weight:700;color:var(--b24t-warn);text-align:center;border-bottom:1px solid var(--b24t-border);">REQ</th>' +
          '<th style="padding:5px 8px;font-size:10px;font-weight:700;color:var(--b24t-err);text-align:center;border-bottom:1px solid var(--b24t-border);">DEL</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  async function loadAnnotatorDataBackground() {
    if (annotatorDataLoaded) return;
    annotatorDataLoaded = true;
    // Prefetch w tle — startBgPrefetch sam czeka na token i odpala cykliczne odświeżanie
    startBgPrefetch();
    // Załaduj dane projektu (zakładka Projekt) — wciąż sekwencyjnie bo jest lekkie
    if (!state.tokenHeaders) {
      await new Promise(function(resolve) {
        var check = setInterval(function() { if (state.tokenHeaders) { clearInterval(check); resolve(); } }, 500);
        setTimeout(function(){ clearInterval(check); resolve(); }, 15000);
      });
    }
    try { await loadAnnotatorProject(); } catch(e) {}
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

  // Delete all mentions with given tagId in given date range
  async function deleteMentionsByTag(tagId, tagName, dateFrom, dateTo, onProgress) {
    addLog(`→ Zbieram wzmianki do usunięcia (tag: ${tagName}, ${dateFrom} → ${dateTo})`, 'warn');
    const allIds = await fetchAllIds(
      p => getMentions(state.projectId, dateFrom, dateTo, [tagId], p),
      onProgress
    );

    if (!allIds.length) {
      addLog(`⚠ Brak wzmianek z tagiem "${tagName}" w podanym zakresie dat.`, 'warn');
      return 0;
    }

    addLog(`→ Usuwam ${allIds.length} wzmianek z tagiem "${tagName}"...`, 'warn');
    let deleted = 0;
    for (let i = 0; i < allIds.length; i++) {
      if (state.status === 'paused' || state.status === 'idle') break;
      // deleteMention is one at a time (no bulk delete in API)
      await gqlRetry('deleteMention', { id: allIds[i] }, `mutation deleteMention($id: IntString!) {
        deleteMention(id: $id)
      }`);
      deleted++;
      if (onProgress) onProgress(deleted, allIds.length, deleted, allIds.length);
      await sleep(100); // gentle rate limiting
    }

    addLog(`✓ Usunięto ${deleted} wzmianek z tagiem "${tagName}"`, 'success');
    return deleted;
  }

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

  // Build auto-delete key for localStorage (per project + tag)
  function buildAutoDeleteKey(projectId, tagId) {
    return `${projectId}_${tagId}`;
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

    // Delete one by one (deleteMention API accepts single ID)
    let deleted = 0;
    for (const id of allIds) {
      if (state.status === 'paused' || state.status === 'idle') break;
      await deleteMention(id);
      deleted++;
      if (onProgress) onProgress('delete', deleted, allIds.length);
      if (deleted % 10 === 0) {
        addLog(`→ Usunięto ${deleted}/${allIds.length}...`, 'info');
        await sleep(100); // rate limiting
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
    var colors = { info: '#9ca3af', success: '#4ade80', warn: '#fbbf24', error: '#f87171', diag: '#f87171' };
    var msgColor = colors[entry.type] || '#9ca3af';
    var msgHtml;
    if (entry.type === 'diag') {
      var dm = entry.message.match(/^(\[DIAG\]\s*)(.*)/s);
      if (dm) {
        msgHtml = '<span style="color:#f87171;font-weight:700;">' + dm[1] + '</span>' + dm[2];
      } else {
        msgHtml = '<span style="color:#f87171;font-weight:700;">[DIAG] </span>' + entry.message;
      }
    } else {
      msgHtml = entry.message;
    }
    var row = document.createElement('div');
    row.dataset.logType = entry.type;
    row.style.cssText = 'display:flex;gap:8px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;line-height:1.5;';
    row.innerHTML =
      '<span style="color:#6b7280;flex-shrink:0;font-size:11px;">' + entry.time + '</span>' +
      '<span style="color:#4b5563;flex-shrink:0;font-size:10px;padding-top:2px;min-width:42px;">[' + entry.type.toUpperCase() + ']</span>' +
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
      'background:#1a1a2e', 'border:1px solid #2d2d4e',
      'border-radius:12px', 'box-shadow:0 16px 48px rgba(0,0,0,0.6)',
      'z-index:2147483647', 'display:none', 'flex-direction:column',
      'font-family:\'Inter\',\'Segoe UI\',system-ui,sans-serif',
      'overflow:hidden', 'resize:both',
    ].join(';');

    el.innerHTML =
      // Header z gradientem
      '<div id="b24t-logp-header" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(135deg,#1e1e3f,#16213e);flex-shrink:0;cursor:move;user-select:none;border-bottom:1px solid #2d2d4e;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-size:14px;font-weight:700;color:#e2e8f0;">📋 Log sesji</span>' +
          '<span id="b24t-logp-count" style="font-size:10px;color:#6b7280;background:#0f0f1e;border-radius:99px;padding:1px 7px;"></span>' +
        '</div>' +
        '<button id="b24t-logp-close" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#e2e8f0;border-radius:5px;padding:2px 10px;cursor:pointer;font-size:15px;line-height:1;">×</button>' +
      '</div>' +
      // Toolbar — filtry + przyciski
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:#13131f;border-bottom:1px solid #252540;flex-shrink:0;flex-wrap:wrap;">' +
        '<span style="font-size:10px;color:#6b7280;margin-right:2px;">Filtr:</span>' +
        _logpFilterChk('info',    '#9ca3af', 'info')    +
        _logpFilterChk('success', '#4ade80', 'success') +
        _logpFilterChk('warn',    '#fbbf24', 'warn')    +
        _logpFilterChk('error',   '#f87171', 'error')   +
        _logpFilterChk('diag',    '#f87171', 'diag')    +
        '<div style="flex:1;"></div>' +
        '<button id="b24t-logp-copy" style="background:#252540;border:1px solid #3d3d6b;color:#c4c4e0;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">📋 Kopiuj</button>' +
        '<button id="b24t-logp-csv" style="background:#252540;border:1px solid #3d3d6b;color:#c4c4e0;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">⬇ CSV</button>' +
      '</div>' +
      // Treść loga
      '<div id="b24t-logp-body" style="flex:1;overflow-y:auto;padding:8px 16px;background:#0f0f1e;">' +
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
      'font-family:\'Inter\', \'Segoe UI\', system-ui, sans-serif',
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
        '<button id="b24t-ap-close" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:14px;line-height:1;">×</button>' +
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
      const projects = getKnownProjects().filter(p => p._tagCount > 0);
      if (!projects.length) { addLog('Brak projektów z tym tagiem.', 'warn'); return; }
      const total = projects.reduce((s, p) => s + p._tagCount, 0);
      if (!confirm(`Usunąć ${total} wzmianek z tagiem "${tagName}" ze wszystkich ${projects.length} projektów?

To jest NIEODWRACALNE.`)) return;
      const btn = document.getElementById('b24t-ap-delete-all');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Usuwam...'; }
      for (const p of projects) {
        addLog(`→ Usuwam "${tagName}" z projektu ${p.name} (${p._tagCount} wzmianek)...`, 'info');
        // Przekaż projectId explicite — runDeleteByTag nie może używać state.projectId
        await runDeleteByTag(tagId, tagName, p._dateFrom, p._dateTo, (phase, cur, tot) => {
          if (btn) btn.textContent = `⏳ ${p.name}: ${phase === 'collect' ? 'zbieram' : cur + '/' + tot}`;
        }, p.id);
        addLog(`✓ ${p.name}: gotowe`, 'success');
      }
      if (btn) { btn.disabled = false; btn.textContent = '🗑 Usuń z wszystkich projektów'; }
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
            : '<div style="font-size:10px;color:var(--b24t-text-faint);">zakres: ' + (p._dateFrom || '?') + ' \u2192 ' + (p._dateTo || '?') + '</div>'
          ) +
        '</div>';
      }).join('');
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
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483648;display:flex;align-items:center;justify-content:center;font-family:\'Inter\',\'Segoe UI\',system-ui,sans-serif;';
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
          '<button id="b24t-grped-close" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:5px;padding:2px 8px;font-size:16px;cursor:pointer;">x</button>' +
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

  async function _fetchOverallStats(group) {
    var projects = lsGet(LS.PROJECTS, {});
    // Użyj tej samej logiki dat co zakładka Projekt — current month, wyjątek dla 1-2 dnia
    var dates = getAnnotatorDates();
    var dateFrom = dates.dateFrom;
    var dateTo   = dates.dateTo;
    addLog('→ [Overall] ' + group.name + ': pobieranie ' + group.projectIds.length + ' projektów (' + dateFrom + ' → ' + dateTo + ')...', 'info');
    var results = [];
    for (var i = 0; i < group.projectIds.length; i++) {
      var pid = group.projectIds[i];
      var pData = projects[pid];
      if (!pData) {
        addLog('[DIAG] _fetchOverallStats: projekt ID:' + pid + ' nieznany w LS.PROJECTS', 'diag');
        results.push({ pid: pid, name: 'ID:' + pid, error: 'projekt nieznany' }); continue;
      }
      var name = _pnResolve(pid);
      var tagIds   = pData.tagIds || {};
      // Szukamy reqVer i toDel w tagIds map
      var reqVerId = null, toDelId = null;
      Object.entries(tagIds).forEach(function(e) {
        if (e[0] === 'REQUIRES_VERIFICATION') reqVerId = e[1];
        if (e[0] === 'TO_DELETE') toDelId = e[1];
      });
      // Fallback do znanych ID
      if (!reqVerId) reqVerId = 1154586;
      if (!toDelId)  toDelId  = 1154757;
      var relTagId = group.relevantTagId || null;
      try {
        var queries = [
          getMentions(pid, dateFrom, dateTo, [], 1),   // total — bez filtra tagu
          relTagId ? getMentions(pid, dateFrom, dateTo, [relTagId], 1) : Promise.resolve({ count: null }),
          getMentions(pid, dateFrom, dateTo, [reqVerId], 1),
          getMentions(pid, dateFrom, dateTo, [toDelId],  1),
        ];
        var counts = await Promise.all(queries);
        results.push({
          pid: pid, name: name,
          total:    counts[0].count,
          relevant: counts[1].count,
          reqVer:   counts[2].count,
          toDelete: counts[3].count,
          dateFrom: dateFrom, dateTo: dateTo,
        });
        addLog('✓ [Overall] ' + name + ': ALL:' + counts[0].count + ' REQ:' + counts[2].count + ' DEL:' + counts[3].count, 'success');
      } catch(e) {
        addLog('✕ [DIAG] getMentions(' + pid + '): ' + e.message, 'diag');
        results.push({ pid: pid, name: name, error: e.message });
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
        if (fresh && dataEl.isConnected) renderOverallStatsData(dataEl, fresh.results, group, fresh);
      }).catch(function(){});
      return;
    }
    dataEl.innerHTML = '<div style="padding:20px 0;text-align:center;"><div style="font-size:22px;animation:b24t-spin 1s linear infinite;display:inline-block;">&#8635;</div><div style="font-size:11px;color:var(--b24t-text-faint);margin-top:8px;">Pobieram statystyki...</div></div>';
    var fresh = await _bgFetchOverallStats(group);
    if (fresh && dataEl.isConnected) renderOverallStatsData(dataEl, fresh.results, group, fresh);
  }

  function _statsCard(label, value, color, bgColor) {
    return '<div style="background:' + bgColor + ';border-radius:8px;padding:10px;text-align:center;">' +
      '<div style="font-size:11px;color:' + color + ';margin-bottom:4px;font-weight:600;">' + label + '</div>' +
      '<div style="font-size:22px;font-weight:800;color:' + color + ';">' + (value != null ? value : '—') + '</div>' +
    '</div>';
  }

  function renderOverallStatsData(el, results, group, cached) {
    if (!el) return;
    var hasRelevant = group.relevantTagId != null;
    var totalAll = 0, totalRelevant = 0, totalReqVer = 0, totalToDelete = 0;
    results.forEach(function(r) {
      if (!r.error) {
        if (r.total    != null) totalAll       += r.total;
        if (r.relevant != null) totalRelevant  += r.relevant;
        if (r.reqVer   != null) totalReqVer    += r.reqVer;
        if (r.toDelete != null) totalToDelete  += r.toDelete;
      }
    });
    // Kafelki — zawsze: Total + opcjonalnie Relevantne + zawsze REQ + DEL
    var cards = _statsCard('Wszystkie', totalAll, 'var(--b24t-text-muted)', 'var(--b24t-bg-elevated)');
    if (hasRelevant) cards += _statsCard('Relevantne', totalRelevant, '#16a34a', '#dcfce7');
    cards += _statsCard('Do weryfikacji', totalReqVer, '#d97706', '#fef3c7');
    cards += _statsCard('Do usunięcia', totalToDelete, '#dc2626', '#fee2e2');
    var colCount = hasRelevant ? 4 : 3;
    var warnHtml = !hasRelevant
      ? '<div style="margin-bottom:8px;padding:7px 10px;background:var(--b24t-warn-bg);border:1px solid color-mix(in srgb,var(--b24t-warn) 30%,transparent);border-radius:7px;font-size:11px;color:var(--b24t-warn);line-height:1.5;">Ustaw tag Relevantne w ustawieniach (⚙) aby widzieć pełne dane.</div>' : '';
    var thREL = hasRelevant ? '<th style="padding:6px 8px;font-size:10px;color:#16a34a;text-align:right;font-weight:600;">REL</th>' : '';
    var tableRows = results.map(function(r) {
      if (r.error) return '<tr><td style="padding:6px 8px;font-size:11px;color:var(--b24t-text);">' + r.name + '</td><td colspan="' + colCount + '" style="padding:6px 8px;font-size:10px;color:var(--b24t-err);">błąd: ' + r.error + '</td></tr>';
      var relTd = hasRelevant ? '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:#16a34a;text-align:right;">' + (r.relevant != null ? r.relevant : '—') + '</td>' : '';
      return '<tr style="border-top:1px solid var(--b24t-border-sub);">' +
        '<td style="padding:6px 8px;font-size:11px;color:var(--b24t-text);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + r.name + '">' + r.name + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:var(--b24t-text-muted);text-align:right;">' + (r.total != null ? r.total : '—') + '</td>' +
        relTd +
        '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:#d97706;text-align:right;">' + (r.reqVer  != null ? r.reqVer  : '—') + '</td>' +
        '<td style="padding:6px 8px;font-size:12px;font-weight:600;color:#dc2626;text-align:right;">' + (r.toDelete != null ? r.toDelete : '—') + '</td>' +
      '</tr>';
    }).join('');
    // Informacja o okresie — z cached lub z pierwszego wyniku
    var dateFrom = (cached && cached.dateFrom) || (results[0] && results[0].dateFrom) || '';
    var dateTo   = (cached && cached.dateTo)   || (results[0] && results[0].dateTo)   || '';
    var label    = (cached && cached.label)    || '';
    var periodHtml = (dateFrom && dateTo)
      ? '<div style="display:flex;align-items:center;gap:6px;padding:6px 0;margin-bottom:8px;border-bottom:1px solid var(--b24t-border-sub);">' +
          '<span style="font-size:11px;color:var(--b24t-text-faint);">📅 Okres:</span>' +
          '<span style="font-size:11px;font-weight:600;color:var(--b24t-text-muted);">' + (label ? label + ' ' : '') + '(' + dateFrom + ' → ' + dateTo + ')</span>' +
        '</div>'
      : '';
    el.innerHTML = periodHtml + warnHtml +
      '<div style="display:grid;grid-template-columns:' + (hasRelevant ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr') + ';gap:6px;margin-bottom:10px;">' + cards + '</div>' +
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
  }

  function showOverallStatsSettings(group) {
    if (!group) return;
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483648;display:flex;align-items:center;justify-content:center;font-family:\'Inter\',\'Segoe UI\',system-ui,sans-serif;';
    var tagOptions = Object.entries(state.tags).map(function(entry) {
      return '<option value="' + entry[1] + '"' + (entry[1] === group.relevantTagId ? ' selected' : '') + '>' + entry[0] + ' (ID: ' + entry[1] + ')</option>';
    }).join('');
    overlay.innerHTML =
      '<div style="background:var(--b24t-bg);border:1px solid var(--b24t-border);border-radius:14px;width:320px;box-shadow:var(--b24t-shadow-h);animation:b24t-slidein 0.25s cubic-bezier(0.34,1.56,0.64,1);">' +
        '<div style="padding:12px 16px;background:var(--b24t-accent-grad);border-radius:14px 14px 0 0;display:flex;align-items:center;gap:10px;">' +
          '<span style="font-size:14px;font-weight:700;color:#fff;flex:1;">&#9881; Ustawienia: ' + group.name + '</span>' +
          '<button id="b24t-os-close" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:5px;padding:2px 8px;font-size:16px;cursor:pointer;">x</button>' +
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
      }).catch(function(){});
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
        <div class="b24t-section-label" style="color:#f87171;">Usuń po tagu</div>
        <div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:10px;line-height:1.5;">
          Usuwa wzmianki z wybranym tagiem w aktualnym zakresie dat.
          <strong style="color:#f87171;">Operacja nieodwracalna.</strong>
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
            <span style="color:#444455;font-size:11px;">→</span>
            <input type="date" id="b24t-del-date-to" class="b24t-input" style="flex:1;">
          </div>
        </div>

        <!-- Progress -->
        <div class="b24t-progress-bar-track" style="margin-bottom:6px;">
          <div id="b24t-del-progress" style="height:100%;background:#f87171;border-radius:99px;width:0%;transition:width 0.3s;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-del-status" style="font-size:10px;color:var(--b24t-text-faint);min-height:14px;flex:1;"></div>
          <div id="b24t-del-timer" style="font-size:11px;color:#8888aa;font-family:'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;margin-left:8px;">00:00</div>
        </div>

        <!-- Run button -->
        <button class="b24t-btn-danger" id="b24t-del-run" style="width:100%;padding:8px;">
          🗑 Usuń wzmianki z tagiem
        </button>

        <div style="font-size:9px;color:#666688;text-align:center;margin-top:6px;">
          Ostrzeżenie pojawi się tylko przy pierwszym użyciu
        </div>
      </div>

      <!-- SEPARATOR -->
      <div style="height:1px;background:#1a1a22;margin:0 12px;"></div>

      <!-- DELETE CURRENT VIEW -->
      <div class="b24t-section">
        <div class="b24t-section-label" style="color:#f87171;">Usuń wyświetlane wzmianki</div>
        <div style="font-size:10px;color:var(--b24t-text-faint);margin-bottom:10px;line-height:1.5;">
          Usuwa wzmianki aktualnie widoczne w panelu Brand24
          (aktywne filtry, zakres dat, tagi itd.).
          <strong style="color:#f87171;">Operacja nieodwracalna.</strong>
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
          <div id="b24t-delview-progress" style="height:100%;background:#f87171;border-radius:99px;width:0%;transition:width 0.3s;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-delview-status" style="font-size:10px;color:var(--b24t-text-faint);min-height:14px;flex:1;"></div>
          <div id="b24t-delview-timer" style="font-size:11px;color:#8888aa;font-family:'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;margin-left:8px;">00:00</div>
        </div>

        <!-- Run button -->
        <button class="b24t-btn-danger" id="b24t-delview-run" style="width:100%;padding:8px;">
          🗑 Usuń wyświetlane wzmianki
        </button>
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
    return div;
  }

  function wireDeleteEvents(panel) {
    const delTab = panel.querySelector('#b24t-delete-tab');
    if (!delTab) return;

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
      el.innerHTML = `<span style="color:#666677;">Zakres:</span> ${d1} → ${d2}`;
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
        _bgFetchAllProjects(newTagId).catch(function(){});
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
      const delTimer = makeTabTimer('b24t-del-timer');
      delTimer.start();

      const setStatus = (msg, cls = '') => {
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = cls === 'error' ? '#f87171' : cls === 'success' ? '#4ade80' : '#9090aa'; }
      };
      const setProgress = (cur, total) => {
        if (progressEl && total > 0) progressEl.style.width = `${Math.round(cur / total * 100)}%`;
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
        for (const id of allIds) {
          await deleteMention(id);
          deleted++;
          setProgress(deleted, allIds.length);
          if (deleted % 5 === 0) setStatus(`Usunięto ${deleted}/${allIds.length}...`);
          await sleep(80);
        }

        setStatus(`✓ Usunięto ${deleted} wzmianek`, 'success');
        setProgress(1, 1);
        addLog(`✓ Quick Delete: ${deleted} wzmianek (tag "${tagName}")`, 'success');
      } catch (e) {
        setStatus(`✕ Błąd: ${e.message}`, 'error');
        addLog(`✕ Quick Delete błąd: ${e.message}`, 'error');
      } finally {
        delTimer.stop();
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
        const el = document.getElementById('b24t-delview-progress');
        if (el) el.style.width = total > 0 ? `${Math.round(cur / total * 100)}%` : '0%';
      };

      if (!state.projectId) { alert('Przejdź do projektu Brand24.'); return; }

      const confirmed = await confirmDeleteWarning();
      if (!confirmed) return;

      if (runBtn) runBtn.disabled = true;
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
        for (const id of ids) {
          await deleteMention(id);
          deleted++;
          setProgress(deleted, ids.length);
          if (deleted % 5 === 0) setStatus(`Usunięto ${deleted}/${ids.length}...`, 'info');
          await sleep(80);
        }

        setStatus(`✓ Usunięto ${deleted} wzmianek`, 'success');
        setProgress(1, 1);
        addLog(`✓ Delete view: usunięto ${deleted} wzmianek`, 'success');
      } catch (e) {
        setStatus(`✕ Błąd: ${e.message}`, 'error');
        addLog(`✕ Delete view błąd: ${e.message}`, 'error');
      } finally {
        delviewTimer.stop();
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
        el.innerHTML = `<span style="color:#666677;">Daty:</span> ${view.dateFrom} → ${view.dateTo}<br>` +
          `<span style="color:#666677;">Filtry tagów:</span> ${grNames}`;
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
      if (qtProgress) qtProgress.style.width = total > 0 ? `${Math.round(cur / total * 100)}%` : '0%';
    };

    if (qtBtn) qtBtn.disabled = true;
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

      // Tag in batches
      setStatus(`Tagowanie ${ids.length} wzmianek → ${tagName}...`, 'info');
      let tagged = 0;
      for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
        const slice = ids.slice(i, i + MAX_BATCH_SIZE);
        await bulkTagMentions(slice, tagId);
        tagged += slice.length;
        setProgress(tagged, ids.length);
        setStatus(`Otagowano ${tagged}/${ids.length}...`, 'info');
        await sleep(200);
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
          <div id="b24t-qt-progress" style="height:100%;background:#6c6cff;border-radius:99px;width:0%;transition:width 0.3s;"></div>
        </div>

        <!-- Status + timer -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-qt-status" class="b24t-qt-status" style="font-size:12px;color:var(--b24t-text-muted);min-height:16px;flex:1;"></div>
          <div id="b24t-qt-timer" style="font-size:13px;color:var(--b24t-text-muted);font-family:'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;margin-left:8px;font-weight:500;">00:00</div>
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
        <span style="color:#666677;">Daty:</span> ${d1} → ${d2}<br>
        <span style="color:#666677;">Filtry tagów:</span> ${grNames}<br>
        ${sq ? `<span style="color:#666677;">Szukaj:</span> "${sq}"<br>` : ''}
        <span style="color:#666677;">Aktualna strona:</span> ${p}
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
        for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
          await bulkUntagMentions(ids.slice(i, i + MAX_BATCH_SIZE), tagId);
          await sleep(200);
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
    setupDragging(panel);
    setupCollapse(panel);
    setupResize(panel, LS.UI_SIZE, { minW: 360, maxW: 720, minH: 380, maxH: Math.round(window.innerHeight * 0.92), useMaxHeight: true });
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
    setTimeout(() => showWhatsNewExtended(false), 2000);

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
