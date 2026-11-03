import { homeAssistant } from './home-assistant.js';
import { philipsHue } from './hue.js';
import { shelly } from './shelly.js';
import { switchbot } from './switchbot.js';
import { rachio } from './rachio.js';
import { spotifyConnector } from './spotify.js';
import { demoHome as simulatedHome } from './demo-home.js';

/**
 * Every real connector MERLIN has. Order is display order. A catalog service appears here only when MERLIN can
 * authenticate to it and control it; guides and unsupported services live in public/connections/integrations.js.
 * The labeled, simulated demo home is added only when explicitly turned on (MERLIN_DEMO_HOME=1).
 */
export function createConnectors({ spotify, demoHome = false }) {
  return [homeAssistant(), philipsHue(), shelly(), switchbot(), rachio(), ...(spotify ? [spotifyConnector(spotify)] : []), ...(demoHome ? [simulatedHome()] : [])];
}
