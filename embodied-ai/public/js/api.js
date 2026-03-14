/**
 * API client for the Embodied AI local inference server and Netlify functions.
 */

const LOCAL_SERVER = 'http://localhost:8000';

/**
 * Check if the local inference server is running.
 */
export async function checkServerHealth() {
  try {
    const res = await fetch(`${LOCAL_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generate a face image using the local FLUX.1-schnell model.
 * @param {object} params - Generation parameters
 * @param {string} params.prompt - Text prompt
 * @param {number} params.width - Image width
 * @param {number} params.height - Image height
 * @param {number} params.num_inference_steps - Number of steps
 * @param {number|null} params.seed - Optional seed
 * @returns {Promise<{image_base64: string, prompt_used: string, generation_time_ms: number, seed: number}>}
 */
export async function generateFace(params) {
  const res = await fetch(`${LOCAL_SERVER}/face/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Face generation failed');
  }

  return res.json();
}

/**
 * Save a face image to gallery (local storage for now, Netlify Blobs later).
 */
export function saveToGallery(imageBase64, metadata) {
  const gallery = JSON.parse(localStorage.getItem('embodied-ai-gallery') || '[]');
  gallery.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    image: imageBase64,
    metadata,
    createdAt: new Date().toISOString(),
  });
  // Keep max 50 items
  if (gallery.length > 50) gallery.length = 50;
  localStorage.setItem('embodied-ai-gallery', JSON.stringify(gallery));
  return gallery;
}

/**
 * Load gallery from local storage.
 */
export function loadGallery() {
  return JSON.parse(localStorage.getItem('embodied-ai-gallery') || '[]');
}
