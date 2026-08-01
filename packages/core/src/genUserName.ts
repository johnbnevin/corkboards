/**
 * Deterministic display-name generator for pubkeys with no kind-0 profile
 * (unresolved, or genuinely anonymous posters).
 *
 * Generates friendly pet names — "Goofy Gopher", "Mellow Otter" — instead of
 * the old `user_<hex8>` prefix, so an anonymous author reads as a person, not
 * a key fragment. This is a client-side convention, NOT a NIP: other clients
 * will show different names for the same npub, which is normal. The full
 * npub remains the real identity and is shown separately wherever it matters.
 *
 * Deterministic (same seed → same name, across sessions and platforms) via a
 * 32-bit FNV-1a hash of the whole seed; adjective and animal are picked from
 * independent bit ranges. Not unique — with ~16k combinations two random
 * pubkeys can share a name; the name is a readability aid, never an identity.
 *
 * Wordlists are deliberately friendly/neutral only — these label real people.
 */

const ADJECTIVES = [
  'Agile', 'Amber', 'Ancient', 'Artful', 'Autumn', 'Bashful', 'Blissful', 'Bold',
  'Bouncy', 'Brave', 'Breezy', 'Bright', 'Brisk', 'Bubbly', 'Calm', 'Candid',
  'Cheerful', 'Chipper', 'Clever', 'Cosmic', 'Cozy', 'Crafty', 'Crimson', 'Curious',
  'Daring', 'Dapper', 'Dashing', 'Dreamy', 'Eager', 'Earnest', 'Electric', 'Elegant',
  'Emerald', 'Fabled', 'Fancy', 'Fearless', 'Festive', 'Fluffy', 'Free', 'Friendly',
  'Frosty', 'Gallant', 'Gentle', 'Giddy', 'Gleeful', 'Glowing', 'Golden', 'Goofy',
  'Graceful', 'Grand', 'Happy', 'Hardy', 'Hearty', 'Hidden', 'Honest', 'Humble',
  'Indigo', 'Intrepid', 'Jaunty', 'Jolly', 'Jovial', 'Joyful', 'Keen', 'Kindly',
  'Lively', 'Loyal', 'Lucky', 'Luminous', 'Mellow', 'Merry', 'Mighty', 'Misty',
  'Modest', 'Mystic', 'Nimble', 'Noble', 'Peppy', 'Perky', 'Placid', 'Plucky',
  'Polished', 'Proud', 'Quick', 'Quiet', 'Radiant', 'Rapid', 'Rustic', 'Sage',
  'Scarlet', 'Serene', 'Silent', 'Silver', 'Sincere', 'Sleek', 'Sly', 'Snappy',
  'Snug', 'Spry', 'Stalwart', 'Steady', 'Stellar', 'Sturdy', 'Sunny', 'Swift',
  'Tranquil', 'Trusty', 'Twilight', 'Upbeat', 'Valiant', 'Velvet', 'Vibrant', 'Vivid',
  'Wandering', 'Warm', 'Whimsical', 'Wild', 'Winsome', 'Wise', 'Witty', 'Wondrous',
  'Zany', 'Zealous', 'Zesty', 'Zippy', 'Azure', 'Coral', 'Dusky', 'Gilded',
] as const;

const ANIMALS = [
  'Alpaca', 'Antelope', 'Armadillo', 'Axolotl', 'Badger', 'Bear', 'Beaver', 'Bison',
  'Bobcat', 'Bunny', 'Camel', 'Capybara', 'Caribou', 'Cheetah', 'Chinchilla', 'Chipmunk',
  'Cougar', 'Coyote', 'Crane', 'Cricket', 'Deer', 'Dingo', 'Dolphin', 'Donkey',
  'Dormouse', 'Dove', 'Duck', 'Eagle', 'Elk', 'Ermine', 'Falcon', 'Fawn',
  'Ferret', 'Finch', 'Firefly', 'Fox', 'Gazelle', 'Gecko', 'Gibbon', 'Giraffe',
  'Gopher', 'Grouse', 'Hamster', 'Hare', 'Hawk', 'Hedgehog', 'Heron', 'Hummingbird',
  'Ibex', 'Iguana', 'Jackal', 'Jackrabbit', 'Jaguar', 'Jay', 'Kestrel', 'Kingfisher',
  'Kitten', 'Koala', 'Kookaburra', 'Lark', 'Lemur', 'Leopard', 'Llama', 'Lobster',
  'Lynx', 'Macaw', 'Magpie', 'Manatee', 'Marmot', 'Marten', 'Meerkat', 'Mink',
  'Mole', 'Mongoose', 'Moose', 'Mouse', 'Narwhal', 'Newt', 'Nightingale', 'Ocelot',
  'Octopus', 'Opossum', 'Oriole', 'Osprey', 'Otter', 'Owl', 'Panda', 'Pangolin',
  'Panther', 'Parrot', 'Pelican', 'Penguin', 'Pheasant', 'Pika', 'Platypus', 'Pony',
  'Porcupine', 'Puffin', 'Quail', 'Quokka', 'Raccoon', 'Raven', 'Reindeer', 'Robin',
  'Salamander', 'Sandpiper', 'Seahorse', 'Seal', 'Sparrow', 'Squirrel', 'Starling', 'Stoat',
  'Stork', 'Swallow', 'Swan', 'Tanager', 'Tapir', 'Terrapin', 'Tortoise', 'Toucan',
  'Turtle', 'Vole', 'Wallaby', 'Walrus', 'Weasel', 'Wombat', 'Wren', 'Yak',
] as const;

/** 32-bit FNV-1a over the whole seed — stable for hex pubkeys and any other string. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Generate a deterministic pet name from a seed (usually a pubkey).
 * Display-only — never an identity; collisions are possible and fine.
 */
export function genUserName(seed: string): string {
  const h = fnv1a32(seed);
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[(h >>> 12) % ANIMALS.length];
  return `${adjective} ${animal}`;
}
