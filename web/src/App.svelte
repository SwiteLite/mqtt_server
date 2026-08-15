<script>
  import { onDestroy, onMount } from 'svelte';
  import Chart from 'chart.js/auto';

  const POLL_MS = 2000;
  const MAX_POINTS = 5000;

  /** @type {Record<string, { value: number, unit: string, lastUpdate: string }>} */
  let temps = {};
  let selectedId = '';
  let error = '';
  let lastFetch = '';

  /** @type {Record<string, { t: number, v: number }[]>} */
  const series = {};

  /** @type {HTMLCanvasElement | null} */
  let canvas = null;
  /** @type {import('chart.js').Chart | null} */
  let chart = null;

  function ensureSelected() {
    const ids = Object.keys(temps).sort();
    if (!selectedId && ids.length) selectedId = ids[0];
    if (selectedId && !temps[selectedId] && ids.length) selectedId = ids[0];
  }

  function pushPoint(deviceId, value) {
    const t = Date.now();
    series[deviceId] ??= [];
    series[deviceId].push({ t, v: Number(value) });
    if (series[deviceId].length > MAX_POINTS) {
      series[deviceId].splice(0, series[deviceId].length - MAX_POINTS);
    }
  }

  function updateChart() {
    if (!chart) return;
    const points = selectedId ? series[selectedId] ?? [] : [];
    chart.data.labels = points.map((p) => new Date(p.t).toLocaleTimeString());
    chart.data.datasets[0].label = selectedId ? `Température ${selectedId}` : 'Température';
    chart.data.datasets[0].data = points.map((p) => p.v);
    chart.update('none');
  }

  async function fetchTemps() {
    try {
      error = '';
      const res = await fetch('/temperatures', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      temps = json || {};
      lastFetch = new Date().toLocaleString();
      for (const [id, data] of Object.entries(temps)) {
        if (data && data.value !== undefined && data.value !== null) {
          pushPoint(id, data.value);
        }
      }
      ensureSelected();
      updateChart();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
  }

  onMount(() => {
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              label: 'Température',
              data: [],
              borderColor: '#66ccff',
              backgroundColor: 'rgba(102, 204, 255, 0.12)',
              fill: true,
              pointRadius: 0,
              tension: 0.25
            }
          ]
        },
        options: {
          responsive: true,
          animation: false,
          plugins: {
            legend: { display: true }
          },
          scales: {
            x: {
              ticks: { maxTicksLimit: 8 }
            },
            y: {
              title: { display: true, text: '°C' }
            }
          }
        }
      });
    }

    fetchTemps();
    const timer = setInterval(fetchTemps, POLL_MS);
    onDestroy(() => {
      clearInterval(timer);
      chart?.destroy();
      chart = null;
    });
  });

  $: updateChart();
</script>

<div class="container">
  <div class="header">
    <div class="title">
      <h1>Températures</h1>
      <div class="sub">Source: <span class="mono">GET /temperatures</span> (poll {POLL_MS} ms)</div>
    </div>
    <div class="row">
      <span class="pill"><strong>{Object.keys(temps).length}</strong> capteurs</span>
      <span class="pill">Dernier fetch: <span class="mono">{lastFetch || '—'}</span></span>
    </div>
  </div>

  <div class="grid">
    <div class="panel">
      <div class="row" style="justify-content: space-between; margin-bottom: 10px;">
        <div class="row">
          <div style="font-weight: 600;">Capteur</div>
          <select bind:value={selectedId}>
            {#each Object.keys(temps).sort() as id}
              <option value={id}>{id}</option>
            {/each}
          </select>
        </div>
        <button
          on:click={fetchTemps}
          style="background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; cursor: pointer;"
        >
          Rafraîchir
        </button>
      </div>

      {#if error}
        <div class="panel error" style="margin-bottom: 10px;">Erreur: {error}</div>
      {/if}

      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Valeur</th>
            <th>Maj</th>
          </tr>
        </thead>
        <tbody>
          {#each Object.entries(temps).sort(([a], [b]) => a.localeCompare(b)) as [id, d]}
            <tr style={id === selectedId ? 'background: rgba(102,204,255,0.08);' : ''}>
              <td class="mono">{id}</td>
              <td>{d?.value}{d?.unit ? `°${d.unit}` : ''}</td>
              <td class="mono" style="color: var(--muted);">{d?.lastUpdate || ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="panel">
      <div style="display:flex; align-items:center; justify-content: space-between; margin-bottom: 10px;">
        <div style="font-weight: 600;">Courbe</div>
        <div class="pill">
          Points: <strong>{selectedId ? (series[selectedId]?.length || 0) : 0}</strong>
        </div>
      </div>
      <canvas bind:this={canvas} height="140"></canvas>
    </div>
  </div>
</div>

