// Tabler Icons 3.49.0, MIT; shapes are vendored in assets/icons.svg.
export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `studio-icon ${className}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}
