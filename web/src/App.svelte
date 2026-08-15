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
  let selectedId = '';
  let overlay = false;
  let rangeMode = 'preset';
  let range = '1d';
  let customDays = 14;
  let error = '';
  let loadingCurrent = false;
  let loadingHistory = false;
  /** @type {Record<string, { t: number, v: number }[]>} */
  let series = {};
  /** @type {{ date: string, averages: Record<string, number> }[]} */
  let daily = [];
  let chartSize = 'm';
  let isFullscreen = false;

  /** @type {HTMLElement | null} */
  let chartEl = null;
  /** @type {HTMLElement | null} */
  let chartPanel = null;
  /** @type {uPlot | null} */
  let plot = null;

  function deviceIds() {
    return Object.keys(temps).sort();
  }

  function seriesIds() {
    return Object.keys(series).sort();
  }

  function dailyDeviceCols() {
    const ids = new Set();
    for (const row of daily) {
      for (const id of Object.keys(row.averages || {})) ids.add(id);
    }
    return [...ids].sort();
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

  /** Aligne les séries sur un axe X commun (uPlot). */
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
    const tSet = new Set();
    for (const id of ids) {
      for (const p of series[id] || []) tSet.add(p.t);
    }
    const ts = [...tSet].sort((a, b) => a - b);
    const maps = ids.map((id) => new Map((series[id] || []).map((p) => [p.t, p.v])));
    return {
      ids,
      data: [
        ts.map((t) => t / 1000),
        ...maps.map((m) => ts.map((t) => (m.has(t) ? m.get(t) : null)))
      ]
    };
  }

  function buildOpts(ids, width, height) {
    return {
      width,
      height,
      pxAlign: false,
      cursor: {
        drag: { x: true, y: true, setScale: true }
      },
      legend: { show: true },
      scales: {
        x: { time: true }
      },
      axes: [
        {
          stroke: 'rgba(232,238,252,0.7)',
          grid: { stroke: 'rgba(255,255,255,0.08)', width: 1 },
          ticks: { stroke: 'rgba(255,255,255,0.12)' },
          values: (_u, splits) => splits.map((s) => formatAxisLabel(s * 1000))
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
      ]
    };
  }

  function destroyPlot() {
    plot?.destroy();
    plot = null;
  }

  function renderPlot() {
    if (!chartEl) return;
    const { ids, data } = toUplotPayload();
    const width = chartEl.clientWidth || 600;
    const height = chartHeightPx();

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

  async function fetchCurrent() {
    loadingCurrent = true;
    try {
      error = '';
      const res = await fetch('/temperatures', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      temps = (await res.json()) || {};
      ensureSelected();
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

  async function fetchHistory() {
    if (!overlay && !selectedId) {
      series = {};
      daily = [];
      renderPlot();
      return;
    }
    loadingHistory = true;
    try {
      error = '';
      const res = await fetch(`/temperatures/history?${historyQuery()}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      series = json.series || {};
      daily = Array.isArray(json.daily) ? json.daily : [];
      await tick();
      renderPlot();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      series = {};
      daily = [];
      renderPlot();
    } finally {
      loadingHistory = false;
    }
  }

  async function refreshAll() {
    await fetchCurrent();
    await fetchHistory();
  }

  function selectDevice(id) {
    selectedId = id;
    if (!overlay) fetchHistory();
  }

  function setRange(id) {
    rangeMode = 'preset';
    range = id;
    fetchHistory();
  }

  function applyCustomDays() {
    rangeMode = 'custom';
    customDays = Math.max(1, Math.min(366, Number(customDays) || 1));
    fetchHistory();
  }

  onMount(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    const onResize = () => renderPlot();
    window.addEventListener('resize', onResize);
    refreshAll();
    return () => {
      window.removeEventListener('resize', onResize);
    };
  });

  onDestroy(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    destroyPlot();
  });
</script>

<div class="container">
  <div class="header">
    <div class="title">
      <h1>Températures</h1>
      <div class="sub">Vue légère BeagleBone</div>
    </div>
    <button class="btn" on:click={refreshAll} disabled={loadingCurrent || loadingHistory}>
      {loadingCurrent || loadingHistory ? 'Chargement…' : 'Rafraîchir'}
    </button>
  </div>

  {#if error}
    <div class="panel error" style="margin-bottom: 14px;">Erreur: {error}</div>
  {/if}

  <section class="panel" style="margin-bottom: 14px;">
    <div class="section-title">Température courante</div>
    {#if deviceIds().length === 0}
      <div class="muted">Aucun capteur pour le moment.</div>
    {:else}
      <div class="cards">
        {#each deviceIds() as id}
          <button
            type="button"
            class="card"
            class:active={!overlay && id === selectedId}
            on:click={() => selectDevice(id)}
          >
            <div class="card-id mono">{id}</div>
            <div class="card-value">
              {temps[id]?.value}<span class="unit">°{temps[id]?.unit || 'C'}</span>
            </div>
            <div class="card-meta muted">{formatCurrent(temps[id]?.lastUpdate)}</div>
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
          <input type="checkbox" bind:checked={overlay} on:change={fetchHistory} />
          Superposer
        </label>
        {#if !overlay}
          <label class="row">
            <span class="muted">Capteur</span>
            <select bind:value={selectedId} on:change={fetchHistory}>
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
          on:keydown={(e) => e.key === 'Enter' && applyCustomDays()}
        />
        <span class="muted">jours</span>
        <button
          type="button"
          class="range-btn"
          class:active={rangeMode === 'custom'}
          on:click={applyCustomDays}
        >
          OK
        </button>
      </label>
    </div>

    <div class="row chart-controls" style="margin-bottom: 8px;">
      <button type="button" class="range-btn" on:click={resetZoom}>Reset zoom</button>
      {#each CHART_SIZES as s}
        <button
          type="button"
          class="range-btn"
          class:active={!isFullscreen && chartSize === s.id}
          on:click={() => setChartSize(s.id)}
        >
          {s.label}
        </button>
      {/each}
      <button type="button" class="range-btn" class:active={isFullscreen} on:click={toggleFullscreen}>
        {isFullscreen ? 'Quitter' : 'Plein écran'}
      </button>
    </div>

    <p class="chart-hint muted">Glisser pour zoomer · Double-clic : reset</p>
    <div class="chart-wrap" bind:this={chartEl}></div>
  </section>

  <section class="panel">
    <div class="section-title">Moyennes journalières</div>
    {#if daily.length === 0}
      <div class="muted">Pas encore de données pour cette période.</div>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Jour</th>
              {#each dailyDeviceCols() as id}
                <th class="mono">{id}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each daily as row}
              <tr>
                <td>{formatDayLabel(row.date)}</td>
                {#each dailyDeviceCols() as id}
                  <td>
                    {row.averages[id] !== undefined ? `${row.averages[id]} °C` : '—'}
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
