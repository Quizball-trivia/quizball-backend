import { describe, expect, it } from 'vitest';
import { parsePlayerClueFile } from '../../src/modules/auction/player-clue-cards.parser.js';
import { normalizeText, resolveAlias } from '../../src/modules/auction/player-clue-cards.aliases.js';

describe('player-clue-cards.parser', () => {
  it('parses old format without difficulty', () => {
    const text = `Player 1 Clue 1: I started my career at Sporting CP. Clue 2: I won the Ballon d'Or multiple times. Clue 3: I play for Al-Nassr. Answer: Cristiano Ronaldo`;
    const { rows, errors } = parsePlayerClueFile(text, 'medium');

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].answerName).toBe('Cristiano Ronaldo');
    expect(rows[0].clue1).toBe('I started my career at Sporting CP.');
    expect(rows[0].clue2).toBe("I won the Ballon d'Or multiple times.");
    expect(rows[0].clue3).toBe('I play for Al-Nassr.');
    expect(rows[0].difficulty).toBe('medium');
    expect(rows[0].difficultySource).toBe('default');
    expect(rows[0].warnings).toContain('difficulty_defaulted');
  });

  it('parses new format with difficulty', () => {
    const text = `Player 1 Difficulty: easy Clue 1: I am from Argentina. Clue 2: I won the World Cup in 2022. Clue 3: I play for Inter Miami. Answer: Lionel Messi`;
    const { rows, errors } = parsePlayerClueFile(text, 'medium');

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].answerName).toBe('Lionel Messi');
    expect(rows[0].difficulty).toBe('easy');
    expect(rows[0].difficultySource).toBe('row');
    expect(rows[0].warnings).not.toContain('difficulty_defaulted');
  });

  it('default difficulty warning is produced when no difficulty on row', () => {
    const text = `Player 1 Clue 1: I am a goalkeeper from Italy. Clue 2: I won the World Cup in 2006. Clue 3: I played for Juventus. Answer: Gianluigi Buffon`;
    const { rows } = parsePlayerClueFile(text, 'medium');

    expect(rows[0].warnings).toContain('difficulty_defaulted');
    expect(rows[0].difficulty).toBe('medium');
  });

  it('rejects invalid difficulty and falls back to default', () => {
    const text = `Player 1 Difficulty: extreme Clue 1: I am from Brazil. Clue 2: I won two World Cups. Clue 3: I am called The King. Answer: Pelé`;
    const { rows } = parsePlayerClueFile(text, 'medium');

    expect(rows[0].validationErrors).toContainEqual(expect.stringContaining('Invalid difficulty'));
    expect(rows[0].difficulty).toBe('medium');
    expect(rows[0].difficultySource).toBe('default');
  });

  it('handles accented player names', () => {
    const text = `Player 1 Clue 1: I am from France. Clue 2: I won the World Cup in 2018. Clue 3: I play for Real Madrid. Answer: Kylian Mbappé`;
    const { rows } = parsePlayerClueFile(text, 'medium');

    expect(rows[0].answerName).toBe('Kylian Mbappé');
  });

  it('handles names with apostrophes and periods', () => {
    const text = `Player 1 Clue 1: I am from Brazil. Clue 2: I play as a forward. Clue 3: I transferred to PSG. Answer: Neymar Jr.`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].answerName).toBe('Neymar Jr.');
  });

  it('handles multiple entries in one text file', () => {
    const text = `Player 1 Clue 1: I am from Portugal. Clue 2: I won the Ballon d'Or. Clue 3: I play for Al-Nassr. Answer: Cristiano Ronaldo
Player 2 Clue 1: I am from Argentina. Clue 2: I won the World Cup. Clue 3: I play for Inter Miami. Answer: Lionel Messi
Player 3 Difficulty: hard Clue 1: I am from Croatia. Clue 2: I won the Champions League. Clue 3: I play for Real Madrid. Answer: Luka Modrić`;
    const { rows, errors } = parsePlayerClueFile(text, 'medium');

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(3);
    expect(rows[0].answerName).toBe('Cristiano Ronaldo');
    expect(rows[1].answerName).toBe('Lionel Messi');
    expect(rows[2].answerName).toBe('Luka Modrić');
    expect(rows[2].difficulty).toBe('hard');
    expect(rows[0].rowIndex).toBe(1);
    expect(rows[1].rowIndex).toBe(2);
    expect(rows[2].rowIndex).toBe(3);
  });

  it('rejects clue containing answer name', () => {
    const text = `Player 1 Clue 1: I am Lionel Messi from Argentina. Clue 2: I won the World Cup. Clue 3: I play for Inter Miami. Answer: Lionel Messi`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].validationErrors).toContainEqual(expect.stringContaining('contains part of the answer'));
  });

  it('rejects empty clues', () => {
    const text = `Player 1 Clue 1: Clue 2: I won the World Cup. Clue 3: I play for Spain. Answer: Andrés Iniesta`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].validationErrors).toContainEqual(expect.stringContaining('Clue 1 is empty'));
  });

  it('rejects duplicate clues', () => {
    const text = `Player 1 Clue 1: I am a midfielder from Spain. Clue 2: I am a midfielder from Spain. Clue 3: I won the World Cup. Answer: Andrés Iniesta`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].validationErrors).toContainEqual(expect.stringContaining('Clue 1 and Clue 2 are identical'));
  });

  it('rejects market value references in clues', () => {
    const text = `Player 1 Clue 1: My market value is 180 million euros. Clue 2: I am from France. Clue 3: I play for Real Madrid. Answer: Kylian Mbappé`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].validationErrors).toContainEqual(expect.stringContaining('market value'));
  });

  it('produces fact-risk flags for high-risk terms', () => {
    const text = `Player 1 Clue 1: I hold the record for most goals. Clue 2: I won the World Cup twice. Clue 3: I won the Ballon d'Or three times. Answer: Pelé`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].factRiskFlags).toContain('record');
    expect(rows[0].factRiskFlags).toContain('world cup');
    expect(rows[0].factRiskFlags).toContain("ballon d'or");
  });

  it('handles whitespace variations', () => {
    const text = `Player 1   Clue 1:   I am from Germany.   Clue 2:   I won the World Cup.   Clue 3:   I am a goalkeeper.   Answer:   Manuel Neuer`;
    const { rows } = parsePlayerClueFile(text);

    expect(rows[0].answerName).toBe('Manuel Neuer');
    expect(rows[0].clue1).toBe('I am from Germany.');
  });

  it('handles multiline format where clues are on separate lines', () => {
    const text = `Player 1
Clue 1: I am from Portugal.
Clue 2: I won the Ballon d'Or five times.
Clue 3: I play for Al-Nassr.
Answer: Cristiano Ronaldo`;
    const { rows, errors } = parsePlayerClueFile(text, 'medium');

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].answerName).toBe('Cristiano Ronaldo');
    expect(rows[0].clue1).toBe('I am from Portugal.');
  });
});

describe('player-clue-cards.aliases', () => {
  it('normalizes accented text', () => {
    expect(normalizeText('Kylian Mbappé')).toBe('kylian mbappe');
    expect(normalizeText('Luka Modrić')).toBe('luka modric');
    expect(normalizeText('Andrés Iniesta')).toBe('andres iniesta');
  });

  it('resolves common aliases', () => {
    expect(resolveAlias('Mbappe')).toBe('Kylian Mbappé');
    expect(resolveAlias('Modric')).toBe('Luka Modrić');
    expect(resolveAlias('Andres Iniesta')).toBe('Andrés Iniesta');
    expect(resolveAlias('Thomas Muller')).toBe('Thomas Müller');
  });

  it('returns null for unknown aliases', () => {
    expect(resolveAlias('Unknown Player')).toBeNull();
  });
});
