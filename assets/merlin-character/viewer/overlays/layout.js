import {chooseClockSpot} from '../clock-layout.js';

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
