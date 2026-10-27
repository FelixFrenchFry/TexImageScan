import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const repositories = process.argv.slice(2);
if (!repositories.length) throw new Error('Pass Hugging Face repository IDs');
const cache = '.cache/ocr-research';
await mkdir(cache, { recursive: true });
const results = [];
let previous = [];
try {
  previous = JSON.parse(await readFile(join(cache, 'audit.json'), 'utf8')).models;
} catch {
  /* the first audit has no previous snapshot */
}
async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return response.ok
    ? { status: response.status, text: await response.text() }
    : { status: response.status };
}
for (const repository of repositories) {
  try {
    const url = `https://huggingface.co/api/models/${repository}?blobs=true`;
    const metadata = await request(url);
    if (!metadata.text) {
      results.push({ repository, status: metadata.status });
      continue;
    }
    const info = JSON.parse(metadata.text);
    const directory = join(cache, repository.replaceAll('/', '__'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'metadata.json'), metadata.text);
    const configs = {};
    for (const name of [
      'README.md',
      'config.json',
      'processor_config.json',
      'preprocessor_config.json',
      'generation_config.json',
      'LICENSE',
    ]) {
      if (!info.siblings.some((file) => file.rfilename === name)) continue;
      const response = await request(
        `https://huggingface.co/${repository}/resolve/${info.sha}/${name}`,
      );
      if (!response.text) continue;
      await writeFile(join(directory, name), response.text);
      if (name.endsWith('.json')) configs[name] = JSON.parse(response.text);
    }
    const files = info.siblings.map((file) => ({
      path: file.rfilename,
      size: file.size,
      sha256: file.lfs?.sha256,
    }));
    const weights = files.filter((file) =>
      /\.(safetensors|gguf|bin|onnx(?:_data(?:_\d+)?|\.data)?)$/.test(file.path),
    );
    const config = configs['config.json'];
    const result = {
      repository,
      url: `https://huggingface.co/${repository}`,
      revision: info.sha,
      inspectedAt: new Date().toISOString(),
      createdAt: info.createdAt,
      lastModified: info.lastModified,
      license: info.cardData?.license,
      baseModel: info.cardData?.base_model,
      parameterCounts: info.safetensors,
      modelType: config?.model_type,
      architectures: config?.architectures,
      autoMap: config?.auto_map,
      textConfig: config?.text_config,
      visionConfig: config?.vision_config,
      tags: info.tags,
      files,
      configs,
      repositoryWeightBytesAllVariants: weights.reduce((sum, file) => sum + (file.size ?? 0), 0),
    };
    results.push(result);
    console.log(
      JSON.stringify({
        repository,
        revision: info.sha.slice(0, 10),
        license: result.license,
        parameters: info.safetensors?.total,
        modelType: result.modelType,
        weightFiles: weights.length,
        repositoryWeightBytesAllVariants: result.repositoryWeightBytesAllVariants,
      }),
    );
  } catch (error) {
    results.push({ repository, error: String(error) });
  }
}
const models = [
  ...new Map([...previous, ...results].map((model) => [model.repository, model])).values(),
];
await writeFile(
  join(cache, 'audit.json'),
  JSON.stringify({ capturedAt: new Date().toISOString(), models }, null, 2),
);
console.log(`Saved audit and source files under ${cache}`);
