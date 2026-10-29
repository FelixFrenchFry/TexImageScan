import assert from 'node:assert/strict';
import { z } from 'zod';
import { runEntrySchema } from './metrics.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export { readMathPrompts } from './prompts.ts';
const runSchema = z.object({ variant: z.enum(['baseline', 'ocr-only', 'concise']), manifestSha256: digest,
  finishedAt: z.string().min(1), browser: z.string().min(1), modelRevision: z.string().min(1),
  promptFileSha256: digest, runtimeHashes: z.record(z.string(), digest).refine(value => Object.keys(value).length > 0),
  offline: z.literal(true), prepared: z.object({ gpu: z.string().min(1) }),
  cases: z.array(runEntrySchema.extend({ configuration: z.object({ profileName: z.string(),
    options: z.object({ task: z.enum(['formula', 'ocr']), maxGeneratedTokens: z.literal(2048),
      promptSuffixIds: z.array(z.number().int()) }).strict(), margin: z.literal(0),
  }).strict() })),
});
export type MathRun = z.infer<typeof runSchema>;
export function verifyMathRun(value: unknown, expected: { variant: string; manifestSha256: string;
  prompts: { sha256: string; profiles: Record<string, { task: string; promptSuffixIds: number[] }> }; baseline?: MathRun }) {
  const run = runSchema.parse(value);
  assert.equal(run.manifestSha256, expected.manifestSha256, 'Wrong run manifest');
  assert.equal(run.variant, expected.variant, 'Wrong variant label');
  assert.equal(run.promptFileSha256, expected.prompts.sha256, 'Prompt export changed');
  if (expected.baseline) {
    for (const field of ['modelRevision', 'browser', 'promptFileSha256', 'runtimeHashes', 'prepared'] as const)
      assert.deepEqual(run[field], expected.baseline[field], `Incompatible run provenance: ${field}`);
  }
  const profileName = { baseline: 'nativeFormula', 'ocr-only': 'nativeOCR', concise: 'conciseFormula' }[run.variant];
  const profile = expected.prompts.profiles[profileName]; assert.ok(profile, `Missing prompt profile ${profileName}`);
  for (const entry of run.cases)
    assert.deepEqual(entry.configuration, { profileName, options: { task: profile.task,
      maxGeneratedTokens: 2048, promptSuffixIds: profile.promptSuffixIds }, margin: 0 }, `Wrong configuration: ${entry.id}`);
  return run;
}
