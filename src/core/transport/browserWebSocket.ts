/** Raw WebSocket for browser transports that own their protocol and lifecycle. */
export function openBrowserWebSocket(url: string): WebSocket {
  return new WebSocket(url);
}
