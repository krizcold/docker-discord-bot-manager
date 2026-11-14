// tsc turns import() into require() under "module": "commonjs", and require() refuses Ink's top-level await.
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

export function importEsm<T>(specifier: string): Promise<T> {
  return nativeImport(specifier) as Promise<T>;
}
