const ALIAS_MAP: Record<string, string> = {
  'cristiano ronaldo': 'Cristiano Ronaldo',
  'ronaldo nazario': 'Ronaldo Nazário',
  'ronaldo luís nazário de lima': 'Ronaldo Nazário',
  'neymar jr': 'Neymar Jr.',
  'neymar': 'Neymar Jr.',
  'andres iniesta': 'Andrés Iniesta',
  'xavi hernandez': 'Xavi Hernández',
  'xavi': 'Xavi Hernández',
  'thomas muller': 'Thomas Müller',
  'kylian mbappe': 'Kylian Mbappé',
  'mbappe': 'Kylian Mbappé',
  'luka modric': 'Luka Modrić',
  'modric': 'Luka Modrić',
  'toni kroos': 'Toni Kroos',
  'iker casillas': 'Iker Casillas',
  'pele': 'Pelé',
  'kaka': 'Kaká',
  'karim benzema': 'Karim Benzema',
  'lionel messi': 'Lionel Messi',
  'messi': 'Lionel Messi',
  'diego maradona': 'Diego Maradona',
  'maradona': 'Diego Maradona',
  'zinedine zidane': 'Zinedine Zidane',
  'zidane': 'Zinedine Zidane',
  'frank lampard': 'Frank Lampard',
  'steven gerrard': 'Steven Gerrard',
  'wayne rooney': 'Wayne Rooney',
  'robert lewandowski': 'Robert Lewandowski',
  'lewandowski': 'Robert Lewandowski',
  'eden hazard': 'Eden Hazard',
  'gareth bale': 'Gareth Bale',
  'luis suarez': 'Luis Suárez',
  'suarez': 'Luis Suárez',
  'sergio ramos': 'Sergio Ramos',
  'ramos': 'Sergio Ramos',
  'gerard pique': 'Gerard Piqué',
  'pique': 'Gerard Piqué',
  'david beckham': 'David Beckham',
  'beckham': 'David Beckham',
  'ronaldinho': 'Ronaldinho',
  'andriy shevchenko': 'Andriy Shevchenko',
  'shevchenko': 'Andriy Shevchenko',
  'pavel nedved': 'Pavel Nedvěd',
  'michael owen': 'Michael Owen',
  'raul gonzalez': 'Raúl González',
  'raul': 'Raúl González',
  'fernando torres': 'Fernando Torres',
  'torres': 'Fernando Torres',
  'thierry henry': 'Thierry Henry',
  'henry': 'Thierry Henry',
  'roberto carlos': 'Roberto Carlos',
  'paul scholes': 'Paul Scholes',
  'alessandro del piero': 'Alessandro Del Piero',
  'del piero': 'Alessandro Del Piero',
  'francesco totti': 'Francesco Totti',
  'totti': 'Francesco Totti',
  'gianluigi buffon': 'Gianluigi Buffon',
  'buffon': 'Gianluigi Buffon',
  'manuel neuer': 'Manuel Neuer',
  'neuer': 'Manuel Neuer',
  'kevin de bruyne': 'Kevin De Bruyne',
  'de bruyne': 'Kevin De Bruyne',
  'eden hazard jr': 'Eden Hazard',
  'mo salah': 'Mohamed Salah',
  'mohamed salah': 'Mohamed Salah',
  'salah': 'Mohamed Salah',
  'harry kane': 'Harry Kane',
  'kane': 'Harry Kane',
  'phil foden': 'Phil Foden',
  'jude bellingham': 'Jude Bellingham',
  'bellingham': 'Jude Bellingham',
  'vinicius jr': 'Vinícius Júnior',
  'vinicius': 'Vinícius Júnior',
  'erling haaland': 'Erling Haaland',
  'haaland': 'Erling Haaland',
  'pedri': 'Pedri',
  'gavi': 'Gavi',
  'antoine griezmann': 'Antoine Griezmann',
  'griezmann': 'Antoine Griezmann',
  'paul pogba': 'Paul Pogba',
  'pogba': 'Paul Pogba',
  'ngolo kante': "N'Golo Kanté",
  "n'golo kante": "N'Golo Kanté",
  'kante': "N'Golo Kanté",
  'marcelo': 'Marcelo',
  'dani alves': 'Dani Alves',
  'sergio busquets': 'Sergio Busquets',
  'busquets': 'Sergio Busquets',
  'mats hummels': 'Mats Hummels',
  'mario gotze': 'Mario Götze',
  'mesut ozil': 'Mesut Özil',
  'ozil': 'Mesut Özil',
  'bastian schweinsteiger': 'Bastian Schweinsteiger',
};

const RESOLVED_ALIASES = new Map<string, string>();
for (const [key, value] of Object.entries(ALIAS_MAP)) {
  RESOLVED_ALIASES.set(normalizeText(key), value);
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function resolveAlias(input: string): string | null {
  const normalized = normalizeText(input);
  return RESOLVED_ALIASES.get(normalized) ?? null;
}

export function getAllAliases(): Record<string, string> {
  return { ...ALIAS_MAP };
}
