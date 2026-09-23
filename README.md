# HoodArena

**Pick your coins. Beat your opponent. Take the pool.**

A competitive crypto platform where two players go head-to-head: each picks three
tokens/memecoins and a portfolio split, and whoever's portfolio has the better
percentage return when the clock runs out takes the battle pool.

This is a real client–server product: **real accounts, real matchmaking, real
head-to-head battles between real players, and real custodial money rails.**
The server is the single source of truth — it holds the wallets, keeps picks
secret until both players lock in, streams the same prices to both players,
settles every battle with TWAP math and writes every cent to a SQLite ledger.
A browser is never trusted with anything.

**Money rails (custodial, ONE chain, "their money only"):** every user gets a
derived deposit address on the **Robinhood Chain** (4663); deposits in **USDG**
(1:1) or the native coin (credited at the live price, minus a flat network fee)
are detected on-chain, credited automatically and **auto-swept to the
treasury**. Withdrawals debit instantly, queue for operator approval
(auto-approve threshold configurable) and pay out net of a flat network fee, so
gas is funded by the flows, not by house capital. All keys derive from ONE
master seed.

One chain is a deliberate economic choice, not a simplification. A Live stake
can only buy its basket on the chain that basket lives on, so a second custody
rail could only ever hold dollars Live cannot spend — and the only ways out were
to refuse the battle or to front it from the treasury, buying one player's coins
with money belonging to others. With a single rail every deposit already stands
where it will be spent: **the arena buys with the player's own money and keeps
the fee**, and no house capital is ever at risk. Ethereum was retired in July
2026, Solana and Base on 2 Aug 2026; their adapters remain in `chains.js`
because turning a rail back on is one line.

**Oracle + hedging:** settlement prices come from **Pyth** (sub-second,
resolved by symbol at boot — 18 feeds incl. the memecoins) with CoinGecko as
fallback/metadata. A **hedging engine** makes the treasury hold the net token
exposure of all open Live-Arena battles (token-amount targets fixed at battle
start → no churn, netted across battles): paper book on testnet, a real DEX
executor on the Robinhood chain on mainnet. Admin sees the full picture: hedge book
with drift, and a **backing report** (owed vs held, house equity, ratio).
Live tables above `liveMaxStake` (default $100) stay locked until the operator
raises the cap as the fee reserve grows. Default env is **testnet**
(devnet/Sepolia); mainnet is a deliberate switch after legal review.

## Run it

```
npm install
npm run server     # game server + API + websocket on :8787
npm run dev        # frontend dev server on :5173 (proxies /api + /ws to :8787)
```

**Production:** `npm run build`, then `npm run server` alone — the server serves
the built `dist/` itself, so one Node process is the whole product.

Environment:

| Variable | Meaning | Default |
| --- | --- | --- |
| `HOOD_PORT` | server port | `8787` |
| `HOOD_DB` | SQLite file path | `server/data/hoodarena.db` |
| `HOOD_ADMIN_PASS` | password for the `admin` account | dev default `admin1337` — **set this in production** |
| `HOOD_WALLET_SEED` | 64-hex master seed for ALL custody keys — **set and back up before mainnet** | dev seed auto-generated & stored in DB |
| `HOOD_CHAIN_ENV` | `testnet` or `mainnet` | `testnet` |
| `HOOD_RH_RPC` | Robinhood Chain RPC. **Required** — it is the only custody rail, so with it unset the server refuses to boot rather than show deposit screens with nothing behind them. | unset |
| `HOOD_RH_QUOTE` | address of the chain's stable (USDG). Required on testnet, defaults to the mainnet USDG address otherwise. | mainnet USDG |
| `HOOD_CONFIRMATIONS` | how many blocks behind the head a balance is read at — ≈3s at 10 blocks/s. It is also the confirmation depth before a **deposit is credited**. Do not raise it above ~90: see below. | `30` |
| `HOOD_AUTO_WITHDRAW_MAX` | auto-approve withdrawals up to this USD amount | `0` (all manual) |
| `HOOD_DEPOSIT_FEE` / `HOOD_WITHDRAW_FEE` | flat USD network fees charged to users | per-chain / `0.5` |
| `HOOD_SWEEP` | `off` disables auto-sweep | on |
| `HOOD_HEDGE` | `off` disables hedging, `paper` forces the paper book on mainnet | on |
| `HOOD_HEDGE_MIN` | min USD drift before the hedger trades; also the smallest Live slice a player may pick | `1` |
| `HOOD_TOKENSOURCE` | `off` disables migrated-token ingestion | on |
| `HOOD_TOKENS_PER_POOL` | max ingested tokens surfaced per chain (best-by-liquidity cut) | `400` |
| `HOOD_CI_PRICE_BUDGET` | chain-index DexScreener pricing requests per ingest cycle (×30 addresses) | `100` |
| `HOOD_CHARTS` | `lw` draws charts in-app from our own candle service; `embed` puts every chart back to the DexScreener iframe. `?charts=embed` in the URL overrides it for one browser. | `lw` |
| `HOOD_CG_KEY` | CoinGecko demo API key (free, 30 calls/min). Optional: without it the keyless tier serves prices, the Blue Chips' 7d shapes, their card stats and their candles from one IP budget, and a busy minute answers 429 — the chart lane backs off for a minute and serves its last good series when that happens. | unset |
| `HOOD_BIRDEYE_KEY` | Birdeye API key — an optional extra Solana lane. Its free tier answers `400 Compute units usage limit exceeded` once spent, so nothing depends on it: **Jupiter** (keyless) is Solana's primary source. | unset |
| `HOOD_MIN_TRADES` | 24h trades before a pool counts as a market at all | `6` |
| `HOOD_VOL_MIN` | hard floor under the age-prorated volume requirement | `500` |
| `HOOD_IPFS_GATEWAY` | gateway for `ipfs://` token logos read off-chain | `https://ipfs.io/ipfs/` |
| `HOOD_REFRESH_REQ_CAP` | DexScreener requests per 7s price sweep (rotating window) | `20` |
| `HOOD_JUP_SLIPPAGE_BPS` | Jupiter slippage tolerance | `100` |
| `HOOD_RAILS` | `off` disables watchers/oracles (tests) | on |
| `HOOD_SPEED` | sim-seconds per real second (test runs only) | `1` |

Tests:

```
npm run test:rules    # server rule engine: validation, fees, token gating, battle categories, live stake cap
npm run test:achievements # badge logic + PROOF the rebate can never leave the house down on a player
npm run test:predict  # prediction markets: spec example to the cent, fee cap, refunds, arena-only resolution, admin queue, conservation fuzz
npm run test:wallet   # custody rails with mock chains: deposits, fees, auto-sweep, withdrawal queue, refunds, backing
npm run test:hedger   # hedging engine: open/close/net exposure, no-churn on price moves, thresholds
npm run test:tokensource # migrated-token ingestion: discovery, safety scan, LP-lock gating, categorisation
npm run test:pvp      # spawns the server, two ws clients play a real $100 battle
npm run test:e2e      # spawns server + TWO Chrome sessions that register, train and fight each other through the UI
npm run test:devnet   # REAL on-chain proof on Solana devnet (needs the public faucet to cooperate)
```

## Reading the chain: which block, and why not a paid RPC

`GET /api/rpc/status` is the diagnostic. The health number is `exhausted / reads`
— the share of chain reads that failed on **every** endpoint. It should be zero.

**The trap, and it cost a day.** Balance reads used to ask for state at the
`safe` block tag. On this chain `safe` sits ~7,500 blocks behind the head —
**12.5 minutes** at ~10 blocks/second — and no node keeps state that far back.
The chain's own endpoint answered `-32000: metadata is not found`; the failover
answered `HTTP 403`. **51% of all chain reads were failing**, and because the
same tag gates the multicall the deposit watcher uses, deposits were not being
credited at all. The 403 read like an access problem and the failures read like
rate limiting, so the whole thing was filed as "we need a paid RPC (~$50/mo)".

**A paid RPC would not have fixed it.** Paid nodes prune state too; the request
was simply for something that no longer exists. What fixed it, for free, was
asking for a block that is still on disk — `head − HOOD_CONFIRMATIONS`. Live
`exhausted/reads` went from 51% to 0%.

Measured 3 Aug 2026, and these numbers are why the default is 30:

| | |
| --- | --- |
| chain speed | ~10.1 blocks/second |
| state kept by `rpc.mainnet.chain.robinhood.com` | ~6,200 blocks (~10 min) |
| state kept by `robinhood-rpc.publicnode.com` | **~96 blocks (~10 s)** |
| reorgs seen at depths 0–60 over 908 blocks | none (sequencer L2) |

The failover's ~96 blocks is the binding constraint: read deeper than that and
only one endpoint can answer, which turns the read pool into a single point of
failure — the exact thing it exists to prevent. Deeper is also not free safety,
since `HOOD_CONFIRMATIONS` is the depth at which a **deposit is credited**.

Two invariants worth keeping: a failed read degrades to an **error, never a
zero** (a zero tells a funded player their wallet is empty and makes the arena
refuse a battle for the wrong reason), and bulk work stays on its own lane
(`HOOD_RH_BULK_RPC`) so the indexer can never spend a player's quota.

## Mainnet go-live runbook

1. `.env.mainnet` holds the production secrets (`HOOD_WALLET_SEED` = every
   custody key; `HOOD_ADMIN_PASS`). **Back the file up offline before anything
   else** — whoever has the seed controls all funds; losing it loses them.
2. `npm run preflight:mainnet` — the go-live gate: secrets, all three mainnet
   RPCs + USDC contracts, Pyth, CoinGecko, Jupiter routing, full-reserve
   settings, treasury funding. It refuses on blockers.
3. Fund the treasury addresses the preflight prints (gas: ≥0.05 SOL,
   ≥0.004 ETH, ≥0.002 ETH on Base — a few dollars total; USDC optional, grows
   from fees). Re-run preflight until ALL CLEAR.
4. `npm run server:mainnet` — the server hard-refuses to start on mainnet with
   a dev seed or default admin password. Signup credit is $0 on mainnet
   automatically (full reserve); withdrawals start fully manual; Live tables
   cap at $100 until the operator raises it.
5. On the VPS: copy the repo + `.env.mainnet` (securely), `npm install`,
   `npm run build`, `npm run server:mainnet` behind a reverse proxy with TLS.

## The Robinhood firehose (our own chain tracking)

The trading terminal built on top of this was removed (owner's call) — the
data plane underneath it **stays**, as the arena's own eye on the Robinhood
chain. `server/firehose.js` ingests **every swap on the chain** (measured
~2M/day): 24h backfill (~25 min) + 5s live tail + a deep walk toward
`HOOD_FH_DEEP_DAYS` (7) of history, adaptive `eth_getLogs` halving, pool/token
metadata via Multicall3, per-TOKEN 1-minute candles materialised on ingest
(30-day retention; raw swaps 3 days), ETH/USD read off the WETH/USDG pool's
own `slot0`. `fh_stats` is a book rollup rebuilt every 15s — price, changes,
volume, trades, depth, mcap for every traded token, queryable in one indexed
read (`terminalBook()`), plus `candlesFor`/`tapeFor`/`holdersFor` (exact
Transfer-log census with top-10 share). Health: `GET /api/firehose/status`.

What it feeds the arena (all live):

- **Our own settlement prices for the Robinhood pool.** `server/pricewatch.js`
  compares our last print against the vendor's every 30s and, in the default
  `HOOD_FH_PRICES=primary` mode, feeds the market engine from our swaps every
  5s (vendor price-silenced for those ids; stats still refresh). Promotion is
  guarded — firehose lag or a broad divergence blowout demotes back to the
  vendor automatically; `HOOD_FH_PRICES=shadow` reverts entirely. The evidence
  that earned the default: our prints match raw chain swaps exactly while the
  vendor lags minutes behind on fast movers (RP500 crashed 13× on-chain while
  the vendor still quoted the old price — a stale settlement price is an
  exploit window). Shadow report lives in `/api/firehose/status`.
- **Instant listing.** Every 10s the ingest fast-lists firehose-fresh tokens
  (young + traded + liquid) through the same grading as every other source —
  a coin is in the arena minutes after its first trades, not cycles later, and
  the `fh` discovery source keeps it alive until DexScreener catches up.
- **Holder census on token cards.** `GET /api/token/:id/holders` replays every
  Transfer of a Robinhood token — exact holder count, top wallet and top-10
  share (LP-aware), rendered on the token page.

### Keeping the database from eating the disk

The arena's own data — every account, battle, wallet and ledger row — is **under
a megabyte**. Everything else in the file is this data plane, so disk is a
firehose question, not a product one. Every table that grows has a bound:

| table | kept |
| --- | --- |
| `fh_swaps` (raw swaps) | 6 hours |
| `fh_c1m` (1-minute candles) | 30 days |
| `spark_hist` | 8 days |
| `fh_stats` | 60 seconds |
| `chain_pools` (the chain index) | pools that were checked and never once traded or held depth are forgotten after `HOOD_CI_DEAD_DAYS` (7) |

The chain index had **no** bound until 2 Aug 2026 and grew with every
`PoolCreated` the chain ever emitted — 374k rows at ~12,350/day, ≈830 MB a year.
Of those 374k, only 34k had ever traded or held a dollar of depth. Forgetting a
row cannot hide a coin: the book has two independent doors, and the firehose
surfaces any market with real depth and trades through `bookTokens()`, which
never reads that table. `npm run test:ciprune` pins the rule down.

**`auto_vacuum` is deliberately OFF.** SQLite never returns freed pages to the
filesystem on its own, so the file sits at its highest-ever size — measured once
at 4.68 GB holding 0.9 GB of data, 3.8 GB of it left behind when swap retention
was cut from 3 days to 6 hours. The fix is *not* `auto_vacuum`: FULL rewrites
pages on every commit, and this server writes ~116k swap rows an hour on the main
thread, where it already loses whole seconds to ingest. Instead:

```
npm run db:compact              # report only
npm run db:compact -- --apply   # rebuild, server must be stopped
```

It refuses to run while anything else is writing, checks free disk against the
real data size rather than the bloated file, and reports an integrity check
afterwards. With retention doing its job this is a rare maintenance-window job,
not a cron: budget a few minutes of downtime when the file drifts far above the
~0.8 GB steady state.

## Architecture

```
server/            authoritative game server (Node, express + ws + node:sqlite)
  index.js         REST API + websocket hub + static hosting of dist/
  duel.js          matchmaking queues, duel rooms, settlement, payouts
  rules.js         arena rules (validation, fees, token gating)
  market.js        price engine: real anchors (Pyth/DexScreener/CoinGecko) held flat between prints; GBM only pre-anchor
  tokensource.js   migrated-token ingest + GMGN-grade enrichment (charts, socials, mcap, txns)
  feed.js          CoinGecko poll (server-side only)
  db.js            SQLite schema, wallet ledger, stake locks, crash recovery
  auth.js          scrypt passwords, session tokens
src/               React frontend (Vite) — a view over the server's state
  engine/net.js    REST + websocket client; mirrors server state into the store
```

## What's inside

- **No landing page** — opening the site puts you in the arena, the way every
  trading front-end this competes with works. A visitor without an account sees
  the whole setup (arenas, categories, stakes, live prices, the summary) and
  meets the signup form only when they try to enter a battle. `Rules & Safety`,
  `Terms of Service` and `Privacy Policy` live in the footer on the profile page.

- **Real PvP matchmaking** — queues per (mode, stake, duration, category); the
  first two players at the same table get matched. Private challenge links
  (`#/challenge/<code>`) and direct challenges by name with live notifications.
- **Live token ingestion** — a background service discovers MIGRATED tokens
  (off the launchpad bonding curve into a real DEX pool) on the Robinhood chain
  and auto-sorts them into the arena's tiers. Discovery is OURS
  (`server/chainindex.js`): every `PoolCreated` event of the chain's Uniswap V3
  factory is indexed into SQLite (full-chain backfill + live tail, adaptive
  `eth_getLogs` halving), because vendor lists cap that chain at ~15 addresses
  while it mints ~22k tokens/day. **Discovery is exhaustive; the BOOK is not** —
  and no UI copy may claim otherwise. The index knows ~346k pools; what reaches
  players is `PER_POOL` (1,200) markets taken off the top by depth × turnover,
  after floors on liquidity ($1k), 24h trades (6) and same-ticker duplicates
  ($25k), because a pool nobody has traded is a deployment, not a market. That
  cut is the product: the arena carries the chain's real markets, ranked, not a
  345,000-row dump. Pricing/grading flows through the same
  DexScreener pipeline — the index adds addresses, never opinions. A token that
  lands on-chain and trades is in the arena within one ingest cycle (minutes);
  `npm run chainindex:status` shows the index. Tiers: locked+deep+sellable → **Verified** (both arenas); tradeable
  with liquidity → **Degen** (Classic only — the house holds nothing there, so
  it can never go minus on a bad pick); thin/new → **Fresh** (free only);
  honeypot/can't-sell → **Ineligible** (never). The treasury only ever hedges
  Verified tokens, so an illiquid or non-sellable coin can never leave the
  house holding a bag. (GMGN's own API is Cloudflare-locked and not callable
  server-side; GeckoTerminal + GoPlus expose the same data reliably.)
- **Battle category** — every battle is fought inside ONE token pool, and the
  arena has exactly one: **Robinhood Memes** — filled entirely by the live
  Robinhood-chain ingest (no curated coins anywhere). The old Blue Chips and
  Solana Memes pools were removed (owner decision, 2026-07-30); the pool id
  stays `eth` because it is written into every holding and match record. The
  pool plays **both arenas**: its Live battles are funded in USDG on the
  Robinhood chain (`POOL_FUND.eth`). The chain isn't GoPlus-scannable, but
  unknown is not unsafe — those coins earn Verified on chain evidence (depth,
  coherent stats, observed sells) instead of a scanner's blessing. Both
  players pick all 3 tokens from the pool — a token from any other (removed)
  pool is rejected server-side. A category only offers stakes where it has 3+
  eligible tokens.
- **Pick terminal** — the pick phase is a full-screen, GMGN-style trading
  terminal: a searchable/filterable/sortable token list (trending, new migrated,
  top volume, gainers, favorites; min-liquidity/mcap/age + eligibility filters),
  a middle pane with the selected token's real candle chart (timeframes),
  socials, market cap, holders, top-holder %, buy/sell tax and a Safety &
  Eligibility readout, and a right pane for the 3 portfolio slots (sliders +
  manual %, Equal Split / Clear / Random, an allocation donut, live slippage
  estimate) plus a mode-aware battle summary and a Lock → Confirm flow.
- **Hidden picks, provably** — portfolios live only in server memory until both
  players lock in; the opponent's client literally never receives them early.
- **Classic Arena** — virtual portfolios, money stays in stablecoin, fixed
  guaranteed prize (pool − fee). **Live Arena** — capital is invested after the
  fee, swap costs (~0.3%/side) hit both ways, winner takes the combined final
  value; pre-battle safety checks re-verify every token and force a re-pick (or
  refund) when one fails.
- **Fair settlement** — both players' start prices come from the same server
  tick; settlement uses a **30-second, time-weighted** TWAP priced **at the
  final whistle** (`market.twapAt`), so neither a last-second buy nor a
  settlement delayed by a stalled loop can move a result: a price counts for as
  long as it stood, and anything printed after 0:00 belongs to the next battle.
  The window is measured in time rather than in prints precisely because the
  Robinhood pool now feeds one print per trade — a busy coin must not be able to
  shrink its own protection. Returns beyond ±25% auto-flag the match for review.
- **Trade-by-trade duels** — the Robinhood chain mints a block every 100ms, so a
  second of a battle holds several. The engine still keeps one price per second
  (that is what settles), but every trade released in that second is also turned
  into a point of its own — both portfolios recomputed **on the server** at that
  trade — and shipped with the tick as `micro`. Measured on a live battle: 104
  chart points a minute against the 60 a per-second line can draw, up to 7 in a
  single second. The browser is handed returns to draw, never trusted to compute
  one.
- **Stakes & fees** — a tiered schedule on the total pool, thinning as the
  table grows: 10% up to $100, then 8% / 6% / 5% / 4% / 3% / 2.5% at $100,
  $300, $750, $1500, $3000 and $7500 (defaults in `server/db.js`, editable in
  the admin panel; the client mirrors whatever the server reports),
  shown before entry. Draw rule (<0.05 pp): Classic refunds both stakes fee-free,
  Live pays each player their own final value.
- **Money integrity** — every balance change is a ledger row; stakes are locked
  rows, not vibes; a server restart voids in-flight battles and refunds every
  lock on boot; a battle keeps running if a player closes the tab, and their
  result and payout are waiting when they come back.
- **Token categories** — Arena Verified / Degen Approved (Classic only, 15 min+,
  ≤50% of portfolio) / Fresh Launch (free battles only) / Suspended / Not
  Eligible, with per-token liquidity stake caps — enforced server-side, mirrored
  client-side for instant UX.
- **Real prices, GMGN-style** — once a token has a live print its displayed
  price and its settlement history ARE that print (held flat between updates,
  never simulated): the firehose per trade and DexScreener every 7s for the
  surfaced book. (Pyth + CoinGecko still stream mainnet majors — nothing in the
  arena carries those ids any more, but the pull is the feed-status heartbeat
  that keeps the 90s void rule honest.) The server streams per-second prices to every
  client over the websocket; if the price source dies mid-battle for 90s+,
  real-money matches void with a full refund. Every token carries its full
  GMGN-grade card — real candle chart (DexScreener embed), website, socials,
  market cap, FDV, 5m/1h/6h/24h changes, buys/sells, pool age, contract
  address — in the token list, the token page and the in-battle picker.
- **Charts are in-app, on the clock.** The pick phase is 90 seconds and a
  DexScreener iframe took 1.5–2.2s to boot per coin — every coin, every time,
  since the frames died on unmount. So the arena draws its own now: TradingView
  **Lightweight Charts** (the renderer under GMGN/Photon, attribution mark
  included per its licence) fed by `server/candles.js`, which answers from
  whichever source knows the coin — for the Robinhood book that is **our own
  firehose** (a local SQLite read, no network); the GeckoTerminal/CoinGecko
  branches stayed wired for the removed pools but no longer serve anything.
  Measured in the pick terminal, coin to coin: **median 215ms
  (worst 307) against 1520ms (worst 2193)** for the embed. Anything our service
  cannot answer for yet falls back to the embed, so no token is ever worse off,
  and `HOOD_CHARTS=embed` returns everything to the old engine.
- **Blue Chips drew their own candles** *(pool removed — the machinery below
  is dormant, kept for the day a curated pool returns).* BTC is not an ERC-20
  and the wrapped proxies are a different asset in a different pool, so the
  majors had no pair to embed — they used to fall back to a since-boot line.
  The server pulls
  true OHLC from CoinGecko (`GET /api/token/:id/ohlc?range=1d|7d|30d|90d`,
  cached per range, one throttled lane, a 429 parks it for a minute and the last
  good series keeps serving) and the client renders them itself
  (`src/components/candles.jsx`): candles, wicks, price axis, crosshair with
  O/H/L/C. The vendor's granularity is fixed per range, so the caption names the
  candle size it actually is (a day is 30-minute candles, a month is 4-hour) and
  the range chips are the ones it can answer honestly. The same markets call
  makes their card live too — market cap, FDV and 1h/24h off CoinGecko, 6h off
  those candles, 5m off our own prints — instead of the catalog constants that
  were true the day they were typed.
  Curated tokens resolve their real DEX identity by activity-gated search
  (spoofed pools with fake liquidity do ~0 trades and are rejected).
- **Training** — free battles against arena bots; one completed training battle
  gates real-money play; separate leaderboard.
- **Profiles, history, leaderboards** — all computed from the real match table;
  win-rate boards require 20+ battles. Share cards (canvas PNG) for X/Telegram.
- **Admin** — an `admin` account gets the panel: arena pauses, fee tiers, signup
  credit, token category/stake/pause overrides, live match voiding with refunds,
  user blocking, manual refunds, full per-match event timelines and a complete
  action log.
- **Tournaments** — practice brackets vs bots today (battles are real server
  battles); real 8-player sponsored brackets are the next milestone.
- **Two products, one account** — the app is HoodArena *and* HoodPredict, not an
  arena with a prediction tab. A switcher sits beside the wordmark (which
  changes with it), each product carries its own navigation and accent (arena
  phosphor, Predict ice) down to the searchlights behind the page, and what they
  share is everything underneath: one balance, one wallet, one bell, one
  achievement ladder. `PRODUCTS` in `App.jsx` is the whole map.
- **Prediction markets** — parimutuel pools anyone can open, in two kinds:
  **binary** (YES/NO) and **multiple choice** (2–20 named outcomes, each with
  its own pool and optional picture, exactly one wins — `pm_options`). The
  maths is one machine for both: percentages are the money split, fees come off
  the top capped at the LOSING money (all non-winning pools), winners split the
  rest pro-rata within their pool. A winning outcome NOBODY backed keeps the
  whole pool with the house — the field had its chance (owner's rule; the
  creator earns nothing there either, and the take is booked as `fee_platform`
  so it stays on the revenue record). Creator estimates (which must sum
  to 100) stand in until at least two outcomes hold money. Everything below
  about settlement, freezing, escrow and the admin queue applies to both kinds;
  the admin settles a multi market by clicking the winning option.
  A market is: a question,
  an optional picture (same upload rails as profile pictures — browser crops to a
  256px square, server checks declared type against magic bytes, stored beside
  the avatars, served from `/api/predict-image/:id`), a close time, and a creator
  fee (0–10%) frozen by the first stake; the arena adds a flat 1%. **The question
  is the rule**: there is no separate rules essay or named source to write, since
  that friction sat on the one screen that decides whether a market gets opened
  at all. A question with no clean answer is ruled invalid and refunds everyone,
  which is the safety valve that makes the simpler form safe. Markets published
  before this still show the rules and source they carried — that is what their
  stakers agreed to. The losing pool funds the winning
  pool's profit pro-rata — the house is never a counterparty. Fees are capped
  at the losing pool so a winner can never be paid less than their stake, and
  cancelled/invalid/one-sided markets refund every cent with no fees at all.
  Resolution: **the arena settles every market, nobody else.** A creator opens
  it and earns from the volume but never touches the outcome and cannot cancel
  a market holding money — which closes two holes at once: a vanished creator
  can no longer strand anyone's stake, and a creator on the losing side can no
  longer cancel their way out before the close. An admin decision IS the result
  and pays out on the spot (no review window, no dispute step). The operator's
  side of that is `GET /api/admin/predict` and the admin panel's **Markets**
  tab: every closed market still holding money, oldest first, with its rules
  and source beside the buttons and an overdue flag after `HOOD_PM_OVERDUE_MS`
  (default 3 days) — a decision nobody is reminded to make is one that does not
  happen. Settlement is irreversible by design, so the panel confirms first.
  Settlement is one idempotent transaction; payouts floor to the cent (rounding
  only ever shrinks what leaves); open pools count as liabilities in the
  backing report; the 1% arena fee feeds the achievement rebate base (the
  creator's fee, being another player's income, never does).
  **Public profiles** — `#/predict/c/<name>` is every account's page, not just a
  creator's: followers, the predictor record (calls decided, called right,
  accuracy, net — the same arithmetic the leaderboard ranks on), and, only if
  they have opened a market, the creator half with ledger-true stats (total
  market volume, creator earnings straight from `fee_creator`, resolved count),
  a plain-text post feed (500 chars, cooldown, author/admin delete), and every
  market they run. Posts can carry a picture (scaled to fit in the browser — not
  square-cropped, a post picture is content — validated by the same magic-byte
  rails, filed as `p<postId>`, unlinked with the post). Following an account
  (`pm_follows`) rings your bell for each market they open (7-day window, built
  on the fly in the notification feed — no fan-out writes). Discovery runs
  through the board itself: **every leaderboard row opens that player's
  profile**, plus creator bylines on every market card and names linking to
  profiles wherever they appear (details, discussions, terminal search).
  Its own surfaces: a Predict home with live volume, **My bets** (accuracy over
  *decided* markets only — a refund is not a call you got wrong), a **predictor
  leaderboard** ranked by net profit, a canvas share card, a live payout
  quote in the stake box ("$50 → $65.39 · 1.31x"), an **odds chart** on every
  market (YES/NO step-lines rebuilt entirely from the recorded bets — the curve
  is derived, never stored, so it cannot drift from the ledger; dashed while
  one side is empty), and a **discussion thread** per market where every
  comment is stamped with the side its author actually holds, read from the
  ledger rather than from their claims (author deletes their own, admin any;
  10s cooldown, 500-char cap, plain text only). That quote comes from
  `src/engine/predict.js`, imported by BOTH the server's settlement and the
  browser's preview, so the number a player is shown and the number they are
  paid cannot drift apart — the test stakes exactly what it quoted and asserts
  the payout matches to the cent.
  **Prediction duels** (`#/predict/duels`) — the same product with the crowd
  removed: one question, two people, opposite sides, the *same* stake. Somebody
  asks "Will ETH close above $4,000?", takes YES for $100 and puts it up; the
  taker automatically gets NO for $100; the winner receives **$190** and the
  arena keeps **$10** (`PD_FEE_PCT` = 5% of the pot, the only cut — a duel has
  no creator, so there is no creator fee). Its own table (`pm_duels`), not a
  thin market: a duel has exactly two seats, a fixed price of entry, and an
  ACCEPT step a pool has no concept of. A challenge reaches its opponent two
  ways, and they are independent — `target` (a named player, the only one who
  may accept; NULL = anybody) and `listed` (on the public board, or private-link
  only, which stays private for the whole life of the duel). The seat is claimed
  by a gated `UPDATE ... WHERE status='open'`, so two people hitting Accept
  together cannot both get in and the loser of that race is refused *before*
  their money is touched. Money: both stakes leave through `debit()` with their
  chain plans recorded, the winner is paid across the union of the chains that
  funded the pot, the prize floors to the cent and the fee takes the remainder,
  and settlement is idempotent behind one `finalized IS NULL` gate. **The arena
  settles, nobody else** — the same ruling as markets, and here not even a
  choice: both people in a duel are parties to it, and "they must agree" hands
  the loser a hostage. Duels join the admin **Markets** desk with their own
  queue (YES / NO / void). A duel nobody takes expires at its own deadline and
  the challenger is refunded in full by the 15s sweeper — the one thing a timer
  may do here, because it un-does a bet that never happened rather than deciding
  a result; withdrawing before a taker does the same. Void refunds both sides
  in full, fee included. Open challenges and matched pots count as liabilities
  in the backing report, and each side's half of the fee feeds the achievement
  rebate base exactly like a battle's.
  The board (`#/predict/duels`) is a **dense list beside a pinned rule panel**,
  not a gallery. A hero states the game in four numbered steps (create → accept
  → stakes lock → arena resolves — numbered because it really is a sequence),
  then a tab row splits the board by the thing that decides whether a duel is
  any of your business — *Open duels · Direct challenges · Link only · Settling
  · Resolved*, each with its live count — over a sortable list (expiring
  soonest / newest / biggest pot). Every duel is one **row of five fixed
  columns**, hairline-separated so the eye travels down a column rather than
  around a card: what kind of challenge it is, the question and who asked it,
  the two stakes at equal money, the money (pot / winner gets / arena fee), and
  the countdown with the single action that row is for. Under a day the clock
  ticks to the second; over a day it reads as days and hours, because seconds
  nobody is watching are just noise. The money column reports what actually
  happened — a refunded duel prints *Refunded*, never *winner gets*. Rows you
  have money in carry an ice edge. Colour means one thing each: ice is the
  product and every affordance in it, green and red belong to YES and NO and
  appear only on the stakes, everything else is grey; the panels run a shade
  bluer than the arena's green-grey so the two products never look alike.
  `npm run test:predict` proves the spec's worked example to the cent plus
  conservation on every settlement path — for the pools and for the duels
  (including a 60-duel fuzz pass asserting the house never pays out more than
  the pot took in, on any verdict).
- **Achievements & the fee rebate** — 40 badges derived from the match record
  (volume, plain and stake-floored streaks with opponent-diversity clauses,
  clutch wins judged from a mid-battle record duel.js writes at settlement,
  craft-of-the-win conditions from per-token returns, the full 16-rung stake
  ladder, both arenas, tournaments), 36 of which carry a cash reward
  (catalogue lifetime total $1,167). The reward is never house money: it is a slice of the fees
  **that same player** has already paid, capped by `achieveRebatePct` (default
  40%, hard-clamped to 90 in code). So for every account, at every moment,
  `rewards_paid <= 0.40 x fees_paid` — the arena keeps three of every five fee
  dollars and cannot go negative on anyone through achievements.
  **The mechanic is house-side and is never shown to players.** `/api/achievements`
  deliberately serves only three figures — balance `unlocked`, `claimed` and
  `available` — and no fee base, rate or wording, so the accounting is not one
  devtools tab away; the screen presents a reward balance that grows as you play.
  The test asserts that payload leaks neither "fee" nor "rebate".
  The cap is enforced at the only place money moves (`claimAchievement`), inside
  one transaction: the claim row is inserted first (its primary key kills double
  claims), the ledger is re-read inside the transaction, and a claim past the
  allowance throws and rolls back — no row, no payment, claimable later once the
  fees are there. The fee base counts only what the house actually kept: half the
  pool fee per 1v1, a seat's share of a tournament pot fee, and nothing for
  training battles, classic draws (fee waived), network fees, swap cost or price
  impact. `npm run test:achievements` proves the invariant by brute force, and
  `GET /api/admin/rebates` re-audits every claimer on demand.

## What's deliberately not here yet

- On-chain deposits/withdrawals (custody or escrow decision pending)
- Real DEX execution for Live Arena (currently simulated against real prices)
- Multi-player tournaments with sponsor payouts
- KYC/geo-compliance — required before real money switches on

## Stack

Server: Node 22+ (`node:sqlite`), express, ws — no other runtime deps.
Frontend: React 18 + Vite, hash routing, canvas share cards, self-hosted fonts.
