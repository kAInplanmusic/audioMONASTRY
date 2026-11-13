/** Existing App retry contract: two seconds, at most 150 attempts, cancellable. */
export function startMainStreamRetry(options: { ready: () => boolean; mark: () => void; start: () => void }): () => void {
  let attempts = 0;
  const timer = setInterval(() => {
    if (options.ready() || attempts >= 150) { clearInterval(timer); return; }
    attempts += 1;
    options.mark();
    options.start();
  }, 2000);
  return () => clearInterval(timer);
}
