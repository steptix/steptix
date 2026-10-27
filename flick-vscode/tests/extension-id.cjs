// The extension's ID as VS Code knows it ("<publisher>.<name>"), read from the
// manifest so a rename there needs no change in the tests.
const pkg = require('../package.json');

module.exports = { EXT_ID: `${pkg.publisher}.${pkg.name}` };
