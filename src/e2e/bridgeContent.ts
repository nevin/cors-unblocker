// Test-only (built with --e2e, never shipped). Firefox's WebDriver cannot script extension pages, so
// end-to-end tests drive the extension from ordinary *.test pages: the page posts a request, this
// content script relays it to the background, and posts the answer back.
const REQUEST = 'cors-unblocker-e2e-request';
const RESPONSE = 'cors-unblocker-e2e-response';

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; id?: number; command?: string; args?: unknown[] } | null;
  if (event.source !== window || data?.type !== REQUEST) {
    return;
  }

  void browser.runtime.sendMessage({ e2e: true, command: data.command, args: data.args ?? [] }).then(
    (result: unknown) => window.postMessage({ type: RESPONSE, id: data.id, result }, '*'),
    (error: unknown) => window.postMessage({ type: RESPONSE, id: data.id, error: String(error) }, '*')
  );
});
