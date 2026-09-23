// OPERATOR ONLY - prints the TREASURY PRIVATE KEYS derived from the master
// seed, in formats importable into wallet apps:
//   Solana -> base58 secret key (Phantom: "Import private key")
//   Retired Robinhood / EVM treasuries -> 0x-hex private key (MetaMask:
//   "Import account"). Recovery only: the rails are gone (22 Sep 2026), but any
//   ETH still sitting in those treasuries must stay reachable.
//
// Run this in a PRIVATE terminal only. Anyone who sees the output controls
// the funds. Never screenshot, never paste, never run over screen-share.
//
// Usage: npm run keys:mainnet   (loads .env.mainnet)

import { createHmac } from 'node:crypto'
import { Keypair } from '@solana/web3.js'

const seedHex = process.env.HOOD_WALLET_SEED || ''
if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
  console.error('HOOD_WALLET_SEED missing - run via: npm run keys:mainnet')
  process.exit(1)
}
const seed = Buffer.from(seedHex, 'hex')
const derive = (chain, who) => createHmac('sha512', seed).update(`${chain}:${who}`).digest().subarray(0, 32)

// base58 (Bitcoin alphabet) for Solana secret keys
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (buf) => {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'))
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of buf) { if (b === 0) out = '1' + out; else break }
  return out
}

// The same reduction into the secp256k1 field the old EVM rails used, so the
// key printed here is exactly the key those treasuries were derived with.
const evmKey = (chain) => {
  const raw = derive(chain, 'treasury')
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
  const k = (BigInt('0x' + raw.toString('hex')) % (n - 1n)) + 1n
  return '0x' + k.toString(16).padStart(64, '0')
}

console.log('\n=== TREASURY PRIVATE KEYS - anyone with these controls the funds ===\n')

const sol = Keypair.fromSeed(derive('sol', 'treasury'))
console.log('Solana   address:', sol.publicKey.toBase58())
console.log('Solana   secret (Phantom import):', b58(sol.secretKey))

console.log('\nRetired EVM treasuries (recovery only - import into MetaMask to see the address):')
for (const [chain, label] of [['rh', 'Robinhood 4663'], ['base', 'Base'], ['eth', 'Ethereum']]) {
  console.log(`  ${label.padEnd(15)} ${evmKey(chain)}`)
}

console.log('\nClose this terminal when done. Do not save this output anywhere.\n')
