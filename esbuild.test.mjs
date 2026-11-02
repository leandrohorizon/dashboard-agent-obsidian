import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['test/run.ts'],
  bundle: true,
  external: ['fs', 'path', 'os', 'crypto'],
  format: 'cjs',
  target: 'es2020',
  platform: 'node',
  logLevel: 'info',
  outfile: 'test/.build/run.cjs',
});
