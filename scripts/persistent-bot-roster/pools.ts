/**
 * Hand-curated component pools for the name generator. The COMBINATION RATES
 * (how often a surname is appended, digits are added, casing is lowered, etc.)
 * come from the MEASURED patterns.json — only the raw material below is curated.
 *
 * Roots are Georgian first names and surname stems with transliteration
 * variants, seeded from the real named-user corpus on staging and expanded by
 * hand to ~120 first-name roots and ~90 surname stems so the reachable
 * combination space vastly exceeds 1,000 draws + the ~23.5k exclusion set.
 */

/** Georgian male first-name roots (Latin transliteration, common variants). */
export const FIRST_NAMES_M: string[] = [
  'Giorgi', 'Gio', 'Goga', 'Gogi', 'Gigi', 'Giga',
  'Davit', 'Daviti', 'Dato', 'Datuna', 'Data',
  'Nika', 'Nikoloz', 'Niko', 'Nikusha',
  'Luka', 'Lukas', 'Luka',
  'Zuka', 'Zuriko', 'Zura', 'Zaza', 'Zviad',
  'Guga', 'Gugu',
  'Koka', 'Kakha', 'Kakhi', 'Kaki', 'Kako',
  'Temuri', 'Temo', 'Temur', 'Temol',
  'Bacho', 'Beka', 'Beso', 'Bidzina',
  'Mirian', 'Merab', 'Malkhaz',
  'Oto', 'Otar', 'Otari',
  'Tornike', 'Toko', 'Tornik',
  'Levan', 'Lasha', 'Lado', 'Lekso',
  'Irakli', 'Ika', 'Irakay',
  'Rezi', 'Revaz', 'Rezo',
  'Tazo', 'Taso', 'Tato',
  'Vaska', 'Vaso', 'Vakhtang', 'Vato',
  'Sandro', 'Saba', 'Sergo', 'Soso', 'Sulkhan',
  'Gega', 'Gela', 'Genadi',
  'Grigol', 'Grisha', 'Gocha',
  'Givi', 'Guram', 'Gubaz',
  'Shota', 'Sopho', 'Shalva',
  'Vakho', 'Vova', 'Valeri',
  'Ilia', 'Iuri', 'Ioseb',
  'Paata', 'Pavle', 'Pridon',
  'Ramaz', 'Roin', 'Rati',
  'Zaal', 'Zezva', 'Zurab',
  'Bachana', 'Badri', 'Buba',
  'Elguja', 'Emzar', 'Eldar',
  'Konstantine', 'Kote', 'Kukuri',
  'Mamuka', 'Mikheil', 'Misha', 'Miqa',
  'Nodar', 'Nugo', 'Nugzar',
  'Tengiz', 'Tengo', 'Teimuraz',
  'Ucha', 'Ushangi',
  'Jaba', 'Jano', 'Jemal',
];

/** Georgian female first-name roots (smaller share, as in the real corpus). */
export const FIRST_NAMES_F: string[] = [
  'Natia', 'Nino', 'Nana', 'Nutsa',
  'Ana', 'Ania', 'Anano',
  'Mari', 'Mariam', 'Maka', 'Mako',
  'Tako', 'Tamar', 'Tamta', 'Tea',
  'Salome', 'Sopo', 'Sopho',
  'Lela', 'Lika', 'Lali',
  'Keti', 'Ketevan', 'Khatia',
  'Eka', 'Elene', 'Eliso',
  'Marjana', 'Manana', 'Medea',
];

/**
 * Georgian surname stems. Combined with a suffix at generation time to form
 * realistic surnames (-shvili, -idze, -adze, -ava, -iani, -eli, -ua). Stems are
 * chosen so stem+suffix reads naturally.
 */
export const SURNAME_STEMS: string[] = [
  'Japar', 'Lordkipa', 'Bakur', 'Talakh', 'Gagosh', 'Arsen', 'Aval', 'Kublash',
  'Darakhvel', 'Maisur', 'Sanik', 'Kraveish', 'Tsaguri', 'Matchavar', 'Inasar',
  'Chadun', 'Nozad', 'Zark', 'Mika', 'Kemokl', 'Janjgav', 'Beber', 'Skang',
  'Qorid', 'Araki', 'Tomad', 'Chirad', 'Phkhovel', 'Lesg', 'Kalatoz', 'Tsalugel',
  'Beridz', 'Kapan', 'Gelash', 'Chkhart', 'Dolidz', 'Eliash', 'Gogich', 'Iremash',
  'Jugel', 'Khubul', 'Lomid', 'Meladz', 'Nadir', 'Okrop', 'Papav', 'Qavtar',
  'Rustav', 'Shengel', 'Tabag', 'Ubil', 'Vashal', 'Zhvan', 'Abash', 'Bagrat',
  'Chkhikv', 'Dgeb', 'Elizbar', 'Gvaram', 'Iashvil', 'Kldiash', 'Lobzh', 'Mamul',
  'Natenad', 'Oniani', 'Peikrish', 'Rurad', 'Sakvarel', 'Turash', 'Ugreli',
  'Vephkhv', 'Zumbul', 'Amiran', 'Bochor', 'Chanturi', 'Dvali', 'Ekhvai',
  'Gugesh', 'Imnadz', 'Kikn', 'Lezhav', 'Mgel', 'Nachkeb', 'Odish', 'Purtsel',
  'Ratian', 'Samkhar', 'Tsereteli', 'Ugul',
];

/** Surname suffixes with rough real-world prevalence weights. */
export const SURNAME_SUFFIXES: { value: string; weight: number }[] = [
  { value: 'shvili', weight: 40 },
  { value: 'idze', weight: 22 },
  { value: 'adze', weight: 12 },
  { value: 'ava', weight: 6 },
  { value: 'iani', weight: 6 },
  { value: 'eli', weight: 5 },
  { value: 'ua', weight: 4 },
  { value: 'ashvili', weight: 5 },
];

/** Diminutive suffixes occasionally appended to a first name (kukusha, gogaB). */
export const DIMINUTIVE_SUFFIXES: string[] = ['o', 'a', 'ika', 'ka', 'iko', 'ushka', 'una'];

/**
 * Exact famous-athlete tokens (finding #8). Real players DO use these
 * (hamsik971 was measured), but a bare `ronaldo` reads as impersonation, so the
 * name generator NEVER emits these unmodified — they ALWAYS take decoration
 * (digits/diminutive/suffix), mirroring how the real cohort uses them.
 */
export const PROTECTED_ATHLETE_TOKENS: string[] = [
  'messi', 'ronaldo', 'cr7', 'neymar', 'mbappe', 'pele', 'maradona', 'zlatan',
  'vidal', 'arteta', 'ramos', 'hamsik', 'kaka',
];

/**
 * Generic football-reference tokens seen among real names (roles, echoes). Used
 * at a low, measured rate. Bare <=2-letter tokens (cf, fc, gk) are deliberately
 * excluded — they read as obviously synthetic (finding #8).
 */
export const FOOTBALL_TOKENS: string[] = [
  'costa', 'belardi', 'goat', 'baller', 'striker', 'kaisa', 'golden', 'legend',
  'maestro', 'trequarti', 'libero', 'catenaccio',
];

/**
 * Transliteration variant map: some roots have kh/x, ts/c alternates. Applying
 * a variant occasionally (at a low rate) produces the Talakhadze/Talaxadze
 * style diversity seen in real names.
 */
export const TRANSLIT_VARIANTS: { from: RegExp; to: string }[] = [
  { from: /kh/g, to: 'x' },
  { from: /ts/g, to: 'c' },
  { from: /ch/g, to: 'tch' },
];

/** Curated cities + coordinates per country code (small list each). */
export const COUNTRY_CITIES: Record<string, { name: string; lat: number; lng: number }[]> = {
  GE: [
    { name: 'Tbilisi', lat: 41.7151, lng: 44.8271 },
    { name: 'Batumi', lat: 41.6168, lng: 41.6367 },
    { name: 'Kutaisi', lat: 42.2679, lng: 42.7180 },
    { name: 'Rustavi', lat: 41.5495, lng: 45.0028 },
    { name: 'Zugdidi', lat: 42.5088, lng: 41.8709 },
    { name: 'Gori', lat: 41.9847, lng: 44.1086 },
    { name: 'Poti', lat: 42.1465, lng: 41.6710 },
    { name: 'Telavi', lat: 41.9192, lng: 45.4731 },
    { name: 'Ozurgeti', lat: 41.9245, lng: 42.0064 },
    { name: 'Akhaltsikhe', lat: 41.6392, lng: 42.9826 },
  ],
  US: [
    { name: 'New York', lat: 40.7128, lng: -74.006 },
    { name: 'Los Angeles', lat: 34.0522, lng: -118.2437 },
    { name: 'Chicago', lat: 41.8781, lng: -87.6298 },
  ],
  GB: [
    { name: 'London', lat: 51.5074, lng: -0.1278 },
    { name: 'Manchester', lat: 53.4808, lng: -2.2426 },
    { name: 'Birmingham', lat: 52.4862, lng: -1.8904 },
  ],
  GR: [
    { name: 'Athens', lat: 37.9838, lng: 23.7275 },
    { name: 'Thessaloniki', lat: 40.6401, lng: 22.9444 },
  ],
  TR: [
    { name: 'Istanbul', lat: 41.0082, lng: 28.9784 },
    { name: 'Ankara', lat: 39.9334, lng: 32.8597 },
    { name: 'Izmir', lat: 38.4237, lng: 27.1428 },
  ],
  DE: [
    { name: 'Berlin', lat: 52.52, lng: 13.405 },
    { name: 'Munich', lat: 48.1351, lng: 11.582 },
  ],
  ES: [
    { name: 'Madrid', lat: 40.4168, lng: -3.7038 },
    { name: 'Barcelona', lat: 41.3874, lng: 2.1686 },
  ],
};

/** Football clubs for favorite_club, weighted from the measured non-null set. */
export const CLUBS: { value: string; weight: number }[] = [
  { value: 'FC Barcelona', weight: 19 },
  { value: 'Real Madrid', weight: 12 },
  { value: 'Arsenal FC', weight: 11 },
  { value: 'AC Milan', weight: 7 },
  { value: 'Bayern Munich', weight: 6 },
  { value: 'Manchester United', weight: 5 },
  { value: 'Aston Villa', weight: 4 },
  { value: 'Liverpool FC', weight: 3 },
  { value: 'Brentford FC', weight: 3 },
  { value: 'Chelsea FC', weight: 2 },
  { value: 'Paris Saint-Germain', weight: 2 },
  { value: 'Dinamo Tbilisi', weight: 4 },
];
