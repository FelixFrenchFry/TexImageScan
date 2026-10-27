/** count model bytes only after file integrity checks pass */
export function createModelLoadProgress(files: readonly { path: string; size: number }[]) {
  const remaining = new Map(files.map((file) => [file.path, file.size]));
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  let loaded = 0;
  return (path: string): number | undefined => {
    const size = remaining.get(path);
    if (size === undefined) return;
    remaining.delete(path);
    loaded += size;
    return loaded / total;
  };
}
