// Can the treasury actually trade this token for real?
//
// Live Arena pays the winner the combined FINAL VALUE of both portfolios, and
// the only thing that makes that affordable is the hedge: the treasury holds
// the same basket, so the payout rises and falls with assets it already owns.
// If the treasury cannot execute a token, that hedge is fiction - the arena
// would owe real dollars against nothing. So "not routable" must mean "never
// Live", no matter how deep the pool or how clean the safety scan.
//
// Kept as its own module so the token source can ask the question without
// importing the hedger (which owns the DB and the executor).

let check = () => true // default: paper book / testnet - no real money moves
let warm = async () => {}
let capacity = () => Infinity

export const setVenueCheck = (fn) => { check = fn }
export const setVenueWarm = (fn) => { warm = fn }
export const setVenueCapacity = (fn) => { capacity = fn }

// How many dollars this pool's venue could still turn into a hedge right now.
//
// Routability answers "can the treasury trade this coin"; capacity answers the
// other half - "does it have the money to". They are separate failures: a
// perfectly routable coin is still unhedgeable if the treasury's cash on that
// chain is already committed to other battles. Cross-chain is why: a stake paid
// in USDC on Base cannot buy a token on the Robinhood L2 in the seconds before
// a battle starts, so that chain runs on pre-positioned float and the float is
// what sets how many Live battles can be open at once.
//
// Infinity on the paper book - nothing real is being spent there.
export const venueCapacityUsd = (pool) => {
  try {
    const v = capacity(pool)
    return typeof v === 'number' && !Number.isNaN(v) ? v : Infinity
  } catch { return 0 }
}

// Conservative by construction: anything that throws counts as not routable.
export const venueCanTrade = (token) => {
  try { return check(token) !== false } catch { return false }
}

// Give the executor a chance to resolve routes for freshly ingested tokens, so
// they can become Live-eligible on a later cycle instead of never.
export const venueWarm = async (tokens) => { try { await warm(tokens) } catch { /* next cycle */ } }
