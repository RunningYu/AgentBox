declare module 'node:fs' {
  export function readFileSync(path: string, options: 'utf8'): string;
}
