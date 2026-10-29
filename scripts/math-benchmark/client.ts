declare global {
  interface Window {
    accuracyCommand(request: unknown): Promise<unknown>;
    resetAccuracyWorker(): void;
  }
}

// Playwright serializes this function without its module scope
export async function recognizePrepared({ request, gpu }: { request: unknown; gpu: string }): Promise<unknown> {
  // load and warm the model before the worker starts timing recognition
  const prepared = await window.accuracyCommand({ type: 'prepare', id: crypto.randomUUID() });
  if (typeof prepared !== 'object' || prepared === null || !('type' in prepared) || prepared.type !== 'ready' ||
      !('gpu' in prepared) || typeof prepared.gpu !== 'string' || !prepared.gpu)
    throw new Error('Benchmark preparation did not return a ready GPU');
  if (prepared.gpu !== gpu)
    throw new Error(`Benchmark GPU changed from ${gpu} to ${prepared.gpu}`);
  return window.accuracyCommand(request);
}

// keep dependencies inside this function or on window so Playwright can serialize it
export function installAccuracyClient({ timeoutMs = 300_000 }: { timeoutMs?: number } = {}): void {
  let worker: Worker | undefined;
  let cancelPending: ((reason: Error) => void) | undefined;

  window.resetAccuracyWorker = () => {
    if (cancelPending) cancelPending(new Error('Worker reset'));
    else {
      worker?.terminate();
      worker = undefined;
    }
  };

  window.accuracyCommand = (request) => new Promise((resolve, reject) => {
    if (cancelPending) {
      reject(new Error('Overlapping commands'));
      return;
    }
    if (typeof request !== 'object' || request === null || !('id' in request) || typeof request.id !== 'string') {
      reject(new Error('Command ID is required'));
      return;
    }
    const requestId = request.id;
    const current = worker ??= new Worker('/assets/accuracy-worker.js', { type: 'module' });
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      current.removeEventListener('message', receive);
      current.removeEventListener('error', failure);
      cancelPending = undefined;
      if (error) {
        current.terminate();
        if (worker === current) worker = undefined;
        reject(error);
      } else resolve(result);
    };
    const receive = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (typeof value !== 'object' || value === null || !('type' in value) || !('id' in value) || value.id !== requestId) return;
      if (value.type === 'error') {
        const message = 'error' in value && typeof value.error === 'string' ? value.error : 'Worker command failed';
        finish(new Error(message));
      } else if (value.type === 'ready' || value.type === 'result' || value.type === 'preprocessed') {
        finish(undefined, value);
      }
    };
    const failure = (event: ErrorEvent) => finish(new Error(event.message || 'Worker execution failed'));
    const timer = setTimeout(() => finish(new Error('Worker command timeout')), timeoutMs);
    cancelPending = (reason) => finish(reason);
    current.addEventListener('message', receive);
    current.addEventListener('error', failure);
    try { current.postMessage(request); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
