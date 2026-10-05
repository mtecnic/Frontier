// Deploy-time settings for the Frontier client. Edit this file in your public
// folder; no rebuild is needed.
window.FRONTIER_CONFIG = {
  // Where the API lives, relative to this page or absolute (https://api.example.com/api).
  apiBase: './api',
  // MapLibre style with OpenStreetMap vector tiles. OpenFreeMap is free and needs no key.
  mapStyle: 'https://tiles.openfreemap.org/styles/positron',
  mapStyleDark: 'https://tiles.openfreemap.org/styles/dark',
  // Where the map opens before we know where the player is: [longitude, latitude].
  // defaultCenter: [-115.1398, 36.1699],
  // defaultZoom: 13,
};
