// A curated list of common English words for the game
// In production, replace with a full dictionary API or larger word list

// const WORD_LIST = [
//   "abandon", "ability", "absence", "abstract", "abundant", "academic", "accident", "accurate",
//   "achieve", "acknowledge", "acquire", "action", "activate", "activity", "actually", "addition",
//   "address", "adequate", "adjacent", "adjust", "administration", "advance", "advantage", "adventure",
//   "advocate", "affect", "afternoon", "against", "agency", "aggressive", "agreement", "agriculture",
//   "airplane", "algorithm", "alliance", "although", "ambulance", "anchor", "ancient", "announce",
//   "another", "anticipate", "apartment", "apparent", "appetite", "approach", "appropriate", "approval",
//   "architecture", "argument", "arrange", "article", "artificial", "associate", "assume", "atmosphere",
//   "attempt", "attention", "attitude", "authority", "available", "average", "balance", "bamboo",
//   "barrier", "baseball", "basket", "battery", "battlefield", "because", "become", "behavior",
//   "believe", "benefit", "between", "bicycle", "biology", "blanket", "blossom", "borrow",
//   "bottle", "boundary", "breakfast", "bridge", "bright", "broken", "brother", "budget",
//   "butterfly", "button", "cabinet", "calculate", "calendar", "camera", "campaign", "capable",
//   "captain", "capture", "carbon", "careful", "carpet", "castle", "category", "celebrate",
//   "center", "certainly", "champion", "channel", "chapter", "character", "chemical", "chicken",
//   "childhood", "chocolate", "choose", "circuit", "climate", "clockwork", "clothes", "collect",
//   "colony", "comfort", "command", "comment", "community", "company", "compare", "complete",
//   "complex", "compound", "computer", "concept", "concern", "condition", "confidence", "conflict",
//   "consider", "contain", "content", "continue", "control", "convert", "copper", "correct",
//   "cotton", "couple", "courage", "cover", "create", "creature", "criminal", "crystal",
//   "culture", "current", "customer", "danger", "darkness", "daughter", "decision", "declare",
//   "defeat", "deliver", "depend", "describe", "desert", "design", "develop", "different",
//   "digital", "direct", "discover", "distance", "divide", "doctor", "document", "dragon",
//   "driver", "during", "dynamic", "economy", "effect", "effort", "either", "election",
//   "element", "emergency", "emotion", "empire", "enable", "energy", "engine", "enhance",
//   "enough", "environment", "escape", "establish", "everything", "example", "expand", "experience",
//   "explain", "explore", "export", "express", "extreme", "failure", "family", "famous",
//   "fantasy", "fashion", "father", "feature", "festival", "figure", "finger", "football",
//   "foreign", "forest", "forward", "freedom", "galaxy", "garden", "general", "generate",
//   "gentle", "golden", "government", "garden", "global", "glasses", "gravity", "growth",
//   "hammer", "handle", "happen", "harbor", "harmony", "harvest", "health", "heaven",
//   "history", "hospital", "humble", "hunger", "hunter", "hurricane", "identity", "impact",
//   "improve", "include", "increase", "industry", "infinite", "influence", "information", "inspire",
//   "install", "interest", "involve", "island", "journey", "justice", "kingdom", "kitchen",
//   "knowledge", "language", "leader", "letter", "library", "limited", "listen", "machine",
//   "manage", "market", "master", "medium", "memory", "method", "million", "mirror",
//   "mission", "mixture", "moment", "monster", "mountain", "movement", "multiply", "music",
//   "mystery", "nature", "network", "nothing", "notice", "object", "obvious", "ocean",
//   "option", "orange", "organize", "origin", "outside", "overcome", "oxygen", "palace",
//   "pattern", "people", "perfect", "performance", "person", "picture", "planet", "plastic",
//   "player", "pocket", "popular", "position", "possible", "power", "present", "problem",
//   "process", "produce", "program", "project", "protect", "public", "purple", "question",
//   "random", "reason", "receive", "record", "reduce", "reflect", "region", "remain",
//   "repair", "replace", "research", "resolve", "resource", "respond", "result", "return",
//   "reveal", "revolution", "rhythm", "rocket", "sample", "school", "screen", "secret",
//   "select", "server", "shadow", "silver", "simple", "situation", "soldier", "solution",
//   "something", "source", "special", "spider", "spirit", "spring", "stable", "station",
//   "strength", "structure", "student", "subject", "success", "sudden", "support", "surface",
//   "symbol", "system", "talent", "target", "teacher", "temple", "terrible", "thought",
//   "through", "thunder", "together", "travel", "trigger", "trophy", "tunnel", "ultimate",
//   "universe", "update", "useful", "valley", "variety", "version", "victory", "village",
//   "virtual", "visitor", "visual", "volume", "warrior", "weather", "welcome", "window",
//   "winter", "wonder", "world", "yellow", "absolute", "blanket", "captain", "diamond",
//   "elephant", "fantasy", "garlic", "helpful", "island", "justice", "kitchen", "laptop",
//   "mango", "noodle", "orange", "pepper", "quarter", "rabbit", "salmon", "tomato",
//   "unique", "violin", "walnut", "xenon", "yogurt", "zipper", "balloon", "canvas",
//   "donate", "empire", "falcon", "gamble", "handle", "insect", "jingle", "kettle",
//   "lemon", "marble", "napkin", "oyster", "parrot", "quartz", "radish", "saddle",
//   "talent", "unfold", "velvet", "wander", "yonder", "zombie", "anchor", "blender",
//   "candle", "debris", "effort", "filter", "goblin", "helmet", "impact", "jungle",
//   "kumquat", "lantern", "muffin", "nickel", "oblong", "pickle", "racket", "timber",
//   "update", "vendor", "wisdom", "xenial", "yearly", "zephyr"
// ];

const WORD_LIST = require('an-array-of-english-words');

// Generate a random substring from a random word
function generateSubstring() {
  const word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  const minLen = 2;
  const maxLen = Math.min(4, word.length - 1);
  const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
  const start = Math.floor(Math.random() * (word.length - len));
  const substring = word.substring(start, start + len);
  return substring.toUpperCase();
}

// Validate if a word contains the substring and is in the dictionary
function isValidWord(word, substring) {
  if (!word || typeof word !== 'string') return false;
  const w = word.toLowerCase().trim();
  const sub = substring.toLowerCase();
  if (w.length < 2) return false;
  if (!w.includes(sub)) return false;
  return WORD_LIST.includes(w);
}

module.exports = { WORD_LIST, generateSubstring, isValidWord };
