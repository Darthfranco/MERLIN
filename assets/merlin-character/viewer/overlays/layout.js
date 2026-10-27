import {chooseClockSpot, overlapArea} from '../clock-layout.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const rectangle = value => value && ['left', 'top', 'right', 'bottom'].every(key => finite(value[key])) &&
  value.right >= value.left && value.bottom >= value.top;

/** Reserved rectangles use stage pixels; clock anchors can be passed directly. */
function reservedRectangle(value) {
  if (rectangle(value)) return value;
  if (!value || !['x', 'y', 'width', 'height'].every(key => finite(value[key])) || value.width < 0 || value.height < 0) return null;
  const result = {left: value.x, top: value.y, right: value.x + value.width, bottom: value.y + value.height};
  return rectangle(result) ? result : null;
}

/** The companion keeps active work in a bounded, scrollable corner, including in face mode. */
export function companionOverlayRail({width, height, mode = 'body', clock, obstacles = [], current} = {}) {
  if (![width, height].every(value => finite(value) && value > 0) || !['body', 'face'].includes(mode) || !Array.isArray(obstacles)) return null;
  const inset = Math.max(4, Math.min(width, height) * .025);
  if (width <= inset * 2 || height <= inset * 2) return null;
  const railWidth = Math.min(width - inset * 2, mode === 'face' ? Math.min(320, width * .42) : Math.min(300, width * .32));
  const maxHeight = height * (mode === 'face' ? .2 : .76);
  const right = {id: 'lower-right', x: width - inset - railWidth, bottom: inset, width: railWidth, maxHeight};
  if (mode === 'face') return right;
  const left = {...right, id: 'lower-left', x: inset};
  const clockRect = reservedRectangle(clock), clockCenter = clockRect ? (clockRect.left + clockRect.right) / 2 : width / 2;
  const preference = clockCenter > width * .55 ? 'lower-left' : clockCenter < width * .45 ? 'lower-right' : current || 'lower-right';
  const occupied = obstacles.filter(rectangle).map(value => ({left: value.left * width, top: value.top * height, right: value.right * width, bottom: value.bottom * height}));
  if (clockRect) occupied.push(clockRect);
  const score = target => {
    const rect = {left: target.x, top: height - inset - maxHeight, right: target.x + railWidth, bottom: height - inset};
    return occupied.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle), 0) / (railWidth * maxHeight);
  };
  return [left, right].sort((a, b) => score(a) - score(b) || Number(b.id === preference) - Number(a.id === preference))[0];
}

/** Optional cards yield when every shared anchor is occupied; the clock never does. */
export function chooseOverlaySpot({width, height, cardWidth, cardHeight, obstacles = [], reserved = [], current} = {}) {
  if (![width, height, cardWidth, cardHeight].every(value => finite(value) && value > 0)) return null;
  const inset = Math.min(width, height) * .055;
  if (cardWidth > width - 2 * inset || cardHeight > height - 2 * inset) return null;
  if (!Array.isArray(obstacles) || !obstacles.every(rectangle) || !Array.isArray(reserved)) return null;
  const occupied = reserved.map(reservedRectangle);
  if (occupied.some(value => !value)) return null;
  const normalized = occupied.map(value => ({
    left: value.left / width, top: value.top / height,
    right: value.right / width, bottom: value.bottom / height,
  }));
  // chooseClockSpot applies its usual clearance to the candidate once. Expanding
  // reserved rectangles again would unnecessarily discard nearby safe anchors.
  const spot = chooseClockSpot({width, height, clockWidth: cardWidth, clockHeight: cardHeight,
    obstacles: [...obstacles, ...normalized], current});
  return spot.overlap === 0 ? spot : null;
}
