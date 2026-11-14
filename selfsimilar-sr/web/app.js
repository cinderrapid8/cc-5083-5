'use strict';
// Browser controller for the restoration window.
//
// No image processing happens here: every pixel, metric and anomaly comes
// from the kernel behind /api. Kernel errors are shown in the status area.
// The clear reference images are never requested — the server refuses them —
// and the page has no code path that could display one.

const $ = (id) => document.getElementById(id);
const state = {
  defaults: null,
  catalog: [],
  images: {},
  currentKind: 'sr',
  targets: [],
  patchSize: 5,
  lrSize: null,
  outSize: null,
  scale: 2,
  threshold: 0.45,
  result: null,
  layers: null,
};

const PARAM_IDS = [
  'p_patchSize', 'p_patchStride', 'p_pyramidLevels', 'p_confidenceThreshold',
  'p_brightnessWeight', 'p_rotationPenalty90', 'p_scalePenalty',
  'p_backProjectionIters', 'p_degradeSigma',
];

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

async function fetchJSON(url, opts) {
  const resp = await fetch(url, opts);
  let data;
  try { data = await resp.json(); } catch { throw new Error('server returned a non-JSON response'); }
  if (!data.ok) throw new Error(data.error || 'kernel error');
  return data;
}

async function loadCatalog() {
  const data = await fetchJSON('/api/catalog');
  state.catalog = data.scenes;
  state.defaults = data.defaults;
  const sel = $('sceneSelect');
  for (const s of state.catalog) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.name} · ${s.family}`;
    sel.appendChild(opt);
  }
  fillParams(data.defaults);
  sel.addEventListener('change', onSceneChange);
}

function onSceneChange() {
  const name = $('sceneSelect').value;
  const scene = state.catalog.find((s) => s.name === name);
  if (!scene) { $('sceneNote').textContent = ''; return; }
  $('sceneNote').textContent = scene.description;
  const scales = scene.scales;
  const want = Number($('scale').value);
  if (!scales.includes(String(want))) {
    $('scale').value = scales[0];
  }
}

function fillParams(params) {
  $('p_patchSize').value = params.patchSize;
  $('p_patchStride').value = params.patchStride;
  $('p_pyramidLevels').value = params.pyramidLevels;
  $('p_confidenceThreshold').value = params.confidenceThreshold;
  $('p_brightnessWeight').value = params.brightnessWeight;
  $('p_rotationPenalty90').value = params.rotationPenalty[90];
  $('p_scalePenalty').value = params.scalePenalty;
  $('p_backProjectionIters').value = params.backProjectionIters;
  $('p_degradeSigma').value = params.degradeSigma;
}

function collectParams() {
  return {
    patchSize: Number($('p_patchSize').value),
    patchStride: Number($('p_patchStride').value),
    pyramidLevels: Number($('p_pyramidLevels').value),
    confidenceThreshold: Number($('p_confidenceThreshold').value),
    brightnessWeight: Number($('p_brightnessWeight').value),
    rotationPenalty: { 90: Number($('p_rotationPenalty90').value) },
    scalePenalty: Number($('p_scalePenalty').value),
    backProjectionIters: Number($('p_backProjectionIters').value),
    degradeSigma: Number($('p_degradeSigma').value),
  };
}

function showInputPreview(b64) {
  const img = $('inputPreview');
  img.src = 'data:image/png;base64,' + b64;
  img.classList.remove('hidden');
  img.style.imageRendering = 'pixelated';
  img.style.maxWidth = '320px';
}

$('loadAssetBtn').addEventListener('click', async () => {
  const scene = $('sceneSelect').value;
  if (!scene) { setStatus('先选择一个评测场景。', 'error'); return; }
  const scale = Number($('scale').value);
  setStatus('载入评测输入中…', 'busy');
  try {
    const data = await fetchJSON('/api/load-asset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene, scale }),
    });
    state.lrSize = [data.width, data.height];
    $('inputInfo').textContent = `${data.filename} · ${data.width}×${data.height}（输入，非参照）`;
    showInputPreview(data.pngBase64);
    $('runBtn').disabled = false;
    setStatus(`已载入 ${scene} @ ${scale}× 的 LR 输入。选择倍率后运行。`, 'ok');
  } catch (err) {
    setStatus('载入失败：' + err.message, 'error');
  }
});

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  setStatus('上传并由内核解码中…', 'busy');
  try {
    const data = await fetchJSON('/api/upload', { method: 'POST', body: fd });
    state.lrSize = [data.width, data.height];
    $('inputInfo').textContent = `${data.filename} · ${data.width}×${data.height}`;
    showInputPreview(data.pngBase64);
    $('runBtn').disabled = false;
    setStatus('输入已载入：' + data.filename, 'ok');
  } catch (err) {
    setStatus('加载失败：' + err.message, 'error');
  }
});

$('resetBtn').addEventListener('click', () => {
  if (state.defaults) fillParams(state.defaults);
  setStatus('已恢复内核默认参数。', 'ok');
});

$('runBtn').addEventListener('click', async () => {
  state.scale = Number($('scale').value);
  setStatus('内核运行中：建金字塔、匹配、反投影、异常检测…', 'busy');
  try {
    const data = await fetchJSON('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scale: state.scale, params: collectParams() }),
    });
    state.result = data;
    state.threshold = data.confidenceThreshold;
    state.images = {};
    for (const [kind, b64] of Object.entries(data.images)) {
      state.images[kind] = 'data:image/png;base64,' + b64;
    }
    state.images.diff = await makeDiffImage(data.images.sr, data.images.bicubic);
    state.outSize = data.outputSize;
    $('metrics').classList.remove('hidden');
    $('m_size').textContent = `${data.outputSize[0]}×${data.outputSize[1]}`;
    $('m_time').textContent = `${(data.elapsedMs / 1000).toFixed(2)} s`;
    $('m_resid').textContent = data.residualRMS;
    $('m_residmax').textContent = data.residualMax;
    $('m_conf').textContent = data.meanConfidence;
    $('m_transfer').textContent = (data.transferFraction * 100).toFixed(1) + '%';
    $('m_anomalies').textContent = data.anomalies.length;
    renderAnomalies(data.anomalies);
    showKind(state.currentKind);
    await loadTargets();
    setStatus(`完成。残差 RMS=${data.residualRMS}，迁移 ${(data.transferFraction * 100).toFixed(1)}%，`
      + `检测到 ${data.anomalies.length} 类异常。`, 'ok');
  } catch (err) {
    setStatus('重建失败（内核反馈）：' + err.message, 'error');
  }
});

// Difference view is rendered in the browser only from the two kernel images,
// for display; it is not used by any metric.
async function makeDiffImage(srB64, bicubicB64) {
  const load = (b64) => new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = 'data:image/png;base64,' + b64;
  });
  const [a, b] = await Promise.all([load(srB64), load(bicubicB64)]);
  const c = document.createElement('canvas');
  c.width = a.width; c.height = a.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(a, 0, 0);
  const da = ctx.getImageData(0, 0, c.width, c.height);
  ctx.drawImage(b, 0, 0);
  const db = ctx.getImageData(0, 0, c.width, c.height);
  const out = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < da.data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = da.data[i + k] - db.data[i + k];
      // Signed difference centred on mid-grey, amplified 4x and clamped.
      out.data[i + k] = Math.max(0, Math.min(255, 128 + d * 4));
    }
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.currentKind = tab.dataset.kind;
    showKind(state.currentKind);
  });
});

function showKind(kind) {
  const canvas = $('viewCanvas');
  const url = state.images[kind];
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const ov = $('targetOverlay');
    ov.width = img.width; ov.height = img.height;
    ov.style.width = canvas.clientWidth + 'px';
    ov.style.height = canvas.clientHeight + 'px';
    if (kind === 'sr') drawOverlay();
    else clearOverlay();
  };
  img.src = url;
}

function clearOverlay() {
  const ov = $('targetOverlay');
  ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
}

// Overlay colours are driven by the kernel's confidence relative to the
// threshold that was actually used in this run.
function drawOverlay() {
  const ov = $('targetOverlay');
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  if (!state.outSize || !state.lrSize) return;
  const sx = state.outSize[0] / state.lrSize[0];
  const sy = state.outSize[1] / state.lrSize[1];
  ctx.lineWidth = 1;
  for (const t of state.targets) {
    if (t.transferred) ctx.strokeStyle = 'rgba(245,180,70,0.55)';
    else ctx.strokeStyle = 'rgba(90,162,255,0.30)';
    ctx.strokeRect(t.x * sx, t.y * sy, t.size * sx, t.size * sy);
  }
}

async function loadTargets() {
  const data = await fetchJSON('/api/targets');
  state.targets = data.targets;
  state.patchSize = data.patchSize;
  state.lrSize = [data.lrWidth, data.lrHeight];
  state.threshold = data.threshold;
}

$('viewCanvas').addEventListener('click', async (e) => {
  if (!state.targets.length || state.currentKind !== 'sr') return;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const cssScaleX = canvas.width / rect.width;
  const cssScaleY = canvas.height / rect.height;
  const cx = (e.clientX - rect.left) * cssScaleX;
  const cy = (e.clientY - rect.top) * cssScaleY;
  const sx = state.outSize[0] / state.lrSize[0];
  const sy = state.outSize[1] / state.lrSize[1];
  const lx = cx / sx, ly = cy / sy;
  let best = null, bd = Infinity;
  for (const t of state.targets) {
    const d = Math.hypot(t.x + t.size / 2 - lx, t.y + t.size / 2 - ly);
    if (d < bd) { bd = d; best = t; }
  }
  if (!best || bd > state.patchSize * 1.5) return;
  await showCandidates(best.x, best.y);
});

async function showCandidates(x, y) {
  $('candidateInfo').textContent = `查询目标块 (${x}, ${y}) 的候选与代价…`;
  $('candidateInfo').className = 'muted';
  try {
    const data = await fetchJSON(`/api/candidates?x=${x}&y=${y}`);
    renderCandidates(data);
  } catch (err) {
    $('candidateInfo').textContent = '候选查询失败：' + err.message;
    $('candidateInfo').className = 'status error';
  }
}

function renderCandidates(data) {
  const t = data.target;
  const confColor = t.confidence >= 0.6 ? 'var(--accent2)'
    : t.confidence >= data.threshold ? 'var(--warn)' : 'var(--danger)';
  $('candidateInfo').className = '';
  $('candidateInfo').innerHTML =
    `目标块 (${t.x}, ${t.y})，${t.size}×${t.size}，`
    + `匹配置信度 <b style="color:${confColor}">${t.confidence.toFixed(3)}</b>`
    + `（阈值 ${data.threshold}）。`
    + (data.belowThreshold
      ? ' <b style="color:var(--danger)">低于阈值 → 该块回退保守重采样，不迁移细节。</b>'
      : ' <b style="color:var(--accent2)">高于阈值 → 该块允许细节迁移。</b>');

  const list = $('candidateList');
  list.innerHTML = '';
  const targetCard = document.createElement('div');
  targetCard.className = 'cand target';
  targetCard.innerHTML = `<div class="muted small">目标块（输入图，内核放大的同一块）</div>
    <img src="data:image/png;base64,${data.targetBase64}">`;
  list.appendChild(targetCard);

  data.candidates.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'cand' + (i === 0 ? ' best' : '');
    const tag = i === 0 ? ' · 最优' : '';
    card.innerHTML = `
      <div class="muted small">候选 #${i + 1}${tag} · 金字塔层 ${c.level} · 旋转 ${c.rotation}°</div>
      ${c.patchBase64 ? `<img src="data:image/png;base64,${c.patchBase64}">` : '<div class="muted small">（不可用）</div>'}
      <div class="kv">
        <b>总代价</b><span>${c.cost}</span>
        <b>SSD/像素</b><span>${c.ssdPerPx}</span>
        <b>亮度差</b><span>${c.brightnessDelta}</span>
        <b>旋转代价</b><span>${c.rotationPenalty}</span>
        <b>尺度代价</b><span>${c.scalePenalty}</span>
        <b>源位置</b><span>(${c.x},${c.y}) ${c.w}×${c.h}</span>
      </div>`;
    list.appendChild(card);
  });
}

function renderAnomalies(anomalies) {
  const list = $('anomalyList');
  list.innerHTML = '';
  if (!anomalies || !anomalies.length) {
    $('anomalySummary').textContent = '本次重建未检测到异常项。';
    return;
  }
  const high = anomalies.filter((a) => a.severity === 'high').length;
  $('anomalySummary').textContent =
    `共 ${anomalies.length} 项，其中高严重度 ${high} 项。以下数值均由本次重建计算得到。`;
  for (const a of anomalies) {
    const card = document.createElement('div');
    card.className = 'anomaly ' + a.severity;
    const bits = [];
    if (a.lrRect) bits.push(`LR 区域 x=${a.lrRect[0]} y=${a.lrRect[1]} ${a.lrRect[2]}×${a.lrRect[3]}`);
    if (a.hrRect) bits.push(`输出区域 x=${a.hrRect[0]} y=${a.hrRect[1]} ${a.hrRect[2]}×${a.hrRect[3]}`);
    const measured = Object.entries(a.measured || {})
      .map(([k, v]) => `${k}=${v}`).join('，');
    card.innerHTML = `
      <div class="anomaly-head"><span class="badge ${a.severity}">${a.severity}</span>
        <b>${a.kind}</b></div>
      <div class="small">${a.message}</div>
      <div class="muted small">${[bits.join('；'), measured].filter(Boolean).join(' · ')}</div>`;
    if (a.hrRect) {
      card.style.cursor = 'pointer';
      card.title = '在预览中定位该异常';
      card.addEventListener('click', () => {
        state.currentKind = 'transfer';
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === 'transfer'));
        showKind('transfer');
      });
    }
    list.appendChild(card);
  }
}

$('sweepBtn').addEventListener('click', async () => {
  setStatus('参数扫描中（置信阈值 0.2→0.75）…', 'busy');
  try {
    const data = await fetchJSON('/api/sweep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scale: Number($('scale').value),
        param: 'confidenceThreshold',
        values: [0.2, 0.35, 0.45, 0.6, 0.75],
      }),
    });
    const tbody = document.querySelector('#sweepTable tbody');
    tbody.innerHTML = '';
    for (const r of data.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${r.value}</td>
        <td>${(r.transferFraction * 100).toFixed(1)}%</td>
        <td>${r.meanConfidence}</td>
        <td>${r.residualRMS}</td>
        <td>${r.anomalyCount}${r.worstAnomaly ? '（' + r.worstAnomaly + '）' : ''}</td>
        <td><img src="data:image/png;base64,${r.srBase64}"></td>`;
      tbody.appendChild(tr);
    }
    $('sweepPanel').classList.remove('hidden');
    setStatus('扫描完成：可对比不同阈值下的迁移占比、残差与异常数。', 'ok');
  } catch (err) {
    setStatus('扫描失败（内核反馈）：' + err.message, 'error');
  }
});

loadCatalog().catch((err) => setStatus('场景清单加载失败：' + err.message, 'error'));
