/**
 * Words a typed clue may not contain, in the languages the game is played in. A clue is a few words shown to a
 * room of friends and guests, so the check is per word (after folding): the shared nickname list matches inside words
 * and would refuse real football names (Slutsky).
 * `prefix`: the stem is refused at the start of any word (inflected languages).
 * One list for every language, so a word must not be an ordinary word or name in another: French "con" is Spanish "with",
 * Portuguese "foda" and "fode" are Franco Foda and Fodé (folded), "porra" is a Spanish deck word and a prefix "arsch" would
 * catch Arschawin; they stay exact, or out.
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
  // fr
  'merde', 'merdes', 'merdeux', 'merdique', 'putain', 'pute', 'putes', 'salope', 'salopes', 'salopard', 'salopards', 'salaud', 'salauds', 'connard', 'connards', 'connasse', 'connasses', 'conne', 'connes', 'enculé', 'enculés', 'enculer', 'nique', 'niquer', 'niqué', 'ntm', 'fdp', 'couille', 'couilles', 'chatte', 'chattes', 'bâtard', 'bâtards', 'branleur', 'branleuse', 'trouduc', 'ta gueule', 'ton cul', 'nègre', 'négresse', 'bougnoule', 'bougnoules', 'youpin', 'youpine', 'youpins', 'bicot', 'bicots', 'bamboula', 'tapette', 'tapettes', 'gouine', 'gouines', 'sale arabe', 'sale juif', 'sale noir', 'sale nègre',
  // pt
  'caralho', 'caralhos', 'merda', 'merdas', 'merdinha', 'bosta', 'cacete', 'foda se', 'foder', 'fodeu', 'fodido', 'fodida', 'fodendo', 'fodase', 'buceta', 'boceta', 'xoxota', 'xereca', 'punheta', 'punheteiro', 'boquete', 'cuzão', 'no cu', 'teu cu', 'arrombado', 'arrombada', 'babaca', 'vagabunda', 'vadia', 'viado', 'viadinho', 'bicha', 'sapatão', 'traveco', 'retardado', 'retardada', 'mongoloide', 'pqp', 'vsf', 'tnc',
  // de
  'scheiße', 'scheiß', 'kacke', 'arsch', 'arschloch', 'arschlöcher', 'fotze', 'fotzen', 'muschi', 'hure', 'huren', 'hurensohn', 'hurensöhne', 'nutte', 'nutten', 'schlampe', 'schlampen', 'wichser', 'fick', 'ficken', 'ficker', 'fickt', 'gefickt', 'drecksau', 'missgeburt', 'spast', 'spasti', 'spasten', 'schwuchtel', 'schwuchteln', 'neger', 'negerin', 'kanake', 'kanaken', 'judensau', 'sieg heil',
];
const PREFIX: readonly string[] = ['хуй', 'хуе', 'хуё', 'пизд', 'бляд', 'блят', 'ебан', 'ёбан', 'ебат', 'уеб', 'залуп', 'orospu', 'yarra', 'siktir', 'motherfuck', 'fuck', 'encul', 'enfoir', 'bougnoul', 'caralh', 'arromb', 'punhet', 'scheiß', 'hurens', 'arschl', 'wichs', 'fotz'];

// NFKD splits neither œ nor ß: "cœur" and "coeur", "Scheiße" and "Scheisse" are the same word.
const foldWord = (w: string) => w.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/ı/g, 'i').replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, '');
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
