import { expect, it } from 'vitest';
import { commandSchema, workerCommandSchema } from '../src/protocol';

const crop = {
  type: 'recognize',
  image: 'data:image/png;base64,AAAA',
  name: 'crop.png',
  maxTokens: 1024,
};

it.each(['auto', 'equation', 'mixed'])(
  'preserves the %s task from the panel to the worker',
  (task) => {
    const command = commandSchema.parse({ ...crop, task });
    expect(workerCommandSchema.parse({ ...command, id: 'job' })).toMatchObject({ task });
  },
);

it('defaults taskless requests to Auto and rejects unknown modes', () => {
  expect(commandSchema.parse(crop)).toMatchObject({ task: 'auto' });
  expect(commandSchema.safeParse({ ...crop, task: 'guess' }).success).toBe(false);
});
