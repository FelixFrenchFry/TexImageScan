import { useEffect, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import {
  PORT_NAME,
  stateSchema,
  resultTextReplySchema,
  type AppState,
  type PanelCommand,
} from '../../src/protocol';

export function usePanelHost(options: {
  onState: (state: AppState) => void;
  onDisconnect: () => void;
}) {
  const [connection, setConnection] = useState('Connecting to local model host…');
  const callbacks = useRef(options);
  callbacks.current = options;
  const port = useRef<Browser.runtime.Port | null>(null);
  const pendingReads = useRef(
    new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>(),
  );

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function connect() {
      try {
        const response: unknown = await browser.runtime.sendMessage({ type: 'ensure-host' });
        if (stopped) return;
        if (
          typeof response !== 'object' ||
          response === null ||
          !('ok' in response) ||
          response.ok !== true
        )
          throw new Error('The local model host could not start');
        const next = browser.runtime.connect({ name: PORT_NAME });
        port.current = next;
        next.onMessage.addListener((message: unknown) => {
          if (stopped || port.current !== next) return;
          const parsed = stateSchema.safeParse(message);
          if (parsed.success) {
            callbacks.current.onState(parsed.data);
            setConnection('');
          } else {
            const reply = resultTextReplySchema.safeParse(message);
            if (!reply.success) return;
            const request = pendingReads.current.get(reply.data.id);
            if (!request) return;
            pendingReads.current.delete(reply.data.id);
            if (reply.data.outcome.ok) request.resolve(reply.data.outcome.text);
            else request.reject(new Error(reply.data.outcome.message));
          }
        });
        next.onDisconnect.addListener(() => {
          if (stopped || port.current !== next) return;
          port.current = null;
          callbacks.current.onDisconnect();
          for (const request of pendingReads.current.values())
            request.reject(
              new Error('The local host disconnected. Retry copying when it reconnects.'),
            );
          pendingReads.current.clear();
          setConnection('Reconnecting to local model host…');
          timer = setTimeout(() => void connect(), 1000);
        });
      } catch (error) {
        if (stopped) return;
        setConnection(error instanceof Error ? error.message : 'Connection failed');
        timer = setTimeout(() => void connect(), 2000);
      }
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      port.current?.disconnect();
      port.current = null;
      for (const request of pendingReads.current.values())
        request.reject(new Error('The panel closed.'));
      pendingReads.current.clear();
    };
  }, []);

  function send(command: PanelCommand): void {
    if (!port.current || connection)
      throw new Error('The local host is reconnecting. Try again in a moment.');
    port.current.postMessage(command);
  }

  function readResult(resultId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!port.current || connection) {
        reject(new Error('The local host is reconnecting. Try again in a moment.'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingReads.current.delete(id);
        reject(new Error('Copying timed out. Retry when the host is ready.'));
      }, 30_000);
      const request = {
        resolve: (text: string) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      pendingReads.current.set(id, request);
      try {
        port.current.postMessage({ type: 'read-result', id, resultId } satisfies PanelCommand);
      } catch (error) {
        pendingReads.current.delete(id);
        request.reject(error instanceof Error ? error : new Error('Could not read the current result.'));
      }
    });
  }

  return { connection, send, readResult };
}
