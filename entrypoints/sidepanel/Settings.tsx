import { useEffect, useState } from 'react';
import { Checkbox, Flex, Select, Tooltip } from '@radix-ui/themes';
import { browser } from 'wxt/browser';
import { z } from 'zod';
import { CircleHelp, Download, Trash2 } from 'lucide-react';
import manifest from '../../src/model-manifest.json';
import {
  recognitionModeSchema,
  type AppState,
  type RecognitionMode,
  type PanelCommand,
} from '../../src/protocol';

const capturePermission = { origins: ['<all_urls>'] };
const captureSetupKey = 'captureAcrossTabsSetupComplete';
const modelHosts = z.array(z.string()).parse(browser.runtime.getManifest().host_permissions ?? []);
// Chrome also removes required hosts when broad access is revoked
// restore model hosts from the previous broad approval
// without prompting again for those hosts
const modelDomainPermission = { origins: modelHosts.map((host) => host.replace(/^https?:/, '*:')) };

export function CaptureAccess({ disabled, setup = false }: { disabled: boolean; setup?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  useEffect(() => {
    let stopped = false;
    const refresh = () => {
      void browser.permissions.contains(capturePermission).then(
        (value) => {
          if (!stopped) {
            setEnabled(value);
            if (setup && value) void completeSetup().catch(() => undefined);
          }
        },
        () => {
          if (!stopped) setError('Could not check capture access. Reopen Settings to try again.');
        },
      );
    };
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    refresh();
    return () => {
      stopped = true;
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, [setup]);

  useEffect(() => {
    if (!setup) return;
    let stopped = false;
    void browser.storage.local.get(captureSetupKey).then(
      (saved) => {
        if (!stopped) setSetupComplete(saved[captureSetupKey] === true);
      },
      () => {
        if (!stopped) setError('Could not check capture setup. Reopen the panel to try again.');
      },
    );
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && captureSetupKey in changes)
        setSetupComplete(changes[captureSetupKey]?.newValue === true);
    };
    browser.storage.onChanged.addListener(changed);
    return () => {
      stopped = true;
      browser.storage.onChanged.removeListener(changed);
    };
  }, [setup]);

  async function completeSetup() {
    await browser.storage.local.set({ [captureSetupKey]: true });
    setSetupComplete(true);
  }

  async function change(next: boolean) {
    setChanging(true);
    setFeedback('');
    setError('');
    try {
      // request permission before awaiting to retain the user gesture
      const granted = next
        ? await browser.permissions.request(capturePermission)
        : await browser.permissions.remove(capturePermission);
      if (
        !next &&
        modelHosts.length > 0 &&
        !(await browser.permissions.contains({ origins: modelHosts }))
      ) {
        const restored = await browser.permissions.request(modelDomainPermission);
        if (!restored)
          setError(
            'Capture across tabs is off. Allow model download access in Chrome before downloading a model.',
          );
      }
      const actual = await browser.permissions.contains(capturePermission);
      setEnabled(actual);
      if (next && !granted && !actual)
        setFeedback(
          'Access was not enabled. You can still capture with the toolbar icon or shortcut.',
        );
      if (!next && actual)
        setError(
          'Chrome kept capture access enabled. Try changing site access in Chrome’s extension settings.',
        );
      await completeSetup();
    } catch {
      setError('Could not update capture access. Try again.');
    } finally {
      setChanging(false);
    }
  }

  if (setup) {
    if (enabled === true || setupComplete === true)
      return feedback ? (
        <p className="hint" role="status">
          {feedback}
        </p>
      ) : null;
    if (enabled === null || setupComplete === null)
      return error ? (
        <p className="hint" role="alert">
          {error}
        </p>
      ) : null;
    return (
      <section className="capture-access-setup" aria-label="Capture setup">
        <strong>Capture across tabs</strong>
        <p className="hint">
          Recommended. Capture text and math across websites without clicking the toolbar icon on
          every tab.
        </p>
        <p className="hint">
          Chrome will ask for website access. You can turn this off in <strong>Settings</strong>.
        </p>
        <Flex gap="3" align="center" wrap="wrap">
          <button
            className="primary-action compact"
            disabled={disabled || changing}
            onClick={() => void change(true)}
          >
            Enable across tabs
          </button>
          <button
            className="text-link"
            disabled={disabled || changing}
            onClick={() =>
              void completeSetup().catch(() =>
                setError('Could not remember your choice. Try again.'),
              )
            }
          >
            Not now
          </button>
        </Flex>
        {error && (
          <p className="hint" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="settings-field">
      <label className="capture-access-option">
        <Checkbox
          checked={enabled ?? false}
          disabled={disabled || changing || enabled === null}
          aria-describedby="capture-access-description"
          onCheckedChange={(checked) => void change(checked === true)}
        />
        <span>Capture across tabs</span>
      </label>
      <p id="capture-access-description" className="hint">
        Allow capture across websites without clicking the toolbar icon on each tab. Chrome will ask
        for access to websites. Chrome pages still need the toolbar icon or capture shortcut.
      </p>
      {feedback && (
        <p className="hint" role="status">
          {feedback}
        </p>
      )}
      {error && (
        <p className="hint" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ModelSetup({
  state,
  disabled,
  onPrepare,
}: {
  state: AppState | null;
  disabled: boolean;
  onPrepare: () => void;
}) {
  const downloaded = state?.model === 'ready' || state?.model === 'cached';
  return (
    <section className="model-card" aria-label="Model setup">
      <div className="section-heading">
        <strong>
          <a
            className="model-link"
            href={`https://huggingface.co/${manifest.repository}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {manifest.displayName}
          </a>
        </strong>
        <span className={`model-badge${downloaded ? ' ready' : ''}`}>
          {downloaded ? 'Ready' : 'Setup needed'}
        </span>
      </div>
      <p className="hint">
        {downloaded
          ? 'The model loads automatically when you recognize an image. GPU memory is released after five idle minutes.'
          : 'Download the recognition model once. Images and text stay on your device.'}
      </p>
      {state?.model === 'missing' && (
        <button className="primary-action compact" disabled={disabled} onClick={onPrepare}>
          <Download size={16} aria-hidden="true" />
          {`Download model · ${(manifest.totalBytes / 1_000_000_000).toFixed(2)} GB`}
        </button>
      )}
    </section>
  );
}

export function Settings({
  state,
  disabled,
  task,
  tokens,
  onTask,
  onTokens,
  onCommand,
  onClear,
}: {
  state: AppState | null;
  disabled: boolean;
  task: RecognitionMode;
  tokens: string;
  onTask: (value: RecognitionMode) => void;
  onTokens: (value: string) => void;
  onCommand: (command: PanelCommand) => void;
  onClear: () => void;
}) {
  return (
    <section className="settings-view" aria-label="Settings">
      <h2 className="view-title">Settings</h2>
      <div className="settings-field">
        <div className="settings-field-label">
          <label htmlFor="recognition-mode">Recognition mode</label>
          <Tooltip
            className="help-tooltip"
            content={
              <>
                Choose how to read your image. <strong>Auto</strong> reads text and equations in one
                pass. <strong>Equation</strong> is for standalone formulas.{' '}
                <strong>Text with math</strong> is for text and equations together.
              </>
            }
          >
            <button type="button" className="field-help" aria-label="About recognition mode">
              <CircleHelp size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <Select.Root
          value={task}
          disabled={disabled}
          onValueChange={(value) => onTask(recognitionModeSchema.parse(value))}
        >
          <Select.Trigger id="recognition-mode" aria-label="Recognition mode" />
          <Select.Content>
            <Select.Item value="auto">Auto</Select.Item>
            <Select.Item value="equation">Equation</Select.Item>
            <Select.Item value="mixed">Text with math</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
      <div className="settings-field">
        <div className="settings-field-label">
          <label htmlFor="token-limit">Output limit</label>
          <Tooltip
            className="help-tooltip"
            content={
              <>
                The maximum amount of text the model can generate. Tokens are small pieces of text
                or math notation. Higher limits allow longer results but can take more time.
                Increase <strong>Output limit</strong> if a result stops before it is complete.
              </>
            }
          >
            <button type="button" className="field-help" aria-label="About output limit">
              <CircleHelp size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <Select.Root value={tokens} disabled={disabled} onValueChange={onTokens}>
          <Select.Trigger id="token-limit" aria-label="Output token limit" />
          <Select.Content>
            {['256', '512', '1024', '2048', '4096'].map((value) => (
              <Select.Item key={value} value={value}>
                {value} tokens
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>
      <CaptureAccess disabled={disabled} />
      <div className="settings-group">
        <ModelSetup
          state={state}
          disabled={disabled}
          onPrepare={() => onCommand({ type: 'prepare' })}
        />
        <p className="hint">
          Runs locally on your GPU. Your images and recognized text stay in Chrome.
        </p>
      </div>
      <details className="settings-group">
        <summary>Model &amp; diagnostics</summary>
        <dl>
          <dt>Model</dt>
          <dd>{manifest.sourceModel}</dd>
          <dt>Export revision</dt>
          <dd>{manifest.revision}</dd>
          <dt>GPU</dt>
          <dd>{state?.gpu ?? 'Checked when loading the model'}</dd>
          <dt>Precision</dt>
          <dd>4-bit decoder and embeddings · FP16 vision</dd>
          <dt>Storage</dt>
          <dd>
            Scans, crops and edits stay on this device. Clear result empties the workspace. Scan
            history has separate deletion controls. Model files stay cached separately.
          </dd>
        </dl>
        <Flex gap="3" wrap="wrap">
          <button className="secondary-action" disabled={disabled} onClick={onClear}>
            <Trash2 size={13} aria-hidden="true" />
            Clear result
          </button>
          <button
            className="secondary-action"
            disabled={disabled}
            onClick={() => onCommand({ type: 'remove-model' })}
          >
            Remove model
          </button>
        </Flex>
      </details>
    </section>
  );
}
