<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  const RANGES = [
    { id: '1h', label: '1 h' },
    { id: '1d', label: '1 j' },
    { id: '1w', label: '1 sem' },
    { id: '1m', label: '1 mois' },
    { id: '3m', label: '3 mois' }
  ];

  const COLORS = ['#66ccff', '#ff99cc', '#9dffb0', '#ffd27a'];

  const CHART_SIZES = [
    { id: 'm', label: 'M', height: 280 },
    { id: 'l', label: 'L', height: 420 },
    { id: 'xl', label: 'XL', height: 600 }
  ];

  /** @type {Record<string, { value: number, unit: string, lastUpdate: string }>} */
  let temps = {};
  /** @type {[string, { value: number, unit: string, lastUpdate: string }][]} */
  let tempEntries = [];
  let selectedId = '';
  let overlay = false;
  let rangeMode = 'preset';
  let range = '1d';
  let customDays = 14;
  let error = '';
  let loadingCurrent = false;
  let loadingHistory = false;
  // Verrouillage UI seulement pendant le chargement du graphe (lourd)
  $: busy = loadingHistory;
  /** @type {Record<string, { t: number, v: number }[]>} */
  let series = {};
  /** @type {{ date: string, averages: Record<string, number> }[]} */
  let daily = [];
  /** @type {string[]} colonnes fixes du tableau (tous les capteurs) */
  let dailyCols = [];
  let chartSize = 'm';
  let isFullscreen = false;

  function applyTemps(data) {
    temps = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    tempEntries = Object.keys(temps)
      .sort()
      .map((id) => [id, temps[id]]);
    ensureSelected();
  }

  function deviceIds() {
    return tempEntries.map(([id]) => id);
  }

  /** @type {HTMLElement | null} */
  let chartEl = null;
  /** @type {HTMLElement | null} */
  let chartPanel = null;
  /** @type {HTMLElement | null} */
  let hoverEl = null;
  /** @type {uPlot | null} */
  let plot = null;
  /** ids courants du graphe (pour le readout curseur) */
  let plotIds = [];

  function seriesIds() {
    return Object.keys(series).sort();
  }

  function formatTemp(v) {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : String(v);
  }

  function chartHeightPx() {
    if (isFullscreen) {
      return Math.max(240, (chartPanel?.clientHeight || 600) - 160);
    }
    return CHART_SIZES.find((s) => s.id === chartSize)?.height || 280;
  }

  function ensureSelected() {
    const ids = deviceIds();
    if (!selectedId && ids.length) selectedId = ids[0];
    if (selectedId && !temps[selectedId] && ids.length) selectedId = ids[0];
  }

  function formatCurrent(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('fr-FR');
    } catch {
      return iso;
    }
  }

  function formatDayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return dateStr;
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  }

  function formatAxisLabel(t) {
    const d = new Date(t);
    const shortTime = rangeMode === 'preset' && (range === '1h' || range === '1d');
    if (shortTime) {
      return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    }
    return (
      d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) +
      ' ' +
      d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    );
  }

  function pointCount() {
    return seriesIds().reduce((n, id) => n + (series[id]?.length || 0), 0);
  }

  function nearestValue(pts, t, maxGapMs) {
    if (!pts.length) return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    let best = pts[lo];
    let bestDist = Math.abs(best.t - t);
    if (lo > 0) {
      const d = Math.abs(pts[lo - 1].t - t);
      if (d < bestDist) {
        best = pts[lo - 1];
        bestDist = d;
      }
    }
    return bestDist <= maxGapMs ? best.v : null;
  }

  /** Aligne les séries sur une grille temporelle régulière (curseur propre en superposition). */
  function toUplotPayload() {
    const ids = seriesIds();
    if (!ids.length) {
      return { ids: [], data: [[], []] };
    }
    if (ids.length === 1) {
      const pts = series[ids[0]] || [];
      return {
        ids,
        data: [pts.map((p) => p.t / 1000), pts.map((p) => p.v)]
      };
    }

    /** @type {Record<string, { t: number, v: number }[]>} */
    const sorted = {};
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const id of ids) {
      const pts = (series[id] || []).slice().sort((a, b) => a.t - b.t);
      sorted[id] = pts;
      if (pts.length) {
        if (pts[0].t < tMin) tMin = pts[0].t;
        if (pts[pts.length - 1].t > tMax) tMax = pts[pts.length - 1].t;
      }
    }
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) {
      return { ids: [], data: [[], []] };
    }

    const targetPoints = 300;
    const n = Math.max(2, Math.min(targetPoints, Math.round((tMax - tMin) / 30000) + 1));
    const step = (tMax - tMin) / (n - 1);
    // Important: maxGap >= step sinon trous sur 1 mois / 3 mois
    const maxGap = Math.max(step, 5 * 60 * 1000);
    const ts = Array.from({ length: n }, (_, i) => tMin + i * step);

    return {
      ids,
      data: [
        ts.map((t) => t / 1000),
        ...ids.map((id) => ts.map((t) => nearestValue(sorted[id], t, maxGap)))
      ]
    };
  }

  function formatHoverValue(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${Number(v).toFixed(2)} °C`;
  }

  function clearHoverReadout() {
    if (!hoverEl) return;
    hoverEl.classList.add('empty');
    hoverEl.innerHTML =
      '<span class="muted">Passe le curseur sur le graphe pour voir l’heure et les températures.</span>';
  }

  function paintHoverReadout(u) {
    if (!hoverEl) return;
    const idx = u.cursor.idx;
    if (idx == null || idx < 0 || !u.data?.[0] || u.data[0][idx] == null) {
      clearHoverReadout();
      return;
    }
    const timeLabel = formatAxisLabel(u.data[0][idx] * 1000);
    const parts = [
      `<span class="hover-time mono">${timeLabel}</span>`
    ];
    for (let i = 0; i < plotIds.length; i++) {
      const id = plotIds[i];
      const color = COLORS[i % COLORS.length];
      const v = u.data[i + 1]?.[idx];
      parts.push(
        `<span class="hover-item"><span class="swatch" style="background:${color}"></span>` +
          `<span class="mono">${id}</span><strong>${formatHoverValue(v)}</strong></span>`
      );
    }
    hoverEl.classList.remove('empty');
    hoverEl.innerHTML = parts.join('');
  }

  function buildOpts(ids, width, height) {
    return {
      width,
      height,
      pxAlign: false,
      legend: { show: false },
      cursor: {
        drag: { x: true, y: true, setScale: true }
        // ne pas mettre points.show: true — uPlot attend une fn qui renvoie un DOM node
      },
      scales: {
        x: { time: true }
      },
      axes: [
        {
          stroke: 'rgba(232,238,252,0.7)',
          grid: { stroke: 'rgba(255,255,255,0.08)', width: 1 },
          ticks: { stroke: 'rgba(255,255,255,0.12)' },
          values: (_u, splits) => splits.map((s) => formatAxisLabel(s * 1000)),
          space: 60
        },
        {
          stroke: 'rgba(232,238,252,0.7)',
          grid: { stroke: 'rgba(255,255,255,0.08)', width: 1 },
          ticks: { stroke: 'rgba(255,255,255,0.12)' },
          size: 50
        }
      ],
      series: [
        { label: 'Temps' },
        ...ids.map((id, i) => ({
          label: id,
          stroke: COLORS[i % COLORS.length],
          width: 1.5,
          spanGaps: true,
          points: { show: false }
        }))
      ],
      hooks: {
        setCursor: [paintHoverReadout]
      }
    };
  }

  function destroyPlot() {
    plot?.destroy();
    plot = null;
    plotIds = [];
    clearHoverReadout();
  }

  function renderPlot() {
    if (!chartEl) return;
    const { ids, data } = toUplotPayload();
    const width = chartEl.clientWidth || 600;
    const height = chartHeightPx();
    plotIds = ids;

    if (!ids.length) {
      destroyPlot();
      chartEl.innerHTML = '';
      return;
    }

    if (!plot) {
      chartEl.innerHTML = '';
      plot = new uPlot(buildOpts(ids, width, height), data, chartEl);
      return;
    }

    // Recréer si le nombre de séries change (options series)
    if (plot.series.length - 1 !== ids.length) {
      destroyPlot();
      chartEl.innerHTML = '';
      plotIds = ids;
      plot = new uPlot(buildOpts(ids, width, height), data, chartEl);
      return;
    }

    plot.setSize({ width, height });
    plot.setData(data, true);
  }

  function resetZoom() {
    if (!plot) return;
    plot.setScale('x', { min: plot.data[0][0], max: plot.data[0][plot.data[0].length - 1] });
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let s = 1; s < plot.data.length; s++) {
      for (const v of plot.data[s]) {
        if (v == null || !Number.isFinite(v)) continue;
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (Number.isFinite(yMin) && Number.isFinite(yMax)) {
      const pad = Math.max(0.2, (yMax - yMin) * 0.08);
      plot.setScale('y', { min: yMin - pad, max: yMax + pad });
    }
  }

  async function setChartSize(id) {
    chartSize = id;
    await tick();
    renderPlot();
  }

  async function toggleFullscreen() {
    if (!chartPanel) return;
    try {
      if (!document.fullscreenElement) await chartPanel.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
  }

  function onFullscreenChange() {
    isFullscreen = document.fullscreenElement === chartPanel;
    requestAnimationFrame(() => renderPlot());
  }

  /** Cache historique navigateur (évite de relire le disque BBB à chaque clic). */
  const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
  /** @type {Map<string, { at: number, json: any }>} */
  const historyCache = new Map();

  function historyCacheKey() {
    const device = overlay ? 'all' : selectedId || '';
    const win = rangeMode === 'custom' ? `d:${customDays}` : `r:${range}`;
    return `${device}|${win}`;
  }

  function applyHistoryPayload(json) {
    if (json.current) applyTemps(json.current);
    series = json.series || {};
    daily = Array.isArray(json.daily) ? json.daily : [];
    const colSet = new Set();
    for (const row of daily) {
      for (const id of Object.keys(row.averages || {})) colSet.add(id);
    }
    dailyCols = [...colSet].sort();
  }

  async function fetchCurrent() {
    loadingCurrent = true;
    try {
      // /temperatures fonctionne chez toi ; /api/temps en secours
      let res = await fetch('/temperatures', { cache: 'no-store' });
      if (!res.ok) res = await fetch('/api/temps', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyTemps(data);
      if (!tempEntries.length) {
        error = 'Cache courant vide (sensors_state.json / MQTT)';
      }
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    } finally {
      loadingCurrent = false;
    }
  }

  function historyQuery() {
    const q = new URLSearchParams();
    if (rangeMode === 'custom') {
      q.set('days', String(Math.max(1, Math.min(366, Number(customDays) || 1))));
    } else {
      q.set('range', range);
    }
    q.set('deviceId', overlay ? 'all' : selectedId);
    return q;
  }

  /**
   * @param {boolean} [force=false] ignorer le cache et recharger depuis le serveur
   */
  async function fetchHistory(force = false) {
    if (loadingHistory) return;
    if (!overlay && !selectedId) {
      series = {};
      daily = [];
      dailyCols = [];
      renderPlot();
      return;
    }

    const key = historyCacheKey();
    if (!force) {
      const hit = historyCache.get(key);
      if (hit && Date.now() - hit.at < HISTORY_CACHE_TTL_MS) {
        applyHistoryPayload(hit.json);
        await tick();
        renderPlot();
        return;
      }
    }

    loadingHistory = true;
    try {
      error = '';
      const q = historyQuery();
      let res = await fetch(`/temperatures/history?${q}`, { cache: 'no-store' });
      if (!res.ok) res = await fetch(`/api/temps/history?${q}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      historyCache.set(key, { at: Date.now(), json });
      applyHistoryPayload(json);
      await tick();
      renderPlot();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      series = {};
      daily = [];
      dailyCols = [];
      renderPlot();
    } finally {
      loadingHistory = false;
    }
  }

  async function refreshCurrent() {
    if (loadingCurrent) return;
    await fetchCurrent();
  }

  async function boot() {
    await fetchCurrent();
    await fetchHistory();
  }

  function selectDevice(id) {
    if (busy) return;
    selectedId = id;
    if (!overlay) fetchHistory();
  }

  function setRange(id) {
    if (busy) return;
    // Recliquer la même plage = forcer un rechargement
    const same = rangeMode === 'preset' && range === id;
    rangeMode = 'preset';
    range = id;
    fetchHistory(same);
  }

  function applyCustomDays() {
    if (busy) return;
    rangeMode = 'custom';
    customDays = Math.max(1, Math.min(366, Number(customDays) || 1));
    fetchHistory(true);
  }

  onMount(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    const onResize = () => renderPlot();
    window.addEventListener('resize', onResize);
    boot();
    return () => {
      window.removeEventListener('resize', onResize);
    };
  });

  onDestroy(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    destroyPlot();
  });
</script>

<div class="container" class:is-busy={busy} aria-busy={busy}>
  {#if busy}
    <div class="loading-lock" role="alertdialog" aria-live="assertive" aria-label="Chargement en cours">
      <div class="loading-card">
        <div class="spinner" aria-hidden="true"></div>
        <div class="loading-title">Chargement des données…</div>
        <div class="loading-sub muted">Veuillez patienter....</div>
      </div>
    </div>
  {/if}

  <div class="page" class:page-locked={busy}>
  <div class="header">
    <div class="title">
      <h1>Températures</h1>
      <div class="sub">Monitoring</div>
    </div>
    <button class="btn" on:click={refreshCurrent} disabled={loadingCurrent || busy}>
      {loadingCurrent ? 'Actualisation…' : 'Rafraîchir courantes'}
    </button>
  </div>

  {#if error}
    <div class="panel error" style="margin-bottom: 14px;">Erreur: {error}</div>
  {/if}

  <section class="panel" style="margin-bottom: 14px;">
    <div class="section-title">Températures courantes</div>
    {#if tempEntries.length === 0}
      <div class="muted">Aucun capteur pour le moment.</div>
    {:else}
      <div class="cards">
        {#each tempEntries as [id, reading]}
          <button
            type="button"
            class="card"
            class:active={!overlay && id === selectedId}
            on:click={() => selectDevice(id)}
          >
            <div class="card-id mono">{id}</div>
            <div class="card-value">
              {formatTemp(reading?.value)}<span class="unit">°{reading?.unit || 'C'}</span>
            </div>
            <div class="card-meta muted">{formatCurrent(reading?.lastUpdate)}</div>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <section class="panel chart-panel" class:fullscreen={isFullscreen} bind:this={chartPanel} style="margin-bottom: 14px;">
    <div class="chart-toolbar">
      <div class="section-title" style="margin: 0;">Évolution</div>
      <div class="row">
        <label class="check">
          <input type="checkbox" bind:checked={overlay} on:change={fetchHistory} disabled={busy} />
          Superposer
        </label>
        {#if !overlay}
          <label class="row">
            <span class="muted">Capteur</span>
            <select bind:value={selectedId} on:change={fetchHistory} disabled={busy}>
              {#each deviceIds() as id}
                <option value={id}>{id}</option>
              {/each}
            </select>
          </label>
        {/if}
        <span class="pill">{pointCount()} pts</span>
      </div>
    </div>

    <div class="row" style="margin-bottom: 10px;">
      <div class="range-group">
        {#each RANGES as r}
          <button
            type="button"
            class="range-btn"
            class:active={rangeMode === 'preset' && range === r.id}
            disabled={busy}
            on:click={() => setRange(r.id)}
          >
            {r.label}
          </button>
        {/each}
      </div>
      <label class="row custom-days">
        <input
          class="days-input"
          type="number"
          min="1"
          max="366"
          bind:value={customDays}
          disabled={busy}
          on:keydown={(e) => e.key === 'Enter' && applyCustomDays()}
        />
        <span class="muted">jours</span>
        <button
          type="button"
          class="range-btn"
          class:active={rangeMode === 'custom'}
          disabled={busy}
          on:click={applyCustomDays}
        >
          OK
        </button>
      </label>
    </div>

    <div class="row chart-controls" style="margin-bottom: 8px;">
      <button type="button" class="range-btn" disabled={busy} on:click={resetZoom}>Reset zoom</button>
      {#each CHART_SIZES as s}
        <button
          type="button"
          class="range-btn"
          class:active={!isFullscreen && chartSize === s.id}
          disabled={busy}
          on:click={() => setChartSize(s.id)}
        >
          {s.label}
        </button>
      {/each}
      <button type="button" class="range-btn" class:active={isFullscreen} disabled={busy} on:click={toggleFullscreen}>
        {isFullscreen ? 'Quitter' : 'Plein écran'}
      </button>
    </div>

    <p class="chart-hint muted">
      Glisser pour zoomer · Double-clic : reset · Plages en cache 5 min (recliquer la plage = recharger)
    </p>
    <div class="hover-readout empty" bind:this={hoverEl}>
      <span class="muted">Passe le curseur sur le graphe pour voir l’heure et les températures.</span>
    </div>
    <div class="chart-wrap" bind:this={chartEl}></div>
  </section>

  <section class="panel">
    <div class="section-title">Moyennes journalières</div>
    <p class="muted" style="margin-top: -4px; margin-bottom: 10px;">
      Une colonne par capteur (moyenne de toutes les mesures de la journée).
    </p>
    {#if daily.length === 0}
      <div class="muted">Pas encore de données pour cette période.</div>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Jour</th>
              {#each dailyCols as id}
                <th>
                  <div class="th-sensor">Capteur</div>
                  <div class="mono">{id}</div>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each daily as row}
              <tr>
                <td>{formatDayLabel(row.date)}</td>
                {#each dailyCols as id}
                  <td>
                    {row.averages[id] !== undefined ? `${formatTemp(row.averages[id])} °C` : '—'}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  </div>
</div>
