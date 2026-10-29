import { useEffect, useRef, useState } from 'react';
import { AlertDialog, Callout, Flex, Tooltip } from '@radix-ui/themes';
import {
  AlertCircle,
  ArrowLeft,
  Crop,
  History,
  ImageUp,
  Info,
  LoaderCircle,
  ScanText,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { browser } from 'wxt/browser';
import manifest from '../../src/model-manifest.json';
import {
  MAX_IMAGE_BYTES,
  type AppState,
  type PanelCommand,
} from '../../src/protocol';
import { captureReplySchema, CAPTURE_ACCESS_MESSAGE } from '../../src/capture';
import {
  inactiveWorkspace,
  visibleWorkspace,
  type InactiveWorkspace,
} from '../../src/panel-workspace';
import { usePanelHost } from './use-panel-host';
import { ScanHistory } from './ScanHistory';
import { ScanResult } from './ScanResult';
import { Settings, ModelSetup, CaptureAccess } from './Settings';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [inactive, setInactive] = useState<InactiveWorkspace>({ resultId: null, inputId: null });
  const firstState = useRef(true);
  const [reading, setReading] = useState(false);
  const [startingCapture, setStartingCapture] = useState(false);
  const [text, setText] = useState('');
  const [tokens, setTokens] = useState('2048');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'scan' | 'settings' | 'history'>('scan');
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingText = useRef<{ id: string; text: string } | null>(null);
  const openingScan = useRef<string | null>(null);
  const { connection, send: sendCommand, readResult } = usePanelHost({
    onState(next) {
      if (firstState.current) {
        firstState.current = false;
        setInactive(inactiveWorkspace(next));
      }
      if (next.saveError && next.result) setInactive({ resultId: null, inputId: null });
      const opened = next.result;
      if (
        opened &&
        openingScan.current === opened.id &&
        next.input?.id === opened.id &&
        next.job.kind === 'idle'
      ) {
        openingScan.current = null;
        setInactive({ resultId: null, inputId: null });
      }
      setState(next);
    },
    onDisconnect() {
      pendingText.current = null;
    },
  });
  const selecting = state?.capture.kind === 'selecting';
  const busy = state?.job.kind === 'running' || selecting || reading || startingCapture;
  const { result, input } = state
    ? visibleWorkspace(state, inactive)
    : { result: null, input: null };

  useEffect(() => {
    if (
      result &&
      pendingText.current?.id === result.id &&
      pendingText.current.text !== result.edited
    )
      return;
    pendingText.current = null;
    setText(result?.edited ?? '');
  }, [result?.id, result?.edited, connection]);

  useEffect(() => {
    if (input?.id) setView('scan');
  }, [input?.id]);

  useEffect(() => {
    if (result?.id) setView('scan');
  }, [result?.id]);

  useEffect(() => {
    if (!selecting) return;
    // the side panel can retain keyboard focus after starting page capture
    const cancelCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void browser.runtime
        .sendMessage({ type: 'capture-cancel' })
        .then((reply: unknown) => {
          const response = captureReplySchema.parse(reply);
          if (!response.ok) throw new Error(response.message ?? 'Could not cancel capture.');
        })
        .catch((error: unknown) => {
          setNotice(error instanceof Error ? error.message : 'Could not cancel capture.');
        });
    };
    window.addEventListener('keydown', cancelCapture, { capture: true });
    return () => window.removeEventListener('keydown', cancelCapture, { capture: true });
  }, [selecting]);

  function send(command: PanelCommand) {
    try {
      sendCommand(command);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not send the local command.');
    }
  }

  function openScan(id: string) {
    openingScan.current = id;
    send({ type: 'open-scan', id });
    setView('scan');
  }

  async function chooseFile(file: File) {
    setNotice('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setNotice('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setNotice('Choose an image smaller than 12 MB.');
      return;
    }
    setReading(true);
    try {
      const bitmap = await createImageBitmap(file);
      const pixels = bitmap.width * bitmap.height;
      bitmap.close();
      if (pixels > 8_000_000) throw new Error('Use an image with at most 8 million pixels.');
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read this image'));
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Invalid image'));
        reader.readAsDataURL(file);
      });
      send({ type: 'set-input', image, name: file.name.slice(0, 200) });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'This image could not be opened');
    } finally {
      setReading(false);
    }
  }

  async function captureArea() {
    setNotice('');
    setView('scan');
    setStartingCapture(true);
    try {
      const response = captureReplySchema.parse(
        await browser.runtime.sendMessage({ type: 'capture-begin' }),
      );
      if (!response.ok) throw new Error(response.message ?? 'Could not start capture.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start capture.');
    } finally {
      setStartingCapture(false);
    }
  }

  function edit(value: string) {
    if (!result || busy || connection) return;
    pendingText.current = { id: result.id, text: value };
    setText(value);
    send({ type: 'save', id: result.id, text: value });
  }

  function recognize() {
    if (!input) return;
    setNotice('');
    send({ type: 'recognize', ...input, maxTokens: Number(tokens) });
  }

  async function copyUnsavedResult() {
    if (!state?.result) return;
    setNotice('');
    try {
      const source = await readResult(state.result.id);
      await navigator.clipboard.writeText(source);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not copy the unsaved result.');
    }
  }

  const disabled = !!busy || !state || !!connection;
  const errorNotice =
    notice ||
    (state?.job.kind === 'failed' && state.job.message !== state.saveError
      ? state.job.message
      : state?.capture.kind === 'failed'
        ? state.capture.message
        : '');
  const captureAccessNeeded = errorNotice === CAPTURE_ACCESS_MESSAGE;
  const pendingInput = input && input.id !== result?.id;
  const running = state?.job.kind === 'running' ? state.job : null;
  const status = running
    ? { downloading: 'Downloading', loading: 'Loading', recognizing: 'Recognizing' }[running.phase]
    : state?.model === 'ready' || state?.model === 'cached'
      ? 'Ready'
      : 'Setup needed';
  const progressHeading = running
    ? {
        downloading: 'Downloading model',
        loading: 'Loading model',
        recognizing: 'Recognizing locally',
      }[running.phase]
    : '';
  const toggleView = (next: 'settings' | 'history') => setView(view === next ? 'scan' : next);
  const progressCard = running && (
    <section className="progress-card" aria-live="polite">
      <Flex justify="between" align="center" gap="2">
        <strong>
          <LoaderCircle className="spin" size={16} />
          {progressHeading}
        </strong>
        <button className="text-link" onClick={() => send({ type: 'cancel' })}>
          <X size={14} aria-hidden="true" />
          Cancel
        </button>
      </Flex>
      <p>{running.detail}</p>
      {running.fraction !== null && (
        <div className="measured-progress">
          <progress max="1" value={running.fraction} aria-label={progressHeading} />
          <span>{Math.round(running.fraction * 100)}%</span>
        </div>
      )}
      {running.text && <pre className="stream">{running.text}</pre>}
    </section>
  );
  return (
    <div className="app-shell">
      <header className="app-header">
        <img className="app-logo" src="/icon/logo.svg" alt="" width={24} height={24} />
        <h1>TexImageScan</h1>
        <button
          className="model-status"
          onClick={() => setView('settings')}
          aria-label={`Model status: ${status}`}
        >
          <span
            className={`status-dot ${(state?.model === 'ready' || state?.model === 'cached') && !running ? 'ready' : ''}`}
          />
          <span className="status-model">{manifest.displayName}</span>
          <span className="status-label">{status}</span>
        </button>
        <Tooltip content={<strong>Scan history</strong>}>
          <button
            className="header-icon"
            aria-label="Scan history"
            aria-pressed={view === 'history'}
            onClick={() => toggleView('history')}
          >
            <History size={18} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip content={<strong>Settings</strong>}>
          <button
            className="header-icon"
            aria-label="Settings"
            aria-pressed={view === 'settings'}
            onClick={() => toggleView('settings')}
          >
            <SlidersHorizontal size={18} aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      <div className="action-bar" role="group" aria-label="Capture controls">
        <button className="bar-primary" disabled={disabled} onClick={() => void captureArea()}>
          <Crop size={18} aria-hidden="true" />
          Capture
        </button>
        <button
          className="bar-primary"
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
        >
          <ImageUp size={18} aria-hidden="true" />
          Upload
        </button>
      </div>
      <main id="scan-editor">
        <input
          ref={fileInput}
          type="file"
          aria-label="Choose image file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void chooseFile(file);
            event.target.value = '';
          }}
        />
        {view !== 'scan' && (
          <button className="text-link back-button" onClick={() => setView('scan')}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back to scan
          </button>
        )}
        {connection && (
          <p role="status" className="hint">
            {connection}
          </p>
        )}
        {errorNotice && (
          <Callout.Root
            color={captureAccessNeeded ? 'gray' : 'red'}
            role={captureAccessNeeded ? 'status' : 'alert'}
          >
            <Callout.Icon>
              {captureAccessNeeded ? (
                <Info size={17} aria-hidden="true" />
              ) : (
                <AlertCircle size={17} aria-hidden="true" />
              )}
            </Callout.Icon>
            <Callout.Text>
              {errorNotice}
              {captureAccessNeeded && view !== 'settings' && (
                <button
                  className="text-link capture-access-link"
                  onClick={() => {
                    setNotice('');
                    setView('settings');
                  }}
                >
                  Capture settings
                </button>
              )}
            </Callout.Text>
          </Callout.Root>
        )}
        {state?.saveError && (
          <Callout.Root color="red" role="alert">
            <Callout.Icon>
              <AlertCircle size={17} aria-hidden="true" />
            </Callout.Icon>
            <Callout.Text>
              {state.saveError}
              <br />
              <button
                className="text-link"
                disabled={disabled}
                onClick={() => send({ type: 'retry-save' })}
              >
                Retry saving
              </button>{' '}
              <button
                className="text-link"
                disabled={disabled || !state.result?.edited}
                onClick={() => void copyUnsavedResult()}
              >
                Copy result
              </button>{' '}
              {state.result && (
                <AlertDialog.Root>
                  <AlertDialog.Trigger>
                    <button className="text-link" disabled={disabled}>
                      Discard unsaved result
                    </button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Content className="confirm-dialog" maxWidth="420px">
                    <AlertDialog.Title>Discard unsaved result?</AlertDialog.Title>
                    <AlertDialog.Description>
                      Clear the workspace and discard changes that could not be saved? Saved scans
                      in History are kept. This cannot be undone.
                    </AlertDialog.Description>
                    <div className="dialog-actions">
                      <AlertDialog.Cancel>
                        <button className="secondary-action">Cancel</button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action>
                        <button
                          className="secondary-action danger-action"
                          disabled={disabled}
                          onClick={() => send({ type: 'clear', discard: true })}
                        >
                          Discard result
                        </button>
                      </AlertDialog.Action>
                    </div>
                  </AlertDialog.Content>
                </AlertDialog.Root>
              )}
            </Callout.Text>
          </Callout.Root>
        )}
        {state?.job.kind === 'interrupted' && (
          <Callout.Root color="amber">
            <Callout.Icon>
              <AlertCircle size={17} aria-hidden="true" />
            </Callout.Icon>
            <Callout.Text>
              The previous operation was interrupted. Your last completed result is preserved. Retry
              recognition when you’re ready.
            </Callout.Text>
          </Callout.Root>
        )}
        {state?.job.kind === 'cancelled' && (
          <p role="status" className="hint">
            Cancelled. Your previous result is preserved.
          </p>
        )}
        {view !== 'scan' && progressCard}
        {view === 'scan' && (
          <>
            {!input && !result && !running && <CaptureAccess disabled={disabled} setup />}
            {state?.model === 'missing' && !running && (
              <ModelSetup
                state={state}
                disabled={disabled}
                onPrepare={() => send({ type: 'prepare' })}
              />
            )}
            {!input && !result && (
              <section className="capture-empty" aria-label="New scan">
                <div className="step-label">
                  <span>01 · Capture</span>
                </div>
                <div className="empty-frame">
                  <h2>
                    What would you like to{' '}
                    <span>scan?<Crop size={20} aria-hidden="true" /></span>
                  </h2>
                  <p className="hint">
                    Capture a printed equation, matrix, or aligned equations and turn them into editable LaTeX.
                  </p>
                  <p className="capture-shortcut">
                    <span className="kbd">Alt + Shift + S</span>
                    <span>or press <strong>Capture</strong>.</span>
                  </p>
                </div>
              </section>
            )}
            {pendingInput && input && (
              <section className="staged-input" aria-label="Source image">
                <div className="step-label">
                  <span>01 · Original page crop</span>
                </div>
                <button
                  className="image-area"
                  disabled={disabled}
                  onClick={() => fileInput.current?.click()}
                  aria-label="Choose source image"
                >
                  <img src={input.image} alt={`Source: ${input.name}`} />
                </button>
                <div className="step-label step-gap">
                  <h2>02 · Ready to recognize</h2>
                  <button className="text-link" onClick={() => setView('settings')}>
                    Options
                  </button>
                </div>
                <button
                  className="primary-action recognize"
                  disabled={disabled || state?.model === 'missing'}
                  onClick={recognize}
                >
                  <ScanText size={18} aria-hidden="true" />
                  Recognize image
                </button>
              </section>
            )}
            {pendingInput && progressCard}
            {result && (
              <ScanResult
                key={result.id}
                result={result}
                text={text}
                disabled={disabled}
                previous={!!pendingInput}
                onEdit={edit}
                onRecognize={recognize}
                onNotice={setNotice}
              />
            )}
            {!pendingInput && progressCard}
          </>
        )}
        {view === 'settings' && (
          <Settings
            state={state}
            disabled={disabled}
            tokens={tokens}
            onTokens={setTokens}
            onCommand={send}
            onClear={() => {
              send({ type: 'clear' });
              setView('scan');
            }}
          />
        )}
        <div hidden={view !== 'history'}>
          <ScanHistory
            entries={state?.history ?? []}
            activeId={result?.id}
            disabled={disabled}
            onOpen={openScan}
            onDelete={(ids) => send({ type: 'delete-scans', ids })}
            onClear={() => send({ type: 'clear-history' })}
          />
        </div>
      </main>
    </div>
  );
}
