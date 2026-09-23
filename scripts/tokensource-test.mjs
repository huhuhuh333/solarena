// Token-source test with MOCKED DEX + safety responses: discovery →
// safety scan → categorisation → market registration. No network.
//
// Usage: node scripts/tokensource-test.mjs

import { rmSync, mkdirSync } from 'node:fs'
const DB_DIR = 'server/data/tokensource-test'
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })
process.env.HOOD_DB = `${DB_DIR}/test.db`
// Every cycle reads the verified list afresh here - in production it is cached for 15 minutes.
process.env.HOOD_JUP_VERIFIED_MS = '1'

const log = (...a) => console.log('[tokensrc]', ...a)
const fail = (msg) => { console.error('[FAIL]', msg); process.exitCode = 1 }
const assert = (cond, msg) => { if (!cond) fail(msg); else log('ok:', msg) }

const { categorize, stakeTierFor, exitObserved, ingestOnce, addrKey } = await import('../server/tokensource.js')
const { getPrice } = await import('../server/market.js')
const { dynamicTokens, dynamicById } = await import('../server/registry.js')

// ---- unit: stake tiers (liquidity/volume vs position size) ----
// Live settles in kind, so the treasury crosses the spread once, on entry. The
// depth floor is 100× the stake; it was 150× when a round trip had to fit.
assert(stakeTierFor(100000, 25000) === 1000, '$100k pool + $25k vol → $1000 tier')
assert(stakeTierFor(50000, 12500) === 500, '$50k pool + $12.5k vol → $500 tier')
assert(stakeTierFor(10000, 2500) === 100, '$10k pool + $2.5k vol → $100 tier')
assert(stakeTierFor(1000, 2000) === 10, '$1k pool + $2k vol → $10 tier')
assert(stakeTierFor(900, 50000) === 0, 'deep volume cannot rescue a pool too thin for any stake')
assert(stakeTierFor(500000, 900) === 0, 'no real turnover → no tier, however deep the pool')
assert(stakeTierFor(150000, 3000) === 100, 'thin volume caps the tier even in a huge pool')

// ---- unit: the key both sides of a vendor match go through ----
//
// DexScreener returns EVM addresses CHECKSUMMED; everything the arena reads off
// the chain itself (the firehose reads event logs) is lowercase. Matching those
// by raw string is what left 493 of 1200 live coins with no socials, no chart
// link, and - where the contract publishes no logo() of its own - no picture at
// all. The owner spotted it as "HOODRAT has no image".
const CHECKSUMMED = '0x8E62F281F282686FCa6DCb39288069A93FC23F1c'
const LOWER = '0x8e62f281f282686fca6dcb39288069a93fc23f1c'
assert(addrKey(CHECKSUMMED) === addrKey(LOWER), 'the same EVM token in two casings collapses to ONE key')
assert(addrKey(CHECKSUMMED) === LOWER, 'and that key is the lowercase form the chain gives us')
// Solana base58 is case-SENSITIVE - folding it would merge different mints.
const B58 = 'DSaDXacKU4xDumJp8UkSwzwGeFgwM6XuEmdDn5jLsH7L'
assert(addrKey(B58) === B58, 'a base58 address is passed through untouched, never lowercased')
assert(addrKey('0xNOTHEX') === '0xNOTHEX', 'a non-address string is left alone rather than mangled')

// ---- unit: a coin's picture has to be loadable ----
// The Protocol Labs IPFS gateways 429 a browser loading one page of logos, and
// one coin's metadata "image" was a file path on its deployer's laptop.
{
  const { cleanImg } = await import('../server/tokensource.js')
  const GW = 'https://ipfs.filebase.io/ipfs/'
  const CID0 = 'QmXVKWN3i56vyh4Xot9sTb3XsCu92ihypcArFJLujuwzoS'
  const CID1 = 'bafkreihztk5poge7f2lz6logfjmhc7h7u6shvgacoktnuezks5oblmieue'
  assert(cleanImg(`https://ipfs.io/ipfs/${CID0}`) === GW + CID0, 'an ipfs.io logo is moved to the gateway that serves the burst')
  assert(cleanImg(`ipfs://${CID0}`) === GW + CID0, 'an ipfs:// logo becomes a gateway URL')
  assert(cleanImg(`https://${CID1}.ipfs.nftstorage.link/`) === GW + CID1 + '/', 'a subdomain-gateway logo is rewritten too')
  assert(cleanImg(`https://gateway.pinata.cloud/ipfs/${CID0}/logo.png`) === `${GW}${CID0}/logo.png`, 'a path inside the CID survives the rewrite')
  assert(cleanImg('https://cdn.example.com/x.png') === 'https://cdn.example.com/x.png', 'an ordinary https logo is left alone')
  assert(cleanImg('file:///C:/Users/someone/Downloads/logo.jpg') === null, 'a local file path is no picture at all')
  assert(cleanImg('javascript:alert(1)') === null, 'and neither is anything else that is not http(s)')
}

// ---- unit: sell traffic (measured and shown, but no longer a gate) ----
assert(exitObserved({ buys: 17900, sells: 13645 }) === true, 'thousands of settled sells → the exit visibly works')
assert(exitObserved({ buys: 5000, sells: 3 }) === false, '5000 buys and 3 sells → the honeypot signature')
assert(exitObserved({ buys: 4000, sells: 400 }) === false, 'sells under a quarter of buys → not convincing')
assert(exitObserved({ buys: 200, sells: 150 }) === false, 'healthy ratio but too few sells to prove anything')
assert(exitObserved(null) === false, 'no trade data at all → never claim the exit works')

// ---- unit: categorisation ----
//
// Live pays the winner the coins themselves, so the treasury BUYS and never
// sells. Only what the entry costs may gate: buy tax, and depth for the size.
// Everything about getting back out - sell tax, sell traffic, whether it rugs -
// is the holder's side of the trade and must NOT change the category.
const OLD = { ageHours: 5000 }
// Deep pools must show the gas-paid trading that vouches for their claimed
// depth - without txns24 the spoof detector correctly grades them "painted".
const TXNS = { txns24: { buys: 900, sells: 600 } }
const CLEAN = { checked: true, honeypot: false, sellable: true }
const DEEP = { liquidity: 600000, volume24: 250000, ...OLD, ...TXNS }
assert(categorize(DEEP, CLEAN).category === 'verified', 'deep pool, sane buy tax → verified')
assert(categorize(DEEP, { ...CLEAN, lpLocked: false }).category === 'verified', 'UNLOCKED liquidity is a rug signal, not a block → still verified')
assert(categorize(DEEP, { ...CLEAN, mintable: true }).category === 'verified', 'live mint authority is a rug signal, not a block → still verified')
assert(categorize({ liquidity: 600000, volume24: 250000, ageHours: 0.2, ...TXNS }, CLEAN).category === 'verified', 'a 12-minute-old pool is the player\'s risk → still verified')
// Sixteen stake tiers now, so the ceiling lands much closer to what a pool can
// really carry: $600k of depth and $250k of turnover is a $5,000 book, not a
// $1,000 one.
assert(categorize(DEEP, CLEAN).maxStake === 5000, 'a $600k pool with $250k turnover carries $5,000 battles')
assert(categorize({ liquidity: 20000, volume24: 6000, ...OLD }, CLEAN).maxStake === 200, 'a $20k pool is sized down to $200')
assert(categorize({ liquidity: 20000, volume24: 2100, ...OLD }, CLEAN).maxStake === 50, 'thin turnover caps it further, at $50')

// the three that changed when settlement went in kind
assert(categorize({ liquidity: 30000, volume24: 5000, ...OLD }, { checked: false }).category === 'verified',
  'an unscanned coin is Live-eligible now - the venue probe already proved the treasury can BUY it')
assert(categorize({ ...DEEP, txns24: { buys: 5000, sells: 2 } }, CLEAN).category === 'verified',
  'no sell traffic no longer blocks Live: the arena never sells, the holder does')
assert(categorize(DEEP, { ...CLEAN, sellTax: 30 }).category === 'verified',
  'a 30% sell tax is paid by whoever sells, and that is never the house → still verified')

// …and the ones that did not
assert(categorize(DEEP, { ...CLEAN, buyTax: 30 }).category === 'degen',
  'a 30% BUY tax comes straight out of the house on entry → no Live')
assert(categorize({ liquidity: 4000, volume24: 120, ageHours: 2 }, { checked: false }).category === 'fresh', 'no turnover → fresh (free only)')

// ---- the volume floor is pro-rated by age ----
// $2,000 is a TWENTY-FOUR HOUR number. Charging it whole to a coin that has
// existed for forty minutes asks it to prove something time has not allowed,
// and on a chain minting ~22k tokens a day that parked every fresh launch in
// "free battles only" for its first day. The floor now scales with the slice of
// a day actually lived, never below VOL_MIN ($500) - real money still has to
// have changed hands.
assert(categorize({ liquidity: 4000, volume24: 800, ageHours: 0.7 }, { checked: false }).category === 'verified',
  '$800 traded in the first 42 minutes is a market → battle-ready')
assert(categorize({ liquidity: 4000, volume24: 300, ageHours: 0.7 }, { checked: false }).category === 'fresh',
  '…but $300 is under the hard minimum, however young the coin → still free-only')
assert(categorize({ liquidity: 4000, volume24: 800, ageHours: 40 }, { checked: false }).category === 'fresh',
  'a coin that has had a full day to trade still owes the whole $2,000 floor')
assert(categorize({ liquidity: 4000, volume24: 800 }, { checked: false }).category === 'fresh',
  'unknown age is treated as a full day - the strict path, never the lenient one')
assert(categorize({ liquidity: 900000, volume24: 900000, ...OLD }, { checked: true, honeypot: true }).category === 'ineligible', 'honeypot → ineligible whatever the liquidity')
assert(categorize({ liquidity: 900000, volume24: 900000, ...OLD }, { checked: true, sellable: false }).category === 'ineligible', "a contract written so nobody can ever sell is a trap, not a risk → ineligible")

// ---- integration: full ingest with mocked APIs ----
// The arena's one pool is Solana Memes (22 Sep 2026). Jupiter carries it -
// its verified list, its activity feeds and an address lookup that keeps the
// existing book alive - with DexScreener for the chart pair and GoPlus for the
// token program's can't-sell switches. Every vendor here is a mock.
const HOURS = (h) => new Date(Date.now() - h * 3600e3).toISOString()
const jup = (o) => ({
  id: o.id, symbol: o.sym, name: o.name, icon: o.img ?? null, usdPrice: o.price, liquidity: o.liq,
  holderCount: o.holders ?? 1000, mcap: o.mcap ?? o.liq * 5, fdv: o.mcap ?? o.liq * 5,
  stats24h: { buyVolume: o.vol / 2, sellVolume: o.vol / 2, numBuys: o.buys, numSells: o.sells, priceChange: 4 },
  stats1h: { priceChange: 1 }, stats5m: { priceChange: 0.2 },
  firstPool: { id: 'pool' + o.id, createdAt: HOURS(o.ageH ?? 5000) },
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: o.freezable ? false : true, topHoldersPercentage: o.top10 ?? 20 },
  tags: o.tags || ['verified', 'meme'],
  ...(o.launchpad ? { launchpad: o.launchpad } : {}),
  ...(o.graduated ? { graduatedPool: 'grad' + o.id, graduatedAt: HOURS(1) } : {}),
  ...(o.twitter ? { twitter: o.twitter } : {}),
})
const solanaTokens = [
  { id: 'SoDeep1111', sym: 'SOLDEEP', name: 'Sol Deep', price: 3.2, liq: 300000, vol: 50000, img: 'http://x/soldeep.png', buys: 400, sells: 150, twitter: 'https://x.com/soldeep' },
  { id: 'SoMid22222', sym: 'SOMID', name: 'So Mid', price: 0.02, liq: 30000, vol: 5000, buys: 60, sells: 30 },
  // Thin but genuinely traded: it clears the "somebody has bought this" bar and
  // still lands in fresh, which is the distinction the assertions below check.
  { id: 'SoThin3333', sym: 'SOTINY', name: 'So Tiny', price: 0.5, liq: 3000, vol: 400, buys: 7, sells: 4, ageH: 30 },
  // Never traded. A deployment, not a market.
  { id: 'SoDead4444', sym: 'SODEAD', name: 'So Dead', price: 0.1, liq: 58000, vol: 0, buys: 0, sells: 0 },
  // A major-asset costume: the EXCLUDE list refuses the ticker outright.
  { id: 'FakeBtc555', sym: 'BTC', name: 'Fake Bitcoin', price: 0.01, liq: 500000, vol: 100000, buys: 900, sells: 700 },
  // Not memecoins, by Jupiter's own labels.
  { id: 'Stable6666', sym: 'USDX', name: 'Some Dollar', price: 1, liq: 900000, vol: 900000, buys: 900, sells: 900, tags: ['verified', 'stable'] },
  { id: 'Stock77777', sym: 'NVDAX', name: 'Nvidia xStock', price: 180, liq: 900000, vol: 900000, buys: 900, sells: 900, tags: ['verified', 'xstocks', 'stocks'] },
  { id: 'Defi888888', sym: 'PROTO', name: 'Protocol Token', price: 1, liq: 900000, vol: 900000, buys: 900, sells: 900, tags: ['verified', 'defi'] },
  // Two coins called CLONE: a real one and a launchpad-farm copy.
  { id: 'CloneBig99', sym: 'CLONE', name: 'Clone Big', price: 0.5, liq: 90000, vol: 40000, buys: 900, sells: 700 },
  { id: 'CloneFarmA', sym: 'CLONE', name: 'Clone Farm', price: 0.5, liq: 2600, vol: 30000, buys: 800, sells: 600 },
  // …and a second REAL coin sharing a ticker, standing on its own depth.
  { id: 'TwinOneBBB', sym: 'TWIN', name: 'Twin One', price: 1, liq: 120000, vol: 60000, buys: 800, sells: 600 },
  { id: 'TwinTwoCCC', sym: 'TWIN', name: 'Twin Two', price: 1, liq: 60000, vol: 30000, buys: 500, sells: 400 },
  // Still on its pump.fun bonding curve, busy and deep enough to rank.
  { id: 'CurvePumpD', sym: 'CURVE', name: 'On The Curve', price: 0.001, liq: 40000, vol: 60000, buys: 900, sells: 500, launchpad: 'pump.fun', ageH: 2 },
  // Graduated from the same launchpad - a real pool now, plays for money.
  { id: 'GradPumpEE', sym: 'GRAD', name: 'Graduated', price: 0.004, liq: 40000, vol: 60000, buys: 900, sells: 500, launchpad: 'pump.fun', graduated: true, ageH: 30 },
  // A launchpad that never reports graduation, but $800k deep - no curve holds that.
  { id: 'DeepLpIIII', sym: 'DEEPLP', name: 'Deep Launchpad', price: 0.02, liq: 800000, vol: 900000, buys: 900, sells: 700, launchpad: 'stonkfun', ageH: 500 },
  // GoPlus findings (see the mock below): frozen-by-default accounts, a
  // token-2022 transfer fee, and a live freeze authority.
  { id: 'FrozenFFFF', sym: 'FROZE', name: 'Frozen', price: 1, liq: 200000, vol: 90000, buys: 900, sells: 600 },
  { id: 'TaxedGGGGG', sym: 'TAXED', name: 'Taxed', price: 1, liq: 200000, vol: 90000, buys: 900, sells: 600 },
  { id: 'FreezeHHHH', sym: 'FRZAUTH', name: 'Freeze Auth', price: 1, liq: 200000, vol: 90000, buys: 900, sells: 600, freezable: true },
]
const GOPLUS = {
  FrozenFFFF: { default_account_state: '2', non_transferable: '0', freezable: { status: '0' }, mintable: { status: '0' }, transfer_fee: {}, holders: [], holder_count: '10' },
  TaxedGGGGG: { default_account_state: '1', non_transferable: '0', freezable: { status: '0' }, mintable: { status: '0' }, transfer_fee: { current_fee_rate: { fee_rate: '0.3' } }, holders: [{ percent: '12.5' }], holder_count: '4200' },
  FreezeHHHH: { default_account_state: '1', non_transferable: '0', freezable: { status: '1' }, mintable: { status: '0' }, transfer_fee: {}, holders: [], holder_count: '900' },
}

// Parameterised so a test can re-run the same ingest against a changed market
// (see the identity-stability check below). `verified` is what the verified
// list returns; the address lookup always answers from the whole market.
const makeFetch = (book = solanaTokens, { verified = book } = {}) => async (url) => {
  if (url.includes('lite-api.jup.ag/tokens/v2/tag?query=verified')) return verified.map(jup)
  if (url.includes('lite-api.jup.ag/tokens/v2/search?query=')) {
    const ids = decodeURIComponent(url.split('query=')[1]).split(',')
    return book.filter((t) => ids.includes(t.id)).map(jup)
  }
  if (url.includes('lite-api.jup.ag/tokens/v2/')) return [] // the activity feeds are quiet in this market
  if (url.includes('token-profiles/latest') || url.includes('token-boosts')) return []
  if (url.includes('/tokens/v1/solana/')) {
    const addrs = url.split('/tokens/v1/solana/')[1].split(',')
    return book.filter((t) => addrs.includes(t.id)).map((t) => ({
      chainId: 'solana', dexId: 'raydium', url: `https://dexscreener.com/solana/pair${t.id}`, pairAddress: 'pair' + t.id,
      baseToken: { address: t.id, symbol: t.sym, name: t.name },
      priceUsd: String(t.price), liquidity: { usd: t.liq / 2 }, volume: { h24: t.vol / 3 },
      txns: { h24: { buys: 3, sells: 2 } },
      pairCreatedAt: Date.now() - 5000 * 3600 * 1000, info: { imageUrl: null, websites: [], socials: [] },
    }))
  }
  if (url.includes('gopluslabs.io/api/v1/solana/token_security')) {
    const a = url.split('contract_addresses=')[1]
    return { code: 1, result: GOPLUS[a] ? { [a]: GOPLUS[a] } : {} }
  }
  throw new Error('unexpected url ' + url)
}
const fetchJson = makeFetch()

const res = await ingestOnce({ fetchJson })
log('ingested:', JSON.stringify(res))
const byId = Object.fromEntries(dynamicTokens().map((t) => [t.id, t]))
const byName = (n) => Object.values(byId).find((t) => t.name === n)

// surfaced: SOLDEEP, SOMID, SOTINY, CLONE, TWIN, TWIN_x, CURVE, GRAD, DEEPLP, TAXED, FRZAUTH.
// Refused: BTC (impostor), USDX / NVDAX / PROTO (not memecoins), the CLONE farm
// (thin duplicate), SODEAD (never traded), FROZE (nobody can sell it).
assert(res.count === 11, `surfaced 11 tokens (${res.count}) - impostor, non-memes, clone farm, dead pool and the frozen mint refused`)
assert(res.bySource.jup === 11, 'every token came through the Jupiter lane')
assert(byId.SOLDEEP?.category === 'verified' && byId.SOLDEEP.maxStake === 2000, 'SOLDEEP verified @ $2000')
assert(byId.SOLDEEP.pool === 'sol', 'a Solana token → the sol pool')
assert(byId.SOLDEEP.src === 'jup' && byId.SOLDEEP.srcChain === 'solana', 'it came from Jupiter, on Solana')
assert(byId.SOLDEEP.img === 'http://x/soldeep.png', 'real logo carried through')
assert(byId.SOLDEEP.socials.some((s) => s.type === 'twitter'), 'the socials Jupiter publishes reach the card')
assert(byId.SOLDEEP.pairAddress === 'pairSoDeep1111', 'DexScreener supplies the chart pair')
assert(byId.SOLDEEP.liquidity === 300000, 'enrichment FILLS: a one-pool pair never overwrites the token-level depth')
assert(Math.round(byId.SOLDEEP.ageHours) === 5000, 'Jupiter\'s first-pool date becomes the token age')
assert(byId.SOLDEEP.top10Pct === 20, 'the top-10 holder share rides along from Jupiter\'s audit')
assert(byId.SOTINY?.img === null, 'no published image → no image, never a placeholder')
assert(byId.SOMID?.category === 'verified' && byId.SOMID.maxStake === 200, 'medium pool → verified but sized down to $200')
assert(byId.SOTINY?.category === 'fresh', 'thin token → fresh')
assert(!byName('So Dead'), 'a pool with seeded depth but zero trades never enters the book')
assert(!byName('Fake Bitcoin'), 'a coin wearing a major-asset ticker is refused outright')
assert(!byName('Some Dollar') && !byName('Nvidia xStock') && !byName('Protocol Token'),
  'stablecoins, tokenised stocks and protocol tokens are not memecoins - Jupiter\'s own tags keep them out')
// ---- ticker collisions ----
assert(byId.CLONE?.name === 'Clone Big', 'the strongest coin of a ticker keeps the clean id')
assert(!byName('Clone Farm'), 'a thin duplicate of an already-listed ticker is refused - this is what stops clone farms')
assert(byId.TWIN?.name === 'Twin One', 'the deeper twin keeps the clean id')
const twinB = byName('Twin Two')
assert(twinB && twinB.id !== 'TWIN' && twinB.ticker === 'TWIN',
  'a genuinely deep second coin of the same name survives under a suffixed id, displayed ticker stays clean')
// ---- the bonding curve ----
assert(byId.CURVE?.category === 'fresh' && byId.CURVE.maxStake === 0 && byId.CURVE.onCurve === true,
  'a coin still on its launchpad bonding curve plays free battles only, however busy')
assert(byId.CURVE.safety.migrated === false, '…and its card says it has not migrated')
assert(byId.GRAD?.category === 'verified' && byId.GRAD.safety.migrated === true, 'the same launchpad, graduated → a real market that plays for money')
assert(byId.DEEPLP?.category === 'verified' && !byId.DEEPLP.onCurve,
  'a launchpad that never reports graduation is not "on a curve" when its book is $800k deep')
// ---- GoPlus, in Solana's vocabulary ----
assert(!byName('Frozen'), 'accounts frozen by default = nobody can sell = ineligible, gone from the book')
assert(byId.TAXED?.buyTax === 30 && byId.TAXED.category === 'degen', 'a 30% token-2022 transfer fee is a buy tax → no Live')
assert(byId.TAXED.topHolderPct === 12.5, 'Solana holder percents are already percents, not fractions')
assert(byId.TAXED.holders === 4200, 'GoPlus holder count lands on the card')
assert(byId.FRZAUTH?.category === 'verified' && byId.FRZAUTH.safety.sellNotBlockable === false,
  'a live freeze authority is the holder\'s risk: shown as a failed check, never a block')

// ---- an id is a promise about a CONTRACT ----
const idMap = () => Object.fromEntries(dynamicTokens().map((t) => [t.id, t.address]))
const before = idMap()
const flipped = solanaTokens.map((p) => (p.id === 'TwinTwoCCC' ? { ...p, liq: 900000, vol: 400000 } : p))
await ingestOnce({ fetchJson: makeFetch(flipped) })
const after = idMap()
for (const [id, addr] of Object.entries(before)) {
  if (after[id]) assert(after[id] === addr, `id ${id} still points at the same contract after a leadership flip`)
}
assert(after.TWIN === before.TWIN, 'TWIN keeps its original contract even after the other twin overtakes it')
assert(Math.abs(getPrice('SOLDEEP') - 3.2) < 0.05, 'SOLDEEP price registered in the market engine')
assert(dynamicById('SOLDEEP')?.ticker === 'SOLDEEP', 'dynamic token resolvable by id')

// ---- the book keeps what it has ----
// Jupiter's activity feeds only show what is hot this minute. A coin already in
// the book that drops out of every list is looked up by address and kept while
// it still clears the floors.
{
  const res6 = await ingestOnce({ fetchJson: makeFetch(solanaTokens, { verified: [solanaTokens[1]] }) })
  const ids = new Set(dynamicTokens().map((t) => t.id))
  assert(ids.has('SOLDEEP') && ids.has('GRAD') && res6.count === 11,
    `a quiet cycle (nothing on any list) keeps the whole book alive by address (${res6.count})`)
}

// ---- venue gate: a token the treasury cannot trade must never reach Live ----
const { setVenueCheck } = await import('../server/venue.js')
setVenueCheck((t) => t.pool === 'sol')
const res2 = await ingestOnce({ fetchJson })
const byId2 = Object.fromEntries(dynamicTokens().map((t) => [t.id, t]))
assert(byId2.SOLDEEP?.category === 'verified', 'routable chain → still verified')
assert(res2.byCat.verified === res.byCat.verified, 'venue gate leaves the routable tokens alone')

setVenueCheck(() => false) // no Solana venue - today's mainnet
const res3 = await ingestOnce({ fetchJson })
assert(res3.byCat.verified === 0, 'no venue at all → nothing is Live-eligible, whatever the safety scan says')
const byId3 = Object.fromEntries(dynamicTokens().map((t) => [t.id, t]))
assert(byId3.SOLDEEP?.category === 'degen' && byId3.SOLDEEP.maxStake === 2000, 'downgraded to Classic but keeps its size ceiling')
assert(/no way to buy it on Solana/.test(byId3.SOLDEEP.blurb), 'the card explains it is a venue problem, not a safety one')
setVenueCheck(() => true)

// ---- a flaky discovery source must not shrink the arena ----
process.env.HOOD_POOL_KEEP_MIN = '2'
{
  const before = dynamicTokens().filter((t) => t.pool === 'sol').length
  const dead = async (url) => {
    if (url.includes('lite-api.jup.ag')) throw new Error('http 503') // Jupiter is down this cycle
    return fetchJson(url)
  }
  const res4 = await ingestOnce({ fetchJson: dead })
  const after = dynamicTokens().filter((t) => t.pool === 'sol').length
  assert(before >= 2 && after === before, `Solana pool survives a dead discovery source (${after}/${before} kept)`)
  const res5 = await ingestOnce({ fetchJson })
  assert(res5.count >= res4.count, 'a healthy cycle rebuilds the live book')
}
delete process.env.HOOD_POOL_KEEP_MIN

// ---- a retired pool leaves the book ----
// Robinhood coins are gone with their pool: nothing prices, lists or plays them.
const { setDynamic: setBook, dynamicCount } = await import('../server/registry.js')
const { register } = await import('../server/auth.js')
const { creditTokens, getUserByName } = await import('../server/db.js')
const RH_OLD = { id: 'RHOLD', ticker: 'RHOLD', name: 'Old Robinhood Coin', pool: 'eth', address: '0xabc', srcChain: 'robinhood', category: 'verified', maxStake: 100, base: 2, dynamic: true, liquidity: 50000 }
setBook([...dynamicTokens(), RH_OLD])
await ingestOnce({ fetchJson })
assert(!dynamicById('RHOLD'), 'a coin from the retired pool drops out of the book on the next cycle')

// ---- a retired pool's names go back into circulation ----
// A Robinhood clone once claimed the id SOMEMEME; the real Solana coin would
// have listed as SOMEMEME_XXXX forever. A pin nobody's holding depends on is
// released at boot - and a pin somebody's holding is not.
{
  const { releaseRetiredIds, pinnedIdFor } = await import('../server/tokensource.js')
  const { db: pdb } = await import('../server/db.js')
  register('rhholder', 'password123')
  creditTokens(getUserByName('rhholder').id, 'RHWON', 12.5, 'an old win')
  const pin = pdb.prepare('INSERT OR REPLACE INTO token_ids (id, address, pool, first_seen) VALUES (?,?,?,?)')
  pin.run('SOMEMEME', '0xrhclone', 'eth', Date.now())
  pin.run('RHWON', '0xabc', 'eth', Date.now())
  const freed = releaseRetiredIds()
  assert(freed >= 1 && !pinnedIdFor('eth', '0xrhclone'), 'an unheld Robinhood pin is released')
  assert(pinnedIdFor('eth', '0xabc') === 'RHWON', 'a held coin keeps its id - the holding still points at its contract')
  assert(pinnedIdFor('sol', 'SoDeep1111') === 'SOLDEEP', 'Solana pins are never touched')
  const meme = { id: 'SoMeme9999', sym: 'SOMEMEME', name: 'The Real One', price: 1, liq: 500000, vol: 400000, buys: 900, sells: 800 }
  await ingestOnce({ fetchJson: makeFetch([...solanaTokens, meme]) })
  assert(dynamicById('SOMEMEME')?.address === 'SoMeme9999', 'the real Solana coin now lists under the clean name')
}

// ---- the book survives a restart ----
const { warmFromCache } = await import('../server/tokensource.js')
const ingested = await ingestOnce({ fetchJson })
assert(ingested.count > 0, 'a cycle ran and cached its book')
setBook([]) // exactly what a fresh process starts with
assert(dynamicCount() === 0, 'setup: the registry is empty, as it is at boot')
const warmed = warmFromCache()
assert(warmed === ingested.count, `the last good book is restored at boot (${warmed}/${ingested.count})`)
const back = Object.fromEntries(dynamicTokens().map((t) => [t.id, t]))
assert(back.SOLDEEP?.maxStake === 2000 && back.SOLDEEP.address === 'SoDeep1111',
  'restored tokens keep their address and ceiling - enough to price, sell and settle')
assert(getPrice('SOLDEEP') > 0, 'and their prices are live in the market engine again')
setBook([])
const { db: tdb } = await import('../server/db.js')
tdb.prepare('UPDATE token_cache SET data = ? WHERE id = 1').run(JSON.stringify([{ ...back.SOLDEEP }, RH_OLD]))
assert(warmFromCache() === 1 && !dynamicById('RHOLD'), 'a cache written before the switch does not bring back the Robinhood book')

try { rmSync(DB_DIR, { recursive: true, force: true }) } catch { /* wal */ }
log(process.exitCode ? 'FAILURES PRESENT' : 'ALL TOKEN-SOURCE TESTS PASSED')
process.exit(process.exitCode || 0)
