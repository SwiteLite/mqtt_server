<script>
  import { onDestroy, onMount } from 'svelte';
  import Chart from 'chart.js/auto';
  import zoomPlugin from 'chartjs-plugin-zoom';

  Chart.register(zoomPlugin);

  const RANGES = [
    { id: '1h', label: '1 heure' },
    { id: '1d', label: '1 jour' },
    { id: '1w', label: '1 semaine' },
    { id: '1m', label: '1 mois' },
    { id: '3m', label: '3 mois' }
  ];

  const COLORS = [
    { border: '#66ccff', fill: 'rgba(102, 204, 255, 0.12)' },
    { border: '#ff99cc', fill: 'rgba(255, 153, 204, 0.12)' },
    { border: '#9dffb0', fill: 'rgba(157, 255, 176, 0.10)' },
    { border: '#ffd27a', fill: 'rgba(255, 210, 122, 0.12)' }
  ];

  const CHART_SIZES = [
    { id: 'm', label: 'M', height: 360 },
    { id: 'l', label: 'L', height: 520 },
    { id: 'xl', label: 'XL', height: 720 }
  ];

  /** @type {Record<string, { value: number, unit: string, lastUpdate: string }>} */
  let temps = {};
  let selectedId = '';
  let overlay = false;
  let rangeMode = 'preset'; // preset | custom
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
  /** @type {'zoom' | 'pan'} */
  let interactMode = 'zoom';

  /** @type {HTMLCanvasElement | null} */
  let canvas = null;
  /** @type {HTMLElement | null} */
  let chartPanel = null;
  /** @type {import('chart.js').Chart | null} */
  let chart = null;

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

  function chartHeight() {
    if (isFullscreen) return '100%';
    return `${CHART_SIZES.find((s) => s.id === chartSize)?.height || 360}px`;
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
      month: 'long',
      year: 'numeric'
    });
  }

  function formatAxisLabel(t) {
    const d = new Date(t);
    const shortTime =
      rangeMode === 'preset' && (range === '1h' || range === '1d');
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

  function applyInteractMode() {
    if (!chart?.options?.plugins?.zoom) return;
    const zoom = chart.options.plugins.zoom;
    const isZoom = interactMode === 'zoom';
    zoom.zoom.drag.enabled = isZoom;
    zoom.pan.enabled = !isZoom;
    zoom.zoom.wheel.enabled = true;
    zoom.zoom.pinch.enabled = true;
  }

  function updateChart({ resetZoom = true } = {}) {
    if (!chart) return;
    const ids = seriesIds();
    chart.data.datasets = ids.map((id, i) => {
      const c = COLORS[i % COLORS.length];
      return {
        label: id,
        data: (series[id] || []).map((p) => ({ x: p.t, y: p.v })),
        borderColor: c.border,
        backgroundColor: c.fill,
        fill: ids.length === 1,
        pointRadius: 0,
        tension: 0.2
      };
    });
    chart.options.scales.x.ticks.callback = (v) => formatAxisLabel(v);
    chart.update('none');
    if (resetZoom && typeof chart.resetZoom === 'function') {
      chart.resetZoom();
    }
  }

  function zoomBy(factor) {
    if (chart && typeof chart.zoom === 'function') chart.zoom(factor);
  }

  function resetZoomView() {
    if (chart && typeof chart.resetZoom === 'function') chart.resetZoom();
  }

  function setChartSize(id) {
    chartSize = id;
    requestAnimationFrame(() => chart?.resize());
  }

  function setInteractMode(mode) {
    interactMode = mode;
    applyInteractMode();
  }

  async function toggleFullscreen() {
    if (!chartPanel) return;
    try {
      if (!document.fullscreenElement) {
        await chartPanel.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
  }

  function onFullscreenChange() {
    isFullscreen = document.fullscreenElement === chartPanel;
    requestAnimationFrame(() => chart?.resize());
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
      updateChart();
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
      updateChart({ resetZoom: true });
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      series = {};
      daily = [];
      updateChart();
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

    const ctx = canvas?.getContext('2d');
    if (ctx) {
      chart = new Chart(ctx, {
        type: 'line',
        data: { datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          interaction: {
            mode: 'nearest',
            axis: 'x',
            intersect: false
          },
          plugins: {
            legend: { display: true },
            tooltip: {
              callbacks: {
                title(items) {
                  const x = items[0]?.parsed?.x;
                  return typeof x === 'number' ? formatAxisLabel(x) : '';
                }
              }
            },
            zoom: {
              limits: {
                x: { min: 'original', max: 'original' },
                y: { min: 'original', max: 'original' }
              },
              pan: {
                enabled: false,
                mode: 'xy'
              },
              zoom: {
                wheel: { enabled: true, speed: 0.1 },
                pinch: { enabled: true },
                drag: {
                  enabled: true,
                  backgroundColor: 'rgba(102, 204, 255, 0.15)',
                  borderColor: 'rgba(102, 204, 255, 0.6)',
                  borderWidth: 1
                },
                mode: 'xy'
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              ticks: {
                maxTicksLimit: 8,
                maxRotation: 0,
                callback: (v) => formatAxisLabel(v)
              }
            },
            y: {
              title: { display: true, text: '°C' }
            }
          }
        }
      });

      applyInteractMode();

      canvas?.addEventListener('dblclick', (e) => {
        e.preventDefault();
        resetZoomView();
      });
    }

    refreshAll();
  });

  onDestroy(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    chart?.destroy();
    chart = null;
  });
</script>

<div class="container">
  <div class="header">
    <div class="title">
      <h1>Températures</h1>
      <div class="sub">Valeurs courantes et historique</div>
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
          Superposer les capteurs
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
        <span class="pill">{pointCount()} points</span>
      </div>
    </div>

    <div class="row" style="margin-bottom: 12px;">
      <div class="range-group" role="group" aria-label="Durée">
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
        <span class="muted">Personnalisé</span>
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
          Appliquer
        </button>
      </label>
    </div>

    <div class="row chart-controls" style="margin-bottom: 10px;">
      <div class="range-group" role="group" aria-label="Interaction">
        <button
          type="button"
          class="range-btn"
          class:active={interactMode === 'zoom'}
          on:click={() => setInteractMode('zoom')}
          title="Glisser pour zoomer sur une zone"
        >
          Zoom cadre
        </button>
        <button
          type="button"
          class="range-btn"
          class:active={interactMode === 'pan'}
          on:click={() => setInteractMode('pan')}
          title="Glisser pour déplacer la vue"
        >
          Déplacer
        </button>
      </div>
      <div class="range-group" role="group" aria-label="Zoom">
        <button type="button" class="range-btn" on:click={() => zoomBy(1.2)} title="Zoom avant">+</button>
        <button type="button" class="range-btn" on:click={() => zoomBy(0.8)} title="Zoom arrière">−</button>
        <button type="button" class="range-btn" on:click={resetZoomView} title="Double-clic aussi">Reset zoom</button>
      </div>
      <div class="range-group" role="group" aria-label="Taille">
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
          {isFullscreen ? 'Quitter plein écran' : 'Plein écran'}
        </button>
      </div>
    </div>

    <p class="chart-hint muted">
      Molette : zoom · Mode Zoom cadre : sélectionner une zone · Mode Déplacer : glisser · Double-clic : reset
    </p>

    <div class="chart-wrap" style="height: {chartHeight()};">
      <canvas bind:this={canvas}></canvas>
    </div>
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
