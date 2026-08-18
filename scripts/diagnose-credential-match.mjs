// Why did the broker say "no saved login" for a site you have in Bitwarden?
//
//   bw unlock            # then paste the export line it prints
//   node scripts/diagnose-credential-match.mjs https://www.example.com/login
//
// Prints item NAMES and URIs only — never a username or password — and shows
// exactly where a candidate was dropped: by Bitwarden's own matching, or by
// ours. Those have opposite fixes, and the tool's answer looks identical.

import { BitwardenVault } from '../dist/credentials/vault.js';
import { hostOf, itemsCoveringHost, originForLookup, pageIsFillable, uriCoversHost } from '../dist/credentials/domain-match.js';

const url = process.argv[2];
if (!url) {
  console.log('Usage: node scripts/diagnose-credential-match.mjs <url of the sign-in page>');
  process.exit(1);
}

const vault = new BitwardenVault();
const status = await vault.status();
console.log(`bw status: ${status}`);
if (status !== 'unlocked' || !vault.unlocked) {
  console.log(
    '\nThe vault is locked for THIS process. Unlock it in your own terminal and\n' +
      'export the session, so your master password goes only to Bitwarden:\n\n' +
      '  $env:BW_SESSION = (bw unlock --raw)      # PowerShell\n' +
      '  export BW_SESSION=$(bw unlock --raw)     # bash\n',
  );
  process.exit(1);
}

const host = hostOf(url);
const origin = originForLookup(url);
console.log(`\npage url .......... ${url}`);
console.log(`page host ......... ${host}`);
console.log(`fillable .......... ${pageIsFillable(url) ?? 'yes'}`);
console.log(`origin sent to bw . ${origin}`);

const items = await vault.itemsForUrl(url);
console.log(`\nBitwarden returned ${items.length} login item(s) for that origin:`);
for (const item of items) {
  console.log(`  - ${item.name}`);
  for (const uri of item.uris) {
    console.log(`      ${uriCoversHost(uri, host ?? '') ? 'covers    ' : 'DOES NOT  '} ${uri}`);
  }
  if (item.uris.length === 0) console.log('      (no URIs saved on this item)');
}

const kept = itemsCoveringHost(items, host ?? '');
console.log(`\nafter our own host re-check: ${kept.length} item(s) — ${kept.map((i) => i.name).join(', ') || 'none'}`);

console.log('\nverdict:');
if (items.length === 0) {
  console.log('  Bitwarden itself returned nothing. The item either has no URI saved,');
  console.log('  or its URI/match-mode does not cover this address. Fix it in Bitwarden.');
} else if (kept.length === 0) {
  console.log('  Bitwarden DID return the item and OUR rule dropped it — a bug on our side.');
  console.log('  Most likely a sibling subdomain: our matching is suffix-based, so');
  console.log('  secure.example.com and www.example.com do not cover each other.');
} else {
  console.log('  Matching is fine. If the tool still refused, the cause is later in the');
  console.log('  gate order (approval, or the form scan) — not the vault lookup.');
}
