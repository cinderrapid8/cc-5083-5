'use strict';
// Browser-side controller. It holds no image-processing logic of its own:
// every rendered image and metric comes from the Node kernel behind /api.
// Kernel failures are displayed in the status bar (failure feedback loop).

const $ = (id) => document.getElementById(id);
const state = {
  defaults: null,
  images: {},          // kind -> data URL
  currentKind: 'sr',
  targets: [],
  patchSize: 5,
  lrSize: null,
  outSize: null,
  scale: 2,
};

const PARAM_IDS = [
  'patchSize', 'patchStride', 'pyramidLevels', 'confidenceThreshold',
  'brightnessWeight', 'rotationPenalty90', 'scalePenalty',
  'backProjectionIters', 'degradeSigma',
];

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

async function fetchJSON(url, opts) {
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'kernel error');
  return data;
}

async function loadParams() {
  const data = await fetchJSON('/api/params');
  state.defaults = data.defaults;
  fillParams(data.current);
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
    setStatus('输入已加载：' + data.filename, 'ok');
  } catch (err) {
    setStatus('加载失败（已回传给界面）：' + err.message, 'error');
  }
});

$('resetBtn').addEventListener('click', () => {
  if (state.defaults) fillParams(state.defaults);
  setStatus('已恢复内核默认参数。', 'ok');
});

$('runBtn').addEventListener('click', async () => {
  state.scale = Number($('scale').value);
  setStatus('内核运行中：建金字塔、匹配、反投影…', 'busy');
  try {
    const data = await fetchJSON('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scale: state.scale, params: collectParams() }),
    });
    state.images = {};
    for (const [kind, b64] of Object.entries(data.images)) {
      state.images[kind] = 'data:image/png;base64,' + b64;
    }
    state.outSize = data.outputSize;
    $('metrics').classList.remove('hidden');
    $('m_size').textContent = `${data.outputSize[0]}×${data.outputSize[1]}`;
    $('m_time').textContent = `${(data.elapsedMs / 1000).toFixed(2)} s`;
    $('m_resid').textContent = data.residualRMS;
    $('m_residmax').textContent = data.residualMax;
    $('m_conf').textContent = data.meanConfidence;
    $('m_transfer').textContent = (data.transferFraction * 100).toFixed(1) + '%';
    showKind(state.currentKind);
    await loadTargets();
    setStatus(`完成。残差RMS=${data.residualRMS}，迁移占比=${(data.transferFraction * 100).toFixed(1)}%。`, 'ok');
  } catch (err) {
    setStatus('重建失败（内核反馈）：' + err.message, 'error');
  }
});

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
    if (kind === 'sr') drawOverlay();
  };
  img.src = url;
}

async function loadTargets() {
  const data = await fetchJSON('/api/targets');
  state.targets = data.targets;
  state.patchSize = data.patchSize;
  state.lrSize = [data.lrWidth, data.lrHeight];
}

function drawOverlay() {
  const ov = $('targetOverlay');
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  if (!state.outSize || !state.lrSize) return;
  const sx = state.outSize[0] / state.lrSize[0];
  const sy = state.outSize[1] / state.lrSize[1];
  ctx.strokeStyle = 'rgba(90,162,255,0.35)';
  ctx.lineWidth = 1;
  for (const t of state.targets) {
    ctx.strokeRect(t.x * sx, t.y * sy, t.size * sx, t.size * sy);
  }
}

$('viewCanvas').addEventListener('click', async (e) => {
  if (!state.targets.length || state.currentKind !== 'sr') return;
  const rect = e.target.getBoundingClientRect();
  const cssScaleX = e.target.width / rect.width;
  const cssScaleY = e.target.height / rect.height;
  const cx = (e.clientX - rect.left) * cssScaleX;
  const cy = (e.clientY - rect.top) * cssScaleY;
  const sx = state.outSize[0] / state.lrSize[0];
  const sy = state.outSize[1] / state.lrSize[1];
  const lx = cx / sx, ly = cy / sy;
  // Nearest recorded target position.
  let best = null, bd = Infinity;
  for (const t of state.targets) {
    const d = Math.hypot(t.x + t.size / 2 - lx, t.y + t.size / 2 - ly);
    if (d < bd) { bd = d; best = t; }
  }
  if (!best || bd > state.patchSize * 1.5) return;
  try {
    const data = await fetchJSON(`/api/candidates?x=${best.x}&y=${best.y}`);
    renderCandidates(data);
  } catch (err) {
    $('candidateInfo').textContent = '候选查询失败：' + err.message;
    $('candidateInfo').className = 'status error';
  }
});

function renderCandidates(data) {
  const t = data.target;
  const confColor = t.confidence >= 0.6 ? 'var(--accent2)' : t.confidence >= 0.45 ? 'var(--warn)' : 'var(--danger)';
  $('candidateInfo').innerHTML =
    `目标块 (${t.x}, ${t.y})，尺寸 ${t.size}×${t.size}，` +
    `匹配置信度 <b style="color:${confColor}">${t.confidence.toFixed(3)}</b>，` +
    (t.confidence < 0.45 ? '低于阈值 → 该区域采用保守重采样，未迁移细节。' : '高于阈值 → 允许细节迁移。');
  const list = $('candidateList');
  list.innerHTML = '';
  const targetCard = document.createElement('div');
  targetCard.className = 'cand';
  targetCard.innerHTML = `<div class="muted small">目标块（输入图）</div>
    <img src="data:image/png;base64,${t.largeBase64}">`;
  list.appendChild(targetCard);
  data.candidates.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'cand' + (i === 0 ? ' best' : '');
    card.innerHTML = `
      <div class="muted small">候选 #${i + 1}${i === 0 ? ' · 最优' : ''} · 金字塔层 ${c.level} · 旋转 ${c.rotation}°</div>
      <img src="data:image/png;base64,${c.pngBase64}">
      <div class="kv">
        <b>总代价</b><span>${c.cost}</span>
        <b>SSD/像素</b><span>${c.ssdPerPx}</span>
        <b>亮度差</b><span>${c.brightnessDelta}</span>
        <b>旋转代价</b><span>${c.rotationPenalty}</span>
        <b>尺度代价</b><span>${c.scalePenalty}</span>
        <b>源位置</b><span>(${c.x},${c.y}) ${c.w}×${c.h}</b>
      </div>`;
    list.appendChild(card);
  });
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
      tr.innerHTML = `<td>${r.value}</td><td>${(r.transferFraction * 100).toFixed(1)}%</td>
        <td>${r.meanConfidence}</td><td>${r.residualRMS}</td>
        <td><img src="data:image/png;base64,${r.srBase64}"></td>`;
      tbody.appendChild(tr);
    }
    $('sweepPanel').classList.remove('hidden');
    setStatus('扫描完成：可对比不同阈值下的迁移占比与残差。', 'ok');
  } catch (err) {
    setStatus('扫描失败（内核反馈）：' + err.message, 'error');
  }
});

loadParams().catch((err) => setStatus('参数加载失败：' + err.message, 'error'));
