// Prompt themes: preset prompt chunks the composer appends as tags.
//
// Everything here is pure: no Node fs, no React and no DOM. The server persists themes
// (src/server/themes.ts) and the composer renders them, but the wording of a chunk and
// the punctuation rule that joins it are one shared decision, so both sides import this.

import type { PromptTheme, PromptThemeCategory } from './types';

/** The category order the picker shows, with Custom last because it grows at runtime. */
export const PROMPT_THEME_CATEGORIES = [
  'style',
  'mood',
  'lighting',
  'camera',
  'custom',
] as const satisfies readonly PromptThemeCategory[];

export const PROMPT_THEME_CATEGORY_LABELS: Readonly<Record<PromptThemeCategory, string>> = {
  style: 'Style',
  mood: 'Mood',
  lighting: 'Lighting',
  camera: 'Camera',
  custom: 'Custom',
};

/**
 * The shipped themes. Each chunk is written to carry its own weight in a prompt: a
 * photographic style names film stock and light behaviour, not a single adjective.
 */
export const DEFAULT_PROMPT_THEMES: readonly PromptTheme[] = [
  {
    id: 'realistic',
    name: 'Realistic',
    category: 'style',
    snippet:
      'candid photograph, natural skin texture with subtle pores and fine imperfections, true-to-life proportions, authentic materials, unretouched editorial realism',
    builtIn: true,
  },
  {
    id: '35mm-film',
    name: '35mm Film',
    category: 'style',
    snippet:
      'shot on 35mm analog film, subtle organic grain, Kodak Portra 400 color rendition, gentle highlight roll-off, natural halation',
    builtIn: true,
  },
  {
    id: 'editorial',
    name: 'Editorial',
    category: 'style',
    snippet:
      'high-fashion magazine editorial photography, deliberate art direction, clean composition, refined styling, crisp micro-contrast',
    builtIn: true,
  },
  {
    id: 'documentary',
    name: 'Documentary',
    category: 'style',
    snippet:
      'raw photojournalism style, unposed candid moment, environmental context, realistic exposure, authentic lived-in atmosphere',
    builtIn: true,
  },
  {
    id: 'concept-art',
    name: 'Concept Art',
    category: 'style',
    snippet:
      'detailed environment and character concept art, painterly brushwork, atmospheric perspective, strong silhouette readability',
    builtIn: true,
  },
  {
    id: 'oil-painting',
    name: 'Oil Painting',
    category: 'style',
    snippet:
      'classical oil on canvas, rich impasto texture, visible directional brushstrokes, luminous glazing, museum-grade tonal depth',
    builtIn: true,
  },
  {
    id: 'anime',
    name: 'Anime',
    category: 'style',
    snippet:
      'high-budget theatrical anime key visual, crisp lineart, cel-shaded lighting with soft atmospheric gradients, expressive framing',
    builtIn: true,
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    category: 'mood',
    snippet:
      'near-future cyberpunk urban atmosphere, rain-slicked asphalt, dense layered signage, weathered industrial tech, humid night haze',
    builtIn: true,
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    category: 'mood',
    snippet:
      'cinematic widescreen film still, deliberate visual storytelling, dramatic depth layering, theatrical color grading, atmospheric tension',
    builtIn: true,
  },
  {
    id: 'noir',
    name: 'Noir',
    category: 'mood',
    snippet:
      'neo-noir atmosphere, deep chiaroscuro shadows, high-contrast pools of practical light, wet reflective surfaces, moody brooding tone',
    builtIn: true,
  },
  {
    id: 'dark-fantasy',
    name: 'Dark Fantasy',
    category: 'mood',
    snippet:
      'gothic dark fantasy atmosphere, weathered stone and wrought iron, drifting mist, ancient arcane details, solemn muted palette',
    builtIn: true,
  },
  {
    id: 'minimalist',
    name: 'Minimalist',
    category: 'mood',
    snippet:
      'minimalist architectural composition, generous negative space, restrained neutral palette, clean geometric lines, quiet stillness',
    builtIn: true,
  },
  {
    id: 'golden-hour',
    name: 'Golden Hour',
    category: 'lighting',
    snippet:
      'warm low-angle golden hour sunlight, long soft shadows, luminous rim lighting, gentle atmospheric warmth',
    builtIn: true,
  },
  {
    id: 'neon-night',
    name: 'Neon Night',
    category: 'lighting',
    snippet:
      'nocturnal practical neon lighting, cyan and magenta reflections on wet surfaces, deep crushed shadows, glowing signage bokeh',
    builtIn: true,
  },
  {
    id: 'overcast',
    name: 'Overcast',
    category: 'lighting',
    snippet:
      'soft diffused overcast daylight, even wraparound light, muted natural color palette, subtle surface sheen',
    builtIn: true,
  },
  {
    id: 'studio-softbox',
    name: 'Studio Softbox',
    category: 'lighting',
    snippet:
      'controlled studio softbox key light, subtle sculpted falloff, clean catchlights, neutral seamless backdrop',
    builtIn: true,
  },
  {
    id: 'shallow-dof',
    name: 'Shallow DOF',
    category: 'camera',
    snippet:
      'shot on 85mm f/1.4 prime lens, razor-sharp subject focus, creamy optical bokeh background separation, subtle natural vignette',
    builtIn: true,
  },
  {
    id: 'macro',
    name: 'Macro',
    category: 'camera',
    snippet:
      'extreme macro close-up photography, 100mm macro lens, microscopic surface detail, razor-thin plane of focus, tactile textures',
    builtIn: true,
  },
];

/** A slug safe for a URL path segment, with a readable fallback for anything unusable. */
export function normalizeThemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'theme';
}

/** A sentence, exclamation or question ends a chunk: the next one starts after a space. */
function endsSentence(text: string): boolean {
  return /[.!?]$/.test(text);
}

/** A chunk that already ends in punctuation keeps its own separator; otherwise a comma. */
function joinSnippets(snippets: readonly string[]): string {
  let joined = '';
  for (const snippet of snippets) {
    if (joined.length === 0) {
      joined = snippet;
      continue;
    }
    joined += `${endsSentence(joined) ? ' ' : ', '}${snippet}`;
  }
  return joined;
}

/** The separator between the user's prompt and the first appended chunk. */
function baseSeparator(basePrompt: string): string {
  if (endsSentence(basePrompt)) return ' ';
  if (/[,;]$/.test(basePrompt)) return ' ';
  return '. ';
}

/**
 * The prompt the provider actually receives: the user's words, then every active chunk.
 *
 * A chunk the prompt already contains is skipped, so clicking "Use prompt" on a finished
 * batch and keeping its tags never doubles the wording. Duplicate chunks are collapsed
 * case-insensitively for the same reason: two tags may carry the same sentence.
 */
export function composePromptWithThemes(
  basePrompt: string,
  themes: readonly Pick<PromptTheme, 'snippet'>[],
): string {
  const base = basePrompt.trim();
  const lowerBase = base.toLowerCase();
  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const theme of themes) {
    const snippet = theme.snippet.trim();
    if (snippet.length === 0) continue;
    const key = snippet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (lowerBase.length > 0 && lowerBase.includes(key)) continue;
    snippets.push(snippet);
  }

  const joined = joinSnippets(snippets);
  if (base.length === 0) return joined;
  if (joined.length === 0) return base;
  return `${base}${baseSeparator(base)}${joined}`;
}

/**
 * How many characters the active tags add, so the composer counter can read
 * `49 (+184) / 4000` without the user wondering what the extra text is.
 */
export function themeAppendCharDelta(
  basePrompt: string,
  themes: readonly Pick<PromptTheme, 'snippet'>[],
): number {
  const composed = composePromptWithThemes(basePrompt, themes);
  return Math.max(0, composed.length - basePrompt.trim().length);
}
