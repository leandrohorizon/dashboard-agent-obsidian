import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', 'fs', 'path', 'os', 'crypto'],
  format: 'cjs',
  target: 'es2018',
  platform: 'node',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  outfile: 'main.js',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
