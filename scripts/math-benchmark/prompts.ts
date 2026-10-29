import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import model from '../../src/model-manifest.json' with { type: 'json' };
import { sha256 } from './dataset.ts';

const profileSchema = z.object({ task: z.enum(['formula', 'ocr']), text: z.string(),
  promptSuffixIds: z.array(z.number().int().min(0).max(103423)).min(1).max(512) });
const exportSchema = z.object({ modelRevision: z.string(), tokenizerSha256: z.string(),
  browserTokenizerSha256: z.string(), browserTaskDefinitionSha256: z.string(),
  profiles: z.record(z.string(), profileSchema) });

/** verify the native tokenizer export against the pinned browser model */
export async function readMathPrompts() {
  const bytes = await readFile(new URL('./prompts.json', import.meta.url));
  const prompts = exportSchema.parse(JSON.parse(bytes.toString()));
  const tasksUrl = new URL('../../public/paddle/paddleocr_vl_tasks.mjs', import.meta.url);
  const taskModule: unknown = await import(tasksUrl.href);
  const tasks = z.object({ PADDLEOCR_VL_TASKS: z.record(z.string(), z.object({
    prompt: z.string(), promptSuffixIds: z.array(z.number().int()),
  })) }).parse(taskModule).PADDLEOCR_VL_TASKS;
  assert.equal(prompts.modelRevision, model.sourceRevision, 'Prompt model revision changed');
  assert.equal(prompts.tokenizerSha256, prompts.browserTokenizerSha256, 'Tokenizer export mismatch');
  assert.equal(prompts.browserTokenizerSha256, model.files.find(file => file.path === 'm6e9-tokenizer.json')?.sha256, 'Wrong pinned tokenizer');
  assert.equal(prompts.browserTaskDefinitionSha256, sha256(await readFile(tasksUrl)), 'Native task definition changed');
  for (const { profileName, task } of [{ profileName: 'nativeFormula', task: 'formula' }, { profileName: 'nativeOCR', task: 'ocr' }]) {
    const profile = prompts.profiles[profileName], definition = tasks[task];
    assert.ok(profile && definition, 'Missing native task profile');
    assert.equal(profile.task, task);
    assert.equal(profile.text, definition.prompt);
    assert.deepEqual(profile.promptSuffixIds, definition.promptSuffixIds, 'Native task tokens changed');
  }
  return { sha256: sha256(bytes), profiles: prompts.profiles };
}
