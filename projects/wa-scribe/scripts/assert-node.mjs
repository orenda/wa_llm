if (!/^(24|26)\.\d+\.\d+$/.test(process.versions.node)) {
  console.error(`wa-scribe requires Node 24.x or 26.x, got ${process.versions.node}`);
  process.exit(1);
}
