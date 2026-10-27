import { useEffect, useId, useRef, useState } from 'react';
import { Callout, TextArea } from '@radix-ui/themes';
import { AlertCircle, Check, Copy, Download, RotateCcw } from 'lucide-react';
import manifest from '../../src/model-manifest.json';
import { type RecognitionResult } from '../../src/protocol';
import { exportSource } from '../../src/history';
import { splitMath, renderMath } from '../../src/preview';
import { downloadRenderedImage, renderedImage, type ImageFormat } from '../../src/rendered-image';

const formats = [
  { value: 'latex', label: 'LaTeX', short: 'LaTeX' },
  { value: 'markdown', label: 'Markdown with math', short: 'Markdown' },
  { value: 'text', label: 'Plain text', short: 'Plain text' },
] satisfies { value: string; label: string; short: string }[];

export function ScanResult({
  result,
  text,
  disabled,
  previous,
  onEdit,
  onRecognize,
  onNotice,
}: {
  result: RecognitionResult;
  text: string;
  disabled: boolean;
  previous: boolean;
  onEdit: (value: string) => void;
  onRecognize: () => void;
  onNotice: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<'original' | 'rendered'>('rendered');
  const previewId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'copy' | ImageFormat | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyRequest = useRef(0);
  const mode = result.mode ?? result.task;

  useEffect(() => {
    copyRequest.current++;
    setCopied(null);
    setDownloaded(null);
    return () => {
      clearTimeout(timer.current);
      copyRequest.current++;
    };
  }, [text]);

  async function copy(format: (typeof formats)[number]) {
    const request = ++copyRequest.current;
    clearTimeout(timer.current);
    setCopied(null);
    setDownloaded(null);
    try {
      await navigator.clipboard.writeText(exportSource(text, format.value));
      if (request !== copyRequest.current) return;
      setCopied(format.label);
      timer.current = setTimeout(() => setCopied(null), 1800);
    } catch {
      onNotice('Clipboard access failed. Select the editable source and copy it manually.');
    }
  }

  async function exportImage(action: 'copy' | ImageFormat) {
    const request = ++copyRequest.current;
    clearTimeout(timer.current);
    setCopied(null);
    setDownloaded(null);
    setExporting(action);
    try {
      if (action === 'copy') {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': renderedImage(text, 'png') }),
        ]);
        if (request !== copyRequest.current) return;
        setCopied('PNG');
        timer.current = setTimeout(() => setCopied(null), 1800);
      } else {
        const blob = await renderedImage(text, action);
        if (request !== copyRequest.current) return;
        downloadRenderedImage(blob, result.name, action);
        setDownloaded(action.toUpperCase());
        timer.current = setTimeout(() => setDownloaded(null), 1800);
      }
    } catch (error) {
      if (request === copyRequest.current)
        onNotice(
          error instanceof Error
            ? error.message
            : 'Image export failed. Try downloading SVG instead.',
        );
    } finally {
      setExporting(null);
    }
  }

  const time = new Date(result.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (previous)
    return (
      <section className="previous-result" aria-label="Previous result">
        <div className="step-label">
          <span>Previous result</span>
          <span className="step-meta">{time}</span>
        </div>
        <div className="previous-card">
          <img className="source-thumbnail" src={result.image} alt={`Source: ${result.name}`} />
          <p className="previous-excerpt">{text || 'Empty source'}</p>
        </div>
      </section>
    );

  const copyHeading = text ? 'Copy as' : result.original ? 'Source is empty' : 'No text recognized';
  return (
    <section className="result-view" aria-label="Recognition result">
      <div className="step-label">
        <span>01 · Original page crop</span>
      </div>
      <figure className="original-image">
        <img src={result.image} alt={`Source: ${result.name}`} />
      </figure>
      {result.truncated && (
        <Callout.Root color="amber">
          <Callout.Icon>
            <AlertCircle size={16} />
          </Callout.Icon>
          <Callout.Text>
            Output reached its token limit and may be incomplete or repetitive. Try a tighter crop
            or a manual mode.
          </Callout.Text>
        </Callout.Root>
      )}
      <div className="step-label step-gap">
        <span>02 · Recognized · {(result.elapsedMs / 1000).toFixed(1)} s</span>
        {!editing && (
          <div className="preview-switch" role="group" aria-label="Preview mode">
            <button
              type="button"
              aria-pressed={preview === 'original'}
              aria-controls={previewId}
              onClick={() => setPreview('original')}
            >
              Original
            </button>
            <button
              type="button"
              aria-pressed={preview === 'rendered'}
              aria-controls={previewId}
              onClick={() => setPreview('rendered')}
            >
              Rendered
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="result-edit">
          <TextArea
            aria-label="Editable source"
            className="source-editor"
            readOnly={disabled}
            value={text}
            maxLength={100_000}
            onChange={(event) => onEdit(event.target.value)}
            resize="vertical"
          />
          <div className="editor-tools">
            <button
              className="text-link"
              disabled={disabled || text === result.original}
              onClick={() => onEdit(result.original)}
            >
              Reset edits
            </button>
          </div>
        </div>
      ) : (
        <div className="result-box" id={previewId}>
          <img
            className="preview-original"
            src={result.image}
            alt={`Original preview: ${result.name}`}
            aria-hidden={preview !== 'original'}
            inert={preview !== 'original'}
          />
          <div
            className="preview"
            aria-hidden={preview !== 'rendered'}
            inert={preview !== 'rendered'}
          >
            {splitMath(text).map((part, index) => {
              if (part.kind === 'text') return <span key={index}>{part.source}</span>;
              const rendered = renderMath(part.source, part.display);
              return rendered.kind === 'html' ? (
                <span key={index} dangerouslySetInnerHTML={{ __html: rendered.html }} />
              ) : (
                <span key={index} className="math-error" title={rendered.message}>
                  {part.source}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {!result.original && (
        <p role="status" className="hint">
          No text was recognized. Try a clearer or more tightly cropped image.
        </p>
      )}
      <div className="step-label step-gap">
        <h2>03 · {copyHeading}</h2>
        <button className="text-link" onClick={() => setEditing(!editing)}>
          {editing ? 'Preview' : 'Edit source'}
        </button>
      </div>
      <div className="copy-formats" aria-label="Copy result">
        {formats.map((format) => {
          const done = copied === format.label;
          return (
            <button
              key={format.value}
              type="button"
              className={`copy-format${done ? ' copied' : ''}`}
              aria-label={`Copy ${format.label}`}
              disabled={!text || exporting !== null}
              onClick={() => void copy(format)}
            >
              <span className="copy-text">
                <strong>{format.short}</strong>
                <code>{text ? exportSource(text, format.value) : 'Nothing to copy'}</code>
              </span>
              {done ? (
                <span className="copied-label">
                  <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                  Copied
                </span>
              ) : (
                <Copy size={18} aria-hidden="true" />
              )}
            </button>
          );
        })}
        <div
          className="image-exports"
          role="group"
          aria-label="Rendered image exports"
          aria-busy={exporting !== null}
        >
          <div className={`image-export-row${copied === 'PNG' ? ' copied' : ''}`}>
            <button
              type="button"
              className="image-export-copy"
              aria-label="Copy PNG"
              disabled={!text.trim() || exporting !== null}
              onClick={() => void exportImage('copy')}
            />
            <span className="image-export-label">
              <strong>PNG</strong>
              <span>Rendered image · 2× resolution</span>
            </span>
            <button
              type="button"
              className="image-export-action"
              aria-label="Download PNG"
              disabled={!text.trim() || exporting !== null}
              onClick={() => void exportImage('png')}
            >
              <Download size={18} aria-hidden="true" />
            </button>
            <span className="image-export-copy-mark" aria-hidden="true">
              {copied === 'PNG' ? (
                <span className="copied-label">
                  <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                  Copied
                </span>
              ) : (
                <Copy size={18} aria-hidden="true" />
              )}
            </span>
          </div>
          <div className="image-export-row">
            <button type="button" className="image-export-copy" aria-label="Copy SVG" disabled />
            <span className="image-export-label">
              <strong>SVG</strong>
              <span>Scalable vector image</span>
            </span>
            <button
              type="button"
              className="image-export-action"
              aria-label="Download SVG"
              disabled={!text.trim() || exporting !== null}
              onClick={() => void exportImage('svg')}
            >
              <Download size={18} aria-hidden="true" />
            </button>
            <span className="image-export-copy-mark" aria-hidden="true">
              <Copy size={18} />
            </span>
          </div>
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {copied ? `Copied ${copied}` : downloaded ? `${downloaded} download started.` : ''}
      </div>
      <details className="scan-details">
        <summary>Scan details</summary>
        <div className="scan-metadata">
          <span>OCR</span>
          <span className="scan-model">
            {result.modelRevision === manifest.revision ? manifest.displayName : 'previous model'}
          </span>
          <span>{result.tokenCount} tokens</span>
          {mode && (
            <span>
              {mode === 'auto' ? 'Auto' : mode === 'equation' ? 'Equation' : 'Text with math'}
            </span>
          )}
        </div>
        <button className="text-link" disabled={disabled} onClick={onRecognize}>
          <RotateCcw size={13} aria-hidden="true" />
          Recognize again
        </button>
      </details>
    </section>
  );
}
