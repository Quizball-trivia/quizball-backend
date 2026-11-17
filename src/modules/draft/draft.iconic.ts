import type { Honour, League } from './draft.rules.js';

/**
 * Iconic Clubs: one league of the seasons people still talk about, drawn from the squads already in a pack. Each entry
 * names a club-season by its pack id (`<clubId>-<start year>`) and what made it. Seasons a pack does not carry are
 * skipped, so a release without one simply plays without it.
 */
export const ICONIC_LEAGUE: League = { id: 'iconic', name: 'Iconic Clubs', short: 'ICO', teams: 20, games: 38 };

/** The fewest seasons that still make a league: you plus 19 rivals, and enough left over that each draft differs. */
export const ICONIC_MIN_SEASONS = 30;

export const ICONIC_SEASONS: ReadonlyArray<readonly [id: string, honour: Honour]> = [
  // England
  ['pl-1003-2015', 'surprise'], // Leicester City 2015/16: champions at 5000-1
  ['pl-11-2003', 'unbeaten'], // Arsenal 2003/04: the Invincibles
  ['pl-985-1998', 'treble'], // Manchester United 1998/99
  ['pl-985-2007', 'ucl_winners'], // Manchester United 2007/08
  ['pl-985-1993', 'double'], // Manchester United 1993/94
  ['pl-631-2004', 'champions'], // Chelsea 2004/05: 95 points
  ['pl-631-2011', 'ucl_winners'], // Chelsea 2011/12: Munich
  ['pl-281-2011', 'champions'], // Manchester City 2011/12: 93:20
  ['pl-281-2017', 'centurions'], // Manchester City 2017/18: 100 points
  ['pl-281-2022', 'treble'], // Manchester City 2022/23
  ['pl-31-2004', 'ucl_winners'], // Liverpool 2004/05: Istanbul
  ['pl-31-2019', 'champions'], // Liverpool 2019/20
  ['pl-31-1983', 'treble'], // Liverpool 1983/84
  ['pl-164-1994', 'champions'], // Blackburn Rovers 1994/95
  ['pl-148-2018', 'ucl_final'], // Tottenham 2018/19
  ['pl-703-1978', 'european_cup'], // Nottingham Forest 1978/79
  ['pl-762-1995', 'title_race'], // Newcastle 1995/96: the Entertainers
  ['pl-11-1990', 'champions'], // Arsenal 1990/91: one defeat
  ['pl-29-1984', 'champions'], // Everton 1984/85: title and Cup Winners' Cup
  // Spain
  ['laliga-131-2008', 'treble'], // Barcelona 2008/09
  ['laliga-131-2014', 'treble'], // Barcelona 2014/15: MSN
  ['laliga-131-1991', 'european_cup'], // Barcelona 1991/92: the Dream Team
  ['laliga-131-2010', 'ucl_winners'], // Barcelona 2010/11: Wembley
  ['laliga-418-2016', 'ucl_winners'], // Real Madrid 2016/17: league and Cardiff
  ['laliga-418-2001', 'ucl_winners'], // Real Madrid 2001/02: Glasgow
  ['laliga-418-2011', 'centurions'], // Real Madrid 2011/12: 100 points
  ['laliga-418-1997', 'ucl_winners'], // Real Madrid 1997/98: the Séptima
  ['laliga-418-1986', 'champions'], // Real Madrid 1986/87: the Quinta del Buitre
  ['laliga-13-2013', 'champions'], // Atlético Madrid 2013/14
  ['laliga-1049-2001', 'champions'], // Valencia 2001/02
  ['laliga-1049-2003', 'double'], // Valencia 2003/04: league and UEFA Cup
  ['laliga-897-1999', 'champions'], // Deportivo 1999/2000: Super Depor
  ['laliga-897-1993', 'title_race'], // Deportivo 1993/94: one penalty short
  ['laliga-368-2006', 'uefa_cup'], // Sevilla 2006/07
  ['laliga-1050-2005', 'ucl_semi'], // Villarreal 2005/06
  ['laliga-621-1983', 'double'], // Athletic Club 1983/84
  ['laliga-681-1981', 'champions'], // Real Sociedad 1981/82
  ['laliga-12321-2023', 'surprise'], // Girona 2023/24
  // Italy
  ['seriea-12-2000', 'champions'], // Roma 2000/01
  ['seriea-46-2009', 'treble'], // Inter 2009/10
  ['seriea-46-1988', 'champions'], // Inter 1988/89: the record Scudetto
  ['seriea-506-2011', 'unbeaten'], // Juventus 2011/12
  ['seriea-506-1995', 'ucl_winners'], // Juventus 1995/96
  ['seriea-506-1985', 'champions'], // Juventus 1985/86
  ['seriea-6195-1986', 'double'], // Napoli 1986/87: Maradona
  ['seriea-6195-2022', 'champions'], // Napoli 2022/23
  ['seriea-5-1987', 'champions'], // Milan 1987/88: Sacchi
  ['seriea-5-1991', 'unbeaten'], // Milan 1991/92
  ['seriea-5-2006', 'ucl_winners'], // Milan 2006/07
  ['seriea-1038-1990', 'champions'], // Sampdoria 1990/91
  ['seriea-398-1999', 'champions'], // Lazio 1999/2000
  ['seriea-130-1998', 'uefa_cup'], // Parma 1998/99
  ['seriea-800-2023', 'europa_league'], // Atalanta 2023/24
  // Germany
  ['bundesliga-27-2012', 'treble'], // Bayern 2012/13
  ['bundesliga-27-2019', 'treble'], // Bayern 2019/20
  ['bundesliga-27-1973', 'european_cup'], // Bayern 1973/74
  ['bundesliga-27-2000', 'ucl_winners'], // Bayern 2000/01
  ['bundesliga-15-2023', 'unbeaten'], // Leverkusen 2023/24
  ['bundesliga-16-2011', 'double'], // Dortmund 2011/12
  ['bundesliga-16-2012', 'ucl_final'], // Dortmund 2012/13
  ['bundesliga-82-2008', 'surprise'], // Wolfsburg 2008/09
  ['bundesliga-79-2006', 'champions'], // Stuttgart 2006/07
  ['bundesliga-c-1--fc-kaiserslautern-1997', 'surprise'], // Kaiserslautern 1997/98: promoted champions
  ['bundesliga-18-1975', 'champions'], // Mönchengladbach 1975/76
  ['bundesliga-41-1982', 'european_cup'], // Hamburg 1982/83
  ['bundesliga-89-2022', 'surprise'], // Union Berlin 2022/23
  // France
  ['ligue1-162-2003', 'ucl_final'], // Monaco 2003/04
  ['ligue1-162-2016', 'champions'], // Monaco 2016/17
  ['ligue1-1082-2010', 'double'], // Lille 2010/11
  ['ligue1-583-2019', 'ucl_final'], // PSG 2019/20
  ['ligue1-583-2024', 'treble'], // PSG 2024/25
  ['ligue1-1041-2006', 'champions'], // Lyon 2006/07
  ['ligue1-244-1991', 'champions'], // Marseille 1991/92
  ['ligue1-618-1975', 'ucl_final'], // Saint-Étienne 1975/76
  ['ligue1-995-1994', 'champions'], // Nantes 1994/95
  ['ligue1-1082-2020', 'champions'], // Lille 2020/21
];
