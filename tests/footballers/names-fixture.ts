import { footballerNamesOf } from '../../src/modules/footballers/footballers.names.js';
import { buildUniverse } from '../../src/modules/footballers/footballers.universe.js';

// Invented footballers only (the repository is public). Pairs one or two edits apart, so a typo of one is the other's
// exact name.
export const UNIVERSE = buildUniverse('rel-test', [
  { pid: 'kell-a', name: 'Judo Kellerman', game: 'Kellerman', fame: 80, aliases: [] },
  { pid: 'kell-b', name: 'Jobo Kellerman', game: 'Kellerman', fame: 20, aliases: [] },
  { pid: 'var-a', name: 'Tomas Varnik', game: 'Varnik', fame: 70, aliases: [] },
  { pid: 'var-b', name: 'Tamas Varnik', game: 'Varnik', fame: 10, aliases: [] },
  { pid: 'mos-a', name: 'Teo Arlan Moss', game: 'Moss', fame: 60, aliases: [] },
  { pid: 'mos-b', name: 'Arlan Moss', game: 'Moss', fame: 30, aliases: [] },
  { pid: 'wil-a', name: 'Wilmar', game: 'Wilmar', fame: 50, aliases: [] },
  { pid: 'wil-b', name: 'Wilmar', game: 'Wilmar', fame: 10, aliases: [] },
  { pid: 'dak-a', name: 'Benn Gallo-Dak', game: 'Gallo-Dak', fame: 30, aliases: ['Benn Dak'] },
  { pid: 'mik-a', name: 'Mikkel', game: 'Mikkel', fame: 40, aliases: [] },
  { pid: 'mik-b', name: 'Mikael', game: 'Mikael', fame: 10, aliases: [] },
  { pid: 'gal-a', name: 'Ezio Galtero', game: 'Galtero', fame: 50, aliases: [] },
  { pid: 'gal-b', name: 'Ezio Gautero', game: 'Gautero', fame: 5, aliases: [] },
  { pid: 'ost-a', name: 'Lars Østergard', game: 'Østergard', fame: 30, aliases: ['ლარს ოსტერგარდი'] },
  // One Georgian spelling for two Latin names; an initial alias.
  { pid: 'hen-a', name: 'Luka Henrik', game: 'Henrik', fame: 30, aliases: ['ლუკა ენრიკი'] },
  { pid: 'enr-a', name: 'Luka Enrik', game: 'Enrik', fame: 40, aliases: ['ლუკა ენრიკი', 'L. Enrik'] },
  // One name for two people: an alias of one, the own name of the other.
  { pid: 'mae-a', name: 'Rui Pando', game: 'Pando', fame: 30, aliases: ['Maelo'] },
  { pid: 'mae-b', name: 'Maelo', game: 'Maelo', fame: 5, aliases: [] },
  { pid: 'vel-a', name: 'Taro Velmar', game: 'Velmar', fame: 20, aliases: [] },
]);
export const NAMES = footballerNamesOf(UNIVERSE);
