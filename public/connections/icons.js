const paths = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  external: '<path d="M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  light: '<path d="M9 18h6m-5 3h4M8.5 14.5a6 6 0 1 1 7 0L15 16H9z"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="m7 7 2-3h6l2 3"/>',
  speaker: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="15" r="3"/><path d="M11 7h2"/>',
  climate: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0ZM12 10v7m6-11h3m-3 5h3"/>',
  appliance: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 8h14m-10-2h.01M12 6h.01"/><rect x="8" y="11" width="8" height="7" rx="1"/>',
  sensor: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  blinds: '<path d="M4 3h16v16H4zM4 7h16M4 11h16M4 15h16m4-12v19m-1-1h2"/>',
  vacuum: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="2"/><path d="M6 16h12"/>',
  tv: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  garden: '<path d="M12 21v-9m0 4c-7 0-9-4-9-10 6 0 9 3 9 8m0 2c7 0 9-4 9-10-6 0-9 3-9 8"/>',
  energy: '<path d="m13 2-8 12h6l-1 8 9-13h-6z"/>',
  garage: '<path d="M3 21V9l9-6 9 6v12M7 21V11h10v10M7 15h10M7 19h10"/>',
  hub: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 15h.01M12 15h.01M7 6a8 8 0 0 1 10 0M10 3a11 11 0 0 1 4 0"/>',
};

export function icon(name, className = '') {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('viewBox', '0 0 24 24');
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', 'currentColor');
  element.setAttribute('stroke-width', '1.65');
  element.setAttribute('stroke-linecap', 'round');
  element.setAttribute('stroke-linejoin', 'round');
  element.setAttribute('aria-hidden', 'true');
  if (className) element.setAttribute('class', className);
  // Only these static, authored paths enter SVG markup; no user/catalog input does.
  element.innerHTML = paths[name] || paths.hub;
  return element;
}
