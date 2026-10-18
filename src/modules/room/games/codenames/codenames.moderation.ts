/**
 * Words a typed clue may not contain, in the five languages the game is played in. A clue is a few words shown to a
 * room of friends and guests, so the check is per word (after folding): the shared nickname list matches inside words
 * and would refuse real football names (Slutsky).
 * `prefix`: the stem is refused at the start of any word (inflected languages).
 */
const EXACT: readonly string[] = [
  // en
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'cunt', 'cock', 'pussy', 'whore', 'slut', 'bitch', 'bastard', 'wanker', 'twat', 'asshole', 'nazi', 'hitler', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kike', 'chink', 'spic', 'paki', 'coon',
  // es
  'puta', 'puto', 'putas', 'putos', 'mierda', 'pendejo', 'pendeja', 'maricon', 'marica', 'joder', 'polla', 'verga', 'culero', 'cabron', 'zorra', 'chinga', 'chingada', 'gilipollas', 'hijueputa', 'malparido', 'pelotudo', 'boludo', 'mogolico',
  // tr
  'amk', 'aq', 'amq', 'orospu', 'sik', 'sikik', 'yarrak', 'yarak', 'ibne', 'amcik', 'kahpe', 'pezevenk', 'gavat', 'kaltak', 'yavsak', 
  // ru (transliterated forms too)
  'suka', 'blyad', 'blyat', 'pizda', 'mudak', 'pidor', 'pidar', 'gandon', 'shluha', 'eblan',
  'сука', 'суки', 'мудак', 'пидор', 'пидар', 'гандон', 'шлюха', 'дебил', 'чмо',
  // ka (Georgian script and the usual Latin spellings)
  'ტრაკი', 'ყლე', 'ყლეო', 'მუტელი', 'ბოზი', 'ბოზო', 'პიდარასტი', 'ნაბოზარი', 'შენი დედა', 'yle', 'traki', 'bozi', 'muteli', 'nabozari',
];
const PREFIX: readonly string[] = ['хуй', 'хуе', 'хуё', 'пизд', 'бляд', 'блят', 'ебан', 'ёбан', 'ебат', 'уеб', 'залуп', 'orospu', 'yarra', 'siktir', 'motherfuck', 'fuck'];

const foldWord = (w: string) => w.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, '');
const exact = new Set(EXACT.map((w) => w.split(' ').map(foldWord).join(' ')));
const prefixes = PREFIX.map(foldWord);

export function isClueBlocked(text: string): boolean {
  const words = text.split(/[\s\-_.,;:!?'"’()]+/u).map(foldWord).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    if (exact.has(words[i]) || (i + 1 < words.length && exact.has(`${words[i]} ${words[i + 1]}`))) return true;
    if (prefixes.some((p) => words[i].startsWith(p))) return true;
  }
  return false;
}
