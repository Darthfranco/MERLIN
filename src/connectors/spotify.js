// Spotify is managed by its own service (src/spotify.js: OAuth with PKCE, token refresh, playback tools). This adapter only
// reports its real status to the shared connector hub, so every screen reads one source, and handles Disconnect.
// "Connected" means Spotify itself issued tokens to MERLIN after the account owner approved access; nothing is simulated.

export function spotifyConnector(spotify) {
  return {
    id: 'spotify',
    name: 'Spotify',
    external: true,
    summary: 'Search, play, pause, skip, change volume, shuffle, repeat, queue and move playback between your Spotify devices, by typing.',
    setupUrl: '/#spotify-title',
    kinds: [],
    externalStatus() {
      const status = spotify.status();
      if (status.connected) return { status: 'connected', detail: 'Connected to your Spotify account. Playback needs Spotify Premium and an open Spotify device.', values: { client_id_saved: true } };
      if (status.configured) return { status: 'saved', detail: 'Client ID saved. Choose Connect Spotify and approve access on Spotify to finish. MERLIN cannot play music until then.', values: { client_id_saved: true } };
      return { status: 'not_connected', detail: 'Add the Client ID of your free Spotify developer app, then connect. You need Spotify Premium for playback.', values: {} };
    },
    async disconnect() {
      await spotify.disconnect();
      return 'Removed the Spotify tokens from MERLIN. To fully revoke access, also remove MERLIN in your Spotify account under Apps.';
    },
  };
}
