/** Shown instead of the app when the backend rejects the browser session (HTTP 401). */
export function SessionRequired({ reason }: { reason?: string }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight">Session required</h1>
        <p className="mt-2 text-sm text-muted-foreground">{reason ?? 'Open the interface from a terminal to start a session.'}</p>
        <pre className="mt-5 rounded-md bg-input px-3 py-2.5 font-mono text-sm">
          <code>domain-scout ui</code>
        </pre>
      </div>
    </main>
  );
}
