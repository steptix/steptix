const [major, minor] = process.versions.node.split('.').map(Number);
if (process.platform !== 'win32' || process.arch !== 'x64' || major < 22 || (major === 22 && minor < 21)) {
  console.error('Steptix Runtime requires Windows x64 and Node.js 22.21 or later (x64).');
  process.exit(1);
}
