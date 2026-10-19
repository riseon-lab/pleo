import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORIES, SECTIONS, DEFAULT_SELECTIONS, composePrompt, normalizeRecipe, chooseDirection } from '../frontend/js/studio/catalog.js';
import { h } from '../frontend/js/ui.js';

const recipe = { identity: 'maya_character', extra: 'A small red notebook in her hand', selections: {
  ...DEFAULT_SELECTIONS, location: 'cafe', lens: '85', accessories: ['earrings', 'watch'],
} };
const prompt = composePrompt(recipe);
assert.ok(prompt.startsWith('maya_character.'));
assert.ok(prompt.includes('outdoor sidewalk café'));
assert.ok(prompt.includes('85mm portrait lens'));
assert.ok(prompt.includes('understated earrings') && prompt.includes('wristwatch'));
assert.ok(prompt.endsWith('A small red notebook in her hand.'));
assert.equal(composePrompt(JSON.parse(JSON.stringify(recipe))), prompt, 'a saved recipe produces the same prompt');

const override = composePrompt({ selections: { look: 'tailored', top: 'tee' } });
assert.ok(!override.includes('turtleneck'), 'a garment override replaces the old garment');
assert.ok(override.includes('T-shirt') && override.includes('gray wide-leg tailored trousers') && override.includes('black loafers'));
const allOverrides = composePrompt({ selections: { look: 'tailored', top: 'tee', bottom: 'jeans', shoes: 'sneakers' } });
assert.ok(!allOverrides.includes('loafers') && !allOverrides.includes('tailored trousers'));

const filtered = normalizeRecipe({ mode: 'invalid', identity: 12, selections: {
  framing: 'invented', lens: '85', extra: 'untrusted', accessories: ['watch', 'watch', 'invented'],
} });
assert.equal(filtered.mode, 'builder');
assert.equal(filtered.identity, '');
assert.equal(filtered.selections.framing, undefined);
assert.equal(filtered.selections.extra, undefined);
assert.deepEqual(filtered.selections.accessories, ['watch']);
assert.equal(normalizeRecipe(null).mode, 'builder');
assert.equal(composePrompt({ selections: {} }), 'An adult character.');

const moving = chooseDirection({ selections: DEFAULT_SELECTIONS }, 'activity', 'run');
assert.equal(moving.selections.body, undefined, 'running replaces a static body pose');
assert.equal(chooseDirection(moving, 'body', 'sit').selections.activity, undefined, 'a new pose replaces a conflicting action');
const coffee = chooseDirection({ selections: DEFAULT_SELECTIONS }, 'activity', 'coffee');
assert.equal(coffee.selections.hands, undefined, 'holding coffee clears hands in pockets');
assert.equal(chooseDirection(coffee, 'hands', 'pockets').selections.activity, undefined);
assert.equal(chooseDirection({ selections: { top: 'tee' } }, 'look', 'tailored').selections.top, undefined);
assert.equal(chooseDirection({ selections: { body: 'sit' } }, 'body', 'sit').selections.body, undefined);
assert.deepEqual(chooseDirection({ selections: { accessories: ['watch'] } }, 'accessories', 'earrings').selections.accessories, ['watch', 'earrings']);

// ARIA booleans must stay explicit strings; an empty attribute hides selected-state styling and semantics.
const previousDocument = globalThis.document;
try {
  globalThis.document = { createElement: () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }) };
  const button = h('button', { 'aria-pressed': true, 'aria-selected': false, disabled: true });
  assert.deepEqual(button.attributes, { 'aria-pressed': 'true', 'aria-selected': 'false', disabled: '' });
} finally { globalThis.document = previousDocument; }

const sprite = readFileSync(new URL('../frontend/assets/icons.svg', import.meta.url), 'utf8');
for (const category of CATEGORIES) {
  for (const name of [category.icon, ...category.sections.flatMap(section => section.options.map(option => option.icon))]) {
    assert.ok(sprite.includes(`id="${name}"`), `missing local icon: ${name}`);
  }
}
for (const section of SECTIONS) assert.equal(new Set(section.options.map(item => item.id)).size, section.options.length);
assert.equal(new Set(SECTIONS.map(section => section.id)).size, SECTIONS.length);
console.log(`PASS  ${SECTIONS.reduce((n, section) => n + section.options.length, 0)} directions: prompt composition, wardrobe overrides, persistence, validation and local icons`);
