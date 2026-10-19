import { h, clear } from '../ui.js';
import { CATEGORIES, normalizeRecipe, selectedDirections, chooseDirection } from './catalog.js';
import { icon } from './icons.js';

export function promptBuilder({ value, onChange }) {
  let recipe = normalizeRecipe(value);
  let active = 'pose';
  let detail = 'body';
  const tabs = h('div', { class: 'builder-tabs', role: 'tablist', 'aria-label': 'Prompt categories' });
  const sections = h('div', { class: 'builder-sections', role: 'group', 'aria-label': 'Category details' });
  const choices = h('div', { class: 'builder-choices', role: 'group' });
  const search = h('input', { type: 'search', placeholder: 'Find a direction…', 'aria-label': 'Find a direction', oninput: drawChoices });
  const count = h('span', { class: 'muted builder-count', 'aria-live': 'polite' });
  const element = h('section', { class: 'studio-workbench', 'aria-label': 'Prompt builder' }, tabs,
    h('div', { class: 'builder-tools' }, sections, search), choices,
    h('div', { class: 'builder-footer' },
      h('span', { class: 'muted' }, 'Choose a direction. Tap a selected option to clear it.'), count,
      h('button', { class: 'text-btn', onclick: () => { recipe.selections = {}; draw(); onChange(); } }, 'Clear selections')));

  function draw() {
    clear(tabs);
    for (const category of CATEGORIES) {
      tabs.append(h('button', {
        id: `builder-tab-${category.id}`, type: 'button', role: 'tab',
        'aria-selected': category.id === active, 'aria-controls': 'builder-options',
        tabindex: category.id === active ? 0 : -1,
        onclick: () => { active = category.id; detail = category.sections[0].id; search.value = ''; draw(); },
        onkeydown: event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = CATEGORIES.findIndex(item => item.id === active);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? CATEGORIES.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + CATEGORIES.length) % CATEGORIES.length;
          active = CATEGORIES[next].id; detail = CATEGORIES[next].sections[0].id; search.value = ''; draw();
          tabs.children[next].focus();
        },
      }, icon(category.icon), h('span', {}, category.label),
      h('small', {}, selectedDirections(recipe).filter(item => item.category === category.id).length || '')));
    }
    clear(sections);
    const category = CATEGORIES.find(item => item.id === active);
    for (const item of category.sections) {
      sections.append(h('button', { class: 'detail-tab', 'aria-pressed': detail === item.id,
        onclick: () => { detail = item.id; search.value = ''; draw(); } }, item.label));
    }
    element.classList.toggle('manual-active', recipe.mode === 'manual');
    drawChoices();
  }

  function drawChoices() {
    clear(choices);
    choices.id = 'builder-options';
    choices.setAttribute('aria-labelledby', `builder-tab-${active}`);
    const category = CATEGORIES.find(item => item.id === active);
    const query = search.value.trim().toLowerCase();
    const groups = category.sections.filter(item => query || item.id === detail);
    let matched = 0;
    for (const group of groups) {
      const options = group.options.filter(item => !query || `${item.label} ${item.hint} ${group.label}`.toLowerCase().includes(query));
      if (!options.length) continue;
      const grid = h('div', { class: 'choice-grid' });
      if (query) choices.append(h('h3', { class: 'search-group-title' }, group.label));
      for (const option of options) {
        const selected = group.multiple ? recipe.selections[group.id]?.includes(option.id) : recipe.selections[group.id] === option.id;
        grid.append(h('button', { class: 'direction-choice', type: 'button', 'aria-pressed': Boolean(selected),
          title: option.prompt, onclick: () => {
            recipe = chooseDirection(recipe, group.id, option.id);
            draw(); onChange();
          } }, h('span', { class: 'choice-visual' }, icon(option.icon)),
        h('span', { class: 'choice-label' }, option.label),
        h('small', {}, option.hint || option.prompt)));
        matched++;
      }
      choices.append(grid);
    }
    if (!matched) choices.append(h('p', { class: 'muted empty-search' }, 'No matching directions in this category. Try a different word.'));
    count.textContent = `${selectedDirections(recipe).length} selected`;
  }

  draw();
  return { element, get value() { return normalizeRecipe(recipe); },
    set(value) { recipe = normalizeRecipe(value); draw(); },
    patch(patch) { recipe = normalizeRecipe({ ...recipe, ...patch }); draw(); },
  };
}
