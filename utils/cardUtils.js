// ── Card Deck Utilities ──────────────────────────────────────────────────────

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const RANK_ORDER = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, id: `${rank}${suit}` });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function dealCards(playerCount) {
  const deck = shuffleDeck(createDeck());
  const hands = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, i) => hands[i % playerCount].push(card));
  return hands;
}

// ── Bluff Validation ─────────────────────────────────────────────────────────

/**
 * Validate a challenge:
 * Returns true if the last claim was a BLUFF (cards don't match claimed rank)
 */
function wasBluff(playedCards, claimedRank) {
  return !playedCards.every(c => c.rank === claimedRank);
}

// ── Room State Factory ────────────────────────────────────────────────────────

function createBluffRoom(roomCode, hostId, hostName, settings = {}) {
  return {
    roomCode,
    game: 'cardsbluff',
    status: 'waiting',      // waiting | playing | finished
    players: [{
      id: hostId,
      name: hostName,
      isHost: true,
      socketId: hostId,
      hand: [],
      cardCount: 0,
      isAlive: true,
    }],
    settings: {
      maxPlayers: settings.maxPlayers || 6,
      startingCards: settings.startingCards || null, // null = auto deal
    },
    // Game state
    currentPlayerIndex: 0,
    pile: [],               // all played cards (face down)
    lastClaim: null,        // { playerId, playerName, count, rank, cardCount }
    lastPlayedCards: [],    // actual cards played last turn (for challenge reveal)
    passCount: 0,           // consecutive passes
    winner: null,
    log: [],                // [ { type, msg, ts } ] — game event log
  };
}

module.exports = { RANKS, SUITS, RANK_ORDER, createDeck, shuffleDeck, dealCards, wasBluff, createBluffRoom };
