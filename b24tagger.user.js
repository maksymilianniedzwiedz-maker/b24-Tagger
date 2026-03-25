// ==UserScript==
// @name         B24 Tagger BETA
// @namespace    https://brand24.com
// @version      0.3.9
// @description  Automatyczne tagowanie wzmianek w Brand24 na podstawie pliku z labelkami
// @author       B24 Tagger
// @match        https://app.brand24.com/*
// @match        https://panel.brand24.pl/*
// @updateURL    https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js
// @downloadURL   https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect       hooks.slack.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // CONSTANTS & CONFIG
  // ─────────────────────────────────────────────────────────────────────────────

  const VERSION = '0.3.9';
  const LS = {
    SETUP_DONE:  'b24tagger_setup_done',
    PROJECTS:    'b24tagger_projects',
    SCHEMAS:     'b24tagger_schemas',
    JOBS:        'b24tagger_jobs',
    CRASHLOG:    'b24tagger_crashlog',
    UI_POS:      'b24tagger_ui_pos',
    UI_COLLAPSED:'b24tagger_ui_collapsed',
    PANEL_CORNER:     'b24tagger_panel_corner',
    DELETE_CONFIRMED: 'b24tagger_delete_confirmed',
    DELETE_AUTO:      'b24tagger_delete_auto',
    HISTORY:          'b24tagger_history',
  };
  const MAX_BATCH_SIZE = 1000;
  const HEALTH_CHECK_INTERVAL = 30000;
  const ACTION_TIMEOUT_WARN = 10000;
  const RETRY_DELAYS = [2000, 4000, 8000];

  // ─────────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────────

  const state = {
    status: 'idle',          // idle | running | paused | error | done
    lastMentionsVars: null,  // last organic getMentions variables from Brand24
    matchPreview: null,      // match preview result
    columnOverride: null,    // manual column mapping
    soundEnabled: false,     // play sound on done
    auditMode: false,        // audit compare mode
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

  // ─────────────────────────────────────────────────────────────────────────────
  // LOCAL STORAGE HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  const lsGet = (key, fallback = null) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };
  const lsSet = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // URL NORMALIZATION
  // ─────────────────────────────────────────────────────────────────────────────

  function normalizeUrl(url) {
    if (!url) return '';
    return url
      .replace(/^https?:\/\/(www\.)?/, '')
      .replace(/twitter\.com/, 'x.com')
      .replace(/\/status\//, '/statuses/')
      .replace(/\/$/, '')
      .toLowerCase()
      .trim();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TOKEN CAPTURE
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // GRAPHQL HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // API OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

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
    }`);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // FILE PARSING
  // ─────────────────────────────────────────────────────────────────────────────

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

  async function parseXLSX(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          // Simple XLSX parser using SheetJS-like approach
          // Since we can't import SheetJS in Tampermonkey easily,
          // we'll read the file as text and parse CSV-style
          // For now, signal that XLSX needs conversion
          resolve({ needsXLSX: true, data });
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function autoDetectColumns(rows) {
    if (!rows.length) return {};
    const headers = Object.keys(rows[0]);
    const detected = {};

    // Assessment column FIRST - detect before date to avoid false matches
    // Looks for columns with small set of distinct string values (labels)
    const assessmentCol = headers.find(h => {
      if (['assessment', 'label', 'ocena', 'flag', 'category', 'status'].includes(h.toLowerCase())) return true;
      const vals = new Set(rows.map(r => (r[h] || '').toString().trim()).filter(Boolean));
      const isLikelyLabel = vals.size >= 2 && vals.size <= 15 && rows.length > vals.size * 3;
      // Exclude columns that look like dates or IDs
      const sampleVal = [...vals][0] || '';
      const looksLikeDate = /\d{4}-\d{2}-\d{2}/.test(sampleVal);
      const looksLikeId = /^[a-f0-9]{20,}$/.test(sampleVal) || /^\d{15,}$/.test(sampleVal);
      return isLikelyLabel && !looksLikeDate && !looksLikeId;
    });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // URL MAP BUILDING
  // ─────────────────────────────────────────────────────────────────────────────

  // Fetch a single page with full getMentions query
  async function fetchMentionsPage(projectId, dateFrom, dateTo, gr, page) {
    return getMentions(projectId, dateFrom, dateTo, gr, page);
  }

  async function buildUrlMap(dateFrom, dateTo, untaggedOnly) {
    const gr = untaggedOnly ? [state.untaggedId] : [];
    const map = {};
    const CONCURRENCY = 10; // parallel requests per batch

    updateProgress('map', 0, '?');
    addLog(`→ Budowanie mapy URL (${untaggedOnly ? 'Untagged' : 'pełny zakres'}) [${CONCURRENCY}x równolegle]`, 'info');

    // Step 1: fetch page 1 to get total count and pageSize
    const first = await fetchMentionsPage(state.projectId, dateFrom, dateTo, gr, 1);
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
        batch.map(p => fetchMentionsPage(state.projectId, dateFrom, dateTo, gr, p))
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


  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN TAGGING FLOW
  // ─────────────────────────────────────────────────────────────────────────────

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
      const entry = state.urlMap[normalizedUrl];

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

  // ─────────────────────────────────────────────────────────────────────────────
  // PARTITION MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN RUN LOOP
  // ─────────────────────────────────────────────────────────────────────────────

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
      saveSessionToHistory();
      if (state.soundEnabled) playDoneSound();
      showFinalReport();
      clearCheckpoint();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NAVIGATION HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // CHECKPOINT & CRASH LOG
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // HEALTH CHECK
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // SESSION TIMER
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────────────────────────────────────

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
    log.scrollTop = log.scrollHeight;

    // Keep max 200 entries in DOM
    while (log.children.length > 200) log.removeChild(log.firstChild);
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

  // ─────────────────────────────────────────────────────────────────────────────
  // UI HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // EXPORT
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG BRIDGE
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // UI - STYLES
  // ─────────────────────────────────────────────────────────────────────────────

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* === B24 TAGGER PANEL === */
      #b24t-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 440px;
        background: #0f0f13;
        border: 1px solid #2a2a35;
        border-radius: 12px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 13px;
        color: #e2e2e8;
        z-index: 2147483647;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
        user-select: none;
        overflow: hidden;
        transition: box-shadow 0.2s;
      }
      #b24t-panel:hover { box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06); }
      #b24t-panel.dragging { opacity: 0.92; box-shadow: 0 20px 60px rgba(0,0,0,0.8); }

      /* Topbar */
      #b24t-topbar {
        display: flex;
        align-items: center;
        padding: 10px 12px;
        background: #141419;
        border-bottom: 1px solid #1e1e28;
        cursor: grab;
        gap: 8px;
      }
      #b24t-topbar:active { cursor: grabbing; }
      .b24t-logo {
        font-size: 12px;
        font-weight: 700;
        color: #6c6cff;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        flex-shrink: 0;
      }
      .b24t-version { font-size: 9px; color: #7878aa; margin-left: 4px; }
      #b24t-topbar-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }
      .b24t-badge {
        font-size: 9px;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 99px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .badge-idle    { background: #1e1e28; color: #b8b8d8; }
      .badge-running { background: #0d3320; color: #4ade80; }
      .badge-paused  { background: #2a2500; color: #facc15; }
      .badge-error   { background: #2d1010; color: #f87171; }
      .badge-done    { background: #0d2240; color: #60a5fa; }

      .b24t-icon-btn {
        background: none; border: none; color: #7878aa;
        cursor: pointer; padding: 3px 5px; border-radius: 4px;
        font-size: 13px; line-height: 1;
        transition: color 0.15s, background 0.15s;
      }
      .b24t-icon-btn:hover { color: #b0b0cc; background: #1e1e28; }

      /* Token status */
      #b24t-meta-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 5px 12px;
        background: #0c0c10;
        border-bottom: 1px solid #1a1a22;
        font-size: 11px;
      }
      .b24t-token-ok      { color: #4ade80; }
      .b24t-token-pending { color: #facc15; }
      .b24t-token-error   { color: #f87171; }
      #b24t-session-timer { color: #b8b8d8; font-size: 11px; }

      /* Body */
      #b24t-body { overflow-y: auto; max-height: 72vh; }
      #b24t-body::-webkit-scrollbar { width: 3px; }
      #b24t-body::-webkit-scrollbar-track { background: #0f0f13; }
      #b24t-body::-webkit-scrollbar-thumb { background: #2a2a35; border-radius: 99px; }

      /* Sections */
      .b24t-section {
        padding: 10px 12px;
        border-bottom: 1px solid #1a1a22;
      }
      .b24t-section-label {
        font-size: 11px; font-weight: 600; color: #6666aa;
        text-transform: uppercase; letter-spacing: 0.1em;
        margin-bottom: 8px;
      }
      .b24t-project-name { font-size: 14px; font-weight: 600; color: #c0c0e0; }
      .b24t-project-meta { font-size: 11px; color: #b8b8d8; margin-top: 3px; }

      /* File zone */
      .b24t-file-zone {
        border: 1px dashed #2a2a35; border-radius: 6px;
        padding: 8px 10px; cursor: pointer;
        display: flex; align-items: center; gap: 8px;
        transition: border-color 0.15s, background 0.15s;
      }
      .b24t-file-zone:hover { border-color: #6c6cff; background: #13131a; }
      .b24t-file-icon { font-size: 16px; flex-shrink: 0; }
      .b24t-file-name { font-size: 13px; color: #c0c0e0; font-weight: 500; }
      .b24t-file-meta { font-size: 11px; color: #b8b8d8; }
      .b24t-date-range {
        display: flex; align-items: center; gap: 6px;
        margin-top: 6px; font-size: 10px; color: #b8b8d8;
      }
      .b24t-date-chip {
        background: #1a1a22; border: 1px solid #2a2a35;
        border-radius: 99px; padding: 2px 8px;
        color: #aaaacc; font-size: 11px;
      }

      /* Mapping */
      .b24t-map-row {
        display: grid; grid-template-columns: 1fr 1fr 80px;
        gap: 4px; margin-bottom: 4px; align-items: center;
      }
      .b24t-map-label { font-size: 12px; color: #b0b0cc; truncate: ellipsis; overflow: hidden; white-space: nowrap; }
      .b24t-map-count { font-size: 11px; color: #b8b8d8; }
      .b24t-select {
        background: #1a1a22; border: 1px solid #2a2a35;
        color: #c0c0e0; border-radius: 4px; font-size: 12px;
        padding: 3px 4px; width: 100%; cursor: pointer;
        font-family: inherit;
      }
      .b24t-select:focus { outline: none; border-color: #6c6cff; }
      .b24t-add-tag-btn {
        font-size: 10px; color: #6c6cff; background: none; border: none;
        cursor: pointer; padding: 2px 0; text-align: left;
        margin-top: 4px;
      }
      .b24t-add-tag-btn:hover { color: #9090ff; }

      /* Toggle rows */
      .b24t-toggle-row {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 4px;
      }
      .b24t-toggle-label { font-size: 12px; color: #b0b0cc; }
      .b24t-radio-group { display: flex; gap: 12px; }
      .b24t-radio { display: flex; align-items: center; gap: 4px; cursor: pointer; }
      .b24t-radio input { accent-color: #6c6cff; cursor: pointer; }
      .b24t-radio span { font-size: 12px; color: #b0b0cc; }
      .b24t-checkbox-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .b24t-checkbox-row input { accent-color: #6c6cff; cursor: pointer; }
      .b24t-checkbox-row label { font-size: 12px; color: #b0b0cc; cursor: pointer; }
      .b24t-select-inline {
        background: #1a1a22; border: 1px solid #2a2a35;
        color: #a0a0c0; border-radius: 4px; font-size: 10px;
        padding: 2px 4px; cursor: pointer; font-family: inherit;
        margin-left: 4px;
      }

      /* Progress */
      .b24t-progress-bar-track {
        height: 3px; background: #1a1a22; border-radius: 99px;
        overflow: hidden; margin: 6px 0 4px;
      }
      #b24t-progress-bar {
        height: 100%; background: #6c6cff;
        border-radius: 99px; width: 0%;
        transition: width 0.3s ease;
      }
      #b24t-progress-label { font-size: 10px; color: #b8b8d8; }
      #b24t-progress-action { font-size: 10px; color: #7878aa; margin-top: 2px; }

      /* Stats */
      .b24t-stats-grid {
        display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;
      }
      .b24t-stat-card {
        background: #141419; border: 1px solid #1e1e28;
        border-radius: 6px; padding: 6px 8px;
      }
      .b24t-stat-label { font-size: 11px; color: #b8b8d8; margin-bottom: 3px; }
      .b24t-stat-value { font-size: 18px; font-weight: 600; color: #a0a0c0; }
      .b24t-stat-value.ok  { color: #4ade80; }
      .b24t-stat-value.warn { color: #facc15; }

      /* Log */
      #b24t-log {
        height: 120px; overflow-y: auto;
        font-size: 11px; line-height: 1.6;
      }
      #b24t-log::-webkit-scrollbar { width: 3px; }
      #b24t-log::-webkit-scrollbar-thumb { background: #2a2a35; }
      .b24t-log-entry { display: flex; gap: 6px; padding: 1px 0; }
      .b24t-log-time { color: #8888aa; flex-shrink: 0; }
      .b24t-log-msg  { color: #aaaacc; flex: 1; }
      .b24t-log-elapsed { color: #7878aa; font-size: 9px; flex-shrink: 0; }
      .b24t-log-success .b24t-log-msg { color: #4ade80; }
      .b24t-log-error   .b24t-log-msg { color: #f87171; }
      .b24t-log-warn    .b24t-log-msg { color: #facc15; }
      .b24t-log-info    .b24t-log-msg { color: #b0b0cc; }
      .b24t-log-clear { font-size: 9px; color: #7878aa; background: none; border: none; cursor: pointer; float: right; }
      .b24t-log-clear:hover { color: #b0b0cc; }

      /* Action bar */
      #b24t-actions {
        display: flex; gap: 6px; padding: 10px 12px;
        background: #0c0c10;
        border-top: 1px solid #1a1a22;
      }
      .b24t-btn-primary {
        flex: 1; background: #6c6cff; color: #fff;
        border: none; border-radius: 6px; padding: 8px 0;
        font-size: 12px; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: background 0.15s, transform 0.1s;
      }
      .b24t-btn-primary:hover { background: #8080ff; }
      .b24t-btn-primary:active { transform: scale(0.97); }
      .b24t-btn-primary:disabled { background: #2a2a35; color: #7878aa; cursor: not-allowed; }
      .b24t-btn-secondary {
        flex: 1; background: #1a1a22; color: #aaaacc;
        border: 1px solid #2a2a35; border-radius: 6px; padding: 8px 0;
        font-size: 12px; cursor: pointer; font-family: inherit;
        transition: background 0.15s;
      }
      .b24t-btn-secondary:hover { background: #22222c; }
      .b24t-btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
      .b24t-btn-danger {
        flex: 1; background: #2d1010; color: #f87171;
        border: 1px solid #3d1515; border-radius: 6px; padding: 8px 0;
        font-size: 12px; cursor: pointer; font-family: inherit;
        transition: background 0.15s;
      }
      .b24t-btn-danger:hover { background: #3d1515; }
      .b24t-btn-warn {
        background: #2a2000; color: #facc15;
        border: 1px solid #3a3000; border-radius: 6px; padding: 6px 12px;
        font-size: 11px; cursor: pointer; font-family: inherit;
      }

      /* Crash banner */
      #b24t-crash-banner {
        display: none; margin: 8px 12px;
        background: #1a0808; border: 1px solid #3d1515;
        border-radius: 6px; padding: 8px 10px;
        font-size: 10px; color: #f87171;
      }
      .b24t-crash-actions { display: flex; gap: 6px; margin-top: 6px; }
      .b24t-crash-detail-toggle {
        font-size: 9px; color: #7878aa; background: none; border: none;
        cursor: pointer; padding: 0;
      }
      .b24t-crash-detail {
        display: none; font-size: 9px; color: #7878aa;
        background: #0c0c10; border-radius: 4px; padding: 6px;
        margin-top: 6px; white-space: pre-wrap; max-height: 80px; overflow-y: auto;
      }

      /* Tabs */
      #b24t-tabs {
        display: flex; background: #0c0c10;
        border-bottom: 1px solid #1a1a22;
      }
      .b24t-tab {
        flex: 1; background: none; border: none;
        color: #b8b8d8; font-size: 12px; font-weight: 500;
        padding: 8px 0; cursor: pointer; font-family: inherit;
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
      }
      .b24t-tab:hover { color: #b0b0cc; }
      .b24t-tab.b24t-tab-active { color: #6c6cff; border-bottom-color: #6c6cff; }

      /* Collapsed hides tabs too */
      #b24t-panel.collapsed #b24t-tabs { display: none; }

      #b24t-panel.collapsed #b24t-body,
      #b24t-panel.collapsed #b24t-actions,
      #b24t-panel.collapsed #b24t-meta-bar { display: none; }

      /* Modal */
      .b24t-modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647;
      }
      .b24t-modal {
        background: #0f0f13; border: 1px solid #2a2a35;
        border-radius: 12px; padding: 20px; width: 320px;
        font-family: 'SF Mono', monospace;
      }
      .b24t-modal-title { font-size: 13px; font-weight: 600; color: #facc15; margin-bottom: 12px; }
      .b24t-modal-text { font-size: 11px; color: #b0b0cc; line-height: 1.6; margin-bottom: 16px; }
      .b24t-modal-text strong { color: #c0c0d0; }
      .b24t-modal-actions { display: flex; gap: 6px; flex-wrap: wrap; }

      /* Report modal */
      #b24t-report-modal {
        display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,0.7);
        align-items: center; justify-content: center;
        z-index: 2147483647;
      }
      .b24t-report-content {
        background: #0f0f13; border: 1px solid #2a2a35;
        border-radius: 12px; padding: 24px; width: 280px;
        font-family: 'SF Mono', monospace;
      }
      .b24t-report-content h3 { font-size: 14px; color: #6c6cff; margin-bottom: 16px; }
      .b24t-report-row {
        display: flex; justify-content: space-between;
        padding: 6px 0; border-bottom: 1px solid #1a1a22;
        font-size: 11px; color: #b8b8d8;
      }
      .b24t-report-row strong { color: #a0a0c0; }
      .b24t-report-content button { margin-top: 12px; width: 100%; }

      /* Input */
      .b24t-input {
        background: #1a1a22; border: 1px solid #2a2a35;
        color: #a0a0c0; border-radius: 4px; font-size: 11px;
        padding: 5px 8px; width: 100%; font-family: inherit;
        box-sizing: border-box;
      }
      .b24t-input:focus { outline: none; border-color: #6c6cff; }

      /* Setup wizard */
      #b24t-setup {
        position: fixed; inset: 0; background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483647; font-family: 'SF Mono', monospace;
      }
      .b24t-setup-card {
        background: #0f0f13; border: 1px solid #2a2a35;
        border-radius: 16px; width: 480px; max-height: 90vh;
        overflow-y: auto; padding: 28px;
      }
      .b24t-setup-card::-webkit-scrollbar { width: 3px; }
      .b24t-setup-card::-webkit-scrollbar-thumb { background: #2a2a35; }
      .b24t-setup-header { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
      .b24t-setup-logo { font-size: 14px; font-weight: 700; color: #6c6cff; letter-spacing: 0.1em; }
      .b24t-setup-step { font-size: 11px; color: #7878aa; margin-left: auto; }
      .b24t-progress-dots { display: flex; gap: 4px; margin-bottom: 24px; }
      .b24t-dot { width: 6px; height: 6px; border-radius: 50%; background: #1e1e28; }
      .b24t-dot.active { background: #6c6cff; }
      .b24t-dot.done { background: #4ade80; }
      .b24t-setup-title { font-size: 16px; color: #e2e2e8; margin-bottom: 6px; }
      .b24t-setup-desc { font-size: 11px; color: #7878aa; margin-bottom: 20px; line-height: 1.6; }
      .b24t-check-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 0; font-size: 11px;
      }
      .b24t-check-icon { flex-shrink: 0; }
      .b24t-check-label { color: #b0b0cc; }
      .b24t-check-ok { color: #4ade80; }
      .b24t-check-fail { color: #f87171; }
      .b24t-check-wait { color: #facc15; }
      .b24t-setup-nav { display: flex; justify-content: space-between; margin-top: 24px; gap: 8px; }
    `;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UI - HTML
  // ─────────────────────────────────────────────────────────────────────────────

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'b24t-panel';

    panel.innerHTML = `
      <!-- TOPBAR -->
      <div id="b24t-topbar">
        <span class="b24t-logo">B24 Tagger <span style="font-size:9px;color:#6c6cff;letter-spacing:0.08em;">BETA</span></span>
        <span class="b24t-version">v${VERSION}</span>
        <div id="b24t-topbar-right">
          <span id="b24t-status-badge" class="b24t-badge badge-idle">Idle</span>
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
      <div id="b24t-subbar" style="display:flex;align-items:center;justify-content:space-between;padding:4px 12px;background:#0a0a0d;border-bottom:1px solid #1a1a22;">
        <button class="b24t-icon-btn" id="b24t-btn-changelog" title="Changelog & Feedback" style="font-size:10px;letter-spacing:0.03em;color:#6c6cff;padding:3px 8px;border:1px solid #6c6cff33;border-radius:4px;">📋 Changelog & Feedback</button>
        <div style="display:flex;align-items:center;gap:8px;">
          <div id="b24t-token-status-sub" style="font-size:9px;"></div>
          <div id="b24t-session-timer-sub" style="font-size:10px;color:#444466;font-family:'SF Mono',monospace;"></div>
        </div>
      </div>

      <div id="b24t-tabs">
        <button class="b24t-tab b24t-tab-active" data-tab="main">📄 Plik</button>
        <button class="b24t-tab" data-tab="quicktag">⚡ Quick Tag</button>
        <button class="b24t-tab" data-tab="delete">🗑 Quick Delete</button>
        <button class="b24t-tab" data-tab="history">📋 Historia</button>
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
        <div id="b24t-file-validation" style="display:none;margin-top:8px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;"></div>

        <!-- COLUMN OVERRIDE -->
        <div id="b24t-column-override-section" style="display:none;margin-top:8px;">
          <button id="b24t-col-override-toggle" style="font-size:10px;color:#7878aa;background:none;border:none;cursor:pointer;padding:0;">&#9881; Zmien wykryte kolumny &#9660;</button>
          <div id="b24t-column-override" style="display:none;margin-top:6px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;"></div>
        </div>

        <!-- MATCH PREVIEW -->
        <div id="b24t-match-preview" style="display:none;margin-top:8px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:10px;"></div>

        <!-- FILE VALIDATION -->
        <div id="b24t-file-validation" style="display:none;margin-top:8px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;"></div>

        <!-- COLUMN OVERRIDE -->
        <div id="b24t-column-override-section" style="display:none;margin-top:6px;">
          <button id="b24t-col-override-toggle" style="font-size:10px;color:#7878aa;background:none;border:none;cursor:pointer;padding:2px 0;">⚙ Zmień wykryte kolumny ▾</button>
          <div id="b24t-column-override" style="display:none;margin-top:6px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;"></div>
        </div>

        <!-- MATCH PREVIEW -->
        <div id="b24t-match-preview" style="display:none;margin-top:8px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:10px;"></div>

        <!-- PARTYCJE -->
        <div class="b24t-section" id="b24t-partition-section" style="display:none">
          <div class="b24t-section-label">Partycje</div>
          <div id="b24t-partition-info" style="font-size:11px;color:#9090aa;margin-bottom:6px;"></div>
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

          <div style="height:1px;background:#1e1e28;margin:8px 0;"></div>
          <div class="b24t-checkbox-row">
            <input type="checkbox" id="b24t-sound-cb">
            <label for="b24t-sound-cb">Dźwięk po zakończeniu sesji</label>
          </div>
        </div>

        <!-- POSTĘP -->
        <div class="b24t-section" id="b24t-progress-section">
          <div class="b24t-section-label">Postęp</div>
          <div id="b24t-progress-label" style="font-size:12px;color:#9090aa;">Gotowy do startu</div>
          <div class="b24t-progress-bar-track"><div id="b24t-progress-bar"></div></div>
          <div id="b24t-progress-action" style="font-size:10px;color:#7878aa;"></div>
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

      <!-- HISTORY TAB (injected by JS) -->
      <div id="b24t-history-tab-placeholder"></div>

      </div><!-- /body -->

      <!-- ACTION BAR -->
      <div id="b24t-actions" style="flex-direction:column;gap:6px;">
        <div style="display:flex;gap:6px;width:100%;">
          <button class="b24t-btn-primary" id="b24t-btn-start" style="flex:2;">▶ Start</button>
          <button class="b24t-btn-secondary" id="b24t-btn-preview" title="Match Preview — sprawdź dopasowanie bez tagowania" style="flex:1;font-size:11px;">Match</button>
          <button class="b24t-btn-secondary" id="b24t-btn-audit" title="Audit Mode — porównaj bez tagowania" style="flex:1;font-size:11px;color:#9090ff;">Audit</button>
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

  // ─────────────────────────────────────────────────────────────────────────────
  // UI - DRAGGING & COLLAPSING
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // UI - EVENT WIRING
  // ─────────────────────────────────────────────────────────────────────────────

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
      if (!box || !btn) return;
      const show = box.style.display === 'none';
      box.style.display = show ? 'block' : 'none';
      btn.innerHTML = (show ? '&#9881; Zmien wykryte kolumny &#9650;' : '&#9881; Zmien wykryte kolumny &#9660;');
      if (show && state.file && state.file.rows) buildColumnOverrideUI(state.file.rows);
    });

    // Sound checkbox
    panel.querySelector('#b24t-sound-cb')?.addEventListener('change', (e) => {
      state.soundEnabled = e.target.checked;
    });

    // Match Preview
    panel.querySelector('#b24t-btn-preview')?.addEventListener('click', async () => {
      if (!state.file) { addLog('Wgraj plik przed Match Preview.', 'warn'); return; }
      if (!state.tokenHeaders) { addLog('Token nie jest gotowy.', 'warn'); return; }
      const preview = await runMatchPreview();
      if (preview) renderMatchPreview(preview);
    });

    // Audit Mode
    panel.querySelector('#b24t-btn-audit')?.addEventListener('click', async () => {
      if (!state.file) { addLog('Wgraj plik przed Audit Mode.', 'warn'); return; }
      if (!Object.keys(state.mapping).length) { addLog('Skonfiguruj mapowanie przed Audit Mode.', 'warn'); return; }
      if (state.status === 'running') { addLog('Sesja już uruchomiona.', 'warn'); return; }
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

    // Help
    panel.querySelector('#b24t-btn-help').addEventListener('click', showHelp);

    // Changelog / What's New
    panel.querySelector('#b24t-btn-changelog')?.addEventListener('click', () => showWhatsNewExtended(true));

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

  // ─────────────────────────────────────────────────────────────────────────────
  // FILE HANDLING
  // ─────────────────────────────────────────────────────────────────────────────

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
    // Load SheetJS from CDN dynamically
    return new Promise((resolve, reject) => {
      if (window.XLSX) {
        readWithSheetJS(file, resolve, reject);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = () => readWithSheetJS(file, resolve, reject);
      script.onerror = () => reject(new Error('Nie można załadować parsera XLSX. Sprawdź połączenie.'));
      document.head.appendChild(script);
    });
  }

  function readWithSheetJS(file, resolve, reject) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = window.XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { defval: '' });
        // Normalize date fields
        rows.forEach(row => {
          Object.keys(row).forEach(k => {
            if (row[k] instanceof Date) {
              row[k] = row[k].toISOString().substring(0, 10);
            }
          });
        });
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SCHEMA MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // MAPPING UI
  // ─────────────────────────────────────────────────────────────────────────────

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
        <div style="font-size:10px;color:#7878aa;grid-column:span 2;">Pomiń ℹ</div>
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

  // ─────────────────────────────────────────────────────────────────────────────
  // INIT RUN
  // ─────────────────────────────────────────────────────────────────────────────

  async function initRun() {
    if (!state.file) { showError('Najpierw wgraj plik z wzmiankami.'); return; }
    if (!Object.keys(state.mapping).length) { showError('Skonfiguruj mapowanie labelek.'); return; }
    if (!state.projectId) { showError('Przejdź do zakładki Mentions projektu Brand24.'); return; }
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

  // ─────────────────────────────────────────────────────────────────────────────
  // PROJECT DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  async function detectProject() {
    const projectId = getProjectId();
    if (!projectId) return;

    state.projectId = projectId;
    state.projectName = document.title.split(' - ')[0].trim() || `Project ${projectId}`;

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

  // ─────────────────────────────────────────────────────────────────────────────
  // HELP / TUTORIAL
  // ─────────────────────────────────────────────────────────────────────────────

  function showHelp() {
    const modal = document.createElement('div');
    modal.className = 'b24t-modal-overlay';
    modal.innerHTML = `
      <div class="b24t-modal" style="width:400px;max-height:80vh;overflow-y:auto;">
        <div class="b24t-modal-title" style="color:#6c6cff;">B24 Tagger — Pomoc</div>
        <div class="b24t-modal-text">
          <strong>Jak używać:</strong><br>
          1. Przejdź do widoku Mentions projektu w Brand24<br>
          2. Wgraj plik CSV/JSON/XLSX z labelkami<br>
          3. Skonfiguruj mapowanie labelek → tagi<br>
          4. Kliknij <strong>Start</strong> (lub najpierw Test Run)<br><br>

          <strong>Tryby:</strong><br>
          • <strong>Test Run</strong> — symulacja bez zapisu tagów<br>
          • <strong>Właściwy</strong> — prawdziwe tagowanie<br><br>

          <strong>Mapa wzmianek:</strong><br>
          • <strong>Untagged</strong> — szybszy, tylko nieoznaczone<br>
          • <strong>Pełna</strong> — wszystkie wzmianki w zakresie dat<br><br>

          <strong>Debug (dla programistów):</strong><br>
          W konsoli przeglądarki wpisz:<br>
          <code style="color:#4ade80;">window.B24Tagger.debug.getState()</code><br>
          <code style="color:#4ade80;">window.B24Tagger.debug.testGraphQL()</code><br>
          <code style="color:#4ade80;">window.B24Tagger.debug.getLogs()</code><br><br>

          <strong>Wersja:</strong> ${VERSION}
        </div>
        <button class="b24t-btn-secondary" onclick="this.closest('.b24t-modal-overlay').remove()" style="width:100%;margin-top:8px;">Zamknij</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SETUP CHECK (first run)
  // ─────────────────────────────────────────────────────────────────────────────

  function showSetupWizard(onComplete) {
    let step = 0;
    const steps = [
      {
        title: 'Witaj w B24 Tagger',
        desc: 'Automatyczne tagowanie wzmianek Brand24 na podstawie pliku z labelkami. Skonfigurujmy wtyczkę — zajmie to chwilę.',
        checks: [],
        next: 'Dalej →',
      },
      {
        title: 'Weryfikacja środowiska',
        desc: 'Sprawdzam czy wszystko jest gotowe do pracy.',
        checks: [
          { label: 'Strona Brand24', check: () => window.location.hostname.includes('brand24') },
          { label: 'Widok Mentions (przejdź do projektu)', check: () => !!getProjectId() },
          { label: 'Token API (poczekaj chwilę)', check: () => !!state.tokenHeaders },
        ],
        next: 'Kontynuuj →',
      },
      {
        title: 'Format pliku',
        desc: 'Wtyczka przyjmuje pliki CSV, JSON lub XLSX.\n\nWymagane kolumny: url (adres wzmianki), assessment (labelka np. RELEVANT / IRRELEVANT).\nOpcjonalne: created_date, text, id.\n\nWtyczka automatycznie wykrywa kolumny — możesz też ustawić je ręcznie po wgraniu pliku.',
        checks: [],
        next: 'Rozumiem →',
      },
      {
        title: 'Mapowanie i narzędzia',
        desc: 'Po wgraniu pliku:\n• Dopasuj każdą labelkę do tagu Brand24 (wtyczka zapamięta wybór)\n• Użyj Match Preview żeby sprawdzić % dopasowania przed startem\n• Użyj Audit Mode żeby porównać plik z Brand24 bez tagowania\n\nW zakładkach Quick Tag i Quick Delete możesz tagować i usuwać wzmianki bez pliku — na podstawie aktualnego widoku Brand24.',
        checks: [],
        next: 'Rozumiem →',
      },
      {
        title: 'Historia i feedback',
        desc: 'Zakładka Historia przechowuje ostatnie 20 sesji z pełnymi statystykami.\n\nPrzycisk ZMIANY w panelu otwiera dziennik zmian i planowane funkcje.\n\nMożesz też wysłać nam feedback bezpośrednio na Slack — kliknij ZMIANY → zakładka Feedback.',
        checks: [],
        next: 'Rozumiem →',
      },
      {
        title: 'Gotowy do pracy!',
        desc: 'Zawsze zacznij od Test Run żeby sprawdzić czy matching działa poprawnie przed właściwą sesją.\n\nPrzycisk ? w panelu otworzy tę pomoc ponownie w każdej chwili.',
        checks: [],
        next: 'Zacznijmy!',
      },
    ];

    const overlay = document.createElement('div');
    overlay.id = 'b24t-setup';

    const render = () => {
      const s = steps[step];
      const dots = steps.map((_, i) =>
        `<div class="b24t-dot ${i < step ? 'done' : i === step ? 'active' : ''}"></div>`
      ).join('');

      // Run checks
      const checkHtml = s.checks.map(c => {
        const ok = c.check();
        return `<div class="b24t-check-row">
          <span class="b24t-check-icon ${ok ? 'b24t-check-ok' : 'b24t-check-fail'}">${ok ? '✓' : '✗'}</span>
          <span class="b24t-check-label">${c.label}</span>
        </div>`;
      }).join('');

      const canContinue = s.checks.length === 0 || s.checks.every(c => c.check());

      overlay.innerHTML = `
        <div class="b24t-setup-card">
          <div class="b24t-setup-header">
            <span class="b24t-setup-logo">B24 TAGGER</span>
            <span class="b24t-setup-step">Krok ${step + 1} z ${steps.length}</span>
          </div>
          <div class="b24t-progress-dots">${dots}</div>
          <div class="b24t-setup-title">${s.title}</div>
          <div class="b24t-setup-desc" style="white-space:pre-line;">${s.desc}</div>
          ${checkHtml}
          <div class="b24t-setup-nav">
            ${step > 0 ? '<button class="b24t-btn-secondary" id="b24t-setup-back" style="flex:0.5;">← Wstecz</button>' : '<div></div>'}
            <button class="b24t-btn-primary" id="b24t-setup-next" ${canContinue ? '' : 'disabled'}>${s.next}</button>
          </div>
        </div>
      `;

      overlay.querySelector('#b24t-setup-next').addEventListener('click', () => {
        if (step < steps.length - 1) { step++; render(); }
        else {
          overlay.remove();
          lsSet(LS.SETUP_DONE, true);
          onComplete();
        }
      });

      const backBtn = overlay.querySelector('#b24t-setup-back');
      if (backBtn) backBtn.addEventListener('click', () => { step--; render(); });

      // Auto-refresh checks every second on step 1
      if (step === 1 && !canContinue) {
        setTimeout(() => { if (overlay.isConnected) render(); }, 1000);
      }
    };

    render();
    document.body.appendChild(overlay);
  }


  // ─────────────────────────────────────────────────────────────────────────────
  // F1 - MATCH PREVIEW
  // ─────────────────────────────────────────────────────────────────────────────

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
      matched, unmatched, noAssessment, unmatchedList,
      total: state.file.rows.length,
      pct: Math.round(matched / Math.max(1, matched + unmatched) * 100),
    };
    return state.matchPreview;
  }

  function renderMatchPreview(preview) {
    const el = document.getElementById('b24t-match-preview');
    if (!el) return;
    const color = preview.pct >= 80 ? '#4ade80' : preview.pct >= 50 ? '#facc15' : '#f87171';
    el.style.display = 'block';
    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<span style="font-size:11px;color:#b0b0cc;font-weight:600;">Match Preview</span>' +
        '<span style="font-size:14px;font-weight:700;color:' + color + ';">' + preview.pct + '%</span>' +
      '</div>' +
      '<div style="display:flex;gap:10px;font-size:10px;margin-bottom:6px;">' +
        '<span style="color:#4ade80;">✓ ' + preview.matched + ' matched</span>' +
        '<span style="color:#f87171;">✗ ' + preview.unmatched + ' brak</span>' +
        (preview.noAssessment ? '<span style="color:#7878aa;">~ ' + preview.noAssessment + ' bez labelki</span>' : '') +
      '</div>' +
      '<div style="height:4px;background:#1a1a22;border-radius:99px;overflow:hidden;margin-bottom:6px;">' +
        '<div style="height:100%;width:' + preview.pct + '%;background:' + color + ';border-radius:99px;transition:width 0.4s;"></div>' +
      '</div>' +
      (preview.unmatched > 0
        ? '<button id="b24t-preview-btn" style="font-size:10px;color:#7878aa;background:none;border:none;cursor:pointer;padding:0;">Pokaż niezmatched (' + Math.min(preview.unmatched, 50) + ') \u25be</button>' +
          '<div id="b24t-preview-list" style="display:none;max-height:80px;overflow-y:auto;margin-top:4px;font-size:9px;color:#555588;line-height:1.6;">' +
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

  // ─────────────────────────────────────────────────────────────────────────────
  // F2 - MANUAL COLUMN MAPPING
  // ─────────────────────────────────────────────────────────────────────────────

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
    let html = '<div style="font-size:10px;color:#7878aa;margin-bottom:6px;">Kolumny wykryte automatycznie. Zmień jeśli coś się nie zgadza:</div>';
    roles.forEach(function(r) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
      html += '<span style="font-size:10px;color:#b0b0cc;width:140px;flex-shrink:0;">' + r.label + ':</span>';
      html += '<select class="b24t-select b24t-col-sel" data-role="' + r.key + '" style="flex:1;"><option value="">— brak —</option>';
      headers.forEach(function(h) {
        html += '<option value="' + h + '"' + (detected[r.key] === h ? ' selected' : '') + '>' + h + '</option>';
      });
      html += '</select></div>';
    });
    html += '<div id="b24t-col-preview" style="font-size:10px;color:#555588;margin-top:4px;"></div>';
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
    state.columnOverride = newMap;
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

  // ─────────────────────────────────────────────────────────────────────────────
  // F4 - SESSION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

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
          '<button id="b24t-history-clear" style="font-size:9px;color:#7878aa;background:none;border:none;cursor:pointer;">wyczyść</button>' +
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
      list.innerHTML = '<div style="font-size:11px;color:#555588;text-align:center;padding:16px 0;">Brak historii sesji</div>';
      return;
    }
    list.innerHTML = history.map(function(s) {
      const mins = Math.floor(s.durationSec / 60);
      const secs = s.durationSec % 60;
      return '<div style="background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;margin-bottom:6px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">' +
          '<span style="font-size:11px;color:#b0b0cc;font-weight:600;">' + s.projectName + '</span>' +
          '<span style="font-size:9px;color:#555588;">' + s.date + '</span>' +
        '</div>' +
        '<div style="font-size:10px;color:#7878aa;margin-bottom:3px;">📄 ' + s.fileName + '</div>' +
        '<div style="display:flex;gap:10px;font-size:10px;">' +
          '<span style="color:#4ade80;">✓ ' + s.tagged + ' otagowano</span>' +
          '<span style="color:#facc15;">⚠ ' + s.skipped + ' pominięto</span>' +
          (s.noMatch ? '<span style="color:#f87171;">✗ ' + s.noMatch + ' brak matcha</span>' : '') +
          (s.deleted ? '<span style="color:#f87171;">🗑 ' + s.deleted + ' usunięto</span>' : '') +
        '</div>' +
        '<div style="font-size:9px;color:#444466;margin-top:3px;">' + s.mode + ' · ' + mins + 'm ' + secs + 's</div>' +
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

  // ─────────────────────────────────────────────────────────────────────────────
  // F5 - FILE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────────

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
      return '<div style="display:flex;gap:6px;align-items:flex-start;padding:4px 0;border-bottom:1px solid #1a1a22;">' +
        '<span style="flex-shrink:0;' + (w.type === 'warn' ? 'color:#facc15;' : 'color:#7878aa;') + '">' + (w.type === 'warn' ? '⚠' : 'ℹ') + '</span>' +
        '<span style="font-size:10px;color:#9090bb;">' + w.msg + '</span></div>';
    }).join('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // F6 - AUDIT MODE
  // ─────────────────────────────────────────────────────────────────────────────

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
      wrongHtml = '<div style="margin-top:12px;font-size:10px;color:#7878aa;">Błędne tagi (pierwsze 5):</div>';
      result.taggedWrong.slice(0,5).forEach(function(e) {
        wrongHtml += '<div style="font-size:9px;color:#555588;padding:3px 0;border-bottom:1px solid #1a1a22;">' +
          e.url.substring(0,50) + '<br>' +
          '<span style="color:#f87171;">✗ ma: ' + e.actual + '</span> <span style="color:#4ade80;">\u2192 powinien: ' + e.expected + '</span></div>';
      });
    }
    content.innerHTML =
      '<h3 style="color:#6c6cff;font-size:14px;margin-bottom:16px;">🔍 Raport Audit Mode</h3>' +
      '<div class="b24t-report-row"><span>✓ Prawidłowo otagowane</span><strong style="color:#4ade80;">' + result.alreadyTagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>⚠ Nieztagowane</span><strong style="color:#facc15;">' + result.untagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>✗ Błędny tag</span><strong style="color:#f87171;">' + result.taggedWrong.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>? Nie znaleziono w Brand24</span><strong style="color:#7878aa;">' + result.notFound.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>~ W Brand24, brak w pliku</span><strong>' + result.notInFile + '</strong></div>' +
      wrongHtml +
      '<div style="display:flex;gap:6px;margin-top:16px;">' +
        '<button onclick="document.getElementById(\'b24t-report-modal\').style.display=\'none\'" class="b24t-btn-secondary" style="flex:1;">Zamknij</button>' +
        '<button onclick="window.B24Tagger.exportAuditReport()" class="b24t-btn-primary" style="flex:1;">\u2193 Eksport CSV</button>' +
      '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // F9 - SOUND NOTIFICATION
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // F11 - TAG COUNTS IN MAPPING
  // ─────────────────────────────────────────────────────────────────────────────

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


  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: MATCH PREVIEW
  // ─────────────────────────────────────────────────────────────────────────────

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

  function renderMatchPreview(preview) {
    const el = document.getElementById('b24t-match-preview');
    if (!el) return;
    const color = preview.pct >= 80 ? '#4ade80' : preview.pct >= 50 ? '#facc15' : '#f87171';
    el.style.display = 'block';
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="font-size:11px;color:#b0b0cc;font-weight:600;">Match Preview</span>' +
      '<span style="font-size:14px;font-weight:700;color:' + color + ';">' + preview.pct + '%</span></div>' +
      '<div style="display:flex;gap:10px;font-size:10px;margin-bottom:6px;">' +
      '<span style="color:#4ade80;">&#10003; ' + preview.matched + ' matched</span>' +
      '<span style="color:#f87171;">&#10007; ' + preview.unmatched + ' brak</span>' +
      (preview.noAssessment ? '<span style="color:#7878aa;">~ ' + preview.noAssessment + ' bez labelki</span>' : '') + '</div>' +
      '<div style="height:4px;background:#1a1a22;border-radius:99px;overflow:hidden;margin-bottom:6px;">' +
      '<div style="height:100%;width:' + preview.pct + '%;background:' + color + ';border-radius:99px;"></div></div>' +
      (preview.unmatched > 0
        ? '<div id="b24t-preview-list-toggle" style="font-size:10px;color:#7878aa;cursor:pointer;">Pokaż niezmatched (' + Math.min(preview.unmatched, 50) + ') &#9660;</div>' +
          '<div id="b24t-preview-list" style="display:none;max-height:80px;overflow-y:auto;margin-top:4px;font-size:9px;color:#555588;line-height:1.6;">' +
          preview.unmatchedList.map(function(u){ return '<div>' + u.substring(0, 60) + '</div>'; }).join('') +
          (preview.unmatched > 50 ? '<div>...i ' + (preview.unmatched - 50) + ' wiecej</div>' : '') + '</div>'
        : '');
    var btn = document.getElementById('b24t-preview-list-toggle');
    if (btn) btn.addEventListener('click', function() {
      var list = document.getElementById('b24t-preview-list');
      var show = list.style.display === 'none';
      list.style.display = show ? 'block' : 'none';
      btn.innerHTML = 'Pokaz niezmatched (' + Math.min(preview.unmatched, 50) + ') ' + (show ? '&#9650;' : '&#9660;');
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: MANUAL COLUMN MAPPING
  // ─────────────────────────────────────────────────────────────────────────────

  function buildColumnOverrideUI(rows) {
    if (!rows || !rows.length) return;
    const headers = Object.keys(rows[0]);
    const el = document.getElementById('b24t-column-override');
    if (!el) return;
    const roles = [
      { key: 'url', label: 'URL' },
      { key: 'assessment', label: 'Labelka (assessment)' },
      { key: 'date', label: 'Data' },
      { key: 'text', label: 'Tresc (opcjonalnie)' },
    ];
    const detected = state.file ? state.file.colMap : {};
    var html = '<div style="font-size:10px;color:#7878aa;margin-bottom:6px;">Kolumny wykryte automatycznie. Zmien jesli cos sie pomylilo:</div>';
    roles.forEach(function(r) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
        '<span style="font-size:10px;color:#b0b0cc;width:130px;flex-shrink:0;">' + r.label + ':</span>' +
        '<select class="b24t-select b24t-col-sel" data-role="' + r.key + '" style="flex:1;">' +
        '<option value="">-- brak --</option>' +
        headers.map(function(h) { return '<option value="' + h + '"' + (detected[r.key] === h ? ' selected' : '') + '>' + h + '</option>'; }).join('') +
        '</select></div>';
    });
    html += '<div id="b24t-col-sample" style="font-size:9px;color:#555588;margin-top:4px;"></div>';
    el.innerHTML = html;
    el.querySelectorAll('.b24t-col-sel').forEach(function(sel) {
      sel.addEventListener('change', function() { applyColumnOverride(el, rows); });
    });
    applyColumnOverride(el, rows);
  }

  function applyColumnOverride(el, rows) {
    var newMap = {};
    el.querySelectorAll('.b24t-col-sel').forEach(function(sel) {
      if (sel.value) newMap[sel.dataset.role] = sel.value;
    });
    state.columnOverride = newMap;
    if (state.file) {
      state.file.colMap = Object.assign({}, state.file.colMap, newMap);
      state.file.meta = processFileData(rows, state.file.colMap);
    }
    var preview = el.querySelector('#b24t-col-sample');
    if (preview && rows[0]) {
      var parts = [];
      if (newMap.url) parts.push('URL: "' + (rows[0][newMap.url] || '').substring(0, 40) + '"');
      if (newMap.assessment) parts.push('Label: "' + (rows[0][newMap.assessment] || '') + '"');
      preview.textContent = parts.join(' | ');
    }
    state.matchPreview = null;
    var prevEl = document.getElementById('b24t-match-preview');
    if (prevEl) prevEl.style.display = 'none';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: SESSION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

  function saveSessionToHistory() {
    if (!state.projectId || !state.stats) return;
    var history = lsGet(LS.HISTORY, []);
    history.unshift({
      date: new Date().toLocaleString('pl-PL'),
      projectName: state.projectName || String(state.projectId),
      projectId: state.projectId,
      tagged: state.stats.tagged,
      skipped: state.stats.skipped,
      noMatch: state.stats.noMatch,
      deleted: state.stats.deleted || 0,
      fileName: state.file ? state.file.name : '--',
      durationSec: state.sessionStart ? Math.floor((Date.now() - state.sessionStart) / 1000) : 0,
      mode: state.testRunMode ? 'Test Run' : 'Wlasciwy',
    });
    lsSet(LS.HISTORY, history.slice(0, 20));
  }

  function buildHistoryTab() {
    var div = document.createElement('div');
    div.id = 'b24t-history-tab';
    div.style.display = 'none';
    div.innerHTML = '<div class="b24t-section">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<div class="b24t-section-label">Historia sesji</div>' +
      '<button id="b24t-history-clear" style="font-size:9px;color:#7878aa;background:none;border:none;cursor:pointer;">wyczysc</button></div>' +
      '<div id="b24t-history-list"></div></div>';
    return div;
  }

  function renderHistoryTab() {
    var list = document.getElementById('b24t-history-list');
    if (!list) return;
    var history = lsGet(LS.HISTORY, []);
    if (!history.length) {
      list.innerHTML = '<div style="font-size:11px;color:#555588;text-align:center;padding:16px 0;">Brak historii sesji</div>';
      return;
    }
    list.innerHTML = history.map(function(s) {
      var dur = Math.floor(s.durationSec / 60) + 'm ' + (s.durationSec % 60) + 's';
      return '<div style="background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;margin-bottom:6px;">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
        '<span style="font-size:11px;color:#b0b0cc;font-weight:600;">' + s.projectName + '</span>' +
        '<span style="font-size:9px;color:#555588;">' + s.date + '</span></div>' +
        '<div style="font-size:10px;color:#7878aa;margin-bottom:3px;">&#128196; ' + s.fileName + '</div>' +
        '<div style="display:flex;gap:10px;font-size:10px;">' +
        '<span style="color:#4ade80;">&#10003; ' + s.tagged + ' otagowano</span>' +
        '<span style="color:#facc15;">&#9888; ' + s.skipped + ' pominieto</span>' +
        (s.noMatch ? '<span style="color:#f87171;">&#10007; ' + s.noMatch + ' brak matcha</span>' : '') +
        (s.deleted ? '<span style="color:#f87171;">&#128465; ' + s.deleted + ' usunieto</span>' : '') + '</div>' +
        '<div style="font-size:9px;color:#444466;margin-top:3px;">' + s.mode + ' &middot; ' + dur + '</div></div>';
    }).join('');
  }

  function wireHistoryTab() {
    var clearBtn = document.getElementById('b24t-history-clear');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      if (confirm('Wyczysc historie sesji?')) { lsSet(LS.HISTORY, []); renderHistoryTab(); }
    });
    var tab = document.getElementById('b24t-history-tab');
    if (tab) new MutationObserver(function() {
      if (tab.style.display !== 'none') renderHistoryTab();
    }).observe(tab, { attributes: true, attributeFilter: ['style'] });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: FILE VALIDATION
  // ─────────────────────────────────────────────────────────────────────────────

  function validateFile(rows, colMap) {
    var warnings = [];
    var urlSet = new Set();
    var dupUrls = 0, noUrl = 0, noAssessment = 0, badUrl = 0;
    rows.forEach(function(row) {
      var url = colMap.url ? (row[colMap.url] || '').trim() : '';
      var assessment = colMap.assessment ? (row[colMap.assessment] || '').trim() : '';
      if (!url) { noUrl++; }
      else if (!/^https?:\/\//.test(url)) { badUrl++; }
      else if (urlSet.has(url)) { dupUrls++; }
      else { urlSet.add(url); }
      if (!assessment) noAssessment++;
    });
    if (dupUrls > 0) warnings.push({ type: 'warn', msg: dupUrls + ' zduplikowanych URLi - te wzmianki moga byc otagowane podwojnie' });
    if (noUrl > 0) warnings.push({ type: 'warn', msg: noUrl + ' wierszy bez URL - zostana pominiete' });
    if (badUrl > 0) warnings.push({ type: 'warn', msg: badUrl + ' URLi bez http/https' });
    if (noAssessment > 0) warnings.push({ type: 'info', msg: noAssessment + ' wierszy bez labelki - zostana pominiete' });
    if (rows.length > 5000) warnings.push({ type: 'warn', msg: 'Duzy plik: ' + rows.length + ' wierszy. Operacja moze trwac kilkadziesiat sekund.' });
    if (colMap.date) {
      var dates = rows.map(function(r) { return (r[colMap.date] || '').substring(0, 10); })
                      .filter(function(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
      if (dates.length) {
        var minD = dates.reduce(function(a,b){ return a < b ? a : b; });
        var maxD = dates.reduce(function(a,b){ return a > b ? a : b; });
        var days = Math.round((new Date(maxD) - new Date(minD)) / 86400000);
        if (days > 90) warnings.push({ type: 'warn', msg: 'Szeroki zakres dat: ' + days + ' dni (' + minD + ' do ' + maxD + '). Rozwaz podzial na mniejsze pliki.' });
      }
    }
    return warnings;
  }

  function renderFileValidation(warnings) {
    var el = document.getElementById('b24t-file-validation');
    if (!el) return;
    if (!warnings.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = warnings.map(function(w) {
      return '<div style="display:flex;gap:6px;padding:4px 0;border-bottom:1px solid #1a1a22;">' +
        '<span style="flex-shrink:0;' + (w.type === 'warn' ? 'color:#facc15;' : 'color:#7878aa;') + '">' + (w.type === 'warn' ? '&#9888;' : 'i') + '</span>' +
        '<span style="font-size:10px;color:#9090bb;">' + w.msg + '</span></div>';
    }).join('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: AUDIT MODE
  // ─────────────────────────────────────────────────────────────────────────────

  async function runAuditMode() {
    if (!state.file || !state.projectId) return;
    state.status = 'running';
    state.sessionStart = Date.now();
    updateStatusUI();
    startSessionTimer();
    addLog('Audit Mode - porownuje plik z Brand24...', 'info');
    var dateFrom = state.file.meta.minDate;
    var dateTo   = state.file.meta.maxDate;
    var colMap   = state.file.colMap;
    var map = await buildUrlMap(dateFrom, dateTo, false);
    var result = { alreadyTagged: [], untagged: [], taggedWrong: [], notFound: [], notInFile: 0 };
    var fileUrls = new Set(state.file.rows.map(function(r) {
      return normalizeUrl(colMap.url ? (r[colMap.url] || '') : '');
    }).filter(Boolean));
    result.notInFile = Object.keys(map).filter(function(k) { return !fileUrls.has(k); }).length;
    state.file.rows.forEach(function(row) {
      var assessment = (colMap.assessment ? (row[colMap.assessment] || '') : '').trim().toUpperCase();
      if (!assessment) return;
      var urlRaw = colMap.url ? (row[colMap.url] || '') : '';
      if (!urlRaw) return;
      var entry = map[normalizeUrl(urlRaw)];
      var expectedMapping = state.mapping[assessment];
      if (!entry) { result.notFound.push(urlRaw); return; }
      var tags = (entry.existingTags || []).map(function(t) { return t.id; });
      if (tags.length === 0) {
        result.untagged.push({ url: urlRaw, expected: expectedMapping ? expectedMapping.tagName : assessment });
      } else if (expectedMapping && tags.includes(expectedMapping.tagId)) {
        result.alreadyTagged.push(urlRaw);
      } else {
        result.taggedWrong.push({ url: urlRaw,
          expected: expectedMapping ? expectedMapping.tagName : assessment,
          actual: (entry.existingTags || []).map(function(t) { return t.title; }).join(', ') });
      }
    });
    state.status = 'done';
    updateStatusUI();
    showAuditReport(result);
    addLog('Audit: ' + result.alreadyTagged.length + ' OK, ' + result.untagged.length + ' nieztagowane, ' + result.taggedWrong.length + ' zle tagi, ' + result.notFound.length + ' nie znaleziono', 'success');
    saveSessionToHistory();
  }

  function showAuditReport(result) {
    var modal = document.getElementById('b24t-report-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    var content = modal.querySelector('.b24t-report-content');
    if (!content) return;
    var wrongHtml = '';
    if (result.taggedWrong.length > 0) {
      wrongHtml = '<div style="margin-top:12px;font-size:10px;color:#7878aa;">Bledne tagi (pierwsze 5):</div>' +
        result.taggedWrong.slice(0, 5).map(function(e) {
          return '<div style="font-size:9px;color:#555588;padding:3px 0;border-bottom:1px solid #1a1a22;">' +
            e.url.substring(0, 50) + '<br><span style="color:#f87171;">ma: ' + e.actual +
            '</span> <span style="color:#4ade80;">powinien: ' + e.expected + '</span></div>';
        }).join('');
    }
    content.innerHTML = '<h3 style="color:#6c6cff;font-size:14px;margin-bottom:16px;">Raport Audit Mode</h3>' +
      '<div class="b24t-report-row"><span>Prawidlowo otagowane</span><strong style="color:#4ade80;">' + result.alreadyTagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>Nieztagowane (Untagged)</span><strong style="color:#facc15;">' + result.untagged.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>Bledny tag</span><strong style="color:#f87171;">' + result.taggedWrong.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>Nie znaleziono w Brand24</span><strong style="color:#7878aa;">' + result.notFound.length + '</strong></div>' +
      '<div class="b24t-report-row"><span>W Brand24 ale nie w pliku</span><strong>' + result.notInFile + '</strong></div>' +
      wrongHtml +
      '<div style="display:flex;gap:6px;margin-top:16px;">' +
      '<button onclick="document.getElementById(\'b24t-report-modal\').style.display=\'none\'" class="b24t-btn-secondary" style="flex:1;">Zamknij</button>' +
      '<button onclick="window.B24Tagger.exportAuditReport()" class="b24t-btn-primary" style="flex:1;">Eksport CSV</button></div>';
    window.B24Tagger._lastAuditResult = result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: SOUND NOTIFICATION
  // ─────────────────────────────────────────────────────────────────────────────

  function playDoneSound() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      [523.25, 659.25, 783.99].forEach(function(freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        var start = ctx.currentTime + i * 0.12;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.18, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    } catch(e) {}
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FEATURE: TAG COUNTS IN MAPPING
  // ─────────────────────────────────────────────────────────────────────────────

  function updateTagCountsInMapping() {
    if (!state.file || !state.file.meta || !state.file.meta.assessments) return;
    var container = document.getElementById('b24t-mapping-rows');
    if (!container) return;
    var tagBuckets = {};
    Object.entries(state.mapping).forEach(function(entry) {
      var label = entry[0], m = entry[1];
      var count = state.file.meta.assessments[label] || 0;
      tagBuckets[m.tagId] = (tagBuckets[m.tagId] || 0) + count;
    });
    container.querySelectorAll('.b24t-tag-select').forEach(function(sel) {
      var label = sel.dataset.label;
      var mapping = state.mapping[label ? label.toUpperCase() : ''];
      if (!mapping) return;
      var total = tagBuckets[mapping.tagId] || 0;
      Array.from(sel.options).forEach(function(opt) {
        if (parseInt(opt.value) === mapping.tagId) {
          var base = opt.dataset.origText || opt.textContent.replace(/ \(\d+\)$/, '');
          opt.dataset.origText = base;
          opt.textContent = total > 0 ? base + ' (' + total + ')' : base;
        }
      });
    });
  }


  // ─────────────────────────────────────────────────────────────────────────────
  // CHANGELOG - historia wersji
  // ─────────────────────────────────────────────────────────────────────────────

  const CHANGELOG = [
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


  // ─────────────────────────────────────────────────────────────────────────────
  // WHAT'S NEW - modal i przycisk
  // ─────────────────────────────────────────────────────────────────────────────

  function showWhatsNew(forceShow) { showWhatsNewExtended(forceShow); }


  // ─────────────────────────────────────────────────────────────────────────────
  // FEEDBACK & PLANNED FEATURES
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // KONFIGURACJA — uzupełnij przed użyciem
  // ─────────────────────────────────────────────────────────────────────────────
  // Slack Webhook URL — jak go zdobyć: https://api.slack.com/apps → Incoming Webhooks
  const SLACK_WEBHOOK_URL = 'TWOJ_SLACK_WEBHOOK_URL';
  const RAW_URL = 'https://raw.githubusercontent.com/maksymilianniedzwiedz-maker/b24-Tagger/main/b24tagger.user.js';

  // Planned features list
  const PLANNED_FEATURES = [
    { priority: 'high',   text: 'Podgląd wzmianki on-hover — najedź na URL w logu żeby zobaczyć treść i autora', next: true  },
    { priority: 'high',   text: 'Szybkie filtry w Quick Tag — builder filtrów (źródło, sentyment, daty) bez dotykania UI Brand24', next: false },
    { priority: 'high',   text: 'Tryb "Continue from date" — automatyczna kontynuacja od ostatniej przetworzonej daty', next: false },
    { priority: 'medium', text: 'Bulk rename / merge tagów — zmiana nazwy tagu i scalanie tagów w projekcie', next: false },
    { priority: 'medium', text: 'Statystyki projektu — trendy relevant/irrelevant w czasie',                    next: false },
    { priority: 'medium', text: 'Eksport / import konfiguracji — szybki onboarding nowych analityków',         next: false },
    { priority: 'low',    text: 'Wieloprojektowość — jeden plik z wzmiankami z wielu projektów',              next: false },
    { priority: 'low',    text: 'Skróty klawiszowe — Ctrl+Enter, Escape, Ctrl+Shift+B',                        next: false },
    { priority: 'low',    text: 'Scheduler — zaplanowane automatyczne uruchomienie o wybranej godzinie',       next: false },
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
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'SF Mono\',\'Fira Code\',monospace;';

    modal.innerHTML =
      '<div style="background:#0f0f13;border:1px solid #2a2a35;border-radius:14px;width:440px;box-shadow:0 20px 60px rgba(0,0,0,0.8);">' +
        '<div style="padding:20px 20px 16px;border-bottom:1px solid #1a1a22;">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<div style="width:32px;height:32px;background:#facc1522;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;">💬</div>' +
            '<div>' +
              '<div style="font-size:14px;font-weight:700;color:#e2e2e8;">Prześlij feedback</div>' +
              '<div style="font-size:10px;color:#555588;margin-top:2px;">Trafia bezpośrednio na kanał Slack zespołu</div>' +
            '</div>' +
            '<button id="b24t-fb-close" style="margin-left:auto;background:none;border:none;color:#444455;cursor:pointer;font-size:18px;line-height:1;padding:4px;">\u00d7</button>' +
          '</div>' +
        '</div>' +
        '<div style="padding:20px;">' +
          // Stars
          '<div style="margin-bottom:16px;">' +
            '<div style="font-size:11px;color:#7878aa;margin-bottom:8px;">Ogólna ocena wtyczki:</div>' +
            '<div id="b24t-fb-stars" style="display:flex;gap:6px;">' +
              [1,2,3,4,5].map(function(i) {
                return '<span data-val="' + i + '" style="font-size:24px;cursor:pointer;color:#1e1e28;transition:color 0.1s;">★</span>';
              }).join('') +
            '</div>' +
          '</div>' +
          // Textarea
          '<div style="margin-bottom:16px;">' +
            '<div style="font-size:11px;color:#7878aa;margin-bottom:6px;">Komentarz / sugestia / błąd (opcjonalnie):</div>' +
            '<textarea id="b24t-fb-text" placeholder="Co działa dobrze? Co można poprawić? Jakiś bug?" ' +
              'style="width:100%;height:90px;background:#141419;border:1px solid #2a2a35;border-radius:6px;color:#c0c0e0;' +
              'font-family:inherit;font-size:11px;padding:8px 10px;resize:none;box-sizing:border-box;outline:none;line-height:1.5;">' +
            '</textarea>' +
          '</div>' +
          // Status
          '<div id="b24t-fb-status" style="font-size:10px;color:#555588;min-height:14px;margin-bottom:12px;"></div>' +
          // Buttons
          '<div style="display:flex;gap:8px;">' +
            '<button id="b24t-fb-cancel" style="flex:1;background:#1a1a22;color:#9090aa;border:1px solid #2a2a35;border-radius:6px;padding:8px;font-size:12px;cursor:pointer;font-family:inherit;">Anuluj</button>' +
            '<button id="b24t-fb-send" style="flex:2;background:#6c6cff;color:#fff;border:none;border-radius:6px;padding:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Wyślij feedback</button>' +
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
    let html = '<div style="font-size:10px;color:#555588;margin-bottom:16px;">Szczegółowe informacje techniczne o zmianach w kodzie. Dostępne od v0.3.4.</div>';

    DEV_CHANGELOG.forEach(function(v, idx) {
      html +=
        '<div style="margin-bottom:' + (idx < DEV_CHANGELOG.length - 1 ? '16' : '0') + 'px;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
            '<span style="font-size:12px;font-weight:700;color:#e2e2e8;font-family:\'SF Mono\',monospace;">v' + v.version + '</span>' +
            '<span style="font-size:10px;color:#444466;">' + v.date + '</span>' +
          '</div>' +
          v.notes.map(function(n) {
            return '<div style="display:flex;gap:8px;align-items:flex-start;padding:2px 0;">' +
              '<span style="flex-shrink:0;color:#6c6cff;font-size:10px;">›</span>' +
              '<span style="font-size:10px;color:#7878aa;line-height:1.5;font-family:\'SF Mono\',monospace;">' + n + '</span>' +
            '</div>';
          }).join('') +
        '</div>' +
        (idx < DEV_CHANGELOG.length - 1 ? '<div style="height:1px;background:#1a1a22;margin:0 0 16px 0;"></div>' : '');
    });

    const modal = document.createElement('div');
    modal.id = 'b24t-devnotes-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483648;font-family:\'SF Mono\',\'Fira Code\',monospace;';
    modal.innerHTML =
      '<div style="background:#0a0a0d;border:1px solid #2a2a35;border-radius:14px;width:520px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.9);">' +
        '<div style="padding:16px 20px;border-bottom:1px solid #1a1a22;flex-shrink:0;display:flex;align-items:center;gap:10px;">' +
          '<span style="font-size:16px;">🔧</span>' +
          '<div>' +
            '<div style="font-size:13px;font-weight:700;color:#e2e2e8;">Patch notes dla programistów</div>' +
            '<div style="font-size:10px;color:#444466;margin-top:2px;">Szczegóły techniczne zmian w kodzie · B24 Tagger BETA</div>' +
          '</div>' +
          '<button id="b24t-devnotes-close" style="margin-left:auto;background:none;border:none;color:#444455;cursor:pointer;font-size:18px;line-height:1;">\u00d7</button>' +
        '</div>' +
        '<div style="overflow-y:auto;flex:1;padding:20px;">' + html + '</div>' +
        '<div style="padding:12px 20px;border-top:1px solid #1a1a22;flex-shrink:0;text-align:right;">' +
          '<button id="b24t-devnotes-ok" style="background:#2a2a35;color:#9090aa;border:none;border-radius:6px;padding:7px 20px;font-size:12px;cursor:pointer;font-family:inherit;">Zamknij</button>' +
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
    const prioColor = { high: '#f87171', medium: '#facc15', low: '#7878aa' };
    const prioLabel = { high: '🔴', medium: '🟡', low: '🟢' };

    // Build changelog HTML
    let changelogHtml = '';
    CHANGELOG.forEach(function(v, idx) {
      const isLatest = idx === 0;
      changelogHtml +=
        '<div style="margin-bottom:' + (idx < CHANGELOG.length - 1 ? '20' : '0') + 'px;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
            '<span style="font-size:15px;font-weight:700;color:#e2e2e8;font-family:\'SF Mono\',monospace;">v' + v.version + '</span>' +
            '<span style="font-size:12px;font-weight:600;background:' + v.labelColor + '22;color:' + v.labelColor + ';padding:2px 10px;border-radius:99px;">' + v.label + '</span>' +
            '<span style="font-size:11px;color:#555577;margin-left:auto;">' + v.date + '</span>' +
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
    let plannedHtml =
      '<div style="font-size:12px;color:#666699;margin-bottom:14px;line-height:1.6;">Lista funkcji planowanych w przyszłych wersjach. Masz pomysł? Skorzystaj z zakładki Feedback!</div>';
    PLANNED_FEATURES.forEach(function(f) {
      plannedHtml +=
        '<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #1a1a22;">' +
          '<span style="flex-shrink:0;font-size:16px;">' + prioLabel[f.priority] + '</span>' +
          '<span style="font-size:13px;color:#a0a0cc;line-height:1.6;flex:1;">' + f.text + '</span>' +
          (f.next ? '<span style="flex-shrink:0;font-size:11px;background:#6c6cff22;color:#6c6cff;padding:2px 8px;border-radius:99px;white-space:nowrap;">następna wersja</span>' : '') +
        '</div>';
    });

    const modal = document.createElement('div');
    modal.id = 'b24t-whats-new-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:\'SF Mono\',\'Fira Code\',monospace;';

    modal.innerHTML =
      // Outer container - wider, flex column
      '<div style="background:#0f0f13;border:1px solid #2a2a35;border-radius:14px;width:520px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.85);">' +

        // ── HEADER ────────────────────────────────────────────────────────
        '<div style="padding:16px 20px 0;flex-shrink:0;border-bottom:1px solid #1a1a22;">' +
          // Title row
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
            '<div style="width:36px;height:36px;background:#6c6cff22;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">✦</div>' +
            '<div style="flex:1;">' +
              '<div style="font-size:16px;font-weight:700;color:#e2e2e8;letter-spacing:-0.01em;">B24 Tagger <span style="font-size:11px;color:#6c6cff;letter-spacing:0.08em;font-weight:600;">BETA</span></div>' +
              '<div style="font-size:12px;color:#555577;margin-top:3px;">v' + VERSION + ' · Dziennik zmian</div>' +
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
              'style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#555588;' +
              'font-size:11px;padding:8px 4px;cursor:pointer;font-family:inherit;' +
              'display:flex;align-items:center;justify-content:center;gap:5px;">🗓 Planowane</button>' +
            '<button class="b24t-wnm-tab" data-tab="feedback" ' +
              'style="flex:1;background:none;border:none;border-bottom:2px solid transparent;color:#555588;' +
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
                'color:#555588;font-family:inherit;font-size:12px;cursor:pointer;">💡 Suggestion</button>' +
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
          '</div>' +
        '</div>' +

        // ── FOOTER ────────────────────────────────────────────────────────
        '<div style="padding:10px 20px;border-top:1px solid #1a1a22;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
          // Lewa strona: legenda + devnotes
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
            '<div id="b24t-wnm-legend" style="display:flex;gap:8px;font-size:11px;color:#555577;">' +
              '<span title="Nowa funkcja"><span style="color:#6c6cff;">✦</span> nowe</span>' +
              '<span title="Naprawa błędu"><span style="color:#4ade80;">⚒</span> fix</span>' +
              '<span title="Wydajność"><span style="color:#facc15;">⚡</span> perf</span>' +
              '<span title="Interfejs"><span style="color:#b0b0cc;">◈</span> UI</span>' +
            '</div>' +
            '<button id="b24t-wnm-devnotes-btn" ' +
              'style="font-size:11px;color:#555577;background:none;border:1px solid #2a2a35;border-radius:4px;' +
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
    modal.addEventListener('click', function(e) { if (e.target === modal) closeWnm(); });
  }


  // ─────────────────────────────────────────────────────────────────────────────
  // DEV_CHANGELOG - szczegółowe patch notes dla programistów (od v0.3.4)
  // ─────────────────────────────────────────────────────────────────────────────

  const DEV_CHANGELOG = [
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


  // ─────────────────────────────────────────────────────────────────────────────
  // AUTO UPDATE CHECK
  // ─────────────────────────────────────────────────────────────────────────────

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

  function checkForUpdate() {
    if (!RAW_URL || RAW_URL === 'TWOJ_SLACK_WEBHOOK_URL') return;

    // Throttle: sprawdzaj max raz na godzinę
    const lastCheck = parseInt(localStorage.getItem('b24tagger_update_check') || '0');
    if (Date.now() - lastCheck < 60 * 60 * 1000) return;
    localStorage.setItem('b24tagger_update_check', Date.now());

    const doCheck = function(url) {
      const req = new XMLHttpRequest();
      req.open('GET', url + '?_=' + Date.now(), true);
      req.onload = function() {
        if (req.status !== 200) return;
        const match = req.responseText.match(/\/\/ @version\s+([\d.]+)/);
        if (!match) return;
        const remoteVersion = match[1];
        if (compareVersions(remoteVersion, VERSION) > 0) {
          showUpdateBanner(remoteVersion);
        }
      };
      req.onerror = function() {};
      req.send();
    };

    // Użyj GM_xmlhttpRequest jeśli dostępne (omija CORS), fallback na XHR
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'GET',
        url: RAW_URL + '?_=' + Date.now(),
        onload: function(r) {
          if (r.status !== 200) return;
          const match = r.responseText.match(/\/\/ @version\s+([\d.]+)/);
          if (!match) return;
          const remoteVersion = match[1];
          if (compareVersions(remoteVersion, VERSION) > 0) {
            showUpdateBanner(remoteVersion);
          }
        },
        onerror: function() {}
      });
    } else {
      doCheck(RAW_URL);
    }
  }

  function showUpdateBanner(newVersion) {
    // Nie pokazuj jeśli banner już istnieje
    if (document.getElementById('b24t-update-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'b24t-update-banner';
    banner.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:#0f0f13',
      'border:1px solid #6c6cff',
      'border-radius:10px',
      'padding:12px 18px',
      'display:flex',
      'align-items:center',
      'gap:14px',
      'box-shadow:0 8px 32px rgba(108,108,255,0.25)',
      'z-index:2147483646',
      'font-family:\'SF Mono\',monospace',
      'min-width:320px',
      'animation:b24t-slide-up 0.3s ease',
    ].join(';');

    banner.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;flex:1;">' +
        '<div style="width:32px;height:32px;background:#6c6cff22;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">✦</div>' +
        '<div>' +
          '<div style="font-size:12px;font-weight:700;color:#e2e2e8;">Dostępna aktualizacja!</div>' +
          '<div style="font-size:10px;color:#7878aa;margin-top:2px;">' +
            'B24 Tagger BETA <span style="color:#555588;">v' + VERSION + '</span>' +
            ' → <span style="color:#6c6cff;font-weight:600;">v' + newVersion + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button id="b24t-update-install" style="background:#6c6cff;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;">Zainstaluj</button>' +
        '<button id="b24t-update-dismiss" style="background:#1a1a22;color:#7878aa;border:1px solid #2a2a35;border-radius:6px;padding:7px 10px;font-size:11px;cursor:pointer;font-family:inherit;">✕</button>' +
      '</div>';

    // Dodaj animację CSS
    if (!document.getElementById('b24t-update-style')) {
      const style = document.createElement('style');
      style.id = 'b24t-update-style';
      style.textContent = '@keyframes b24t-slide-up { from { opacity:0; transform:translateX(-50%) translateY(16px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }';
      document.head.appendChild(style);
    }

    document.body.appendChild(banner);

    // Kliknięcie "Zainstaluj" — otwórz raw URL (Tampermonkey obsłuży instalację)
    document.getElementById('b24t-update-install').addEventListener('click', function() {
      window.open(RAW_URL.replace('raw.githubusercontent.com', 'github.com').replace('/main/', '/blob/main/'), '_blank');
      banner.remove();
    });

    // Kliknięcie "✕" — zamknij baner
    document.getElementById('b24t-update-dismiss').addEventListener('click', function() {
      banner.style.animation = 'none';
      banner.style.opacity = '0';
      banner.style.transition = 'opacity 0.2s';
      setTimeout(function() { banner.remove(); }, 200);
    });

    // Auto-ukryj po 15 sekundach
    setTimeout(function() {
      if (document.getElementById('b24t-update-banner')) {
        document.getElementById('b24t-update-dismiss')?.click();
      }
    }, 15000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PARALLEL FETCH HELPER - used by all multi-page collection flows
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE MODE
  // ─────────────────────────────────────────────────────────────────────────────

  // One-time delete confirmation (never shown again after user confirms)
  async function confirmDeleteWarning() {
    if (lsGet(LS.DELETE_CONFIRMED)) return true;
    return new Promise(resolve => {
      const modal = document.createElement('div');
      modal.className = 'b24t-modal-overlay';
      modal.innerHTML = `
        <div class="b24t-modal">
          <div class="b24t-modal-title" style="color:#f87171;">⚠ Operacja nieodwracalna</div>
          <div class="b24t-modal-text">
            Usuwanie wzmianek przez wtyczkę jest <strong style="color:#f87171;">PERMANENTNE</strong>
            i nie można go cofnąć.<br><br>
            Wzmianki znikną z projektu na zawsze.
            Upewnij się że wiesz co robisz.<br><br>
            To ostrzeżenie pojawi się tylko raz.
          </div>
          <div class="b24t-modal-actions">
            <button data-action="cancel" class="b24t-btn-secondary">Anuluj</button>
            <button data-action="confirm" class="b24t-btn-danger">Rozumiem — kontynuuj</button>
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



  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE ENGINE
  // ─────────────────────────────────────────────────────────────────────────────

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
  async function runDeleteByTag(tagId, tagName, dateFrom, dateTo, onProgress) {
    addLog(`→ Usuwanie wzmianek z tagiem "${tagName}" (${dateFrom} → ${dateTo})`, 'warn');

    // Collect IDs in parallel
    const allIds = await fetchAllIds(
      p => getMentions(state.projectId, dateFrom, dateTo, [tagId], p),
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

  // ─────────────────────────────────────────────────────────────────────────────
  // QUICK DELETE TAB
  // ─────────────────────────────────────────────────────────────────────────────

  function buildDeleteTab() {
    const div = document.createElement('div');
    div.id = 'b24t-delete-tab';
    div.style.display = 'none';
    div.innerHTML = `
      <div class="b24t-section">
        <div class="b24t-section-label" style="color:#f87171;">Usuń po tagu</div>
        <div style="font-size:10px;color:#7878aa;margin-bottom:10px;line-height:1.5;">
          Usuwa wzmianki z wybranym tagiem w aktualnym zakresie dat.
          <strong style="color:#f87171;">Operacja nieodwracalna.</strong>
        </div>

        <!-- Tag selector -->
        <div class="b24t-section-label" style="margin-bottom:4px;">Tag do usunięcia</div>
        <select class="b24t-select" id="b24t-del-tag" style="width:100%;margin-bottom:8px;">
          <option value="">— wybierz tag —</option>
        </select>

        <!-- Date range info -->
        <div id="b24t-del-dateinfo" style="font-size:10px;color:#7878aa;margin-bottom:8px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;line-height:1.6;">
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
          <div id="b24t-del-status" style="font-size:10px;color:#7878aa;min-height:14px;flex:1;"></div>
          <div id="b24t-del-timer" style="font-size:11px;color:#8888aa;font-family:'SF Mono',monospace;margin-left:8px;">00:00</div>
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
        <div style="font-size:10px;color:#7878aa;margin-bottom:10px;line-height:1.5;">
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
        <div id="b24t-delview-info" style="font-size:10px;color:#7878aa;margin-bottom:8px;background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;line-height:1.6;">
          Wczytywanie widoku...
        </div>

        <!-- Progress -->
        <div class="b24t-progress-bar-track" style="margin-bottom:6px;">
          <div id="b24t-delview-progress" style="height:100%;background:#f87171;border-radius:99px;width:0%;transition:width 0.3s;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-delview-status" style="font-size:10px;color:#7878aa;min-height:14px;flex:1;"></div>
          <div id="b24t-delview-timer" style="font-size:11px;color:#8888aa;font-family:'SF Mono',monospace;margin-left:8px;">00:00</div>
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
      <div style="height:1px;background:#1e1e28;margin-bottom:8px;"></div>
      <div class="b24t-section-label" style="color:#f87171;margin-bottom:4px;">Auto-Delete po zakończeniu</div>
      <div class="b24t-checkbox-row" id="b24t-auto-delete-row">
        <input type="checkbox" id="b24t-auto-delete-cb">
        <label for="b24t-auto-delete-cb" style="color:#9090aa;">
          Po zakończeniu usuń wzmianki z tagiem:
          <select class="b24t-select-inline" id="b24t-auto-delete-tag">
            <option value="">— wybierz —</option>
          </select>
        </label>
      </div>
      <div id="b24t-auto-delete-save-row" style="display:none;margin-top:6px;padding-left:20px;">
        <div class="b24t-checkbox-row">
          <input type="checkbox" id="b24t-auto-delete-save-cb">
          <label for="b24t-auto-delete-save-cb" style="font-size:10px;color:#7878aa;">
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
        document.getElementById('b24t-del-custom-dates').style.display =
          e.target.value === 'custom' ? 'flex' : 'none';
      });
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


  // ─────────────────────────────────────────────────────────────────────────────
  // QUICK TAG MODE
  // ─────────────────────────────────────────────────────────────────────────────

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
        <div style="font-size:10px;color:#7878aa;margin-bottom:10px;line-height:1.5;">
          Taguje wzmianki widoczne w aktualnym widoku Brand24
          (aktywne filtry, zakres dat, untagged itd.)
        </div>

        <!-- Current view info -->
        <div id="b24t-qt-view-info" style="background:#141419;border:1px solid #1e1e28;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:10px;color:#9090aa;line-height:1.6;">
          Wczytywanie widoku...
        </div>

        <!-- Tag selector -->
        <div class="b24t-section-label" style="margin-bottom:4px;">Wybierz tag</div>
        <select class="b24t-select" id="b24t-qt-tag" style="width:100%;margin-bottom:8px;">
          <option value="">— wybierz tag —</option>
        </select>

        <!-- Scope -->
        <div class="b24t-section-label" style="margin-bottom:4px;">Zakres</div>
        <div class="b24t-radio-group" style="margin-bottom:10px;">
          <label class="b24t-radio">
            <input type="radio" name="b24t-qt-scope" value="current-page" checked>
            <span>Tylko bieżąca strona</span>
          </label>
          <label class="b24t-radio">
            <input type="radio" name="b24t-qt-scope" value="all-pages">
            <span>Wszystkie strony</span>
          </label>
        </div>

        <!-- Progress bar -->
        <div class="b24t-progress-bar-track" style="margin-bottom:6px;">
          <div id="b24t-qt-progress" style="height:100%;background:#6c6cff;border-radius:99px;width:0%;transition:width 0.3s;"></div>
        </div>

        <!-- Status + timer -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div id="b24t-qt-status" class="b24t-qt-status" style="font-size:10px;color:#7878aa;min-height:14px;flex:1;"></div>
          <div id="b24t-qt-timer" style="font-size:11px;color:#8888aa;font-family:'SF Mono',monospace;margin-left:8px;">00:00</div>
        </div>

        <!-- Run button -->
        <button class="b24t-btn-primary" id="b24t-qt-run" style="width:100%;">
          Taguj teraz
        </button>

        <!-- Untag option -->
        <div style="margin-top:8px;text-align:center;">
          <button id="b24t-qt-untag" style="background:none;border:none;font-size:10px;color:#444455;cursor:pointer;font-family:inherit;">
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

  // ─────────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────────

  function init() {
    // Only run on Mentions page
    if (!window.location.pathname.includes('/panel/results/')) return;

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
    wireEvents(panel);
    wireDeleteEvents(panel);
    wireQuickTagEvents(panel);
    wireHistoryTab();
    wireHistoryTab();

    // Tab switching
    panel.querySelectorAll('.b24t-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.b24t-tab').forEach(b => b.classList.remove('b24t-tab-active'));
        btn.classList.add('b24t-tab-active');
        const tab = btn.dataset.tab;
        const mainTab = document.getElementById('b24t-main-tab');
        const qtTabEl = document.getElementById('b24t-quicktag-tab');
        const delTabEl = document.getElementById('b24t-delete-tab');
        const histTabEl = document.getElementById('b24t-history-tab');
        const actions = document.getElementById('b24t-actions');
        if (mainTab) mainTab.style.display = tab === 'main' ? 'block' : 'none';
        if (qtTabEl) qtTabEl.style.display = tab === 'quicktag' ? 'block' : 'none';
        if (delTabEl) delTabEl.style.display = tab === 'delete' ? 'block' : 'none';
        if (histTabEl) histTabEl.style.display = tab === 'history' ? 'block' : 'none';
        if (actions) actions.style.display = tab === 'main' ? 'flex' : 'none';
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
        showSetupWizard(() => {
          addLog('✓ Setup zakończony. Możesz zaczynać!', 'success');
        });
      }, 1500);
    }

    addLog(`B24 Tagger BETA v${VERSION} załadowany.`, 'info');

    // Show What's New on version change
    setTimeout(() => showWhatsNewExtended(false), 2000);

    // Check for updates in background (max raz na godzinę)
    setTimeout(() => checkForUpdate(), 5000);
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

})();