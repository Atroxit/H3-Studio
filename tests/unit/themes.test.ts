// Unit tests for the pure prompt theme module: the shipped catalog, the composition
// rule that joins chunks onto a prompt, the character delta the composer counter shows,
// and the slug an id is made from. No React, no fs, no DOM.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_THEMES,
  PROMPT_THEME_CATEGORIES,
  PROMPT_THEME_CATEGORY_LABELS,
  composePromptWithThemes,
  normalizeThemeId,
  themeAppendCharDelta,
} from '../../src/core/themes';
import type { PromptTheme } from '../../src/core/types';

const FILM: PromptTheme = {
  id: 'film',
  name: 'Film',
  category: 'style',
  snippet: 'shot on 35mm film',
};

const GRAIN: PromptTheme = { id: 'grain', name: 'Grain', category: 'style', snippet: 'visible grain' };

describe('the shipped prompt theme catalog', () => {
  it('has unique ids, readable names and a non-empty chunk for every theme', () => {
    const ids = DEFAULT_PROMPT_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of DEFAULT_PROMPT_THEMES) {
      expect(theme.id).toMatch(/^[a-z0-9-]+$/);
      expect(theme.name.trim().length).toBeGreaterThan(0);
      expect(theme.snippet.trim().length).toBeGreaterThan(0);
      expect(PROMPT_THEME_CATEGORIES).toContain(theme.category);
      expect(theme.builtIn).toBe(true);
    }
  });

  it('ships 18 curated chunks across all four built-in categories', () => {
    expect(DEFAULT_PROMPT_THEMES).toHaveLength(18);
    const categories = new Set(DEFAULT_PROMPT_THEMES.map((theme) => theme.category));
    expect([...categories].sort()).toEqual(['camera', 'lighting', 'mood', 'style']);
    expect(PROMPT_THEME_CATEGORY_LABELS.custom).toBe('Custom');
  });

  it('includes the quick-pick themes the composer strip names first', () => {
    const byId = new Map(DEFAULT_PROMPT_THEMES.map((theme) => [theme.id, theme]));
    expect(byId.get('realistic')?.name).toBe('Realistic');
    expect(byId.get('cinematic')?.name).toBe('Cinematic');
    expect(byId.get('shallow-dof')?.name).toBe('Shallow DOF');
    expect(byId.get('studio-softbox')?.name).toBe('Studio Softbox');
  });
});

describe('composePromptWithThemes', () => {
  it('returns the trimmed base prompt when no theme is active', () => {
    expect(composePromptWithThemes('  a brass lighthouse  ', [])).toBe('a brass lighthouse');
    expect(composePromptWithThemes('   ', [])).toBe('');
  });

  it('appends one chunk after a plain word with a full stop', () => {
    expect(composePromptWithThemes('a brass lighthouse', [FILM])).toBe(
      'a brass lighthouse. shot on 35mm film',
    );
  });

  it('keeps a sentence that already ends in punctuation', () => {
    expect(composePromptWithThemes('A brass lighthouse.', [FILM])).toBe(
      'A brass lighthouse. shot on 35mm film',
    );
    expect(composePromptWithThemes('Who lit it?', [FILM])).toBe(
      'Who lit it? shot on 35mm film',
    );
  });

  it('continues a comma or semicolon list without a stray full stop', () => {
    expect(composePromptWithThemes('a lighthouse,', [FILM])).toBe(
      'a lighthouse, shot on 35mm film',
    );
    expect(composePromptWithThemes('a lighthouse;', [FILM])).toBe(
      'a lighthouse; shot on 35mm film',
    );
  });

  it('joins several chunks with commas, and after a full stop with a space', () => {
    expect(composePromptWithThemes('a lighthouse', [FILM, GRAIN])).toBe(
      'a lighthouse. shot on 35mm film, visible grain',
    );
    const sentence: PromptTheme = { id: 's', name: 'S', category: 'style', snippet: 'A quiet sky.' };
    expect(composePromptWithThemes('a lighthouse', [sentence, FILM])).toBe(
      'a lighthouse. A quiet sky. shot on 35mm film',
    );
  });

  it('deduplicates identical chunks and skips chunks already inside the prompt', () => {
    expect(composePromptWithThemes('a lighthouse', [FILM, FILM])).toBe(
      'a lighthouse. shot on 35mm film',
    );
    // The chunk already in the prompt is dropped; the remaining one is appended normally.
    expect(
      composePromptWithThemes('a lighthouse, shot on 35mm film', [FILM, GRAIN]),
    ).toBe('a lighthouse, shot on 35mm film. visible grain');
  });

  it('returns the joined chunks when the prompt is empty', () => {
    expect(composePromptWithThemes('', [FILM, GRAIN])).toBe('shot on 35mm film, visible grain');
    expect(composePromptWithThemes('   ', [FILM])).toBe('shot on 35mm film');
  });

  it('ignores blank chunks and trims the chunks it keeps', () => {
    const blank: PromptTheme = { id: 'b', name: 'B', category: 'style', snippet: '   ' };
    const padded: PromptTheme = { id: 'p', name: 'P', category: 'style', snippet: '  soft light  ' };
    expect(composePromptWithThemes('a lighthouse', [blank, padded])).toBe(
      'a lighthouse. soft light',
    );
  });

  it('returns the base prompt when every chunk is already present', () => {
    expect(composePromptWithThemes('shot on 35mm film', [FILM])).toBe('shot on 35mm film');
  });
});

describe('themeAppendCharDelta', () => {
  it('counts only the characters the tags add', () => {
    const base = 'a brass lighthouse';
    const composed = composePromptWithThemes(base, [FILM]);
    expect(themeAppendCharDelta(base, [FILM])).toBe(composed.length - base.length);
  });

  it('counts the separator it inserts, and ignores surrounding whitespace', () => {
    expect(themeAppendCharDelta('  a brass lighthouse  ', [FILM])).toBe(
      '. shot on 35mm film'.length,
    );
    expect(themeAppendCharDelta('a lighthouse.', [FILM])).toBe(' shot on 35mm film'.length);
  });

  it('returns zero when nothing new is appended', () => {
    expect(themeAppendCharDelta('a lighthouse', [])).toBe(0);
    expect(themeAppendCharDelta('shot on 35mm film', [FILM])).toBe(0);
  });

  it('returns the joined chunk length when the base prompt is empty', () => {
    expect(themeAppendCharDelta('', [FILM, GRAIN])).toBe('shot on 35mm film, visible grain'.length);
  });
});

describe('normalizeThemeId', () => {
  it('slugifies a readable name', () => {
    expect(normalizeThemeId('Retro VHS')).toBe('retro-vhs');
    expect(normalizeThemeId(' 35mm Film ')).toBe('35mm-film');
    expect(normalizeThemeId('Dark Fantasy!')).toBe('dark-fantasy');
    expect(normalizeThemeId('A--B__C')).toBe('a-b-c');
  });

  it('falls back to a usable id when nothing survives the slug', () => {
    expect(normalizeThemeId('')).toBe('theme');
    expect(normalizeThemeId('!!!')).toBe('theme');
    expect(normalizeThemeId('  ')).toBe('theme');
  });
});
