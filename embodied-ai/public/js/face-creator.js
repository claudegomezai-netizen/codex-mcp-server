/**
 * Face Creator - Builds text prompts from slider/dropdown UI controls.
 */

// All control IDs and how they map to prompt segments
const CONTROLS = {
  age: { type: 'range', format: (v) => `${v} year old` },
  gender: { type: 'select', format: (v) => v ? `${v} person` : '' },
  ethnicity: { type: 'select', format: (v) => v || '' },
  'face-shape': { type: 'select', format: (v) => v ? `${v} face shape` : '' },
  'eye-color': { type: 'select', format: (v) => v ? `${v} eyes` : '' },
  'skin-tone': { type: 'select', format: (v) => v ? `${v} skin tone` : '' },
  'hair-style': { type: 'select', format: (v) => v ? `${v} hair` : '' },
  'hair-color': { type: 'select', format: (v) => v ? `${v} hair color` : '' },
  'facial-hair': { type: 'select', format: (v) => v ? `with ${v}` : '' },
  expression: { type: 'select', format: (v) => v ? `${v} expression` : '' },
  lighting: { type: 'select', format: (v) => v ? `${v} lighting` : '' },
  'shot-type': { type: 'select', format: (v) => v || '' },
};

/**
 * Read all control values and build a structured prompt.
 * @returns {string}
 */
export function buildPrompt() {
  const parts = [];

  for (const [id, config] of Object.entries(CONTROLS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = el.value;
    const formatted = config.format(value);
    if (formatted) parts.push(formatted);
  }

  // Add custom prompt
  const customPrompt = document.getElementById('custom-prompt')?.value?.trim();
  if (customPrompt) parts.push(customPrompt);

  return parts.join(', ');
}

/**
 * Get generation settings from the UI.
 */
export function getGenerationSettings() {
  const size = parseInt(document.getElementById('image-size')?.value || '512', 10);
  const steps = parseInt(document.getElementById('steps')?.value || '4', 10);  // SDXL-Lightning: 4 steps optimal
  const seedEl = document.getElementById('seed');
  const seed = seedEl?.value ? parseInt(seedEl.value, 10) : null;

  return { width: size, height: size, num_inference_steps: steps, seed };
}

/**
 * Randomize all controls with plausible values.
 */
export function randomizeControls() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Age: weighted toward 25-45
  const age = 20 + Math.floor(Math.random() * 40);
  document.getElementById('age').value = age;
  document.getElementById('age-value').textContent = age;

  // Randomize all selects
  const selects = ['gender', 'ethnicity', 'face-shape', 'eye-color', 'skin-tone',
    'hair-style', 'hair-color', 'facial-hair', 'expression', 'lighting', 'shot-type'];

  for (const id of selects) {
    const el = document.getElementById(id);
    if (!el) continue;
    const options = Array.from(el.options);
    el.value = pick(options).value;
  }

  // Clear custom prompt and seed
  const customPrompt = document.getElementById('custom-prompt');
  if (customPrompt) customPrompt.value = '';
  const seed = document.getElementById('seed');
  if (seed) seed.value = '';

  // Update prompt preview
  updatePromptPreview();
}

/**
 * Update the prompt preview text.
 */
export function updatePromptPreview() {
  const promptEl = document.getElementById('prompt-text');
  if (promptEl) {
    promptEl.textContent = buildPrompt();
  }
}

/**
 * Set up event listeners for live prompt preview updates.
 */
export function initControls() {
  // Range sliders: update display value
  const ageSlider = document.getElementById('age');
  if (ageSlider) {
    ageSlider.addEventListener('input', () => {
      document.getElementById('age-value').textContent = ageSlider.value;
      updatePromptPreview();
    });
  }

  const stepsSlider = document.getElementById('steps');
  if (stepsSlider) {
    stepsSlider.addEventListener('input', () => {
      document.getElementById('steps-value').textContent = stepsSlider.value;
    });
  }

  // All selects and inputs: update prompt preview on change
  const allInputs = document.querySelectorAll('select, input, textarea');
  for (const input of allInputs) {
    input.addEventListener('change', updatePromptPreview);
    input.addEventListener('input', updatePromptPreview);
  }

  // Initial preview
  updatePromptPreview();
}
