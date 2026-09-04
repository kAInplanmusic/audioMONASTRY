// Audio-Routing-Adapter (backend-core, Node).
// Hinweis: Das native Addon `audio_core.node` ist in diesem Repo nicht gebaut.
// Der Export schlägt deshalb bewusst fehl, statt lautlos ein No-op zu sein –
// so erkennen Aufrufer sofort, dass echtes Audio-Routing nicht verfügbar ist.

function routeAudio(input, output) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TypeError('routeAudio: input must be a non-empty string');
  }
  if (typeof output !== 'string' || output.length === 0) {
    throw new TypeError('routeAudio: output must be a non-empty string');
  }
  const error = new Error('routeAudio: native audio_core addon is not built; audio routing unavailable');
  error.code = 'ERR_AUDIO_ROUTING_UNAVAILABLE';
  throw error;
}

module.exports = { routeAudio };
