/**
 * Embodied AI - Main Application Controller
 */
import { checkServerHealth, generateFace, saveToGallery, loadGallery } from './api.js';
import { initControls, buildPrompt, getGenerationSettings, randomizeControls } from './face-creator.js';

let isGenerating = false;
let timerInterval = null;
let timerStart = 0;

// --- Server Health ---
async function updateServerStatus() {
  const badge = document.getElementById('server-status');
  const ok = await checkServerHealth();
  badge.textContent = ok ? 'Server: Connected' : 'Server: Disconnected';
  badge.className = `status-badge ${ok ? 'connected' : 'disconnected'}`;
  return ok;
}

// --- Face Generation ---
async function handleGenerate() {
  if (isGenerating) return;

  const serverOk = await updateServerStatus();
  if (!serverOk) {
    alert('Local inference server is not running.\n\nStart it with:\n  cd embodied-ai/server\n  python server.py');
    return;
  }

  isGenerating = true;
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  // Show spinner + start timer
  document.getElementById('loading-spinner').style.display = 'flex';
  document.getElementById('preview-placeholder').style.display = 'none';
  document.getElementById('preview-image').style.display = 'none';

  timerStart = Date.now();
  const loadingText = document.getElementById('loading-text');
  loadingText.textContent = 'Generating... 0s';
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - timerStart) / 1000);
    loadingText.textContent = `Generating... ${elapsed}s`;
  }, 1000);

  const prompt = buildPrompt();
  const settings = getGenerationSettings();

  try {
    const result = await generateFace({
      prompt,
      ...settings,
    });

    // Display result
    const img = document.getElementById('preview-image');
    img.src = `data:image/png;base64,${result.image_base64}`;
    img.style.display = 'block';
    document.getElementById('loading-spinner').style.display = 'none';

    // Update info
    document.getElementById('generation-info').style.display = 'block';
    document.getElementById('gen-time').textContent = (result.generation_time_ms / 1000).toFixed(1);
    document.getElementById('gen-seed').textContent = result.seed;

    // Update seed field for reproducibility
    document.getElementById('seed').value = result.seed;

    // Show save row
    document.getElementById('save-row').style.display = 'flex';

    // Store current result for save/download
    window._currentFace = result;
  } catch (err) {
    document.getElementById('loading-spinner').style.display = 'none';
    document.getElementById('preview-placeholder').style.display = 'block';
    document.getElementById('preview-placeholder').innerHTML = `<p style="color: var(--error);">Error: ${err.message}</p>`;
    console.error('Generation failed:', err);
  } finally {
    clearInterval(timerInterval);
    timerInterval = null;
    isGenerating = false;
    btn.disabled = false;
    btn.textContent = 'Generate Face';
  }
}

// --- Save & Download ---
function handleSave() {
  if (!window._currentFace) return;
  const metadata = {
    prompt: window._currentFace.prompt_used,
    seed: window._currentFace.seed,
    time: window._currentFace.generation_time_ms,
  };
  saveToGallery(window._currentFace.image_base64, metadata);
  renderGallery();
}

function handleDownload() {
  if (!window._currentFace) return;
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${window._currentFace.image_base64}`;
  link.download = `face-${window._currentFace.seed}.png`;
  link.click();
}

// --- Gallery ---
function renderGallery() {
  const gallery = document.getElementById('gallery');
  const items = loadGallery();

  if (items.length === 0) {
    gallery.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem;">No saved faces yet</p>';
    return;
  }

  gallery.innerHTML = items.map((item) => `
    <div class="gallery-item" data-id="${item.id}" title="Seed: ${item.metadata?.seed || '?'}">
      <img src="data:image/png;base64,${item.image}" alt="Saved face">
    </div>
  `).join('');

  // Click to load into preview
  gallery.querySelectorAll('.gallery-item').forEach((el) => {
    el.addEventListener('click', () => {
      const item = items.find((i) => i.id === el.dataset.id);
      if (!item) return;
      const img = document.getElementById('preview-image');
      img.src = `data:image/png;base64,${item.image}`;
      img.style.display = 'block';
      document.getElementById('preview-placeholder').style.display = 'none';
      if (item.metadata?.seed) {
        document.getElementById('seed').value = item.metadata.seed;
      }
      window._currentFace = {
        image_base64: item.image,
        prompt_used: item.metadata?.prompt || '',
        seed: item.metadata?.seed || 0,
        generation_time_ms: item.metadata?.time || 0,
      };
      document.getElementById('save-row').style.display = 'flex';
      document.getElementById('generation-info').style.display = 'block';
      document.getElementById('gen-time').textContent = ((item.metadata?.time || 0) / 1000).toFixed(1);
      document.getElementById('gen-seed').textContent = item.metadata?.seed || '?';
    });
  });
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initControls();
  renderGallery();
  updateServerStatus();

  // Poll server health every 10s
  setInterval(updateServerStatus, 10000);

  // Button handlers
  document.getElementById('btn-generate').addEventListener('click', handleGenerate);
  document.getElementById('btn-random').addEventListener('click', () => {
    randomizeControls();
  });
  document.getElementById('btn-save').addEventListener('click', handleSave);
  document.getElementById('btn-download').addEventListener('click', handleDownload);
});
